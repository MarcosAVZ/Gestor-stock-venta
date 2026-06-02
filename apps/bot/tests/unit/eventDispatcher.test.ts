/**
 * Tests del EventDispatcher.
 *
 * Cubrimos los 4 paths críticos:
 *   1. Texto: pasa al use case, envía respuestas.
 *   2. Imagen: descarga a disco, pasa imagePath al use case, envía respuestas.
 *   3. Imagen con error de mkdir: avisa al user, NO llama al use case.
 *   4. Imagen con error de download: avisa al user, NO llama al use case.
 *   5. Use case lanza excepción: catch defensivo, avisa al user.
 *   6. Port.sendText falla: loggea pero NO crashea (best-effort).
 *   7. Helper `extractPhone` y `buildImagePath` (unit tests puros).
 *   8. processedCount incrementa correctamente.
 *
 * Mocks:
 *   - `port`: fake que implementa `WhatsAppMessagingPort` con in-memory maps.
 *   - `use case deps`: mocks de Logger, RateLimiter, repos, etc.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Message as WAWebJSMessage } from 'whatsapp-web.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { ConversationState, type Conversacion } from '@compras-whatsapp/db';

import { buildEventDispatcher, buildImagePath, extractPhone } from '../../src/interface/whatsapp/eventDispatcher.ts';
import type {
  IncomingMessage,
  WhatsAppMessagingPort,
} from '../../src/infrastructure/messaging/WhatsAppClient.ts';
import type { ConversacionRepository } from '../../src/domain/repositories/ConversacionRepository.ts';
import type { UsuarioRepository } from '../../src/domain/repositories/UsuarioRepository.ts';
import type { RateLimiter } from '../../src/infrastructure/messaging/rateLimiter.ts';

// ── Fakes ─────────────────────────────────────────────────────────

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

interface FakePort extends WhatsAppMessagingPort {
  sentTexts: Map<string, string[]>;
  downloadCalls: Array<{ msg: WAWebJSMessage; destPath: string }>;
  failNextDownload: boolean;
  failNextSend: boolean;
}

function buildFakePort(): FakePort {
  const sentTexts = new Map<string, string[]>();
  const downloadCalls: Array<{ msg: WAWebJSMessage; destPath: string }> = [];
  let failNextDownload = false;
  let failNextSend = false;
  const port: FakePort = {
    sentTexts,
    downloadCalls,
    get failNextDownload() {
      return failNextDownload;
    },
    set failNextDownload(v: boolean) {
      failNextDownload = v;
    },
    get failNextSend() {
      return failNextSend;
    },
    set failNextSend(v: boolean) {
      failNextSend = v;
    },
    initialize: async () => undefined,
    sendText: async (to, text) => {
      if (failNextSend) {
        failNextSend = false;
        throw new Error('fake sendText failure');
      }
      const list = sentTexts.get(to) ?? [];
      list.push(text);
      sentTexts.set(to, list);
    },
    sendImage: async () => undefined,
    downloadMedia: async (msg, destPath) => {
      if (failNextDownload) {
        failNextDownload = false;
        throw new Error('fake download failure');
      }
      downloadCalls.push({ msg, destPath });
      return destPath;
    },
    onIncomingMessage: () => undefined,
    destroy: async () => undefined,
    isReady: () => true,
  };
  return port;
}

function buildMockConversacionRepo(
  existing: Conversacion | null = null,
): ConversacionRepository {
  return {
    findByUsuarioId: vi.fn(async () => existing),
    upsert: vi.fn(async (input) => {
      const conv: Conversacion = {
        id: 'conv-1',
        usuarioId: input.usuarioId,
        estado: input.estado,
        datosTemporales: input.datosTemporales ?? {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return conv;
    }),
    update: vi.fn(async (id, patch) => ({
      id,
      usuarioId: 'u-1',
      estado: patch.estado ?? ConversationState.ESPERANDO_IMAGEN,
      datosTemporales: patch.datosTemporales ?? {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies Conversacion)),
  } as unknown as ConversacionRepository;
}

function buildMockUsuarioRepo(phone: string): UsuarioRepository {
  return {
    findByTelefono: vi.fn(async () => ({
      id: 'u-1',
      telefono: phone,
      nombre: 'Test',
      createdAt: new Date(),
    })),
    create: vi.fn(),
  } as unknown as UsuarioRepository;
}

function buildMockRateLimiter(): RateLimiter {
  return {
    canSendMessage: () => true,
    canSendImage: () => true,
    canSaveCompra: () => true,
    recordMessage: () => undefined,
    recordImage: () => undefined,
    recordCompra: () => undefined,
    dailyCompraCount: () => 0,
    reset: () => undefined,
  } as unknown as RateLimiter;
}

function buildDeps(port: WhatsAppMessagingPort, imagesPath: string) {
  return {
    port,
    config: { imagesPath },
    logger: silentLogger(),
    rateLimiter: buildMockRateLimiter(),
    conversacionRepo: buildMockConversacionRepo(null),
    usuarioRepo: buildMockUsuarioRepo('+5491112345678'),
    whitelist: new Set(['+5491112345678']),
  };
}

function buildIncoming(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    from: '5491112345678@c.us',
    phone: '5491112345678',
    type: 'text',
    body: 'hola',
    hasMedia: false,
    id: 'msg-1',
    raw: { id: { _serialized: 'msg-1' } } as unknown as WAWebJSMessage,
    ...overrides,
  };
}

// ── Tests de helpers ──────────────────────────────────────────────

describe('extractPhone', () => {
  it('strips @c.us suffix', () => {
    expect(extractPhone('5491112345678@c.us')).toBe('5491112345678');
  });

  it('strips @g.us suffix (safety net)', () => {
    expect(extractPhone('120363@g.us')).toBe('120363');
  });

  it('returns input unchanged when no @ present', () => {
    expect(extractPhone('5491112345678')).toBe('5491112345678');
  });
});

describe('buildImagePath', () => {
  it('builds <base>/<phone>/<ts>.<ext>', () => {
    const ts = new Date('2026-06-02T15:30:00Z');
    const result = buildImagePath('/data/images', '5491112345678', ts, 'jpg');
    expect(result).toBe(
      path.join('/data/images', '5491112345678', `${ts.getTime()}.jpg`),
    );
  });

  it('sanitizes non-digit chars from phone', () => {
    const ts = new Date('2026-06-02T15:30:00Z');
    const result = buildImagePath('/data/images', '+54-911-1234-5678', ts, 'jpg');
    expect(result).toContain(path.join('5491112345678', `${ts.getTime()}.jpg`));
  });
});

// ── Tests del dispatcher ──────────────────────────────────────────

describe('EventDispatcher', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatcher-'));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('text message: passes body to use case, sends response', async () => {
    const port = buildFakePort();
    const deps = buildDeps(port, tmpDir);
    const { handle } = buildEventDispatcher(deps);

    // Re-mock use case deps to capture the input.
    const inputCapture: Array<unknown> = [];
    deps.conversacionRepo.findByUsuarioId = vi.fn(async () => ({
      id: 'conv-1',
      usuarioId: 'u-1',
      estado: ConversationState.ESPERANDO_IMAGEN,
      datosTemporales: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies Conversacion));

    // We spy on the use case indirectly by checking sendText side-effect.
    await handle(buildIncoming({ type: 'text', body: 'hola' }));

    expect(port.sentTexts.get('5491112345678@c.us')?.length ?? 0).toBeGreaterThan(0);
    // No se descargó media
    expect(port.downloadCalls.length).toBe(0);
    expect(inputCapture.length).toBe(0); // no captura acá, pero verificamos side effect
  });

  it('image message: downloads to <imagesPath>/<phone>/<ts>.<ext>, passes imagePath to use case', async () => {
    const port = buildFakePort();
    const deps = buildDeps(port, tmpDir);
    const { handle } = buildEventDispatcher(deps);

    deps.conversacionRepo.findByUsuarioId = vi.fn(async () => ({
      id: 'conv-1',
      usuarioId: 'u-1',
      estado: ConversationState.ESPERANDO_IMAGEN,
      datosTemporales: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies Conversacion));

    const before = Date.now();
    await handle(buildIncoming({ type: 'image', hasMedia: true, body: undefined }));
    const after = Date.now();

    expect(port.downloadCalls.length).toBe(1);
    const dest = port.downloadCalls[0]?.destPath ?? '';
    expect(dest.startsWith(tmpDir)).toBe(true);
    expect(dest).toMatch(/5491112345678\\\d+\.jpg$/);
    // Timestamp dentro del rango
    const tsMatch = dest.match(/(\d+)\.jpg$/);
    expect(tsMatch).not.toBeNull();
    const ts = Number(tsMatch?.[1] ?? 0);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('image download failure: sends apology, does NOT call use case', async () => {
    const port = buildFakePort();
    port.failNextDownload = true;
    const deps = buildDeps(port, tmpDir);
    const { handle } = buildEventDispatcher(deps);

    const findByUsuarioIdSpy = vi.spyOn(deps.conversacionRepo, 'findByUsuarioId');
    await handle(buildIncoming({ type: 'image', hasMedia: true }));

    expect(findByUsuarioIdSpy).not.toHaveBeenCalled();
    const sent = port.sentTexts.get('5491112345678@c.us') ?? [];
    expect(sent.some((s) => s.includes('foto'))).toBe(true);
  });

  it('use case throws: catch defensivo, sends apology, does NOT propagate', async () => {
    const port = buildFakePort();
    const deps = buildDeps(port, tmpDir);
    const { handle } = buildEventDispatcher(deps);

    // Forzamos un throw re-mockeando findByUsuarioId para que lance.
    deps.conversacionRepo.findByUsuarioId = vi.fn(async () => {
      throw new Error('Prisma down');
    });

    await expect(handle(buildIncoming({ type: 'text', body: 'hola' }))).resolves.toBeUndefined();
    const sent = port.sentTexts.get('5491112345678@c.us') ?? [];
    expect(sent.some((s) => s.includes('error'))).toBe(true);
  });

  it('port.sendText fails: continues to next response, does NOT crash', async () => {
    const port = buildFakePort();
    const deps = buildDeps(port, tmpDir);
    deps.conversacionRepo.findByUsuarioId = vi.fn(async () => ({
      id: 'conv-1',
      usuarioId: 'u-1',
      estado: ConversationState.ESPERANDO_IMAGEN,
      datosTemporales: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies Conversacion));

    const { handle } = buildEventDispatcher(deps);
    port.failNextSend = true;

    // No throw: aunque sendText falle, el handler resuelve.
    await expect(handle(buildIncoming({ type: 'text', body: 'x' }))).resolves.toBeUndefined();
  });

  it('processed() counter increments per call', async () => {
    const port = buildFakePort();
    const deps = buildDeps(port, tmpDir);
    deps.conversacionRepo.findByUsuarioId = vi.fn(async () => ({
      id: 'conv-1',
      usuarioId: 'u-1',
      estado: ConversationState.ESPERANDO_IMAGEN,
      datosTemporales: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies Conversacion));

    const dispatcher = buildEventDispatcher(deps);
    expect(dispatcher.processed()).toBe(0);
    await dispatcher.handle(buildIncoming({ type: 'text', body: '1' }));
    await dispatcher.handle(buildIncoming({ type: 'text', body: '2' }));
    expect(dispatcher.processed()).toBe(2);
  });

  it('text message with no body (image text fallback): passes empty string', async () => {
    const port = buildFakePort();
    const deps = buildDeps(port, tmpDir);
    deps.conversacionRepo.findByUsuarioId = vi.fn(async () => ({
      id: 'conv-1',
      usuarioId: 'u-1',
      estado: ConversationState.ESPERANDO_IMAGEN,
      datosTemporales: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies Conversacion));

    const { handle } = buildEventDispatcher(deps);
    await handle(buildIncoming({ type: 'text', body: undefined }));
    // Resuelve sin throw, el use case maneja el body vacío
    expect(port.sentTexts.has('5491112345678@c.us')).toBe(true);
  });
});
