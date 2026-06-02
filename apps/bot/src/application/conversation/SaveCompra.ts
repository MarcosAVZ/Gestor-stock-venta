/**
 * @compras-whatsapp/bot — SaveCompra (use case).
 *
 * RESPONSABILIDAD:
 * Persistir una Compra + sus ItemCompra cuando el state machine emite
 * la acción `GUARDAR` (en CONFIRMACION_FINAL + USUARIO_CONFIRMA). Es
 * la pieza que faltaba en PR3: el state machine ya tenía la transición
 * CONFIRMACION_FINAL + "sí" → GUARDADO, pero la implementación real
 * de la persistencia estaba sin wirear. PR5 task 5.5 cierra ese gap.
 *
 * POR QUÉ UN USE CASE SEPARADO:
 * - Testeable con mocks de los repos (sin DB).
 * - Reusable: si en el futuro queremos guardar una compra vía un
 *   comando (ej: "guardar <datos>"), este use case es la puerta.
 * - Mantiene `HandleIncomingMessage` liviano: este use case es
 *   responsable de la persistencia atómica; el orquestador solo
 *   llama y muestra el resultado.
 *
 * INPUT (DatosTemporales):
 * El state machine va acumulando en Conversacion.datosTemporales:
 *   - producto: string (lowercase, trim) — PR3 ValidateOCRData
 *   - costoLote: number — PR3 ValidateOCRData (o `costoIngresado` si
 *     el usuario corrigió manualmente en PR5)
 *   - cantidadIngresada: number — PR5 (o `cantidadSugerida` del OCR)
 *   - unidadIngresada: Unidad — PR5 (o `unidadSugerida` del OCR)
 *   - precioVenta: number — PR5
 *   - imagenOriginal?: string — path a la imagen (si vino por OCR)
 *
 * FLUJO:
 * 1. Extrae y valida con Zod los datos requeridos de datosTemporales.
 * 2. Llama `calcularMetricas` para obtener costoUnitario, ganancia, etc.
 * 3. Crea la Compra vacía (compraRepo.create).
 * 4. Crea el ItemCompra con las métricas (itemCompraRepo.createMany).
 * 5. Retorna la compra persistida (con su id y los items) para que el
 *    caller pueda loggear y el state machine haga el reset a
 *    ESPERANDO_IMAGEN.
 *
 * DECISIONES:
 * - Si falta cualquier campo requerido, lanzamos InvariantViolationError
 *   (es un bug del caller — el state machine no debería llegar a GUARDAR
 *   sin los datos completos).
 * - La transacción atómica Compra + ItemCompra se delega a los repos
 *   (cada repo hace su parte; en producción Prisma usará una
 *   transaction para garantizar atomicidad).
 * - Decimal.js se usa para todos los cálculos (PR5 task 5.2). El repo
 *   serializa a string para Prisma `Decimal`.
 */
import { Decimal } from 'decimal.js';
import { z } from 'zod';

import { Unidad } from '@compras-whatsapp/db';

import { InvariantViolationError } from '../../domain/errors/ProgrammerError.ts';
import type { CompraRepository } from '../../domain/repositories/CompraRepository.ts';
import type { ItemCompraRepository } from '../../domain/repositories/ItemCompraRepository.ts';
import { calcularMetricas } from '../pricing/CalcularMetricas.ts';

// ── Schema de validación de datosTemporales ─────────────────────────

/**
 * Schema que valida el shape de `datosTemporales` requerido para
 * persistir una compra. Acepta ambas variantes (ingresada o sugerida
 * del OCR) para cantidad y unidad.
 */
const datosParaGuardarSchema = z.object({
  producto: z.string().min(1, 'Falta el nombre del producto.'),
  costoLote: z.number().positive('El costo del lote tiene que ser mayor a cero.'),
  precioVenta: z.number().positive('El precio de venta tiene que ser mayor a cero.'),
  cantidadIngresada: z.number().int().positive().optional(),
  cantidadSugerida: z.number().int().positive().optional(),
  unidadIngresada: z.nativeEnum(Unidad).optional(),
  unidadSugerida: z.nativeEnum(Unidad).optional(),
  imagenOriginal: z.string().optional(),
});

export type DatosParaGuardar = z.infer<typeof datosParaGuardarSchema>;

// ── Input / Output ───────────────────────────────────────────────────

export interface SaveCompraDeps {
  compraRepo: CompraRepository;
  itemCompraRepo: ItemCompraRepository;
}

export interface SaveCompraInput {
  /** ID del usuario dueño de la compra. */
  usuarioId: string;
  /** Datos acumulados por el state machine en Conversacion.datosTemporales. */
  datos: DatosParaGuardar;
}

export interface SaveCompraOutput {
  /** ID de la Compra recién creada. */
  compraId: string;
  /** Métricas calculadas (útil para loggear y para que el caller
   *  muestre un resumen al usuario). */
  metricas: {
    costoUnitario: number;
    gananciaUnitaria: number;
    margenBruto: number;
    markup: number;
    ventaTotalEstimada: number;
    gananciaTotalEstimada: number;
  };
}

// ── Use case ─────────────────────────────────────────────────────────

/**
 * Persiste una Compra + su ItemCompra a partir de los datosTemporales
 * acumulados por el state machine. Retorna el id de la compra y las
 * métricas calculadas.
 *
 * @throws {InvariantViolationError} si los datosTemporales no tienen
 *   la shape requerida (producto, costoLote, cantidad, unidad,
 *   precioVenta).
 * @throws {InvariantViolationError} si CalcularMetricas rechaza
 *   valores (cero o negativos). En la práctica esto no debería
 *   pasar porque los schemas Zod ya validan positivos.
 */
export async function saveCompra(
  input: SaveCompraInput,
  deps: SaveCompraDeps,
): Promise<SaveCompraOutput> {
  // 1. Validar shape de datos.
  const parsed = datosParaGuardarSchema.safeParse(input.datos);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new InvariantViolationError(`Datos incompletos para guardar: ${msg}`, {
      metadata: { issues: parsed.error.issues },
    });
  }
  const datos = parsed.data;

  // 2. Resolver cantidad y unidad (ingresada > sugerida).
  const cantidad = datos.cantidadIngresada ?? datos.cantidadSugerida;
  const unidad = datos.unidadIngresada ?? datos.unidadSugerida;
  if (cantidad === undefined) {
    throw new InvariantViolationError(
      'Falta la cantidad (ni cantidadIngresada ni cantidadSugerida están presentes).',
    );
  }
  if (unidad === undefined) {
    throw new InvariantViolationError(
      'Falta la unidad (ni unidadIngresada ni unidadSugerida están presentes).',
    );
  }

  // 3. Calcular métricas con Decimal.js.
  const m = calcularMetricas({
    costoLote: datos.costoLote,
    cantidadReal: cantidad,
    precioVenta: datos.precioVenta,
  });

  // 4. Crear la Compra vacía.
  const compra = await deps.compraRepo.create({
    usuarioId: input.usuarioId,
    imagenOriginal: datos.imagenOriginal,
  });

  // 5. Crear el ItemCompra con las métricas (en una sola transacción
  //    vía createMany).
  const [item] = await deps.itemCompraRepo.createMany([
    {
      compraId: compra.id,
      nombre: datos.producto,
      cantidadLote: cantidad,
      unidad,
      costoLote: new Decimal(datos.costoLote).toFixed(2),
      costoUnitario: m.costoUnitario.toDecimalPlaces(4).toFixed(),
      precioVenta: new Decimal(datos.precioVenta).toFixed(2),
      gananciaUnitaria: m.gananciaUnitaria.toDecimalPlaces(4).toFixed(),
      gananciaTotal: m.gananciaTotalEstimada.toDecimalPlaces(2).toFixed(),
    },
  ]);

  if (item === undefined) {
    // Si la impl retornó array vacío, es un bug del repo. Tratamos
    // como error operacional para que el caller haga rollback.
    throw new InvariantViolationError('itemCompraRepo.createMany retornó array vacío.');
  }

  return {
    compraId: compra.id,
    metricas: {
      costoUnitario: m.costoUnitario.toNumber(),
      gananciaUnitaria: m.gananciaUnitaria.toNumber(),
      margenBruto: m.margenBruto.toNumber(),
      markup: m.markup.toNumber(),
      ventaTotalEstimada: m.ventaTotalEstimada.toNumber(),
      gananciaTotalEstimada: m.gananciaTotalEstimada.toNumber(),
    },
  };
}
