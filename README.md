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

## Cómo usar el bot

Una vez que el bot está corriendo (`pnpm dev` o `docker compose up bot`):

1. **Primera vez**: escaneás el QR que aparece en consola con WhatsApp (ver [Cómo escanear QR la primera vez](#cómo-escanear-qr-la-primera-vez)).
2. **Mandás una captura** de tu compra (Temu, AliExpress, Shein, MercadoLibre, etc.).
3. El bot hace OCR y te pregunta: *"Detecté: medias negras, costo lote $1.500. ¿Es correcto?"*
4. Respondés **sí** o **no**. Si sí, te pregunta cantidad, unidad y precio de venta.
5. Al final te muestra un resumen con la ganancia estimada. Confirmás con **sí** y queda guardada.
6. En cualquier momento podés pedirle datos con los [comandos disponibles](#comandos-disponibles).

> El bot **no manda mensajes automáticos a contactos no whitelisted**: solo procesa mensajes de números en `OWNER_PHONE_NUMBERS` (OWASP A01).

## Comandos disponibles

Manda cualquiera de estos en cualquier momento (incluso a mitad de una carga):

| Comando | Ejemplo | Qué hace |
|---------|---------|----------|
| `resumen` | `resumen` | Total del mes: N compras, invertido $X, ganancia potencial $Y. |
| `estadisticas` | `estadisticas` | Totales históricos: N compras, M items, ticket promedio. |
| `ganancias` | `ganancias` | Suma de ganancia potencial acumulada. |
| `productos` | `productos` | Lista de productos únicos cargados con su cantidad de cargas. |
| `stock` | `stock` | Lista de productos únicos con stock total (suma de cantidades). |
| `producto <nombre>` | `producto medias negras` | Detalle de un producto (búsqueda exacta, fallback fuzzy). |
| `compras mes` | `compras mes` | Listado de compras del mes actual con fecha + total. |
| `top ganancias` | `top ganancias` | Top 5 items por ganancia unitaria (cross-usuario). |
| `cancelar` | `cancelar` | Cancela la operación en curso y vuelve al estado inicial. |
| `menu` | `menu` | Vuelve al estado inicial sin cancelar la conversación. |

Si mandás un texto que no matchea ningún comando, el bot te contesta: *"No entendí. Comandos: resumen, estadisticas, ..."*.

## Cómo escanear QR la primera vez

> [Screenshot del QR en consola iria aqui]

1. Levantá el bot con `docker compose up bot` o `pnpm dev`.
2. En la consola aparece un QR en formato ASCII. El bot loggea `whatsapp_qr_ready` cuando lo emite.
3. Abrí WhatsApp en tu celular → ⋮ Menú → **Dispositivos vinculados** → **Vincular un dispositivo**.
4. Apuntá la cámara al QR de la consola.
5. La sesión queda guardada en `apps/bot/data/session/` y persiste entre reinicios (`whatsapp_session_restored`).

## Troubleshooting OCR

Si el bot te dice *"No pude leer bien la imagen"* o *"No detecté un producto claro"*:

- **Captura más recortada**: que se vea solo el producto, precio y cantidad — sin barras de navegación ni teclado.
- **Buena iluminación**: capturas con flash o luz directa funcionan mejor. Tesseract es sensible a sombras.
- **Letra legible**: si el precio está en una fuente muy decorativa, probá sacando foto con zoom.
- **Formato estándar**: `producto`, `$1.500` o `AR$ 1.500`, `12 unidades` (en ese orden). El parser busca estas tres cosas.
- **Si el OCR sigue fallando**, podés cargar manualmente contestando "no" cuando te pregunta si el producto detectado es correcto y tipeando los datos a mano.

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
