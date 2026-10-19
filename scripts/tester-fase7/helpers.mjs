#!/usr/bin/env node
/**
 * Helpers compartidos de la batería del tester — Fase 7 ronda 1
 * («carga rápida»).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ ES ESTO
 * ─────────────────────────────────────────────────────────────────────────────
 * Adaptación de `scripts/tester-fase4/helpers.mjs` (y este, a su vez, de los de
 * la Fase 3/5). Cada script de esta carpeta verifica una afirmación del brief
 * de la ronda —o un borde hostil— y deja constancia de los números EXACTOS,
 * calculados a mano en comentarios.
 *
 * Reglas de la casa (las mismas de Fase 3/4/5):
 *   · Se corre desde la raíz del repo (`node scripts/tester-fase7/xx.mjs`)
 *     porque el `.env` y `DATABASE_URL` se resuelven desde el cwd.
 *   · Cada script limpia sus datos al final (prefijo propio `T_TESTER_F7_*`),
 *     incluso cuando falla. También limpia ANTES de arrancar: una corrida
 *     anterior interrumpida no envenena la siguiente.
 *   · La verificación de base es por Prisma DIRECTO: los CHECKs y los índices
 *     son parte de lo que se está probando.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA REGLA DE FECHAS DE ESTA RONDA
 * ─────────────────────────────────────────────────────────────────────────────
 * Igual que la Fase 4: los scripts son paramétricos en la fecha. Los flujos de
 * UI usan `todayCalendar()/addDays` (nunca fechas literales); los scripts de
 * API usan fechas de escenarios lejanos al seed (2026-08 y 2028) para que sus
 * movimientos no toquen los totales que miran los flows de octubre.
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

  return readResponse(response);
}

async function readResponse(response) {
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

/**
 * fetch CRUDO con la cookie de sesión, sin parsear ni tocar el estado del
 * módulo. Para las tormentas de pool: los "bloqueadores" tienen que quedarse
 * esperando la respuesta (ocupando su conexión), y el timing se mide afuera.
 */
export function fetchConSesion(path) {
  return fetch(`${BASE_URL}${path}`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
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

/** Compara arrays/objetos por JSON estable. */
export function checkDeep(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  record(a === e, label, e, a);
}

/** Ninguna respuesta de la lista puede ser 500 (cuerpos/ids hostiles). */
export function checkSin500(label, responses) {
  const malas = responses.filter((r) => r.status >= 500);
  record(
    malas.length === 0,
    label,
    "ninguna 5xx",
    malas.map((r) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 120)}`).join(" | "),
  );
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

export function centsToMoney(total) {
  const negative = total < 0n;
  const abs = negative ? -total : total;
  const body = `${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
  return negative ? `-${body}` : body;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Azúcar de dominio (rutas reales, nunca atajos a la base para ESCRIBIR)
 * ──────────────────────────────────────────────────────────────────────────── */

export async function crearCuenta(name, kind, openingBalance = "0") {
  return post("/api/accounts", { name, kind, openingBalance });
}

export async function crearMovimiento(body) {
  return post("/api/transactions", body);
}

/** Vista de movimientos de un rango (para verificar persistencia y lectores). */
export function movimientosDe(from, to) {
  return get(`/api/transactions?from=${from}&to=${to}`);
}

/** Reporte de /analisis para un rango. */
export function reportesDe(from, to) {
  return get(`/api/reports?from=${from}&to=${to}`);
}

/** Contrato de deudas del mes (lector que comparte camino con tarjetas). */
export function deudaDelMes(month, asOf) {
  return get(`/api/debts?month=${month}${asOf ? `&asOf=${asOf}` : ""}`);
}

export function reconciliacion(month, asOf) {
  return get(`/api/reconciliation?month=${month}${asOf ? `&asOf=${asOf}` : ""}`);
}

export function cuentas(query = "") {
  return get(`/api/accounts${query}`);
}

export function cuentaDe(id, query = "") {
  return cuentas(query).then(
    (res) => (res.body?.accounts ?? []).find((a) => a.id === id) ?? null,
  );
}

export function categorias(query = "") {
  return get(`/api/categories${query}`);
}

export function duplicadosDe(params) {
  return get(`/api/transactions/duplicates?${new URLSearchParams(params)}`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Limpieza
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Borra TODO lo que un script haya creado con el prefijo dado.
 *
 * Orden (no es decorativo):
 *   1. Statements / CardPlans → FK Restrict contra Account: primero ellos.
 *   2. Installments          → Cascade de la cuenta, pero explícito.
 *   3. Movements             → FK Restrict contra Account.
 *   4. Accounts              → al final, ya sin nada que las referencie.
 *   5. Categorías y movimientos sueltos con el prefijo (no debería quedar
 *      ninguno, pero la limpieza no confía).
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
    await prisma.installment.deleteMany({ where: { accountId: { in: accountIds } } });
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

  await prisma.movement.deleteMany({ where: { description: { startsWith: tag } } });
  await prisma.category.deleteMany({ where: { name: { startsWith: tag } } });
}

/** Envoltorio estándar: limpia ANTES, login → main → summary → limpia DESPUÉS. */
export async function runScript({ tag, main }) {
  const prisma = new PrismaClient();
  let ok = false;
  try {
    section(`Limpieza previa (${tag})`);
    await cleanupTag(prisma, tag);
    console.log("  lista");

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
