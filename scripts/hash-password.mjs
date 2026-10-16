/**
 * Genera el hash scrypt de una contraseña, en el formato que espera
 * `APP_PASSWORD_HASH` (ver lib/auth/password.ts).
 *
 * Uso:
 *   npm run auth:hash -- "mi-contraseña"
 *
 * Por qué scrypt y no SHA-256 a secas: SHA-256 está diseñado para ser RÁPIDO.
 * Una GPU calcula miles de millones por segundo, así que un hash filtrado se
 * revierte por fuerza bruta en minutos. scrypt es deliberadamente LENTO y usa
 * memoria, lo que encarece el ataque por hardware.
 */
import { randomBytes, scryptSync } from "node:crypto";

const password = process.argv[2];

if (!password) {
  console.error("Falta la contraseña.\n");
  console.error('  npm run auth:hash -- "mi-contraseña"\n');
  process.exit(1);
}

if (password.length < 8) {
  console.error("La contraseña debe tener al menos 8 caracteres.");
  process.exit(1);
}

const salt = randomBytes(16);
const hash = scryptSync(password, salt, 64);

console.log("");
console.log("Pegá esta línea en tu .env (o en las variables de entorno de Vercel):");
console.log("");
console.log(`APP_PASSWORD_HASH="scrypt:${salt.toString("hex")}:${hash.toString("hex")}"`);
console.log("");
console.log("Y quitá APP_PASSWORD para que no queden dos credenciales válidas.");
console.log("");
