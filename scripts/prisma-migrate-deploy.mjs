#!/usr/bin/env node
/**
 * Aplica las migraciones pendientes antes de compilar, en el build de Vercel.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ EXISTE
 *
 * El build sólo corría `prisma generate`: generaba el cliente pero nunca creaba
 * las tablas. En desarrollo eso no se nota, porque la base local ya está
 * migrada a mano; en Vercel, con una base nueva, todas las rutas respondían
 * 500/503 con "no se pudo cargar…" y el mensaje no decía nada, porque el error
 * real era `P2021: la tabla no existe`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ NO MIGRA CON `DATABASE_URL` TAL CUAL
 *
 * En serverless la URL de Neon que va en `DATABASE_URL` es la pooled (host con
 * `-pooler`, PgBouncer). Prisma Migrate abre UNA conexión y usa locks de
 * sesión, y PgBouncer en modo transacción no los sostiene: la migración falla.
 * Es el mismo motivo por el que Prisma documenta una conexión directa para el
 * CLI.
 *
 * En vez de exigir otra variable, se prefiere `DATABASE_URL_UNPOOLED` (la
 * inyecta la integración de Neon en Vercel) y, si no está, se deriva la
 * conexión directa del mismo string: el host pooled de Neon es el directo con
 * `-pooler` en el medio.
 *
 * Uso:
 *     node scripts/prisma-migrate-deploy.mjs
 *
 * Sale con el código de `prisma migrate deploy`. Si la migración falla, el
 * deploy falla: es preferible un deploy rojo y visible a uno verde que publica
 * una app que no puede leer la base.
 */

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * Devuelve la conexión directa a partir de la pooled.
 *
 * Neon: `ep-algo-123-pooler.region.aws.neon.tech` →
 *       `ep-algo-123.region.aws.neon.tech`
 *
 * Se corta el string a mano en vez de pasar por `new URL` + `toString`: ese
 * round-trip puede re-codificar la contraseña y romper una URL que funcionaba.
 * Y si no hay `-pooler` no se toca nada.
 *
 * Los parámetros del pooler (`pgbouncer`, `connection_limit`) no significan
 * nada en una conexión directa, así que se sacan.
 */
export function conexionDirecta(cadena) {
  if (!cadena.includes("-pooler.")) return cadena;

  const [cuerpo, query] = cadena.split("?");
  const host = cuerpo.replace(/-pooler\./, ".");

  if (!query) return host;

  const params = query
    .split("&")
    .filter((param) => param && !/^(pgbouncer|connection_limit)=/.test(param));

  return params.length > 0 ? `${host}?${params.join("&")}` : host;
}

function migrar() {
  try {
    // Nativo desde Node 20.6. NO pisa lo que ya está en el entorno: en Vercel
    // no hay `.env`, y ahí mandan las variables del proyecto.
    process.loadEnvFile();
  } catch {
    // Sin `.env` se usan las variables del entorno.
  }

  const base = process.env.DATABASE_URL;

  if (!base) {
    console.error(
      "\n  DATABASE_URL no está definida: no hay base a la que migrar.\n" +
        "  En Vercel: Settings → Environment Variables → DATABASE_URL.\n",
    );
    process.exit(1);
  }

  const unpooled = process.env.DATABASE_URL_UNPOOLED;
  const directa = unpooled ?? conexionDirecta(base);

  if (unpooled) {
    console.log("migrate deploy: usando DATABASE_URL_UNPOOLED.\n");
  } else if (directa !== base) {
    console.log("migrate deploy: conexión directa derivada de la pooled.\n");
  } else {
    console.log("migrate deploy: DATABASE_URL ya es directa.\n");
  }

  const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
    stdio: "inherit",
    // `shell: true` es necesario en Windows, donde `npx` es un .cmd y no se
    // puede ejecutar directamente desde Node (CVE-2024-27980). En Vercel
    // (Linux) también funciona.
    shell: true,
    env: { ...process.env, DATABASE_URL: directa },
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

// Sólo migra cuando se lo invoca como programa. Al importarlo desde una prueba
// o un REPL no toca la base.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrar();
}
