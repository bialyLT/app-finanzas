#!/usr/bin/env node
/**
 * lib-fase9r3.mjs — los helpers de la ronda 9 r3 (el invariante + los gates
 * que no tocan los datos).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTE MÓDULO Y NO EL `lib.mjs` DE LA RONDA ANTERIOR
 *
 * `lib.mjs` (y `scripts/tester-fase7/helpers.mjs` debajo) resuelven la base con
 * el `DATABASE_URL` del AMBIENTE y la app con `SMOKE_BASE_URL ?? :3000`. Eso
 * está bien para una ronda donde la base de pruebas es la de la persona, pero
 * en ESTA ronda la app está en uso: `finanzas_dev` tiene datos reales y el
 * `:3000` es la instancia de la persona.
 *
 * Por eso este módulo pone dos riendas:
 *
 *   1. La base se resuelve SIEMPRE por `DATABASE_URL_TEST` y el nombre de la
 *      base se VERIFICA: si no es `finanzas_test`, la batería se cae antes de
 *      escribir una sola fila. Una batería que puede borrar los datos de la
 *      persona no es una batería: es un riesgo.
 *   2. La instancia tiene que ser la de PUERTOS DE PRUEBAS: si la URL apunta
 *      al `:3000` (el de la persona), la batería se cae. Los fixtures van
 *      contra la instancia de pruebas o no van.
 *
 * Todo lo demás (los contadores, el `RESULT ok=N fail=M`) es el mismo contrato
 * de siempre: `check`, `checkTrue`, `checkIncluye`, `section` y `summary` de
 * `scripts/tester-fase7/helpers.mjs`.
 */

import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

try {
  process.loadEnvFile();
} catch {
  // Sin `.env` se usan las variables del entorno.
}

/* ────────────────────────────────────────────────────────────────────────────
 * LA BASE: `finanzas_test`, O NADA
 * ──────────────────────────────────────────────────────────────────────────── */

/** Lee una clave del `.env` sin depender del entorno (y sin pisarlo). */
function dotEnvValue(name) {
  try {
    const text = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`));
      if (!match) continue;
      return match[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // Sin `.env`.
  }
  return "";
}

/** El nombre de la base, para verificar que sea la de pruebas. */
export function nombreDeBase(url) {
  try {
    return new URL(url).pathname.replace(/^\//, "");
  } catch {
    return "";
  }
}

export const TEST_DB_URL =
  process.env.DATABASE_URL_TEST || dotEnvValue("DATABASE_URL_TEST");

/**
 * La instancia contra la que corren los fixtures.
 *
 * Por defecto la de pruebas (`:3101`). Si alguien la apunta al `:3000` (el de
 * la persona) la batería se cae: es la rienda que impide que un fixture de
 * pruebas escriba en la app que la persona está usando.
 */
export const BASE =
  process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3101";

/**
 * Verifica las dos riendas. Se llama al PRINCIPIO de cada batería, antes de
 * tocar nada.
 */
export function verificarDestino({ base = BASE, dbUrl = TEST_DB_URL } = {}) {
  const problemas = [];

  const nombre = nombreDeBase(dbUrl);
  if (!dbUrl) problemas.push("no hay DATABASE_URL_TEST");
  else if (nombre !== "finanzas_test") {
    problemas.push(`la base de fixtures es «${nombre}» y no «finanzas_test»`);
  }

  let puerto = "";
  try {
    puerto = new URL(base).port;
  } catch {
    problemas.push(`la URL de fixtures «${base}» no es una URL`);
  }
  if (puerto === "3000") {
    problemas.push(
      "la URL de fixtures apunta al :3000 (la instancia de la persona): los fixtures van contra :3101",
    );
  }

  if (problemas.length > 0) {
    throw new Error(
      `Destino de fixtures IMPERMITIDO: ${problemas.join("; ")}. ` +
        `La batería se cae antes de escribir: no se toca la base de la persona.`,
    );
  }
  return { base, dbUrl, nombre, puerto };
}

/** Cliente de Prisma contra `finanzas_test`, explícito (nunca el ambiente). */
export function clienteDePruebas() {
  if (!TEST_DB_URL) throw new Error("Falta DATABASE_URL_TEST.");
  return new PrismaClient({ datasourceUrl: TEST_DB_URL });
}

/* ────────────────────────────────────────────────────────────────────────────
 * API CON SESIÓN
 * ──────────────────────────────────────────────────────────────────────────── */

let cookie = "";

export const PASSWORD = process.env.APP_PASSWORD ?? "finanzas-dev";

/** Petición autenticada contra la instancia de fixtures. */
export async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Origin: BASE,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers ?? {}),
    },
  });

  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(";")[0];
    if (pair?.startsWith("finanzas_session=")) cookie = pair;
  }

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body, rawText: text };
}

export const get = (path) => api(path);
export const post = (path, body) =>
  api(path, { method: "POST", body: JSON.stringify(body) });
export const patch = (path, body) =>
  api(path, { method: "PATCH", body: JSON.stringify(body) });
export const del = (path) => api(path, { method: "DELETE" });
/** POST con cuerpo crudo (para JSON hostil). */
export const postRaw = (path, raw) =>
  api(path, { method: "POST", body: raw });

export async function login() {
  const res = await post("/api/auth/login", { password: PASSWORD });
  if (res.status !== 200) {
    throw new Error(
      `El login contra ${BASE} respondió ${res.status}: ${res.rawText?.slice(0, 200)}`,
    );
  }
  if (!cookie.startsWith("finanzas_session=")) {
    throw new Error("El login no devolvió cookie de sesión.");
  }
  return res;
}

/* ────────────────────────────────────────────────────────────────────────────
 * ERRORES DE SQL (para leer el mensaje del trigger)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Ejecuta SQL y devuelve `{ ok, error }` con el mensaje del motor.
 *
 * El mensaje del trigger es la evidencia: tiene que decir QUÉ se pidió y POR
 * QUÉ se rechaza, no sólo "constraint violation".
 */
export async function sql(prisma, text, values = []) {
  try {
    const rows = await prisma.$queryRawUnsafe(text, ...values);
    return { ok: true, rows };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** Lo mismo, para escrituras. */
export async function sqlWrite(prisma, text, values = []) {
  try {
    const count = await prisma.$executeRawUnsafe(text, ...values);
    return { ok: true, count };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * CORREDOR DE BATERÍA
 * ──────────────────────────────────────────────────────────────────────────── */

import { counters, failures, check, checkTrue, checkIncluye, section } from "../tester-fase7/helpers.mjs";

export { counters, failures, check, checkTrue, checkIncluye, section };

/** Cierra la cuenta con las DOS líneas que el orquestador sabe leer. */
export function summary() {
  const { passed, failed } = counters;
  console.log(`\n──────── ${passed} ok · ${failed} fallas ────────`);
  if (failed > 0) {
    console.log("Fallaron:");
    for (const f of failures) console.log(`  · ${f}`);
  }
  console.log(`RESULT ok=${passed} fail=${failed}`);
  return failed === 0;
}

/**
 * Corredor estándar: verifica el destino, limpia lo propio, corre `main` y
 * deja el resumen. Sale con 1 si hubo fallas.
 *
 * `limpiar` es obligatorio: la batería borra POR ID lo que creó (nunca un
 * `deleteMany` sin filtro, y jamás contra `finanzas_dev`).
 */
export async function correrBateria({
  etiqueta = "la batería",
  main,
  limpiar = null,
}) {
  let ok = false;
  let prisma = null;
  try {
    const destino = verificarDestino();
    console.log(
      `Destino verificado: base «${destino.nombre}» · instancia ${destino.base}`,
    );
    prisma = clienteDePruebas();
    if (limpiar) await limpiar(prisma);
    await login();
    await main(prisma);
    ok = true;
  } catch (error) {
    console.error(`\n${etiqueta} falló: ${error.message ?? error}`);
    checkTrue(`${etiqueta} termina sin excepción`, false, String(error.message ?? error));
  } finally {
    if (prisma && limpiar) {
      try {
        await limpiar(prisma);
      } catch (error) {
        console.error(`La limpieza falló: ${error.message ?? error}`);
      }
    }
    if (prisma) await prisma.$disconnect();
  }
  const bueno = summary();
  process.exit(bueno && ok ? 0 : 1);
}
