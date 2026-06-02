/**
 * Logger no-op para tests. Evita ruido en stdout y cumple la
 * interfaz de `pino.Logger` (subset usado por el bot).
 */
import type { Logger } from 'pino';

export function silentLogger(): Logger {
  const noop = () => undefined;
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => silentLogger(),
    level: 'silent',
  } as unknown as Logger;
}
