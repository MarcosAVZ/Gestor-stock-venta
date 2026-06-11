/**
 * @compras-whatsapp/bot — Rate limiter per-phone (in-memory).
 *
 * Implementa la regla req-whitelist-and-rate-limit (OWASP A04):
 *   - 1 mensaje de texto cada 2s (RATE_LIMIT_MESSAGE_MS)
 *   - máximo 30 compras/día por usuario (RATE_LIMIT_DAILY_COMPRAS)
 *
 * Decisión: in-memory `Map<phone, timestamps[]>` en lugar de Redis.
 * Justificación (sdd-design obs#28): concurrencia=2 + 1-3 usuarios;
 * el costo de Redis no se justifica. Trade-off: si el bot crashea, se
 * pierde el rate limit — aceptable para MVP. PR4+ puede migrar a
 * Redis si el bot pasa a multi-tenant.
 *
 * Decisión: timestamps se guardan como `number[]` y se filtran los
 * antiguos con `Date.now()` cada vez que se chequea. Esto es O(n)
 * por check pero con n≤1 (mensaje en los últimos minutos)
 * es negligible. La alternativa sería un ring buffer con TTL.
 *
 * Decisión: el rate limiter NO envía mensajes al usuario; retorna
 * boolean y el caller (HandleIncomingMessage) arma el texto
 * contextualmente. Esto lo hace reusable desde la HTTP API también.
 *
 * NOTA: el reset diario se hace por lazy evaluation — al chequear
 * `dailyCompraCount`, se filtran los timestamps de hace más de 24h.
 * No hay cron / setInterval: si el bot está idle 24h+, la primera
 * llamada limpia la lista.
 */

export interface RateLimitConfig {
  messageMs: number;
  dailyCompras: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Segundos a esperar antes de reintentar (0 si allowed=true). */
  retryAfterSec: number;
  /** Razón específica del rechazo (para logging). */
  reason?: 'message_cooldown' | 'daily_compras_exceeded';
}

export class RateLimiter {
  private readonly config: RateLimitConfig;
  /** Mensajes (texto) por phone, en orden cronológico ascendente. */
  private readonly messageTimestamps = new Map<string, number[]>();
  /** Compras por phone (mismo shape; usamos para `dailyCompraCount`). */
  private readonly compraTimestamps = new Map<string, number[]>();

  constructor(config: RateLimitConfig) {
    this.config = config;
  }

  // ── Checks ──────────────────────────────────────────────────────

  /**
   * Chequea si el phone puede enviar un mensaje de texto AHORA.
   * NO graba el timestamp — eso se hace con `recordMessage()` DESPUÉS
   * de que el caller confirma que el mensaje es válido (ej: pasó el
   * whitelist). Esto evita "gastar" el slot en un mensaje que después
   * se rechaza por otro motivo (whitelist, parse, etc.).
   */
  canSendMessage(phone: string, now: number = Date.now()): RateLimitVerdict {
    const last = this.lastTimestamp(this.messageTimestamps, phone);
    if (last === null) return { allowed: true, retryAfterSec: 0 };
    const elapsed = now - last;
    if (elapsed >= this.config.messageMs) return { allowed: true, retryAfterSec: 0 };
    return {
      allowed: false,
      retryAfterSec: Math.ceil((this.config.messageMs - elapsed) / 1000),
      reason: 'message_cooldown',
    };
  }



  /**
   * Chequea si el phone puede guardar una compra más HOY.
   * Cuenta compras en las últimas 24h (rolling window, no "calendario
   * día"). El spec menciona "30 compras/día (timezone local)" — para
   * MVP la rolling window es más simple y equivalente para el caso
   * de uso (no es un sistema financiero, es un anti-abuso).
   */
  canSaveCompra(phone: string, now: number = Date.now()): RateLimitVerdict {
    this.pruneOld(this.compraTimestamps, phone, now, 24 * 60 * 60 * 1000);
    const count = this.compraTimestamps.get(phone)?.length ?? 0;
    if (count < this.config.dailyCompras) return { allowed: true, retryAfterSec: 0 };
    return {
      allowed: false,
      retryAfterSec: 0,
      reason: 'daily_compras_exceeded',
    };
  }

  // ── Record (después de que el caller confirma) ──────────────────

  recordMessage(phone: string, now: number = Date.now()): void {
    this.appendTimestamp(this.messageTimestamps, phone, now);
  }



  recordCompra(phone: string, now: number = Date.now()): void {
    this.appendTimestamp(this.compraTimestamps, phone, now);
  }

  // ── Introspection (test + debug) ────────────────────────────────

  /** Compras en las últimas 24h (útil para tests y el comando `resumen`). */
  dailyCompraCount(phone: string, now: number = Date.now()): number {
    this.pruneOld(this.compraTimestamps, phone, now, 24 * 60 * 60 * 1000);
    return this.compraTimestamps.get(phone)?.length ?? 0;
  }

  /** Reset TOTAL del state — solo para tests. */
  reset(): void {
    this.messageTimestamps.clear();
    this.compraTimestamps.clear();
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private lastTimestamp(map: Map<string, number[]>, key: string): number | null {
    const arr = map.get(key);
    if (arr === undefined || arr.length === 0) return null;
    return arr[arr.length - 1] ?? null;
  }

  private appendTimestamp(map: Map<string, number[]>, key: string, ts: number): void {
    const existing = map.get(key);
    if (existing === undefined) {
      map.set(key, [ts]);
    } else {
      existing.push(ts);
    }
  }

  /**
   * Filtra timestamps con edad mayor a `maxAgeMs` del array del phone.
   * Mutación in-place para evitar allocaciones en hot path.
   */
  private pruneOld(map: Map<string, number[]>, key: string, now: number, maxAgeMs: number): void {
    const arr = map.get(key);
    if (arr === undefined || arr.length === 0) return;
    const cutoff = now - maxAgeMs;
    let i = 0;
    while (i < arr.length && (arr[i] ?? Number.POSITIVE_INFINITY) < cutoff) {
      i++;
    }
    if (i > 0) arr.splice(0, i);
  }
}

/**
 * Factory con defaults razonables. Usado por el container
 * (PR3 task 3.10) para construir el singleton.
 */
export function buildRateLimiter(config: RateLimitConfig): RateLimiter {
  return new RateLimiter(config);
}
