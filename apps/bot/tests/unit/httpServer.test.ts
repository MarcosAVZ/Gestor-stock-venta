/**
 * Tests del HTTP server.
 *
 * Cubrimos:
 *   1. GET /health → 200, status ok, uptimeMs >= 0, service name
 *   2. GET /ready con Prisma OK → 200, status ready
 *   3. GET /ready con Prisma DOWN → 503, status not_ready
 *   4. GET /unknown → 404 JSON
 *   5. Helmet headers presentes (X-Content-Type-Options)
 *   6. x-powered-by header removido
 *   7. JSON body parser acepta <1kb; rechaza >1kb (413)
 *   8. startServer() / close() lifecycle
 */

import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Logger } from 'pino';

import { buildApp, startServer } from '../../src/interface/http/server.ts';
import type { PrismaClientLike } from '../../src/infrastructure/persistence/PrismaClientLike.ts';

// ── Helpers ───────────────────────────────────────────────────────

function silentLogger(): Logger {
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

interface MockPrisma {
  usuario: { findFirst: ReturnType<typeof vi.fn> };
}

function buildMockPrisma(throws: Error | null = null): MockPrisma {
  const findFirst = vi.fn(async () => {
    if (throws !== null) throw throws;
    return { id: 'u-1' };
  });
  return { usuario: { findFirst } } as unknown as MockPrisma;
}

function buildDeps(prisma: MockPrisma, clock?: () => Date) {
  return {
    logger: silentLogger(),
    prisma: prisma as unknown as PrismaClientLike,
    ...(clock !== undefined ? { clock } : {}),
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('buildApp', () => {
  describe('GET /health', () => {
    it('returns 200 with status ok', async () => {
      const prisma = buildMockPrisma();
      const app = buildApp(buildDeps(prisma));
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('sgcw-bot');
      expect(typeof res.body.uptimeMs).toBe('number');
      expect(res.body.uptimeMs).toBeGreaterThanOrEqual(0);
    });

    it('does NOT touch Prisma (liveness != readiness)', async () => {
      const prisma = buildMockPrisma(new Error('down'));
      const app = buildApp(buildDeps(prisma));
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(prisma.usuario.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('GET /ready', () => {
    it('returns 200 ready when Prisma responds', async () => {
      const prisma = buildMockPrisma();
      const app = buildApp(buildDeps(prisma));
      const res = await request(app).get('/ready');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      expect(res.body.checks).toEqual([
        expect.objectContaining({ name: 'database', ok: true }),
      ]);
    });

    it('returns 503 not_ready when Prisma throws', async () => {
      const prisma = buildMockPrisma(new Error('connection refused'));
      const app = buildApp(buildDeps(prisma));
      const res = await request(app).get('/ready');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('not_ready');
      expect(res.body.checks[0].ok).toBe(false);
      expect(res.body.checks[0].error).toContain('connection refused');
    });
  });

  describe('OWASP security headers', () => {
    it('sets X-Content-Type-Options: nosniff via helmet', async () => {
      const prisma = buildMockPrisma();
      const app = buildApp(buildDeps(prisma));
      const res = await request(app).get('/health');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('removes X-Powered-By header (no stack leak)', async () => {
      const prisma = buildMockPrisma();
      const app = buildApp(buildDeps(prisma));
      const res = await request(app).get('/health');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('unknown routes', () => {
    it('returns 404 JSON for unknown paths', async () => {
      const prisma = buildMockPrisma();
      const app = buildApp(buildDeps(prisma));
      const res = await request(app).get('/admin');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
    });
  });

  describe('body size limit', () => {
    it('rejects JSON body > 1kb with 413', async () => {
      const prisma = buildMockPrisma();
      const app = buildApp(buildDeps(prisma));
      const huge = { data: 'x'.repeat(2000) };
      const res = await request(app).post('/health').send(huge);
      expect(res.status).toBe(413);
    });
  });
});

describe('startServer lifecycle', () => {
  it('listens on the given port and closes cleanly', async () => {
    const prisma = buildMockPrisma();
    const app = buildApp(buildDeps(prisma));
    const handle = await startServer(app, 0); // port 0 = ephemeral
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$|^http:\/\/0\.0\.0\.0:\d+$/);

    // Hacer un request real para confirmar que escucha
    const res = await fetch(`${handle.url}/health`);
    expect(res.status).toBe(200);

    await handle.close();
  });

  it('rejects on port-in-use error', async () => {
    const prisma = buildMockPrisma();
    const app1 = buildApp(buildDeps(prisma));
    const handle1 = await startServer(app1, 0);
    const port = new URL(handle1.url).port;

    const app2 = buildApp(buildDeps(prisma));
    await expect(startServer(app2, Number(port))).rejects.toBeDefined();

    await handle1.close();
  });
});

// Sanity check: keep the import live to avoid TS6133 if `express` is unused
void express;
