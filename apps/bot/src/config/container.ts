/**
 * @compras-whatsapp/bot — composition root.
 *
 * POR QUÉ EXISTE: el container es el ÚNICO lugar donde se instancian
 * las dependencias concretas (PrismaClient, WhatsAppWebJsAdapter, etc.)
 * y se conectan entre sí. El resto del código solo consume interfaces.
 * Esto cumple el Dependency Inversion Principle y permite testear
 * cada pieza con mocks sin tocar la wiring real.
 *
 * RESPONSABILIDADES:
 *   1. Validar env al arranque (loadEnv).
 *   2. Construir PrismaClient + 4 repositorios.
 *   3. Construir RateLimiter.
 *   4. Construir WhatsAppWebJsAdapter (puede fallar si no hay Chromium).
 *   5. Construir el dispatcher conectando el port al use case.
 *   6. Construir el Express server.
 *   7. Exportar `start()` y `shutdown()`.
 *
 * NO HACE:
 *   - Registrar SIGTERM/SIGINT handlers (eso es el index.ts).
 *   - Logging de bienvenida (eso es el index.ts también).
 *
 * CÓMO SE TESTEA: este módulo NO se testea unitariamente. Se prueba
 * con `buildContainer({ skipHttpServer: true, skipWhatsAppInit: true })`
 * en un test de integración que mockea Prisma. La complejidad del
 * wiring justifica mantenerlo como integration test.
 */

import type { Logger } from 'pino';

import { loadEnv, type Env } from './env.ts';
import { buildLogger, logSecurityEvent } from '../infrastructure/logging/logger.ts';
import { RateLimiter } from '../infrastructure/messaging/rateLimiter.ts';
import {
  buildWhatsAppAdapter,
  type WhatsAppMessagingPort,
} from '../infrastructure/messaging/WhatsAppClient.ts';
import type { PrismaClientLike } from '../infrastructure/persistence/PrismaClientLike.ts';
import { PrismaCompraRepository } from '../infrastructure/persistence/PrismaCompraRepository.ts';
import { PrismaConversacionRepository } from '../infrastructure/persistence/PrismaConversacionRepository.ts';
import { PrismaItemCompraRepository } from '../infrastructure/persistence/PrismaItemCompraRepository.ts';
import { PrismaUsuarioRepository } from '../infrastructure/persistence/PrismaUsuarioRepository.ts';
import { buildApp, startServer, type ServerHandle } from '../interface/http/server.ts';
import {
  buildEventDispatcher,
  type EventDispatcherHandle,
} from '../interface/whatsapp/eventDispatcher.ts';

// ── Tipos públicos ─────────────────────────────────────────────────

/** Container de la app, construido una vez al boot. */
export interface AppContainer {
  env: Env;
  logger: Logger;
  prisma: PrismaClientLike;
  whatsappPort: WhatsAppMessagingPort;
  dispatcher: EventDispatcherHandle;
  serverHandle: ServerHandle | null;
  /** Inicia todo: HTTP server + sesión WhatsApp. */
  start(): Promise<void>;
  /** Apaga todo en orden: HTTP server → WhatsApp → Prisma. */
  shutdown(): Promise<void>;
}

/** Opciones del container. */
export interface ContainerOptions {
  /** Env pre-validado. Si no, llama `loadEnv()`. */
  env?: Env;
  /** Logger pre-construido. Si no, llama `buildLogger(env)`. */
  logger?: Logger;
  /** Factory de PrismaClient (default: el singleton de `@compras-whatsapp/db`). */
  prismaFactory?: () => PrismaClientLike | Promise<PrismaClientLike>;
  /** Factory del port de WhatsApp (default: `buildWhatsAppAdapter`). */
  whatsappFactory?: (
    env: Env,
    logger: Logger,
  ) => Promise<WhatsAppMessagingPort>;
  /** Skip del HTTP server (tests). */
  skipHttpServer?: boolean;
  /** Skip de la inicialización de WhatsApp (tests). */
  skipWhatsAppInit?: boolean;
}

// ── Default Prisma factory ────────────────────────────────────────

async function defaultPrismaFactory(): Promise<PrismaClientLike> {
  const m = await import('@compras-whatsapp/db');
  // El `prisma` exportado es el `PrismaClient` real; lo casteamos a
  // `PrismaClientLike` (duck typing). Si en runtime se llama un método
  // no declarado, Prisma lo tendrá y funcionará.
  return m.prisma as unknown as PrismaClientLike;
}

// ── Factory ────────────────────────────────────────────────────────

/**
 * Construye el container completo. NO arranca nada: el caller decide
 * cuándo llamar `start()`. Esto permite tests que construyen el
 * container, validan su shape, y nunca lo bootean.
 */
export async function buildContainer(opts: ContainerOptions = {}): Promise<AppContainer> {
  // 1. Env + logger
  const env = opts.env ?? loadEnv();
  const logger = opts.logger ?? buildLogger(env);

  logger.info(
    {
      env: env.NODE_ENV,
      port: env.PORT,
      sessionPath: env.SESSION_PATH,
      imagesPath: env.IMAGES_PATH,
      logLevel: env.LOG_LEVEL,
    },
    'container: building app',
  );

  // 2. Prisma + repos
  const prisma: PrismaClientLike = opts.prismaFactory
    ? await opts.prismaFactory()
    : await defaultPrismaFactory();

  const conversacionRepo = new PrismaConversacionRepository(prisma);
  const usuarioRepo = new PrismaUsuarioRepository(prisma);
  const compraRepo = new PrismaCompraRepository(prisma);
  // ItemCompra se usa en PR4 (createMany al persistir una Compra).
  // Lo instanciamos acá para que el wiring esté cerrado, aunque
  // HandleIncomingMessage no lo consuma todavía.
  const itemCompraRepo = new PrismaItemCompraRepository(prisma);
  void compraRepo;
  void itemCompraRepo;

  // 3. RateLimiter
  const rateLimiter = new RateLimiter({
    messageMs: env.RATE_LIMIT_MESSAGE_MS,
    imageMs: env.RATE_LIMIT_IMAGE_MS,
    dailyCompras: env.RATE_LIMIT_DAILY_COMPRAS,
  });

  // 4. Whitelist
  const whitelist = new Set(env.OWNER_PHONE_NUMBERS);
  if (whitelist.size === 0) {
    logSecurityEvent(logger, 'unauthorized_access', { reason: 'empty_whitelist' });
    throw new Error('OWNER_PHONE_NUMBERS is empty after validation');
  }

  // 5. Inactivity timeout en ms (env está en minutos para legibilidad)
  const inactivityTimeoutMs = env.INACTIVITY_TIMEOUT_MIN * 60 * 1000;

  // 6. Build WhatsApp port (async) ANTES del dispatcher.
  // Por default usamos `buildWhatsAppAdapter`, que internamente importa
  // `whatsapp-web.js`. Si el caller pasó un `whatsappFactory`, ese
  // recibe el env entero (más flexible para tests).
  const whatsappPort: WhatsAppMessagingPort = opts.whatsappFactory
    ? await opts.whatsappFactory(env, logger)
    : await buildWhatsAppAdapter({ sessionPath: env.SESSION_PATH }, logger);

  // 7. Build dispatcher con el port real.
  const dispatcher = buildEventDispatcher({
    port: whatsappPort,
    config: { imagesPath: env.IMAGES_PATH },
    logger,
    rateLimiter,
    conversacionRepo,
    usuarioRepo,
    whitelist,
    inactivityTimeoutMs,
  });

  // 8. Registrar el handler del dispatcher en el port.
  whatsappPort.onIncomingMessage((msg) => {
    void dispatcher.handle(msg);
  });

  // 9. HTTP server (lazy: solo si no se skipea)
  let serverHandle: ServerHandle | null = null;

  const start = async (): Promise<void> => {
    if (!opts.skipHttpServer) {
      const app = buildApp({ logger, prisma });
      serverHandle = await startServer(app, env.PORT);
      logger.info({ url: serverHandle.url }, 'container: http server listening');
    } else {
      logger.info('container: http server skipped (skipHttpServer=true)');
    }
    if (!opts.skipWhatsAppInit) {
      await whatsappPort.initialize();
      logger.info('container: whatsapp session initialized');
    } else {
      logger.info('container: whatsapp init skipped (skipWhatsAppInit=true)');
    }
  };

  const shutdown = async (): Promise<void> => {
    logger.info('container: shutdown initiated');
    if (serverHandle !== null) {
      await serverHandle.close();
      serverHandle = null;
      logger.info('container: http server closed');
    }
    try {
      await whatsappPort.destroy();
      logger.info('container: whatsapp session destroyed');
    } catch (err) {
      logSecurityEvent(logger, 'send_failed', {
        context: 'whatsapp_destroy',
        err: err instanceof Error ? err.message : String(err),
      });
    }
    // Prisma disconnect: solo si la factory por default lo provee
    if (typeof (prisma as unknown as { $disconnect?: () => Promise<void> }).$disconnect === 'function') {
      await (prisma as unknown as { $disconnect: () => Promise<void> }).$disconnect();
      logger.info('container: prisma disconnected');
    }
  };

  return {
    env,
    logger,
    prisma,
    whatsappPort,
    dispatcher,
    get serverHandle() {
      return serverHandle;
    },
    start,
    shutdown,
  };
}
