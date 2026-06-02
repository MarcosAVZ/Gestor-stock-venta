# Changelog

Todos los cambios notables a este proyecto se documentan acá. El formato sigue [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) y este proyecto adhiere a [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-mvp] — 2026-06-02

**Estado**: primera release funcional del MVP. Cubre los 11 requirements del spec, con 65 scenarios verificados por tests automatizados.

### Added — Features

- **Monorepo pnpm** (`apps/bot`, `apps/web` stub, `packages/db`, `packages/shared`) con TypeScript strict y type stripping nativo (Node 22.6+). Cero build step.
- **Stack Docker Compose**: `postgres:16-alpine` con healthcheck, volumen persistente `pgdata`, red dedicada `sgcw_net`. Sin servicios pagos.
- **Prisma schema** (4 modelos): `Usuario`, `Compra`, `ItemCompra`, `Conversacion` con relaciones, cascade delete, índice GIN + extensión `pg_trgm` para fuzzy search.
- **Repositorios Prisma** (`UsuarioRepo`, `CompraRepo`, `ItemCompraRepo`, `ConversacionRepo`) con tests de integración contra DB de test (`DATABASE_URL_TEST`).
- **Cliente WhatsApp** (`whatsapp-web.js`) detrás de interface `WhatsappAdapter`. QR auth, sesión persistente, reconexión con backoff exponencial.
- **State machine conversacional** pura con 7 estados (`ESPERANDO_IMAGEN`, `VALIDANDO_DATOS`, `PREGUNTANDO_CANTIDAD`, `PREGUNTANDO_UNIDAD`, `PREGUNTANDO_PRECIO_VENTA`, `CONFIRMACION_FINAL`, `GUARDADO`). Transiciones inválidas retornan mensaje contextual. Reset por inactividad 15 min.
- **OCR pipeline**: descarga de imagen → preproc con `sharp` (resize 1280px, grayscale, normalize, threshold) → Tesseract.js en worker thread → parser heurístico (AR/US precios, unidades, leading qty) con Zod. Pool de 2 workers FIFO, timeout 30s, retry con crash recovery.
- **Función de aprendizaje**: fuzzy match `pg_trgm` (`similarity > 0.4`) reutiliza valores de cargas previas. Sugerencia contextual antes de pedir valores manuales.
- **8 comandos de consulta** (responden < 2s p95): `resumen`, `estadisticas`, `ganancias`, `productos`, `stock`, `producto <nombre>`, `compras mes`, `top ganancias`. Comando desconocido → mensaje de ayuda + log de `unknown_command`.
- **Whitelist estricta** por `OWNER_PHONE_NUMBERS` (env var). Rechazo silencioso para números fuera de la lista (solo se loggea `unauthorized_access` con `from` hasheado).
- **Rate limiting**: 1 imagen cada 10s + 30 compras/día por usuario.
- **Observabilidad**: Pino estructurado JSON con redact de PII (`phone`, `body`, `imageUrl`). `requestId` (UUID v4) por flujo. `AppError` hierarchy (operational/programmer). 6 tipos de security events loggeados.
- **Graceful shutdown** SIGTERM/SIGINT: deja de aceptar mensajes → drena workers OCR (10s timeout) → cierra sesión WhatsApp → desconecta Prisma → exit 0.
- **HTTP server** (Express + Helmet): `GET /health` (liveness, 200 siempre que el proceso esté vivo) y `GET /ready` (readiness, 200 solo si Prisma conecta).
- **Coverage v8**: thresholds `lines/functions/statements ≥ 70%` y `branches ≥ 60%` aplicados en `apps/bot` y el monorepo.

### Added — Tests

- **337 tests** en `apps/bot` (21 archivos), cubren: state machine (48), queries (35), repos (21), handleIncomingMessage integration (24), conversationStateMachine, OCR parser (25), TesseractExtractor (11), whatsappClient (26), localImageStorage (16), httpServer (10), env (22), logger (15), errors (13), container (6), validateOCRData (8), saveCompra (7), extractPurchaseData (7), CalcularMetricas (11), eventDispatcher (10), imagePreprocessor (7), smoke (1).
- **Coverage report** generado con `@vitest/coverage-v8` (v8 nativo): 73.12% statements / 85.54% branches / 88.32% functions / 73.12% lines.

### Changed

- Versión del workspace: root `0.0.0 → 0.1.0`, paquetes `0.0.0/0.1.0 → 0.1.0-mvp`.
- Coverage thresholds en root `vitest.config.ts`: endurecidos de 50% a 70% (60% branches) en PR5.

### Documentation

- `README.md`: secciones "Cómo usar el bot", "Comandos disponibles" (tabla), "Cómo escanear QR la primera vez", "Troubleshooting OCR", "Filosofía de arquitectura".
- `docs/quickstart.md`: setup paso a paso desde cero (Docker → clonar → pnpm → migraciones → QR → smoke test).
- `CHANGELOG.md` (este archivo).

### Architecture Decisions (ADR-style, summary)

- **Delivery strategy**: 6 chained PRs con `feature-branch-chain` (tracker `feature/mvp-bot`). Cada PR se revisa contra el branch del PR anterior, no contra `main`.
- **Puppeteer lockfile**: `whatsapp-web.js@1.27.0` arrastra `puppeteer@18.2.1` en el lockfile (deprecation warning, sin impacto funcional).
- **decimal.js 10.4.3** para todos los cálculos monetarios (evita floating point errors en `costoUnitario`, `gananciaUnitaria`, `gananciaTotal`).
- **Storage de imágenes local** en `apps/bot/data/images/` (filesystem, no S3) con limpieza por edad (7 días default). El volumen `bot_data` lo persiste entre reinicios.
- **`datosTemporales` como `Json` de Prisma** (no columnas tipadas): flexibilidad para iterar el schema de la conversación sin migraciones.

### Known Limitations / Out of Scope (Fase 2)

- **Dashboard web** (`apps/web`): stub vacío. Se llenará con Vite + React + Tailwind + shadcn/ui en una fase posterior. Hoy todas las consultas son por chat.
- **Multi-tenant**: single-tenant. La whitelist admite varios números pero no hay separación de datos por comercio.
- **Soporte multi-idioma del OCR**: solo `spa.traineddata` incluido. Para productos con descripciones en otros idiomas habría que agregar más modelos.
- **Backups automáticos de la DB**: hoy el volumen `pgdata` persiste pero no hay job de backup. Recomendable configurar `pg_dump` cron en producción.
- **Reporte de compras en PDF/Excel**: no está en el MVP. Se puede agregar como comando de consulta en una iteración futura.
- **Tests E2E del bot con WhatsApp real**: no incluidos. El happy path de `HandleIncomingMessage` está cubierto por integration tests con mocks, pero el ciclo QR + sesión + mensaje real requiere interacción manual (ver `docs/quickstart.md`).
- **HTTPS / TLS en el HTTP server**: el bot expone HTTP plano en el puerto 3000. En producción habría que ponerlo detrás de un reverse proxy (Caddy / nginx).

### Verification (al cierre de PR6)

- `pnpm install -r` ✅
- `pnpm -r typecheck` ✅
- `pnpm -r lint` ✅
- `pnpm -r test` ✅ (337 tests, 0 failures)
- `pnpm --filter @compras-whatsapp/bot test:coverage` ✅ (thresholds cumplidos, exit 0)

### Upgrade / Downgrade

Esta es la primera release con tag, no hay upgrade path. Para volver atrás: `git checkout main && git revert <merge-commit-sha-de-pr6>` (después de mergear PR6 a main).

---

## Formato

Cada release sigue la estructura:

- **Added** — features nuevas
- **Changed** — cambios a features existentes
- **Deprecated** — features que se van a remover
- **Removed** — features removidas
- **Fixed** — bugfixes
- **Security** — fixes de seguridad
- **Known Limitations** — fuera de scope explícito

Los tipos de cambio siguen [Conventional Commits](https://www.conventionalcommits.org/) en los mensajes de git.

[0.1.0-mvp]: #TODO-link-al-tag-despues-de-crearlo
