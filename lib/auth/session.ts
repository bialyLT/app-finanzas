/**
 * Sesión firmada con HMAC-SHA256 usando `node:crypto`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ NO USAMOS JWT NI UNA LIBRERÍA
 * ─────────────────────────────────────────────────────────────────────────────
 * Esta app tiene UN solo usuario y una sola cosa que probar: "¿esta cookie la
 * emitió mi servidor y sigue vigente?". Para eso no hace falta una librería de
 * JWT ni un algoritmo configurable. De hecho, un JWT con `alg` configurable es
 * el vector del ataque `alg: none` y de la confusión HMAC/RSA. Acá el algoritmo
 * está HARDCODEADO a HMAC-SHA256: no hay nada que negociar, no hay nada que
 * forzar.
 *
 * El formato es el mismo de un JWT (`payload.firma`) pero sin header `alg`:
 *
 *     base64url({"v":1,"iat":...,"exp":...})  +  "."  +  base64url(HMAC-SHA256)
 *
 * La firma cubre el payload completo, y el payload contiene `exp`. Por lo tanto
 * NO se puede extender el vencimiento sin invalidar la firma. Esa propiedad es
 * el motivo de firmar el payload en vez de firmar sólo un id.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ `node:crypto` Y NO WEB CRYPTO
 * ─────────────────────────────────────────────────────────────────────────────
 * `proxy.ts` en Next 16 corre en el runtime de Node.js (verificado en
 * node_modules/next/dist/docs/.../proxy.md: "Proxy defaults to using the
 * Node.js runtime"). Al ser Node, tenemos `crypto.timingSafeEqual`, que es la
 * primitiva correcta para comparar secretos. La comparación con `===` corta en
 * el primer byte distinto y filtra el secreto por temporización.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Nombre de la cookie de sesión. Exportado porque proxy y la DAL lo comparten. */
export const SESSION_COOKIE = "finanzas_session";

/** Duración de la sesión: 30 días. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

const TOKEN_VERSION = 1;

interface SessionPayload {
  /** Versión del formato. Permite invalidar tokens viejos sin rotar el secreto. */
  v: number;
  /** Emitido en (segundos Unix). */
  iat: number;
  /** Vence en (segundos Unix). */
  exp: number;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function hmac(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

/**
 * Lee el secreto de firma del entorno.
 * Devuelve `null` si no está configurado: quien llama DEBE fallar cerrado.
 * Un secreto vacío o ausente no puede tratarse como "sin auth".
 */
export function getSessionSecret(): string | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  return secret;
}

/** Emite un token de sesión nuevo, firmado con `secret`. */
export function createSessionToken(secret: string, ttlSeconds: number = SESSION_TTL_SECONDS): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = { v: TOKEN_VERSION, iat: now, exp: now + ttlSeconds };
  const payloadB64 = base64url(JSON.stringify(payload));
  return `${payloadB64}.${hmac(payloadB64, secret)}`;
}

/**
 * Verifica firma y vigencia. Devuelve el payload sólo si TODO es válido.
 *
 * Orden deliberado de las comprobaciones: primero se verifica la FIRMA y recién
 * después se interpreta el contenido. Si se parseara primero, un atacante podría
 * mandar JSON arbitrario y nosotros estaríamos procesando datos no confiables
 * antes de probar que son nuestros.
 */
export function verifySessionToken(
  token: string | undefined | null,
  secret: string,
): SessionPayload | null {
  if (!token) return null;

  const separator = token.indexOf(".");
  if (separator <= 0 || separator === token.length - 1) return null;

  const payloadB64 = token.slice(0, separator);
  const providedSignature = token.slice(separator + 1);

  const expectedSignature = hmac(payloadB64, secret);

  // `timingSafeEqual` exige buffers del mismo largo. Comparar el largo primero
  // no filtra nada útil (el largo de un HMAC-SHA256 es público y constante).
  const provided = Buffer.from(providedSignature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  // Recién ahora el contenido es confiable.
  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as SessionPayload;
  } catch {
    return null;
  }

  if (payload?.v !== TOKEN_VERSION) return null;
  if (typeof payload.exp !== "number" || typeof payload.iat !== "number") return null;
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;

  return payload;
}

/** Opciones de la cookie de sesión. `secure` sólo en producción (en local es http). */
/**
 * ¿La app se está sirviendo por HTTPS?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ NO ALCANZA CON `NODE_ENV === "production"`
 * ─────────────────────────────────────────────────────────────────────────────
 * Es la forma obvia y tiene un agujero: `NODE_ENV` dice CÓMO SE COMPILÓ la app,
 * no CÓMO SE SIRVE.
 *
 * `npm run build && npm start` deja `NODE_ENV=production` sirviendo por http
 * sobre 127.0.0.1 — que es exactamente como conviene correr los tests de
 * interfaz, porque el build de producción es más rápido y más liviano que el
 * servidor de desarrollo. Con la versión ingenua, en esa configuración la cookie
 * sale `Secure`.
 *
 * Y un navegador NO manda una cookie `Secure` por http. El login respondería 200,
 * el navegador descartaría la cookie en silencio, y la app te devolvería al login
 * sin ningún error visible en pantalla ni en el servidor. Es el síntoma más caro
 * de diagnosticar que hay, porque cada pieza por separado parece funcionar.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA REGLA: MANDA EL PROTOCOLO REAL
 * ─────────────────────────────────────────────────────────────────────────────
 * Lo declara `APP_URL`:
 *
 *   · En Vercel  →  APP_URL="https://finanzas.vercel.app"   →  secure: true
 *   · En local   →  APP_URL="http://127.0.0.1:3000"          →  secure: false
 *
 * Si `APP_URL` no está definida se cae a `NODE_ENV`, que es el comportamiento
 * SEGURO: producción sin configurar deja la cookie `Secure`. Olvidarse de una
 * variable no puede degradar la seguridad.
 *
 * Y `http` sólo baja la guardia si el destino es una dirección local, donde no
 * existe forma de tener TLS. Un `APP_URL` en http apuntando a un dominio real es
 * una configuración rota, y se trata como producción.
 */
function isHttps(): boolean {
  const appUrl = process.env.APP_URL?.trim();
  if (!appUrl) return process.env.NODE_ENV === "production";

  if (appUrl.startsWith("https://")) return true;

  const isLoopback = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(appUrl);
  return !isLoopback;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isHttps(),
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}
