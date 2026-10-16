/**
 * Verificación de la contraseña de acceso y defensa contra fuerza bruta.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAS DOS REGLAS
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. FALLAR CERRADO. Si no hay contraseña configurada, NADIE entra. El error
 *    clásico es `if (configured && candidate !== configured) deny()`, que deja
 *    la puerta abierta cuando la variable de entorno se pierde en un deploy.
 *    Acá: sin configuración → `false`, siempre, y se loguea fuerte.
 *
 * 2. COMPARAR EN TIEMPO CONSTANTE. `candidate === expected` corta en el primer
 *    byte distinto. Midiendo tiempos se puede adivinar el secreto byte a byte.
 *    Se comparan digests SHA-256 en vez de los strings crudos porque
 *    `timingSafeEqual` exige largos iguales, y así el largo de la contraseña
 *    tampoco se filtra.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LOS DOS FORMATOS SOPORTADOS
 * ─────────────────────────────────────────────────────────────────────────────
 *   APP_PASSWORD_HASH   (preferido)  "scrypt:<saltHex>:<hashHex>"
 *   APP_PASSWORD        (simple)     texto plano en la variable de entorno
 *
 * Se prefiere el hash: si alguien ve las variables de entorno del proyecto en
 * Vercel, con `APP_PASSWORD` obtiene la contraseña directamente.
 * Para generarlo:
 *
 *   node -e "const{randomBytes,scryptSync}=require('node:crypto');\
 *   const s=randomBytes(16);const h=scryptSync('TU_PASSWORD',s,64);\
 *   console.log('scrypt:'+s.toString('hex')+':'+h.toString('hex'))"
 */

import { createHash, scryptSync, timingSafeEqual } from "node:crypto";

/** Compara dos strings en tiempo constante, hasheando primero para igualar largos. */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** Verifica contra un hash `scrypt:<saltHex>:<hashHex>`. */
function verifyScrypt(candidate: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  if (salt.length === 0 || expected.length === 0) return false;

  // scrypt es deliberadamente caro (~100 ms): eso es lo que protege de fuerza
  // bruta offline si el hash se filtra.
  let derived: Buffer;
  try {
    derived = scryptSync(candidate, salt, expected.length);
  } catch {
    return false;
  }

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** `true` si la app tiene alguna credencial configurada. */
export function isAuthConfigured(): boolean {
  return Boolean(process.env.APP_PASSWORD_HASH || process.env.APP_PASSWORD);
}

/**
 * Verifica la contraseña del usuario.
 * Falla cerrado: cualquier duda, error o configuración ausente devuelve `false`.
 */
export function verifyPassword(candidate: string): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;

  const hash = process.env.APP_PASSWORD_HASH;
  if (hash) return verifyScrypt(candidate, hash);

  const plain = process.env.APP_PASSWORD;
  if (plain) return safeEqual(candidate, plain);

  console.error(
    "[auth] FALLA CERRADO: no hay APP_PASSWORD ni APP_PASSWORD_HASH configurados. " +
      "Ningún login puede tener éxito. Revisá tus variables de entorno.",
  );
  return false;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Anti fuerza bruta
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Limitador de intentos en memoria.
 *
 * ALCANCE REAL: en un servidor Node persistente (dev local, VPS, contenedor)
 * esto funciona bien. En serverless (Vercel) cada instancia tiene su propia
 * memoria y las instancias se reciclan, así que un atacante paciente puede
 * esquivarlo repartiendo intentos. Es defensa en profundidad, no una garantía:
 * la garantía real es que la contraseña sea larga.
 */
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 5_000;

interface AttemptRecord {
  count: number;
  firstAttempt: number;
}

const attempts = new Map<string, AttemptRecord>();

/** Cantidad de intentos fallidos registrados. Se usa para tests manuales. */
export function failedAttempts(ip: string): number {
  const record = attempts.get(ip);
  if (!record) return 0;
  if (Date.now() - record.firstAttempt > WINDOW_MS) {
    attempts.delete(ip);
    return 0;
  }
  return record.count;
}

/** `true` si la IP superó el máximo de intentos en la ventana. */
export function isRateLimited(ip: string): boolean {
  return failedAttempts(ip) >= MAX_ATTEMPTS;
}

/** Registra un intento fallido. */
export function registerFailure(ip: string): void {
  const now = Date.now();
  const record = attempts.get(ip);

  if (!record || now - record.firstAttempt > WINDOW_MS) {
    attempts.set(ip, { count: 1, firstAttempt: now });
    return;
  }
  record.count += 1;
}

/** Limpia los intentos de una IP tras un login exitoso. */
export function clearFailures(ip: string): void {
  attempts.delete(ip);
}

/**
 * Retraso creciente por intento fallido.
 * Frena ataques automatizados sin necesidad de infraestructura externa.
 */
export function backoffDelay(ip: string): Promise<void> {
  const count = failedAttempts(ip);
  if (count === 0) return Promise.resolve();

  const delay = Math.min(BASE_DELAY_MS * 2 ** (count - 1), MAX_DELAY_MS);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Extrae la IP del cliente de los headers del proxy.
 * `x-forwarded-for` puede traer una lista "cliente, proxy1, proxy2": se toma la
 * primera, que es la del cliente original.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip") ?? "desconocida";
}
