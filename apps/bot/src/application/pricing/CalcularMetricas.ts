/**
 * @compras-whatsapp/bot — CalcularMetricas (use case puro).
 *
 * RESPONSABILIDAD:
 * Calcular las métricas de pricing/ganancia a partir de los datos
 * de un lote:
 *   - `costoUnitario`     = costoLote / cantidadLote
 *   - `gananciaUnitaria`  = precioVenta - costoUnitario
 *   - `margenBruto`       = (precioVenta - costoUnitario) / precioVenta
 *                            (% de ganancia sobre el precio de venta)
 *   - `markup`            = (precioVenta - costoUnitario) / costoUnitario
 *                            (% de ganancia sobre el costo)
 *   - `ventaTotalEstimada`    = precioVenta * cantidadLote
 *   - `gananciaTotalEstimada` = gananciaUnitaria * cantidadLote
 *
 * POR QUÉ DECIMAL.JS Y NO NUMBER:
 * - Precios y ganancias son DINERO. Float introduce errores de redondeo
 *   (`0.1 + 0.2 !== 0.3`). Para ARS, donde los centavos importan, esto
 *   es inaceptable. Ver sdd-design obs#28 §3.
 * - Decimal.js hace aritmética con precisión arbitraria y soporta
 *   `.toDecimalPlaces(n)` para redondeo consistente.
 * - Prisma también usa Decimal (Decimal.js) en runtime, así que
 *   pasamos el mismo tipo por las capas. La serialización a JSON se
 *   hace con `.toString()` para no perder precisión.
 *
 * POR QUÉ FUNCIÓN PURA (no clase):
 * - No tiene estado, no toca DB, no loggea. Es una transformación
 *   determinística. Eso la hace trivial de testear y reusable desde
 *   otros use cases (ConfirmCompra la llama).
 *
 * DECISIÓN: si `costoLote <= 0`, `cantidadReal <= 0` o `precioVenta <= 0`
 * se lanza InvariantViolationError — son bugs de caller. El use case
 * NO valida que el precio sea mayor al costo (puede haber ventas a
 * pérdida legítimas que el usuario confirma manualmente).
 *
 * DECISIÓN: si `cantidadReal == 0`, se lanza InvariantViolationError
 * para evitar división por cero. El caller debe validar antes.
 */
import { Decimal } from 'decimal.js';

import { InvariantViolationError } from '../../domain/errors/ProgrammerError.ts';

// ── Input / Output ───────────────────────────────────────────────────

export interface CalcularMetricasInput {
  /** Costo total del lote (ARS). Debe ser > 0. */
  costoLote: number;
  /** Cantidad de unidades en el lote. Debe ser > 0. */
  cantidadReal: number;
  /** Precio de venta por unidad (ARS). Debe ser > 0. */
  precioVenta: number;
}

export interface CalcularMetricasOutput {
  /** Costo por unidad: costoLote / cantidadLote. */
  costoUnitario: Decimal;
  /** Ganancia por unidad: precioVenta - costoUnitario. */
  gananciaUnitaria: Decimal;
  /** Margen bruto: gananciaUnitaria / precioVenta (0-1). */
  margenBruto: Decimal;
  /** Markup: gananciaUnitaria / costoUnitario (>=0). */
  markup: Decimal;
  /** Ingreso total estimado si vende todo el lote. */
  ventaTotalEstimada: Decimal;
  /** Ganancia total estimada si vende todo el lote. */
  gananciaTotalEstimada: Decimal;
}

// ── Use case ─────────────────────────────────────────────────────────

/**
 * Función pura: dado (costoLote, cantidadReal, precioVenta) retorna
 * las métricas de pricing calculadas con Decimal.js.
 *
 * @throws {InvariantViolationError} si cualquier input es <= 0 o NaN.
 */
export function calcularMetricas(input: CalcularMetricasInput): CalcularMetricasOutput {
  const { costoLote, cantidadReal, precioVenta } = input;

  if (!Number.isFinite(costoLote) || costoLote <= 0) {
    throw new InvariantViolationError(
      `costoLote debe ser > 0 y finito, recibido: ${String(costoLote)}`,
      { metadata: { field: 'costoLote', value: costoLote } },
    );
  }
  if (!Number.isFinite(cantidadReal) || cantidadReal <= 0) {
    throw new InvariantViolationError(
      `cantidadReal debe ser > 0 y finito, recibido: ${String(cantidadReal)}`,
      { metadata: { field: 'cantidadReal', value: cantidadReal } },
    );
  }
  if (!Number.isFinite(precioVenta) || precioVenta <= 0) {
    throw new InvariantViolationError(
      `precioVenta debe ser > 0 y finito, recibido: ${String(precioVenta)}`,
      { metadata: { field: 'precioVenta', value: precioVenta } },
    );
  }

  const costo = new Decimal(costoLote);
  const cantidad = new Decimal(cantidadReal);
  const precio = new Decimal(precioVenta);

  const costoUnitario = costo.dividedBy(cantidad);
  const gananciaUnitaria = precio.minus(costoUnitario);
  // margenBruto: ganancia / precioVenta. Si precioVenta es 0 ya fallamos arriba.
  const margenBruto = gananciaUnitaria.dividedBy(precio);
  // markup: ganancia / costoUnitario. Si costoUnitario es 0 → div by 0.
  // Como costoUnitario = costo/cantidad y ambos son > 0, nunca es 0.
  const markup = gananciaUnitaria.dividedBy(costoUnitario);
  const ventaTotalEstimada = precio.times(cantidad);
  const gananciaTotalEstimada = gananciaUnitaria.times(cantidad);

  return {
    costoUnitario,
    gananciaUnitaria,
    margenBruto,
    markup,
    ventaTotalEstimada,
    gananciaTotalEstimada,
  };
}
