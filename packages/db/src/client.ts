/**
 * @compras-whatsapp/db — PrismaClient singleton.
 *
 * Exporta una instancia única de PrismaClient configurada con logging
 * adaptativo al entorno:
 * - development: muestra query + params + duración (para debug)
 * - test: solo warnings y errores
 * - production: solo errores
 *
 * En tests con `vi.mock` el `PrismaClient` real no se instancia; en ese
 * caso los repos reciben un mock del client y este módulo no se importa.
 *
 * El singleton vive en module scope para que hot-reload (`tsx watch`) no
 * cree múltiples conexiones; `globalThis.__prismaClient` evita el leak
 * durante el dev server.
 */

import { PrismaClient, type Prisma } from '@prisma/client';

const NODE_ENV = process.env['NODE_ENV'] ?? 'development';

const logLevels: Prisma.LogLevel[] =
  NODE_ENV === 'production'
    ? ['error']
    : NODE_ENV === 'test'
      ? ['warn', 'error']
      : ['query', 'warn', 'error'];

// Reutiliza la instancia en HMR para no abrir múltiples pools.
const globalForPrisma = globalThis as unknown as {
  __prismaClient?: PrismaClient;
};

export const prisma: PrismaClient =
  globalForPrisma.__prismaClient ??
  new PrismaClient({
    log: logLevels.map((level) =>
      level === 'query'
        ? { emit: 'event', level: 'query' }
        : { emit: 'stdout', level },
    ),
  });

if (NODE_ENV !== 'production') {
  globalForPrisma.__prismaClient = prisma;
}

/**
 * Helper para desconectar limpiamente. Usado por graceful shutdown del bot
 * (PR3) y por el seed script al terminar.
 */
export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
