#!/usr/bin/env node
/**
 * Helpers compartidos de la batería del tester — Fase 5 ronda 1
 * (núcleo server-side de tarjetas de crédito y cuotas).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ ES ESTO
 * ─────────────────────────────────────────────────────────────────────────────
 * Adaptación de `scripts/tester-fase3/helpers.mjs`. Cada script de esta carpeta
 * verifica una afirmación del contrato de la fase (o un borde hostil) y deja
 * constancia de los números EXACTOS, calculados a mano en comentarios.
 *
 * Reglas de la casa (las mismas de Fase 3):
 *   · Se corre desde la raíz del repo (`node scripts/tester-fase5/xx.mjs`)
 *     porque el `.env` y `DATABASE_URL` se resuelven desde el cwd.
 *   · Cada script limpia sus datos al final (prefijo propio `T_TESTER_F5_*`),
 *     incluso cuando falla.
 *   · La verificación de base es por Prisma DIRECTO: los índices únicos
 *     parciales, los CHECKs y las FKs son parte de lo que se está probando.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA REGLA DE FECHAS DE ESTA RONDA
 * ─────────────────────────────────────────────────────────────────────────────
 * El servidor usa el reloj LOCAL de la máquina (`todayCalendar()`). Esta
 * batería está calculada a mano para hoy = 2026-10-17 (día de lanzamiento de
 * la ronda). Cada script llama a `guardToday("2026-10-17")` y se niega a
 * correr si la fecha cambió: los números escritos a mano dejarían de ser
 * verificables y una batería que miente es peor que una que no corre.
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

export const get = (path) => api(path);
export const post = (path, body) =>
  api(path, { method: "POST", body: JSON.stringify(body) });
export const patch = (path, body) =>
  api(path, { method: "PATCH", body: JSON.stringify(body) });
export const del = (path) => api(path, { method: "DELETE" });
/** POST con cuerpo crudo (para probar JSON hostil: `null`, `"texto"`, etc.). */
export const postRaw = (path, raw) => api(path, { method: "POST", body: raw });

/** Petición SIN sesión (para el contrato de 401). */
export async function apiNoAuth(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Origin: BASE_URL,
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body, rawText: text };
}

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

/** `actual` contiene el fragmento `needle` (para mensajes de error). */
export function checkIncluye(label, actual, needle) {
  const value = String(actual ?? "");
  record(value.includes(needle), label, `contiene "${needle}"`, value);
}

/** Diferencias numéricas dentro de una tolerancia (tasas con Decimal). */
export function checkCerca(label, actual, expected, tolerance) {
  const a = Number(actual);
  const e = Number(expected);
  const ok = Number.isFinite(a) && Math.abs(a - e) <= tolerance;
  record(ok, label, `≈ ${e} (±${tolerance})`, a);
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

/**
 * Aborta el script si el día local no es el esperado.
 *
 * La batería tiene los totales de resúmenes y las ventanas de compromisos
 * calculados a mano para una fecha concreta; otro día, otros números.
 */
export function guardToday(expected) {
  const today = localToday();
  if (today !== expected) {
    console.log(
      `\n╳ BATERÍA DESCALIBRADA: está calculada para hoy = ${expected} y hoy es ${today}.`,
    );
    console.log("  Los números de los resúmenes y compromisos cambiarían.");
    process.exit(2);
  }
  return today;
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
 * Centavos exactos (sin floats): "123.45" → 12345n
 * ──────────────────────────────────────────────────────────────────────────── */

/** Convierte un Decimal de Prisma o un string de dinero a centavos (BigInt). */
export function cents(value) {
  const text = typeof value === "string" ? value : value.toFixed(2);
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) throw new Error(`Monto no canónico: ${text}`);
  const digits = (m[3] ?? "").padEnd(2, "0");
  const total = BigInt(m[2]) * 100n + BigInt(digits);
  return m[1] === "-" ? -total : total;
}

/** Σ de montos (Decimal o string) como string canónico de dinero. */
export function sumItems(items, pick = (item) => item.amount) {
  const total = items.reduce((acc, item) => acc + cents(pick(item)), 0n);
  return centsToMoney(total);
}

export function centsToMoney(total) {
  const negative = total < 0n;
  const abs = negative ? -total : total;
  const body = `${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
  return negative ? `-${body}` : body;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Azúcar de dominio (rutas reales, nunca atajos a la base para ESCRIBIR)
 * ──────────────────────────────────────────────────────────────────────────── */

/** Crea una tarjeta. Sin días configurables: default null (sin cierre). */
export async function crearTarjeta(name, { closingDay, dueDay, creditLimit } = {}) {
  return post("/api/accounts", {
    name,
    kind: "CREDIT_CARD",
    ...(closingDay !== undefined ? { closingDay } : {}),
    ...(dueDay !== undefined ? { dueDay } : {}),
    ...(creditLimit !== undefined ? { creditLimit } : {}),
  });
}

export async function crearCuenta(name, kind, openingBalance) {
  return post("/api/accounts", { name, kind, openingBalance });
}

export async function crearGasto({ accountId, amount, date, categoryName, description }) {
  return post("/api/transactions", {
    kind: "EXPENSE",
    amount,
    date,
    accountId,
    categoryName,
    ...(description ? { description } : {}),
  });
}

export async function crearPlan(body) {
  return post("/api/cards/plans", body);
}

export async function correrResumenes(cardId) {
  return post("/api/cards/statements", cardId ? { cardId } : {});
}

export async function pagarResumen(statementId, fromAccountId) {
  return post("/api/cards/statements/pay", { statementId, fromAccountId });
}

export async function vistaTarjetas(query = "") {
  return get(`/api/cards${query}`);
}

/** Busca la tarjeta `id` en la respuesta de GET /api/cards. */
export function tarjetaDe(vista, id) {
  return (vista.body?.cards ?? []).find((card) => card.id === id) ?? null;
}

export async function cuentaDe(id) {
  const res = await get("/api/accounts");
  return (res.body?.accounts ?? []).find((account) => account.id === id) ?? null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Limpieza
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Borra TODO lo que un script haya creado con el prefijo dado.
 *
 * Orden (no es decorativo):
 *   1. Statements   → FK Restrict contra Account: primero ellos.
 *   2. CardPlans    → FK Restrict contra Account; sus items caen por Cascade.
 *   3. Movements    → FK Restrict contra Account; el plan ya no existe, así que
 *                     el FK Restrict de `CardPlan.movementId` no bloquea.
 *   4. Categories   → después de los movimientos que las usan.
 *   5. Accounts     → al final, ya sin nada que las referencie.
 */
export async function cleanupTag(prisma, tag) {
  const accounts = await prisma.account.findMany({
    where: { name: { startsWith: tag } },
    select: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);

  if (accountIds.length > 0) {
    await prisma.statement.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.cardPlan.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.movement.deleteMany({
      where: {
        OR: [
          { accountId: { in: accountIds } },
          { toAccountId: { in: accountIds } },
        ],
      },
    });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  }

  // Movimientos sueltos que llevan el prefijo en la descripción, aunque su
  // cuenta ya no exista (no debería pasar, pero la limpieza no confía).
  await prisma.movement.deleteMany({ where: { description: { startsWith: tag } } });
  await prisma.category.deleteMany({ where: { name: { startsWith: tag } } });
}

/** Envoltorio estándar de script: login → main → limpieza → summary → exit. */
export async function runScript({ tag, main }) {
  const prisma = new PrismaClient();
  let ok = false;
  try {
    await login();
    await main(prisma);
    ok = summary();
  } finally {
    section(`Limpieza (${tag})`);
    await cleanupTag(prisma, tag);
    console.log("  lista");
    await prisma.$disconnect();
  }
  process.exit(ok ? 0 : 1);
}
