#!/usr/bin/env node
/**
 * Harness común de la batería del tester de base de datos — Fase 4.2.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REGLAS DURAS (no negociables)
 * ─────────────────────────────────────────────────────────────────────────────
 * · SÓLO `finanzas_test` (localhost:5433). El DSN se pasa EXPLÍCITO por
 *   `DATABASE_URL_TEST` y se verifica antes de abrir una sola conexión:
 *   cualquier DSN que mencione `finanzas_dev`, un host remoto o un puerto
 *   distinto aborta el script. Nunca se deduce con un regex sobre `.env`
 *   (lección D17): se lee la variable y se compara.
 * · Los datos de prueba llevan un prefijo único por corrida (`T42DB-…`) y se
 *   borran POR ID al terminar, incluso si el script falla. Al cierre se cuenta
 *   y se exige 0.
 * · Los números esperados se calculan A MANO (o con SQL propio escrito desde la
 *   definición del dominio), nunca llamando a la función que se está probando.
 *   Eso es lo que hace que una coincidencia signifique algo.
 */

import { PrismaClient } from "@prisma/client";

try {
  // Nativo desde Node 20.6. Si no hay `.env`, el chequeo de abajo lo dice.
  process.loadEnvFile();
} catch {
  // sin `.env`
}

/* ────────────────────────────────────────────────────────────────────────────
 * Guarda de DSN: la base de la persona no se toca ni para leer
 * ──────────────────────────────────────────────────────────────────────────── */

const FORBIDDEN_DSN =
  /neon\.tech|\.aws\.|\.azure\.|supabase\.co|render\.com|railway\.app|planetscale|finanzas_dev/i;

function abort(message) {
  console.error(`\n  ABORTADO: ${message}\n`);
  process.exit(2);
}

export function assertTestDsn(url) {
  if (!url) {
    abort(
      "Falta DATABASE_URL_TEST en el entorno/.env. Este harness no adivina el DSN.",
    );
  }
  if (FORBIDDEN_DSN.test(url)) {
    abort(`DATABASE_URL_TEST apunta a una base prohibida: ${mask(url)}`);
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    abort(`DATABASE_URL_TEST no es una URL válida: ${mask(url)}`);
  }

  if (parsed.pathname !== "/finanzas_test") {
    abort(`DATABASE_URL_TEST tiene que apuntar a /finanzas_test, no a ${parsed.pathname}`);
  }
  if (parsed.port !== "5433") {
    abort(`DATABASE_URL_TEST tiene que usar el puerto 5433, no ${parsed.port || "(default)"}`);
  }
  if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    abort(`DATABASE_URL_TEST tiene que ser local, no ${parsed.hostname}`);
  }
  return url;
}

export function mask(url) {
  return String(url).replace(/:\/\/[^@]*@/, "://***@");
}

export const DB_URL = assertTestDsn(process.env.DATABASE_URL_TEST);

/** Cliente principal del script. Un pool propio, cerrado al terminar. */
export const db = new PrismaClient({ datasourceUrl: DB_URL });

/** Otro cliente: para concurrencia hacen falta DOS conexiones reales. */
export function newClient() {
  return new PrismaClient({ datasourceUrl: DB_URL });
}

export const BASE_URL = process.env.TESTER_BASE_URL ?? "http://127.0.0.1:3101";
export const PASSWORD = process.env.APP_PASSWORD ?? "";

/* ────────────────────────────────────────────────────────────────────────────
 * HTTP con sesión
 * ──────────────────────────────────────────────────────────────────────────── */

let cookie = "";

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

export async function login() {
  section("Login");
  if (!PASSWORD) abort("Falta APP_PASSWORD para autenticar contra la app.");
  const res = await post("/api/auth/login", { password: PASSWORD });
  check("login responde 200", res.status, 200);
  checkTrue("hay cookie de sesión", cookie.startsWith("finanzas_session="));
  if (!cookie) throw new Error("Sin sesión no se puede probar el borde HTTP.");
}

/* ────────────────────────────────────────────────────────────────────────────
 * Aserciones y contadores
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

export function checkDeep(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  record(a === e, label, e, a);
}

export function checkIncluye(label, actual, needle) {
  const value = String(actual ?? "");
  record(value.includes(needle), label, `contiene "${needle}"`, value);
}

/**
 * Exige que la operación sea RECHAZADA por la base.
 *
 * `needle` es el marcador estable (nombre de constraint o `[finanzas:...]`):
 * que falle por otro motivo no cuenta como que el invariante esté protegido.
 */
export async function checkRejects(label, fn, needle = "") {
  try {
    await fn();
    record(false, label, `rechazo${needle ? ` con "${needle}"` : ""}`, "la base la ACEPTÓ");
  } catch (error) {
    const text = `${error?.message ?? error}`;
    const ok = needle === "" || text.includes(needle);
    record(
      ok,
      label,
      `rechazo con "${needle}"`,
      ok ? `rechazado (${text.slice(0, 140)})` : `rechazado por OTRO motivo: ${text.slice(0, 260)}`,
    );
  }
}

/** Exige que la operación sea ACEPTADA (el caso legítimo del mismo invariante). */
export async function checkAccepts(label, fn) {
  try {
    const value = await fn();
    record(true, label, "aceptada", "aceptada");
    return value;
  } catch (error) {
    record(false, label, "aceptada", `rechazada: ${String(error?.message ?? error).slice(0, 260)}`);
    return null;
  }
}

/** Compara dos montos al CENTAVO, sin floats. */
export function checkMoney(label, actual, expected) {
  let ok = false;
  let detail = "";
  try {
    ok = cents(actual) === cents(expected);
    detail = `${centsToMoney(cents(actual))}`;
  } catch (error) {
    detail = `no es un monto canónico (${String(actual)}): ${error.message}`;
  }
  record(ok, label, centsToMoney(cents(expected)), detail);
}

export function section(title) {
  console.log(`\n${title}`);
}export function summary() {
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
 * Dinero exacto: BigInt en centavos
 * ──────────────────────────────────────────────────────────────────────────── */

export function cents(value) {
  if (typeof value === "bigint") return value;
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number"
        ? value.toFixed(2)
        : value?.toFixed?.(2) ?? String(value);
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
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

export function sumMoney(items) {
  return centsToMoney(items.reduce((acc, item) => acc + cents(item), 0n));
}

/* ────────────────────────────────────────────────────────────────────────────
 * Datos de prueba: prefijo único y limpieza por id
 * ──────────────────────────────────────────────────────────────────────────── */

export function newTag(label) {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `T42DB-${label}-${stamp}-${rand}`;
}

export async function makeAccount(
  tag,
  suffix,
  { currency, kind = "CASH", openingBalance = "0", archived = false, extra = {} },
) {
  return db.account.create({
    data: {
      name: `${tag} ${suffix}`,
      kind,
      currency,
      openingBalance,
      archived,
      ...extra,
    },
  });
}

export async function makeCategory(tag, suffix, kind) {
  const name = `${tag} ${suffix}`;
  return db.category.create({
    data: { name, normalizedName: name.toLowerCase(), kind },
  });
}

export async function makeMovement(fields) {
  return db.movement.create({ data: fields });
}

/**
 * Borra TODO lo que la corrida creó, por id, en orden de FK.
 *
 * No usa `deleteMany({})`: un script de testing no puede tocar filas que no
 * creó. Los datos se identifican por el prefijo del nombre de cuenta/categoría
 * y por los movimientos que cuelgan de esas cuentas.
 */
export async function cleanupTag(tag) {
  const accounts = await db.account.findMany({
    where: { name: { startsWith: tag } },
    select: { id: true },
  });
  const accountIds = accounts.map((account) => account.id);

  const movements = await db.movement.findMany({
    where: {
      OR: [{ accountId: { in: accountIds } }, { toAccountId: { in: accountIds } }],
    },
    select: { id: true },
  });
  const movementIds = movements.map((movement) => movement.id);

  const categories = await db.category.findMany({
    where: { name: { startsWith: tag } },
    select: { id: true },
  });
  const categoryIds = categories.map((category) => category.id);

  await db.recurrenceOccurrence.deleteMany({
    where: { movementId: { in: movementIds } },
  });
  await db.statement.deleteMany({
    where: {
      OR: [{ accountId: { in: accountIds } }, { paidMovementId: { in: movementIds } }],
    },
  });
  await db.cardPlan.deleteMany({
    where: {
      OR: [{ accountId: { in: accountIds } }, { movementId: { in: movementIds } }],
    },
  });
  await db.favoriteTemplate.deleteMany({
    where: {
      OR: [
        { accountId: { in: accountIds } },
        { toAccountId: { in: accountIds } },
        { categoryId: { in: categoryIds } },
      ],
    },
  });
  await db.budget.deleteMany({ where: { categoryId: { in: categoryIds } } });
  await db.installment.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.movement.deleteMany({ where: { id: { in: movementIds } } });
  await db.recurrenceRule.deleteMany({
    where: {
      OR: [{ accountId: { in: accountIds } }, { toAccountId: { in: accountIds } }],
    },
  });
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
  await db.category.deleteMany({ where: { id: { in: categoryIds } } });
}

/** Cuenta los residuos del prefijo. Tiene que dar 0 al cerrar. */
export async function residueOf(tag) {
  const [accounts, categories, movements] = await Promise.all([
    db.account.count({ where: { name: { startsWith: tag } } }),
    db.category.count({ where: { name: { startsWith: tag } } }),
    db.movement.count({ where: { description: { startsWith: tag } } }),
  ]);
  return { accounts, categories, movements };
}

/** Envoltorio estándar: guarda de DSN → limpia → login → main → limpia → 0. */
export async function runBattery({ tag, main, withHttp = true }) {
  let ok = false;
  try {
    console.log(`Base: ${mask(DB_URL)}`);
    console.log(`App : ${BASE_URL}`);
    section(`Limpieza previa (${tag})`);
    await cleanupTag(tag);
    console.log("  lista");

    if (withHttp) await login();
    await main();
    ok = summary();
  } catch (error) {
    // Un script que revienta no puede dejar datos: la limpieza va en el finally.
    ok = false;
    console.error(`\n  ERROR NO CONTROLADO: ${error?.stack ?? error}`);
  } finally {
    section(`Limpieza (${tag})`);
    try {
      await cleanupTag(tag);
      const residue = await residueOf(tag);
      console.log(
        `  residuos: ${residue.accounts} cuentas · ${residue.categories} categorías · ${residue.movements} movimientos`,
      );
      if (residue.accounts !== 0 || residue.categories !== 0 || residue.movements !== 0) {
        ok = false;
        console.log("  FALLA la limpieza dejó residuos");
      }
    } catch (error) {
      ok = false;
      console.error(`  FALLA la limpieza: ${error?.message ?? error}`);
    }
    await db.$disconnect();
  }
  process.exit(ok ? 0 : 1);
}

/* ────────────────────────────────────────────────────────────────────────────
 * SQL propio (la verdad independiente de lib/)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Saldo de una cuenta a una fecha, escrito desde la definición del dominio:
 * apertura + ingresos − gastos − transferencias que salen + las que entran.
 * La pata entrante vale `toAmount` cuando las monedas difieren (es el único
 * número en la moneda de destino) y `amount` cuando son iguales.
 */
export async function sqlBalance(accountId, asOf) {
  const rows = await db.$queryRawUnsafe(
    `
    SELECT (
      a."openingBalance"
      + COALESCE((SELECT SUM(m.amount) FROM "Movement" m
                   WHERE m."accountId" = a.id AND m.kind = 'INCOME' AND m.date <= $2::date), 0)
      + COALESCE((SELECT SUM(CASE WHEN src.currency = dst.currency THEN m.amount ELSE m."toAmount" END)
                    FROM "Movement" m
                    JOIN "Account" src ON src.id = m."accountId"
                    JOIN "Account" dst ON dst.id = m."toAccountId"
                   WHERE m."toAccountId" = a.id AND m.kind = 'TRANSFER' AND m.date <= $2::date), 0)
      - COALESCE((SELECT SUM(m.amount) FROM "Movement" m
                   WHERE m."accountId" = a.id AND m.kind = 'EXPENSE' AND m.date <= $2::date), 0)
      - COALESCE((SELECT SUM(m.amount) FROM "Movement" m
                   WHERE m."accountId" = a.id AND m.kind = 'TRANSFER' AND m.date <= $2::date), 0)
    )::text AS balance
    FROM "Account" a WHERE a.id = $1
    `,
    accountId,
    asOf,
  );
  return rows[0]?.balance ?? "0.00";
}

/**
 * Flujo de caja de UNA moneda en una ventana, escrito desde la fórmula del
 * ROADMAP (no desde `movementCashFlow`).
 */
export async function sqlCashFlow(currency, from, to) {
  const rows = await db.$queryRawUnsafe(
    `
    SELECT (
      COALESCE((SELECT SUM(m.amount) FROM "Movement" m JOIN "Account" a ON a.id = m."accountId"
                 WHERE m.kind = 'INCOME' AND a.kind IN ('CASH','BANK') AND a.currency = $1::"Currency"
                   AND m.date BETWEEN $2::date AND $3::date), 0)
      + COALESCE((SELECT SUM(CASE WHEN src.currency = dst.currency THEN m.amount ELSE m."toAmount" END)
                    FROM "Movement" m
                    JOIN "Account" src ON src.id = m."accountId"
                    JOIN "Account" dst ON dst.id = m."toAccountId"
                   WHERE m.kind = 'TRANSFER' AND dst.kind IN ('CASH','BANK') AND dst.currency = $1::"Currency"::"Currency"
                     AND m.date BETWEEN $2::date AND $3::date), 0)
      - COALESCE((SELECT SUM(m.amount) FROM "Movement" m JOIN "Account" a ON a.id = m."accountId"
                   WHERE m.kind = 'EXPENSE' AND a.kind IN ('CASH','BANK') AND a.currency = $1::"Currency"
                     AND m.date BETWEEN $2::date AND $3::date), 0)
      - COALESCE((SELECT SUM(m.amount) FROM "Movement" m JOIN "Account" a ON a.id = m."accountId"
                   WHERE m.kind = 'TRANSFER' AND a.kind IN ('CASH','BANK') AND a.currency = $1::"Currency"
                     AND m.date BETWEEN $2::date AND $3::date), 0)
    )::text AS cashflow
    `,
    currency,
    from,
    to,
  );
  return rows[0]?.cashflow ?? "0.00";
}

/** Totales de un tipo en una moneda y ventana (Σ `amount`, Σ de conteos). */
export async function sqlKindTotals(currency, from, to) {
  const rows = await db.$queryRawUnsafe(
    `
    SELECT m.kind::text AS kind, SUM(m.amount)::text AS total, COUNT(*)::int AS count
      FROM "Movement" m JOIN "Account" a ON a.id = m."accountId"
     WHERE a.currency = $1::"Currency" AND m.date BETWEEN $2::date AND $3::date
     GROUP BY m.kind
    `,
    currency,
    from,
    to,
  );
  const out = {
    INCOME: { total: "0.00", count: 0 },
    EXPENSE: { total: "0.00", count: 0 },
    TRANSFER: { total: "0.00", count: 0 },
  };
  for (const row of rows) {
    out[row.kind] = { total: row.total, count: row.count };
  }
  return out;
}

/** Suma del efecto neto de las transferencias de una moneda (la identidad). */
export async function sqlTransferNet(currency, from, to) {
  const rows = await db.$queryRawUnsafe(
    `
    SELECT (
      COALESCE((SELECT SUM(CASE WHEN src.currency = dst.currency THEN m.amount ELSE m."toAmount" END)
                  FROM "Movement" m
                  JOIN "Account" src ON src.id = m."accountId"
                  JOIN "Account" dst ON dst.id = m."toAccountId"
                 WHERE m.kind = 'TRANSFER' AND dst.currency = $1::"Currency"
                   AND m.date BETWEEN $2::date AND $3::date), 0)
      - COALESCE((SELECT SUM(m.amount) FROM "Movement" m JOIN "Account" a ON a.id = m."accountId"
                   WHERE m.kind = 'TRANSFER' AND a.currency = $1::"Currency"
                     AND m.date BETWEEN $2::date AND $3::date), 0)
    )::text AS net
    `,
    currency,
    from,
    to,
  );
  return rows[0]?.net ?? "0.00";
}

/** Espera a que la app conteste (para no correr baterías contra el vacío). */
export async function waitForApp() {
  const deadline = Date.now() + 90_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: BASE_URL },
        body: JSON.stringify({ password: "ping" }),
      });
      // Cualquier respuesta HTTP (200/401/400) significa que el server vive.
      if (res.status < 500) return;
      lastError = `status ${res.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`La app no respondió en ${BASE_URL}: ${lastError}`);
}
