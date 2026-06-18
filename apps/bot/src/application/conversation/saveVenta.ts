/**
 * @compras-whatsapp/bot — saveVenta (use case).
 *
 * RESPONSABILIDAD:
 * Guardar una venta en la base de datos, calculando costoUnitario,
 * gananciaUnitaria y gananciaTotal.
 *
 * FLUJO:
 * 1. Recibe datos de la venta (producto, cantidad, precio, costo promedio)
 * 2. Calcula: gananciaUnitaria = precioVenta - costoUnitario
 * 3. Calcula: gananciaTotal = cantidad * gananciaUnitaria
 * 4. Guarda la Venta en la DB
 *
 * POR QUÉ ESTE USE CASE:
 * - Separado del handler porque el cálculo de ganancias es lógica de negocio.
 * - Testeable con mocks de repos (sin DB).
 * - Sigue el patrón de SaveCompra: dependencias inyectadas vía deps.
 */
import type { VentaRepository } from '../../domain/repositories/VentaRepository.ts';

// ── Types ─────────────────────────────────────────────────────────────

export interface SaveVentaDeps {
  ventaRepo: VentaRepository;
}

export interface VentaDatos {
  productoNombre: string;
  cantidad: number;
  precioVentaUnitario: number;
  costoUnitarioPromedio: number;
}

// ── saveVenta ─────────────────────────────────────────────────────────

/**
 * Saves a sale record to the database.
 * Calculates gananciaUnitaria and gananciaTotal.
 *
 * @param usuarioId - ID del usuario que realiza la venta
 * @param datos - Datos de la venta
 * @param deps - Dependencias (ventaRepo)
 */
export async function saveVenta(
  usuarioId: string,
  datos: VentaDatos,
  deps: SaveVentaDeps,
): Promise<void> {
  // Calculate totals
  const precioVentaTotal = datos.cantidad * datos.precioVentaUnitario;
  const gananciaUnitaria = datos.precioVentaUnitario - datos.costoUnitarioPromedio;
  const gananciaTotal = datos.cantidad * gananciaUnitaria;

  // Save to database
  await deps.ventaRepo.create({
    usuarioId,
    productoNombre: datos.productoNombre,
    cantidad: datos.cantidad,
    precioVenta: precioVentaTotal.toFixed(2),
    costoUnitario: datos.costoUnitarioPromedio.toFixed(4),
    gananciaUnitaria: gananciaUnitaria.toFixed(4),
    gananciaTotal: gananciaTotal.toFixed(2),
  });
}
