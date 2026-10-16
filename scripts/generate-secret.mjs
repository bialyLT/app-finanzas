/**
 * Genera un `SESSION_SECRET` aleatorio.
 *
 * Uso:
 *   npm run auth:secret
 *
 * 48 bytes de aleatoriedad criptográfica, codificados en base64url (64 caracteres).
 * El mínimo que acepta lib/auth/session.ts son 32 caracteres: si alguien lograra
 * adivinar el secreto, podría FIRMAR SUS PROPIAS COOKIES de sesión y entrar sin
 * contraseña. Por eso se genera con `randomBytes` y nunca con `Math.random()`
 * (que es predecible a partir de unas pocas salidas).
 */
import { randomBytes } from "node:crypto";

const secret = randomBytes(48).toString("base64url");

console.log("");
console.log("Pegá esta línea en tu .env (o en las variables de entorno de Vercel):");
console.log("");
console.log(`SESSION_SECRET="${secret}"`);
console.log("");
console.log("Ojo: cambiarlo invalida todas las sesiones activas.");
console.log("");
