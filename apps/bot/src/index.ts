/**
 * @compras-whatsapp/bot — entrypoint.
 *
 * POR QUE EXISTE: este archivo es el unico punto de entrada del bot.
 * Se encarga de:
 *   1. Cargar variables de entorno (dotenv).
 *   2. Construir el container (composition root).
 *   3. Arrancar HTTP server + sesion WhatsApp.
 *   4. Registrar signal handlers para graceful shutdown.
 *   5. Registrar process-level error handlers.
 *
 * NO HACE:
 *   - Instanciar dependencias concretas (eso es container.ts).
 *   - Logica de negocio (eso son los use cases en application/).
 *   - Wiring del bot (eso es el container).
 *
 * COMO SE TESTEA: este archivo NO se testea unitariamente. La logica
 * testeable esta en container.ts y los handlers de signal se prueban
 * indirectamente via los tests de integracion del container.
 */

import 'dotenv/config';

import { buildContainer } from './config/container.ts';
import { logSecurityEvent } from './infrastructure/logging/logger.ts';

async function main(): Promise<void> {
  const container = await buildContainer();

  // Signal handlers: idempotentes. Si ya se llamo shutdown, no hacer nada.
  let shuttingDown = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      container.logger.warn({ signal, event: 'shutdown_already_in_progress' }, 'signal received during shutdown');
      return;
    }
    shuttingDown = true;
    container.logger.info({ signal, event: 'signal_received' }, 'graceful shutdown initiated');
    void container
      .shutdown()
      .then(() => {
        container.logger.info({ event: 'shutdown_complete' }, 'graceful shutdown complete');
        process.exit(0);
      })
      .catch((err: unknown) => {
        logSecurityEvent(container.logger, 'send_failed', {
          context: 'graceful_shutdown',
          err: err instanceof Error ? err.message : String(err),
        });
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  // Process-level error handlers.
  process.on('unhandledRejection', (reason: unknown) => {
    container.logger.error(
      { event: 'unhandled_rejection', reason: reason instanceof Error ? reason.message : String(reason) },
      'unhandled promise rejection',
    );
  });

  process.on('uncaughtException', (err: Error) => {
    container.logger.fatal(
      { event: 'uncaught_exception', err: { message: err.message, stack: err.stack } },
      'uncaught exception - shutting down',
    );
    void container.shutdown().finally(() => process.exit(1));
  });

  // Arrancar HTTP server + sesion WhatsApp.
  await container.start();
  container.logger.info(
    {
      event: 'bot_started',
      port: container.env.PORT,
      env: container.env.NODE_ENV,
    },
    'bot started successfully',
  );
}

void main().catch((err: unknown) => {
  // Fallback logger: si el container no se pudo construir, no tenemos
  // un logger de Pino. Usamos console.error con formato minimo.
  console.error(
    '[fatal] failed to start bot:',
    err instanceof Error ? err.message : String(err),
    err instanceof Error ? err.stack : '',
  );
  process.exit(1);
});
