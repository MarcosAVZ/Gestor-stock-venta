/**
 * Parser de comandos de escritura (WRITE commands).
 *
 * Parses text input into a BotCommand or null.
 * Separate from parseQueryCommand (queries/index.ts) which handles
 * read-only queries (resumen, estadisticas, etc).
 *
 * Design:
 * - Pure function: no deps, no DB, no side effects.
 * - Case-insensitive: /NUEVA and /nueva are equivalent.
 * - Whitespace trimmed: "  /nueva  " → { type: 'nueva' }
 * - No args supported: "/nueva compra" → null
 */
export type BotCommand =
  | { type: 'nueva' }
  | { type: 'agregar' }
  | { type: 'editar' }
  | { type: 'eliminar' }
  | { type: 'ayuda' }
  | { type: 'vender' };

/**
 * Parses text input into a BotCommand.
 * Returns null if input doesn't match any slash command.
 * Commands are case-insensitive.
 * Leading/trailing whitespace is trimmed.
 */
export function parseCommand(input: string): BotCommand | null {
  const text = input.trim().toLowerCase();
  if (text === '/nueva' || text === 'nueva') return { type: 'nueva' };
  if (text === '/agregar' || text === 'agregar') return { type: 'agregar' };
  if (text === '/editar' || text === 'editar') return { type: 'editar' };
  if (text === '/eliminar' || text === 'eliminar') return { type: 'eliminar' };
  if (text === '/ayuda' || text === 'ayuda' || text === '/help' || text === 'help') return { type: 'ayuda' };
  if (text === '/vender' || text === 'vender') return { type: 'vender' };
  return null;
}
