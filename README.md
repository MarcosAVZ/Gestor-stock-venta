# Sistema de Gestión de Compras WhatsApp

Bot de WhatsApp que registra compras mayoristas (Temu, AliExpress, Shein, Mercado Libre, etc.) a partir de capturas de pantalla. Reemplaza el registro manual: el operador manda la captura por WhatsApp, el bot hace OCR on-device, valida con el usuario en una conversación paso a paso, calcula costos y márgenes, y guarda todo en PostgreSQL. Después podés consultar por chat (`resumen`, `ganancias`, `stock`, `top ganancias`, etc.).

> **Costo $0, sin servicios pagos.** Todo corre en tu PC con Docker. Ningún componente usa APIs pagas (no hay Google Vision, no hay Meta Cloud, no hay nada cloud). Stack 100% open-source self-hosted.

## Estado del proyecto

**MVP en desarrollo** dividido en 6 PRs encadenados:

| PR | Branch | Qué trae |
|----|--------|----------|
| PR1 | `pr/01-monorepo-docker` | Este PR — monorepo + Docker Compose + Postgres |
| PR2 | `pr/02-prisma-db` | Prisma schema + repos + tests |
| PR3 | `pr/03-bot-state-machine` | Cliente WhatsApp + state machine + logger |
| PR4 | `pr/04-ocr-pipeline` | OCR con Tesseract + sharp + parser |
| PR5 | `pr/05-conversation-queries` | Flujo conversacional + 8 comandos de consulta |
| PR6 | `pr/06-tracker-merge` | Integración a `main` + tag `v0.1.0-mvp` |

## Requisitos

- **Node.js 22 LTS** (mínimo `22.6.0` por type stripping de TypeScript). Verificá con `node --version`.
- **pnpm 9+** (recomendado: activá con `corepack enable && corepack prepare pnpm@latest --activate`).
- **Docker Desktop** (o Docker Engine + Compose v2 en Linux).
- **Git 2.30+**.
- 4 GB de RAM libres (el OCR de Tesseract consume ~200-500 MB por imagen).
- Conexión a internet la primera vez (descarga la imagen de Postgres y — en PR3 — Tesseract).

## Stack

| Capa | Tecnología |
|------|------------|
| Runtime | Node.js 22 LTS |
| Lenguaje | TypeScript strict con type stripping (sin build step) |
| DB | PostgreSQL 16 |
| ORM | Prisma (en PR2) |
| Validación | Zod |
| Logs | Pino (con redact de PII) |
| Bot | whatsapp-web.js (PR3) |
| OCR | Tesseract.js + sharp (PR4) |
| Container | Docker + docker compose v2 |
| Monorepo | pnpm workspaces |
| Tests | vitest |

## Setup rápido

```bash
# 1. Clonar (cuando haya remote)
git clone <repo>
cd "Sistema de Gestión de Compras WhatsApp"

# 2. Habilitar pnpm
corepack enable
corepack prepare pnpm@latest --activate

# 3. Instalar dependencias del workspace
pnpm install

# 4. Configurar variables de entorno
cp .env.example .env
# Editá .env y completá:
#   - DB_PASSWORD (generala con: openssl rand -hex 24)
#   - OWNER_PHONE_NUMBERS (formato E.164: +5491112345678)

# 5. Levantar Postgres
docker compose up -d postgres

# 6. Verificar que está healthy
docker compose ps
# postgres debe estar en estado "healthy"
```

A partir de acá, las próximas dependencias y comandos se van agregando en cada PR.

## Estructura del monorepo

```
.
├── apps/
│   ├── bot/                       # Backend (WhatsApp + Express) - vacío en PR1
│   ├── data/                      # Volumen Docker (sesión + imágenes, gitignored)
│   └── web/                       # Dashboard React (Fase 2) - placeholder
├── packages/
│   ├── db/                        # Prisma schema + client (PR2)
│   └── shared/                    # Zod schemas, tipos, constantes (PR3+)
├── docker-compose.yml             # Postgres + (en PR3) bot
├── .env.example                   # Documentado
├── package.json                   # Scripts globales del workspace
├── pnpm-workspace.yaml
├── tsconfig.base.json             # TypeScript strict
├── vitest.config.ts               # Runner de tests
└── eslint.config.js               # Flat config
```

## Comandos disponibles

| Comando | Qué hace |
|---------|----------|
| `pnpm install` | Instala deps del workspace y todos los paquetes |
| `pnpm typecheck` | Corre `tsc --noEmit` en cada workspace |
| `pnpm test` | Corre `vitest` en cada workspace |
| `pnpm test:coverage` | Igual + reporte de coverage (v8) |
| `pnpm lint` | Corre ESLint en cada workspace |
| `pnpm format` | Aplica Prettier |
| `pnpm dev` | Levanta el bot en modo watch (disponible desde PR3) |
| `pnpm build` | Build de cada workspace (TS no requiere build por type stripping; usado solo para assets) |
| `docker compose up -d` | Levanta Postgres |
| `docker compose down` | Para Postgres (preserva datos en el volumen) |
| `docker compose down -v` | Para Postgres **y borra el volumen** (DB limpia) |
| `docker compose logs -f postgres` | Tail de logs |

## Filosofía de arquitectura

- **Clean Architecture** en `apps/bot`: `domain` (entidades puras, sin libs externas) → `application` (casos de uso) → `infrastructure` (adapters de Prisma, WhatsApp, OCR) → `interfaces` (handlers de comandos, message router).
- **TypeScript con type stripping nativo** (Node 22.6+): cero build step. Los `.ts` se ejecutan directo.
- **Pino con redact de PII**: `phone`, `body`, `imageUrl` nunca aparecen en logs (OWASP A05).
- **Whitelist estricta** por `OWNER_PHONE_NUMBERS` (OWASP A01). Respuesta genérica "no autorizado" para números fuera de la lista — ni siquiera se loggea el cuerpo del mensaje.
- **Rate limiting**: 1 imagen cada 10s por usuario, máximo 30 compras por día (OWASP A04).
- **Graceful shutdown**: SIGTERM/SIGINT → deja de aceptar mensajes → drena workers OCR → cierra Prisma → exit code 0.
- **Sin servicios pagos**: todo on-device, todo open-source, todo reproducible con `docker compose up`.

## Troubleshooting

### `pnpm install` falla con "EACCES" o "permission denied"

En Linux/macOS nunca uses `sudo pnpm install`. Si ves errores de permisos es porque `node_modules` tiene dueño equivocado:

```bash
sudo chown -R $USER:$USER .
rm -rf node_modules
pnpm install
```

### `docker compose up` falla con "port 5432 already in use"

Tenés Postgres nativo corriendo. O paralo (`sudo service postgresql stop` en Linux) o cambiá `POSTGRES_PORT` en `.env`.

### `pnpm typecheck` dice "No projects matched the filters"

Es normal si todavía no hay paquetes en `apps/*` o `packages/*`. Apenas exista uno, el comando correrá en cada workspace. Para verificar el root podés usar `pnpm exec tsc --noEmit -p tsconfig.base.json`.

### El volumen `pgdata` no se borra con `docker compose down`

Es by design — tus datos persisten. Para reset total: `docker compose down -v`. **Esto borra la DB**.

### Quiero empezar desde cero (DB + dependencias + lockfile)

```bash
docker compose down -v
rm -rf node_modules pnpm-lock.yaml
pnpm install
cp .env.example .env
# editá .env
docker compose up -d postgres
```

## Licencia

MIT (a confirmar con el dueño del comercio).
