/**
 * @compras-whatsapp/bot — Formato compartido para exportación e importación Excel.
 *
 * Define los nombres de hojas, columnas, tipos y qué columnas son importables.
 * Es la fuente única de verdad para la estructura del .xlsx.
 * Tanto ExportService como ImportService consumen estas constantes.
 *
 * Convenciones:
 * - `key`: identificador interno (snake_case, en inglés)
 * - `header`: encabezado visible en el Excel (en español)
 * - `type`: tipo de dato en la celda ('string' | 'number')
 * - `readOnly`: true si la columna es solo informativa (no se importa)
 */

export interface ExcelColumn {
  key: string;
  header: string;
  type: 'string' | 'number';
  readOnly: boolean;
}

export const SHEETS = {
  PRODUCTOS: 'Productos',
  COMPRAS: 'Compras',
  VENTAS: 'Ventas',
  RESUMEN: 'Resumen',
} as const;

export type SheetName = (typeof SHEETS)[keyof typeof SHEETS];

const PRODUCTOS_COLUMNS: ExcelColumn[] = [
  { key: 'nombre', header: 'Nombre', type: 'string', readOnly: false },
  { key: 'stock', header: 'Stock', type: 'number', readOnly: false },
  { key: 'precio_venta', header: 'Precio Venta', type: 'number', readOnly: false },
  { key: 'costo_unitario', header: 'Costo Unitario', type: 'number', readOnly: true },
  { key: 'ganancia', header: 'Ganancia', type: 'number', readOnly: true },
] as const;

const COMPRAS_COLUMNS: ExcelColumn[] = [
  { key: 'fecha', header: 'Fecha', type: 'string', readOnly: false },
  { key: 'producto', header: 'Producto', type: 'string', readOnly: false },
  { key: 'cantidad', header: 'Cantidad', type: 'number', readOnly: false },
  { key: 'costo_unitario', header: 'Costo Unitario', type: 'number', readOnly: false },
  { key: 'precio_venta', header: 'Precio Venta', type: 'number', readOnly: true },
] as const;

const VENTAS_COLUMNS: ExcelColumn[] = [
  { key: 'fecha', header: 'Fecha', type: 'string', readOnly: false },
  { key: 'producto', header: 'Producto', type: 'string', readOnly: false },
  { key: 'cantidad', header: 'Cantidad', type: 'number', readOnly: false },
  { key: 'precio_venta', header: 'Precio Venta', type: 'number', readOnly: false },
  { key: 'ganancia', header: 'Ganancia', type: 'number', readOnly: true },
] as const;

const RESUMEN_COLUMNS: ExcelColumn[] = [
  { key: 'metrica', header: 'Métrica', type: 'string', readOnly: false },
  { key: 'valor', header: 'Valor', type: 'number', readOnly: false },
] as const;

export const COLUMNS = {
  PRODUCTOS: PRODUCTOS_COLUMNS,
  COMPRAS: COMPRAS_COLUMNS,
  VENTAS: VENTAS_COLUMNS,
  RESUMEN: RESUMEN_COLUMNS,
} as const;

/** Columnas que se pueden importar desde un Excel (editar vía /importar). */
export const IMPORTABLE_COLUMNS = ['nombre', 'stock', 'precio_venta'] as const;

export type ImportableColumn = (typeof IMPORTABLE_COLUMNS)[number];

/** Helper: obtiene los headers de una hoja para usarlos como fila de encabezado. */
export function getHeaders(sheet: keyof typeof COLUMNS): string[] {
  return COLUMNS[sheet].map((c) => c.header);
}
