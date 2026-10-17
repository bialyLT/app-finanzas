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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ HAY DOS CUBETAS (POR IP Y GLOBAL)
 * ─────────────────────────────────────────────────────────────────────────────
 * `clientIp` lee `x-forwarded-for`, un header que el CLIENTE puede inventar. En
 * un servidor Node que no esté detrás de un proxy que lo pise, un atacante manda
 * un `X-Forwarded-For` distinto en cada intento y el límite por IP NUNCA se
 * llena: 5 intentos por cada IP nueva, IPs infinitas, fuerza bruta sin freno.
 *
 * La defensa no puede depender de un dato que el atacante controla. Por eso,
 * ADEMÁS de la cubeta por IP, hay una cubeta GLOBAL con el mismo umbral y la
 * misma ventana: si SUMADOS los fallos de todas las IP se supera el máximo, se
 * corta el login. Rotar el header ya no sirve de nada.
 *
 * TRADE-OFF EXPLÍCITO (seguridad contra disponibilidad): con esto, cualquiera
 * que gaste 5 intentos fallidos puede bloquear el login durante la ventana. Es
 * una molestia, pero el modelo de amenaza de esta app prioriza que NO se filtren
 * los datos financieros: bloquear 15 minutos es preferible a permitir una fuerza
 * bruta sin límite. Un único usuario que se equivoca una vez no se ve afectado, y
 * un login correcto libera el contador.
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

/**
 * Cubeta global: agrupa los fallos de TODAS las IP. Es la que no se puede
 * esquivar rotando `x-forwarded-for`.
 */
let globalAttempts: AttemptRecord | null = null;

/** Suma un intento a un registro, reiniciando la ventana si ya venció. */
function accumulate(record: AttemptRecord | null): AttemptRecord {
  const now = Date.now();
  if (!record || now - record.firstAttempt > WINDOW_MS) {
    return { count: 1, firstAttempt: now };
  }
  record.count += 1;
  return record;
}

/** Cantidad de intentos fallidos registrados para una IP. Se usa en tests. */
export function failedAttempts(ip: string): number {
  const record = attempts.get(ip);
  if (!record) return 0;
  if (Date.now() - record.firstAttempt > WINDOW_MS) {
    attempts.delete(ip);
    return 0;
  }
  return record.count;
}

/** Cantidad de intentos fallidos registrados en total, sumando todas las IP. */
export function globalFailedAttempts(): number {
  if (globalAttempts && Date.now() - globalAttempts.firstAttempt > WINDOW_MS) {
    globalAttempts = null;
    return 0;
  }
  return globalAttempts?.count ?? 0;
}

/**
 * `true` si hay que frenar el login: la IP superó el máximo, O el total de fallos
 * de todas las IP lo superó (esto último cubre el `x-forwarded-for` rotado).
 */
export function isRateLimited(ip: string): boolean {
  return failedAttempts(ip) >= MAX_ATTEMPTS || globalFailedAttempts() >= MAX_ATTEMPTS;
}

/** Registra un intento fallido en la cubeta de la IP y en la global. */
export function registerFailure(ip: string): void {
  attempts.set(ip, accumulate(attempts.get(ip) ?? null));
  globalAttempts = accumulate(globalAttempts);
}

/**
 * Limpia los intentos tras un login exitoso. También resetea la cubeta global:
 * un login correcto significa que los fallos eran de un usuario legítimo que se
 * equivocó, no de un ataque. Si no se reseteara, un par de errores de tipeo
 * dejarían el login trabado y el dueño quedaría afuera de su propia app.
 */
export function clearFailures(ip: string): void {
  attempts.delete(ip);
  globalAttempts = null;
}

/**
 * Retraso creciente por intento fallido.
 * Frena ataques automatizados sin necesidad de infraestructura externa.
 */
export function backoffDelay(ip: string): Promise<void> {
  const count = Math.max(failedAttempts(ip), globalFailedAttempts());
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
