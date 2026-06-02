# Quickstart — Sistema de Gestión de Compras WhatsApp

Guía paso a paso para arrancar el bot desde cero, en menos de 15 minutos. Asume Windows / macOS / Linux con Docker Desktop instalado.

> **TL;DR**: `corepack enable && pnpm install && docker compose up -d postgres && pnpm --filter @compras-whatsapp/db prisma:migrate && pnpm dev` → escaneás QR → mandás una captura.

---

## 1. Prerrequisitos

Antes de empezar, asegurate de tener:

| Tool           | Versión mínima | Cómo verificar                                     |
| -------------- | -------------- | -------------------------------------------------- |
| Node.js        | 22.6.0 LTS     | `node --version`                                   |
| pnpm           | 9.0.0          | `pnpm --version`                                   |
| Docker Desktop | 4.x            | `docker --version`                                 |
| Git            | 2.30+          | `git --version`                                    |
| RAM libre      | 4 GB           | El OCR de Tesseract consume ~200-500 MB por imagen |

### 1.1 Instalar Node.js 22 LTS

- **Windows / macOS**: bajá el instalador de <https://nodejs.org/en/download>.
- **Linux**: usá `nvm` (`nvm install 22 && nvm use 22`) o el package manager de tu distro.

Verificá: `node --version` debe devolver `v22.x.x` o superior.

### 1.2 Instalar pnpm 9

pnpm se gestiona con `corepack`, que viene con Node 22:

```bash
corepack enable
corepack prepare pnpm@latest --activate
pnpm --version
```

Si ya tenías pnpm instalado y querés forzar la versión del repo, corré `corepack prepare pnpm@9.15.0 --activate` (la `packageManager` declarada en `package.json`).

### 1.3 Instalar Docker Desktop

- **Windows / macOS**: <https://www.docker.com/products/docker-desktop/>.
- **Linux**: instalá `docker-ce` + `docker-compose-plugin` (Docker Engine, NO Docker Desktop).

Verificá: `docker compose version` debe devolver `v2.x.x` o superior.

---

## 2. Clonar el repositorio

```bash
git clone <url-del-repo>
cd "Sistema de Gestión de Compras WhatsApp"
```

(El nombre del directorio tiene tildes y espacios — andá con cuidado si copiás paths a mano.)

---

## 3. Instalar dependencias del workspace

```bash
pnpm install
```

Esto resuelve todos los workspaces (`apps/bot`, `apps/web`, `packages/db`, `packages/shared`) y popula `node_modules` en la raíz + en cada workspace.

> Si ves warnings sobre `deprecated` (puppeteer, supertest, etc.) es **normal** — son deps transitivas de `whatsapp-web.js` que se resolvieron correctamente.

---

## 4. Configurar variables de entorno

```bash
cp .env.example .env
```

Editá `.env` con tus valores reales:

```env
# Postgres (defaults OK para dev)
POSTGRES_USER=sgcw
POSTGRES_DB=sgcw
POSTGRES_PORT=5432

# Generá uno con: openssl rand -hex 24
DB_PASSWORD=<pegar-acá-el-output>

# Connection string (host = postgres cuando corre en docker, localhost si lo corrés nativo)
DATABASE_URL=postgresql://sgcw:<db-password>@localhost:5432/sgcw

# Tu número de WhatsApp en formato E.164 (código país + número, sin espacios)
# Ejemplo Argentina: +5491112345678
OWNER_PHONE_NUMBERS=+5491112345678

# OCR (defaults OK)
TESSDATA_PATH=/usr/share/tesseract-ocr/4.00/tessdata/
OCR_CONCURRENCY=2
OCR_TIMEOUT_MS=30000
```

> **IMPORTANTE**: `.env` está en `.gitignore`. NUNCA lo commitees. Subílo a tu gestor de secretos (1Password, Bitwarden, etc.) y regenerá el `DB_PASSWORD` si se filtra.

---

## 5. Levantar Postgres

```bash
docker compose up -d postgres
```

Verificá que está healthy:

```bash
docker compose ps
# NAME              STATUS          PORTS
# sgcw-postgres     Up (healthy)    0.0.0.0:5432->5432/tcp
```

Si dice `Up (health: starting)`, esperá 5-10 segundos y volvé a chequear. Si dice `unhealthy` o `restarting`, mirá los logs:

```bash
docker compose logs postgres
```

El problema más común es que el puerto 5432 ya está en uso por otro Postgres. Solución: cambiá `POSTGRES_PORT` en `.env` (ej. `5433`).

---

## 6. Correr migraciones de Prisma

```bash
pnpm --filter @compras-whatsapp/db prisma:migrate
```

Esto crea las 4 tablas (`Usuario`, `Compra`, `ItemCompra`, `Conversacion`), el índice GIN y habilita la extensión `pg_trgm`.

Para resetear la DB (borrar todas las tablas y volver a migrar):

```bash
docker compose down -v    # borra el volumen pgdata
docker compose up -d postgres
pnpm --filter @compras-whatsapp/db prisma:migrate
```

---

## 7. Arrancar el bot

```bash
pnpm dev
```

(o equivalentemente `pnpm --filter @compras-whatsapp/bot dev`).

La primera vez vas a ver un QR en la consola, similar a:

```
[17:23:45.123] INFO (bot/16631): event=whatsapp_qr_ready
     █▀▀▀▀▀█  █ █▀█ █▀▀▀▀▀█
     █ ███ █  ▀▄ ▄▀ █ ███ █
     █ ▀▀▀ █  ▄▀▀▄ █ ▀▀▀ █
     ...
```

> **Tip**: si la consola de PowerShell / Windows Terminal se trunca el QR, redirigí los logs a un archivo y abrílo aparte: `pnpm dev 2>&1 | Tee-Object -FilePath bot.log`.

### Escanear el QR

1. Abrí WhatsApp en tu celular.
2. Tocá **⋮ Menú** (Android) o **Configuración** (iOS) → **Dispositivos vinculados** → **Vincular un dispositivo**.
3. Apuntá la cámara al QR de la consola.
4. La sesión queda guardada en `apps/bot/data/session/`. Los próximos reinicios NO piden QR.

Vas a ver en consola:

```
[17:23:52.456] INFO (bot/16631): event=whatsapp_authenticated phone=+5491112345678
[17:23:55.789] INFO (bot/16631): event=whatsapp_ready
[17:23:55.890] INFO (bot/16631): event=bot_started port=3000 env=development
```

> **Nota sobre el QR**: `whatsapp-web.js` usa Puppeteer headless, que descarga una versión de Chromium la primera vez. Si está bloqueada la descarga, configurá `PUPPETEER_DOWNLOAD_HOST` o instalá Chromium manualmente.

---

## 8. Probar el bot con un mensaje de prueba

Mandá un mensaje desde tu celular (el número whitelisted en `OWNER_PHONE_NUMBERS`):

```
hola
```

El bot debería responder:

```
¡Hola! Soy el bot de compras mayoristas. Mandame una captura de tu compra y te ayudo a registrarla.
```

Después mandá una captura de pantalla de una compra (Temu, AliExpress, Shein, MercadoLibre, lo que sea). El bot va a:

1. Bajar la imagen.
2. Hacer OCR con Tesseract.
3. Preguntarte: _"Detecté: <producto>, costo lote $<monto>. ¿Es correcto? (sí/no/corregir)"_.
4. Si respondés **sí**, te pregunta cantidad → unidad → precio de venta.
5. Al final te muestra un resumen con ganancia estimada.
6. Confirmás con **sí** y queda guardada en Postgres.

### Probar los comandos de consulta

```
resumen
```

Debería devolverte un resumen del mes actual (vacío si acabás de empezar). Otros comandos para probar:

| Comando                  | Qué hace                                                 |
| ------------------------ | -------------------------------------------------------- |
| `resumen`                | Resumen del mes: compras, invertido, ganancia potencial. |
| `estadisticas`           | Totales históricos.                                      |
| `ganancias`              | Ganancia potencial acumulada.                            |
| `productos`              | Lista de productos únicos.                               |
| `stock`                  | Stock total por producto.                                |
| `producto medias negras` | Detalle de un producto (fuzzy match).                    |
| `compras mes`            | Compras del mes actual.                                  |
| `top ganancias`          | Top 5 items por ganancia unitaria.                       |
| `menu`                   | Volver al estado inicial.                                |
| `cancelar`               | Cancelar la operación en curso.                          |

---

## 9. Health checks

El bot expone 2 endpoints HTTP (Express + Helmet, sin auth):

```bash
# Liveness: 200 siempre que el proceso esté vivo
curl http://localhost:3000/health
# {"status":"ok","uptime":123}

# Readiness: 200 solo si Prisma conecta, 503 si no
curl http://localhost:3000/ready
# {"status":"ok","db":"up"}
```

Útil para monitoreo (UptimeRobot, Better Stack, etc.).

---

## 10. Verificaciones de tests + coverage

Antes de mergear un cambio:

```bash
# Typecheck en todo el workspace
pnpm -r typecheck

# Lint
pnpm -r lint

# Todos los tests
pnpm -r test

# Coverage del bot con thresholds (70% lines/funcs/stmts, 60% branches)
pnpm --filter @compras-whatsapp/bot test:coverage
```

Si `test:coverage` falla con "threshold not met", NO bajes los thresholds. Es una señal de que falta cobertura en código nuevo. Agregá tests hasta cumplir.

---

## 11. Estructura del proyecto

```
.
├── apps/
│   ├── bot/                # Backend (WhatsApp + Express + OCR)
│   │   ├── src/
│   │   │   ├── application/  # Use cases puros
│   │   │   ├── domain/       # Errores + interfaces de repos
│   │   │   ├── infrastructure/  # Prisma, WhatsApp, OCR, logger
│   │   │   ├── interface/    # HTTP server + message router
│   │   │   └── config/       # Composition root (container)
│   │   ├── tests/            # unit + integration
│   │   └── data/             # gitignored: session WA + imágenes
│   └── web/                # Dashboard React (Fase 2) - stub
├── packages/
│   ├── db/                 # Prisma schema + client
│   └── shared/             # Zod schemas, tipos, constantes, AppError
├── docker-compose.yml      # postgres (+ bot cuando haya Dockerfile)
├── .env.example
├── CHANGELOG.md
├── docs/                   # Esta carpeta
└── README.md
```

---

## 12. Troubleshooting

### `pnpm install` falla con EACCES / permission denied

En Linux/macOS nunca uses `sudo`. Si ves errores de permisos es porque `node_modules` tiene dueño equivocado:

```bash
sudo chown -R $USER:$USER .
rm -rf node_modules
pnpm install
```

### `docker compose up` falla con "port 5432 already in use"

Postgres nativo está corriendo en tu máquina. O paralo (`sudo service postgresql stop` en Linux) o cambiá `POSTGRES_PORT` en `.env` (ej. `5433`) y actualizá el `DATABASE_URL` correspondiente.

### El bot arranca pero el QR no aparece

`whatsapp-web.js` necesita Chromium. La primera vez tarda un poco mientras Puppeteer lo descarga. Si la red está bloqueada:

```bash
# Forzá un mirror de Puppeteer (ej. en China)
PUPPETEER_DOWNLOAD_HOST=https://npmmirror.com/mirrors pnpm install
```

### El bot dice "No autorizado" cuando mando un mensaje

Tu número no está en `OWNER_PHONE_NUMBERS`. Editá `.env` con el formato E.164 (`+<código_país><número>`, sin espacios ni guiones) y reiniciá el bot.

### El OCR devuelve "No pude leer bien la imagen"

- Captura más recortada: solo producto, precio y cantidad. Sin barras del navegador ni teclado.
- Buena iluminación: Tesseract es sensible a sombras.
- Probá con una captura de prueba estándar (Temu, AliExpress suelen funcionar bien).
- Si sigue fallando, respondé "no" cuando te pregunta si el producto detectado es correcto y tipeá los datos a mano.

### Los tests de integración fallan con "Can't reach database"

Necesitás una DB de test. Creala una vez:

```bash
docker exec -it sgcw-postgres psql -U sgcw -d sgcw -c "CREATE DATABASE sgcw_test;"
```

Y agregá en `.env`:

```env
DATABASE_URL_TEST=postgresql://sgcw:<db-password>@localhost:5432/sgcw_test
```

### Quiero empezar desde cero TOTAL (DB + deps + lockfile)

```bash
docker compose down -v          # borra volumen pgdata
rm -rf node_modules pnpm-lock.yaml
pnpm install
docker compose up -d postgres
pnpm --filter @compras-whatsapp/db prisma:migrate
pnpm dev
```

---

## 13. Próximos pasos

- **Cargar 5-10 compras** de prueba para tener datos reales en la DB.
- **Probar los 8 comandos** de consulta y verificar que respondan < 2s.
- **Configurar un cron de backup** de Postgres (ej. `pg_dump` diario a S3).
- **Monitorear `/health` y `/ready`** con UptimeRobot o similar.
- **Migrar el dashboard web** (`apps/web`) de stub a Vite + React + shadcn/ui (Fase 2).

---

## 14. Más documentación

- [README.md](../README.md) — overview del proyecto, stack, filosofía de arquitectura.
- [CHANGELOG.md](../CHANGELOG.md) — features, decisiones y known limitations por release.
- `.env.example` — documentación inline de cada variable de entorno.
- `docker-compose.yml` — comments sobre el stack de containers.
