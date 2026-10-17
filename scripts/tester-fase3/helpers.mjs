#!/usr/bin/env node
/**
 * Helpers compartidos de la batería de pruebas del tester (Fase 3, núcleo
 * server-side de recurrencia).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ ES ESTO
 * ─────────────────────────────────────────────────────────────────────────────
 * Los scripts de esta carpeta son la evidencia de la ronda de testing: cada uno
 * verifica una afirmación del informe del dev (o una que se me ocurrió a mí) y
 * deja constancia de los números EXACTOS, no de "parece que anda".
 *
 * Reglas de la casa:
 *   · Se corre desde la raíz del repo (`node scripts/tester-fase3/xx.mjs`)
 *     porque el `.env` y `DATABASE_URL` se resuelven desde el cwd.
 *   · Cada script limpia sus datos al final (prefijo `T_TESTER_`).
 *   · La verificación DB es por Prisma DIRECTO: la base es parte de lo que se
 *     está probando (los CHECKs y los índices son la última defensa).
 */

import { PrismaClient } from "@prisma/client";

try {
  process.loadEnvFile();
} catch {
  // Sin .env se usan los valores por defecto.
}

export const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000";
export const PASSWORD = process.env.APP_PASSWORD ?? "finanzas-dev";
export { PrismaClient };

let cookie = "";

/** Petición autenticada con `Origin` a mano (Node no lo manda: ver smoke.mjs). */
export async function api(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Origin: BASE_URL,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers ?? {}),
    },
  });

  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const raw of setCookie) {
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

export const post = (path, body) =>
  api(path, { method: "POST", body: JSON.stringify(body) });

export const patch = (path, body) =>
  api(path, { method: "PATCH", body: JSON.stringify(body) });

/** POST con cuerpo crudo (para probar JSON hostil: `null`, `"texto"`, etc.). */
export const postRaw = (path, raw) =>
  api(path, { method: "POST", body: raw });

/* ────────────────────────────────────────────────────────────────────────────
 * Contadores y aserciones
 * ──────────────────────────────────────────────────────────────────────────── */

export const counters = { passed: 0, failed: 0 };
export const failures = [];

function record(ok, label, expected, actual) {
  if (ok) {
    counters.passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    counters.failed += 1;
    failures.push(label);
    console.log(`  FALLA ${label}`);
    console.log(`        esperado: ${expected}`);
    console.log(`        obtenido: ${actual}`);
  }
}

export function check(label, actual, expected) {
  record(String(actual) === String(expected), label, expected, actual);
}

export function checkTrue(label, condition, detail = "") {
  record(Boolean(condition), label, "true", condition ? "true" : `false ${detail}`);
}

/** Compara arrays/objetos por JSON estable. */
export function checkDeep(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  record(a === e, label, e, a);
}

export function section(title) {
  console.log(`\n${title}`);
}

export function summary() {
  console.log(
    `\n──────── ${counters.passed} ok · ${counters.failed} fallas ────────`,
  );
  if (counters.failed > 0) {
    console.log("Fallaron:");
    for (const f of failures) console.log(`  · ${f}`);
  }
  return counters.failed === 0;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Sesión
 * ──────────────────────────────────────────────────────────────────────────── */

export async function login() {
  section("Login");
  const res = await post("/api/auth/login", { password: PASSWORD });
  check("login responde 200", res.status, 200);
  checkTrue("hay cookie de sesión", cookie.startsWith("finanzas_session="));
  if (!cookie) throw new Error("Sin sesión no se puede seguir.");
}

/* ────────────────────────────────────────────────────────────────────────────
 * Fechas-calendario locales (mismos criterios que lib/dates.ts, versión JS)
 * ──────────────────────────────────────────────────────────────────────────── */

const pad2 = (n) => String(n).padStart(2, "0");

export function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function calToDate(value) {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function dateToCal(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function addDaysCal(value, days) {
  const d = calToDate(value);
  d.setDate(d.getDate() + days);
  return dateToCal(d);
}

/** Igual que `addMonths` de lib/dates.ts: clampa al fin de mes. */
export function addMonthsCal(value, months) {
  const d = calToDate(value);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return dateToCal(d);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Limpieza y consultas directas a la base
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Borra TODO lo que haya creado un script con el prefijo dado.
 *
 * El orden es el del smoke (y no es decorativo): las OCURRENCIAS primero,
 * porque borrar un movimiento POSTED dispara el `SetNull` del FK y el CHECK
 * `occurrence_shape_by_status` rechaza la ocurrencia que queda posteada sin
 * movimiento. Después movimientos (la FK a Account es Restrict), reglas,
 * categorías y cuentas.
 */
export async function cleanupTag(prisma, tag) {
  const rules = await prisma.recurrenceRule.findMany({
    where: { title: { startsWith: tag } },
    select: { id: true },
  });
  const ruleIds = rules.map((r) => r.id);
  if (ruleIds.length > 0) {
    await prisma.recurrenceOccurrence.deleteMany({ where: { ruleId: { in: ruleIds } } });
    await prisma.movement.deleteMany({ where: { recurrenceRuleId: { in: ruleIds } } });
    await prisma.recurrenceRule.deleteMany({ where: { id: { in: ruleIds } } });
  }

  await prisma.movement.deleteMany({ where: { description: { startsWith: tag } } });

  const accounts = await prisma.account.findMany({
    where: { name: { startsWith: tag } },
    select: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length > 0) {
    // Cualquier movimiento que quede en esas cuentas (no sólo los del tag).
    const remaining = await prisma.movement.findMany({
      where: { accountId: { in: accountIds } },
      select: { recurrenceRuleId: true },
    });
    const refRules = [...new Set(remaining.map((m) => m.recurrenceRuleId).filter(Boolean))];
    if (refRules.length > 0) {
      await prisma.recurrenceOccurrence.deleteMany({ where: { ruleId: { in: refRules } } });
      await prisma.movement.deleteMany({ where: { recurrenceRuleId: { in: refRules } } });
      await prisma.recurrenceRule.deleteMany({ where: { id: { in: refRules } } });
    }
    await prisma.movement.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  }
}

/** Cuenta las filas de una tabla filtrando por ids de reglas. */
export async function countOccurrences(prisma, ruleIds) {
  return prisma.recurrenceOccurrence.count({ where: { ruleId: { in: ruleIds } } });
}

/** Las fechas (`YYYY-MM-DD`) de las ocurrencias de una regla, ordenadas. */
export async function occurrenceDates(prisma, ruleId) {
  const rows = await prisma.recurrenceOccurrence.findMany({
    where: { ruleId },
    orderBy: { dueDate: "asc" },
  });
  return rows.map((r) => {
    const d = r.dueDate;
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  });
}
