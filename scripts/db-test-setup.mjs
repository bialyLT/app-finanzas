#!/usr/bin/env node
/**
 * Aplica las migraciones a la base de datos de TEST (`DATABASE_URL_TEST`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ EXISTE ESTE SCRIPT
 * ─────────────────────────────────────────────────────────────────────────────
 * `prisma migrate deploy` lee `DATABASE_URL`, no `DATABASE_URL_TEST`. La forma
 * obvia de apuntarlo es
 *
 *     cross-env DATABASE_URL=$DATABASE_URL_TEST prisma migrate deploy
 *
 * pero eso obliga a agregar `cross-env` como dependencia (en Windows `VAR=x cmd`
 * no funciona, y los scripts de npm no garantizan el shell), y encima deja sin
 * resolver el problema de que `$DATABASE_URL_TEST` tiene que expandirse AL VALOR
 * de la otra variable, no a su nombre.
 *
 * Este script hace lo mismo sin dependencias: lee `.env`, toma el valor de
 * `DATABASE_URL_TEST` y lo pasa como `DATABASE_URL` al proceso de Prisma. Mismo
 * resultado, cero dependencias nuevas, y funciona igual en Windows, macOS y
 * Linux.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTO ES PELIGROSO SI ESTÁ MAL
 * ─────────────────────────────────────────────────────────────────────────────
 * Si `DATABASE_URL_TEST` apuntara por error a la base de producción, este script
 * le aplicaría migraciones. Por eso se verifica explícitamente que la URL no
 * contenga señales de producción antes de ejecutar.
 */

import { spawnSync } from "node:child_process";

try {
  // Nativo desde Node 20.6.
  process.loadEnvFile();
} catch {
  // Sin `.env` no hay nada que hacer, y el chequeo de abajo lo va a decir.
}

const testUrl = process.env.DATABASE_URL_TEST;

if (!testUrl) {
  console.error(
    "\n  Falta DATABASE_URL_TEST en .env\n" +
      "  Copiá .env.example a .env y completá la cadena de conexión de test.\n",
  );
  process.exit(1);
}

// ── Guarda contra el accidente irreversible ──────────────────────────────────
// `migrate deploy` no borra datos, pero aplicar una migración de un esquema que
// todavía está en desarrollo a una base con datos reales puede romperla. Un
// chequeo de 6 líneas evita el peor escenario.
const looksLikeProduction =
  /neon\.tech|\.aws\.|\.azure\.|supabase\.co|render\.com|railway\.app|planetscale/i.test(
    testUrl,
  ) || /prod/i.test(testUrl);

if (looksLikeProduction) {
  console.error(
    "\n  DATABASE_URL_TEST parece apuntar a un servicio remoto o de producción:\n" +
      `  ${testUrl.replace(/:\/\/[^@]*@/, "://***@")}\n\n` +
      "  Este script es sólo para la base LOCAL de testing. Abortado.\n",
  );
  process.exit(1);
}

console.log("Aplicando migraciones a la base de TEST…");
console.log(`  ${testUrl.replace(/:\/\/[^@]*@/, "://***@")}\n`);

const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
  stdio: "inherit",
  // `shell: true` es necesario en Windows, donde `npx` es un .cmd y no se puede
  // ejecutar directamente desde Node (CVE-2024-27980).
  shell: true,
  env: { ...process.env, DATABASE_URL: testUrl },
});

process.exit(result.status ?? 1);
