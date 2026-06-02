/**
 * @compras-whatsapp/bot — HTTP server (health/ready endpoints).
 *
 * POR QUÉ EXISTE: en producción (Docker, k8s, etc.) el orquestador
 * necesita saber si el bot está vivo y si puede recibir tráfico. Los
 * endpoints estándar de k8s son `/health` (liveness — estoy vivo?) y
 * `/ready` (readiness — puedo servir?). En MVP usamos los mismos
 * nombres aunque no haya k8s: así migrar a k8s es trivial.
 *
 * SEGURIDAD (OWASP A05):
 *   - Helmet aplica headers default (X-Content-Type-Options,
 *     X-Frame-Options, etc.). NO configuramos CSP agresivo porque
 *     el server no sirve HTML.
 *   - `/health` y `/ready` son públicos (sin auth): k8s los llama
 *     sin credenciales. No exponen información sensible.
 *   - Body size limit 1kb: el bot no recibe requests con body.
 *     Defensa contra slow-loris y DoS básico.
 *
 * DISEÑO:
 *   - `app` es el Express app puro, testeable con supertest.
 *   - `startServer(app, port)` lo pone a escuchar, devuelve handle
 *     para `close()`.
 *   - El container (task 3.10) es el único que llama a startServer
 *     y maneja SIGTERM/SIGINT para cerrar limpiamente.
 */

import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';

import { logSecurityEvent } from '../../infrastructure/logging/logger.ts';
import type { PrismaClientLike } from '../../infrastructure/persistence/PrismaClientLike.ts';

// ── Tipos ─────────────────────────────────────────────────────────

/** Resultado de un readiness check. */
export interface ReadinessCheck {
  /** Nombre del check (e.g. "database"). */
  name: string;
  /** True si pasó. */
  ok: boolean;
  /** Latencia en ms. */
  latencyMs: number;
  /** Mensaje de error opcional. */
  error?: string;
}

/** Dependencias del server. */
export interface HttpServerDeps {
  logger: Logger;
  /** Prisma para el check de DB en /ready. */
  prisma: PrismaClientLike;
  /** Función que devuelve la fecha actual (clock, para tests). */
  clock?: () => Date;
}

export interface ServerHandle {
  /** URL del server (e.g. `http://0.0.0.0:3000`). */
  url: string;
  /** Cierra el server (graceful). */
  close(): Promise<void>;
}

// ── App factory ───────────────────────────────────────────────────

/**
 * Construye la app de Express con los endpoints.
 * NO escucha: para eso está `startServer`.
 */
export function buildApp(deps: HttpServerDeps): Express {
  const { logger, prisma, clock = () => new Date() } = deps;
  const startTime = clock().getTime();

  const app = express();
  app.disable('x-powered-by'); // OWASP: no leak stack
  app.use(helmet()); // A05: headers default seguros
  app.use(express.json({ limit: '1kb' })); // body size cap defensivo

  // ── /health: liveness ────────────────────────────────────────
  // ¿Estoy vivo? Siempre 200 mientras el proceso corra. No depende
  // de Prisma ni de WhatsApp: si la DB está caída pero el proceso
  // corre, k8s NO debe matarme — solo dejar de mandarme tráfico.
  app.get('/health', (_req: Request, res: Response) => {
    const uptimeMs = clock().getTime() - startTime;
    res.status(200).json({
      status: 'ok',
      service: 'sgcw-bot',
      uptimeMs,
      timestamp: clock().toISOString(),
    });
  });

  // ── /ready: readiness ────────────────────────────────────────
  // ¿Puedo servir tráfico? Aquí sí chequeamos dependencias. Si la
  // DB no responde, devolvemos 503 y k8s me saca del load balancer.
  app.get('/ready', async (_req: Request, res: Response) => {
    const checks: ReadinessCheck[] = [];

    // Check 1: Database (Prisma ping)
    const dbStart = clock().getTime();
    try {
      // `findFirst` con `select: { id: true }` es la forma más barata
      // de confirmar que la conexión funciona. NO usamos `$queryRaw`
      // porque añade un round-trip extra al parser SQL.
      await prisma.usuario.findFirst({ select: { id: true } });
      checks.push({ name: 'database', ok: true, latencyMs: clock().getTime() - dbStart });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      checks.push({
        name: 'database',
        ok: false,
        latencyMs: clock().getTime() - dbStart,
        error: errMsg,
      });
      logSecurityEvent(logger, 'send_failed', { check: 'database', err: errMsg });
    }

    const allOk = checks.every((c) => c.ok);
    res.status(allOk ? 200 : 503).json({
      status: allOk ? 'ready' : 'not_ready',
      service: 'sgcw-bot',
      timestamp: clock().toISOString(),
      checks,
    });
  });

  // ── 404 fallback ─────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  // ── Error handler (último middleware) ─────────────────────────
  app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: express.NextFunction) => {
    // body-parser errors: body > 1kb → 413; JSON inválido → 400.
    if (err.type === 'entity.too.large') {
      res.status(413).json({ error: 'payload_too_large' });
      return;
    }
    if (err.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }
    logger.error(
      { err: err.message, stack: err.stack },
      'http: unhandled error in request',
    );
    res.status(500).json({ error: 'internal_server_error' });
  });

  return app;
}

// ── Server lifecycle ──────────────────────────────────────────────

/**
 * Pone la app a escuchar en `port`. Devuelve un handle para shutdown.
 *
 * `host: '0.0.0.0'` para que Docker pueda reach-ear el server
 * desde fuera del container. En dev, `localhost` también funciona.
 */
export async function startServer(
  app: Express,
  port: number,
  host = '0.0.0.0',
): Promise<ServerHandle> {
  return new Promise<ServerHandle>((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const addr = server.address();
      const url =
        typeof addr === 'object' && addr !== null ? `http://${addr.address}:${addr.port}` : '';
      resolve({
        url,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => {
              if (err !== undefined) rej(err);
              else res();
            });
          }),
      });
    });
    server.once('error', reject);
  });
}
