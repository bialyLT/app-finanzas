#!/usr/bin/env node
/**
 * 02 · EL LOCK DE `PATCH /api/settings` — ¿serializa? ¿colisiona? ¿se libera?
 *                           y ¿qué invariante deja abierta?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ MIDE
 * ─────────────────────────────────────────────────────────────────────────────
 * La ruta toma `pg_advisory_xact_lock(442004)` antes de contar cuentas y
 * escribir la lista de monedas. Este script corre contra `finanzas_test` y
 * verifica, con dos conexiones reales:
 *
 *   1. La sentencia EXACTA de la ruta adquiere el lock (no es un no-op).
 *   2. El lock EXCLUYE de verdad (un segundo intento simultáneo falla).
 *   3. No colisiona con el otro advisory lock de la app (`lib/csv-import.ts`,
 *      73672101): son claves distintas del mismo espacio.
 *   4. La forma de dos claves `(442004, 0)` es OTRO espacio (no colisiona).
 *   5. Se libera solo al commitear y al revertir (no queda pegado).
 *   6. NO frena el alta de una cuenta: es el agujero que la propia ruta
 *      documenta como diferido.
 *   7. La invariante "ninguna cuenta en una moneda apagada" NO se sostiene:
 *      a) bajo la carrera modelada con las sentencias de la ruta,
 *      b) por un camino DETERMINISTA sin concurrencia (`PATCH /api/accounts`
 *         puede mover una cuenta sin historia a una moneda apagada).
 *
 * Los checks 7a y 7b se declaran como fallas A PROPÓSITO: miden la invariante
 * deseada, no el comportamiento actual. Si mañana se cierran, el script pasa a
 * verde sin que nadie edite la batería.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CÓMO SE CORRE
 * ─────────────────────────────────────────────────────────────────────────────
 *   node scripts/tester-quality/02-lock-settings.mjs
 *
 * Toca SÓLO `finanzas_test` (aborta si el DSN no la nombra), y deja la base
 * como la encontró: guarda `enabledCurrencies`, borra las cuentas que crea por
 * id y restaura la fila de configuración. Imprime `RESULT ok=N fail=M`.
 */

import { PrismaClient } from "@prisma/client";

try {
  process.loadEnvFile();
} catch {
  // Sin `.env` el guard de abajo aborta con un mensaje útil.
}

const url = process.env.DATABASE_URL_TEST;

let ok = 0;
const fails = [];

function check(name, condition, detail = "") {
  if (condition) {
    ok += 1;
    console.log(`ok   ${name}`);
  } else {
    fails.push(name);
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const SETTINGS_LOCK_KEY = 442004; // app/api/settings/route.ts
const CSV_LOCK_KEY = 73672101; // lib/csv-import.ts

if (!url) {
  console.error("Falta DATABASE_URL_TEST. No se toca nada.");
  process.exit(2);
}
if (!/finanzas_test/.test(url)) {
  console.error(
    `DATABASE_URL_TEST no apunta a finanzas_test (${url.replace(/:[^:@/]+@/, ":***@")}). Abortado.`,
  );
  process.exit(2);
}

const a = new PrismaClient({ datasourceUrl: url });
const b = new PrismaClient({ datasourceUrl: url });

/** ¿La clave está libre AHORA, desde una transacción nueva? */
async function isFree(client, sql) {
  const rows = await client.$queryRawUnsafe(sql);
  return rows[0].free === true;
}

const free1 = (client, key) =>
  isFree(client, `SELECT pg_try_advisory_xact_lock(${key}) AS free`);
const free2 = (client, k1, k2) =>
  isFree(client, `SELECT pg_try_advisory_xact_lock(${k1}, ${k2}) AS free`);

const createdIds = [];
let savedEnabled = null;
let before = 0;

try {
  /* ── 0 · Estado de partida ─────────────────────────────────────────────── */
  const settings = await a.appSettings.findUnique({ where: { id: 1 } });
  savedEnabled = settings?.enabledCurrencies ?? ["ARS"];
  before = await a.account.count();
  console.log(
    `info finanzas_test: ${before} cuentas, enabledCurrencies=${JSON.stringify(savedEnabled)}`,
  );

  /* ── 1 · La sentencia exacta de la ruta adquiere el lock ───────────────── */
  // Misma forma que la ruta: `$executeRaw` con un template y el número suelto.
  let releaseHolder;
  const holder = new Promise((resolve) => {
    releaseHolder = resolve;
  });
  let holderReady;
  const holderAcquired = new Promise((resolve) => {
    holderReady = resolve;
  });

  const holderTx = a
    .$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SETTINGS_LOCK_KEY})`;
      holderReady();
      await holder;
    })
    .catch(() => {});

  await holderAcquired;

  check(
    "la sentencia exacta de la ruta (pg_advisory_xact_lock(442004)) toma el lock",
    (await free1(b, SETTINGS_LOCK_KEY)) === false,
    "un segundo intento obtuvo el lock: la llamada de la ruta no lockea",
  );

  /* ── 2 · No colisiona con el lock del CSV ─────────────────────────────── */
  check(
    `no colisiona con el lock de lib/csv-import.ts (${CSV_LOCK_KEY})`,
    (await free1(b, CSV_LOCK_KEY)) === true,
    "el lock de la configuración bloquea la importación CSV: colisión de claves",
  );

  /* ── 3 · La forma de dos claves es otro espacio ────────────────────────── */
  check(
    "la forma (442004, 0) es otro espacio de claves y no se bloquea",
    (await free2(b, SETTINGS_LOCK_KEY, 0)) === true,
    "una clave de dos enteros se bloqueó con la clave de un bigint",
  );

  /* ── 4 · El lock no frena el alta de cuentas (agujero declarado) ───────── */
  const racing = await b.account.create({
    data: { name: "tq-race-usd", kind: "CASH", currency: "USD", openingBalance: "0" },
  });
  createdIds.push(racing.id);
  check(
    "el lock de la configuración NO frena un INSERT de cuenta (ventana de la carrera)",
    racing.id !== undefined,
  );

  /* ── 5 · Se libera al commitear ────────────────────────────────────────── */
  releaseHolder();
  await holderTx;
  check(
    "el lock se libera solo al terminar la transacción",
    (await free1(b, SETTINGS_LOCK_KEY)) === true,
    "el lock quedó tomado después del commit: bloquearía el próximo PATCH",
  );

  /* ── 6 · Se libera al revertir ─────────────────────────────────────────── */
  await a
    .$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SETTINGS_LOCK_KEY})`;
      throw new Error("rollback a propósito");
    })
    .catch(() => {});
  check(
    "el lock se libera al revertir la transacción",
    (await free1(b, SETTINGS_LOCK_KEY)) === true,
    "el lock sobrevivió al rollback",
  );

  /* ── 7a · La carrera modelada, con las sentencias de la ruta ───────────── */
  // A(settings) = lock → count de la moneda que se apaga → upsert → commit
  // B(alta)     = INSERT de una cuenta en esa moneda → commit
  // Sin nada que serialice A contra B, el orden count→insert→upsert deja una
  // cuenta viva en una moneda apagada. La precondición es 0 cuentas en USD
  // (si ya hubiera una, la ruta devolvería 409 y no habría nada que probar).
  await a.account.deleteMany({ where: { id: { in: createdIds } } });
  createdIds.length = 0;
  await a.appSettings.update({ where: { id: 1 }, data: { enabledCurrencies: ["ARS"] } });
  const usdBefore = await a.account.count({ where: { currency: "USD" } });

  let insertDone;
  const insertDoneP = new Promise((resolve) => {
    insertDone = resolve;
  });
  let countDone;
  const countDoneP = new Promise((resolve) => {
    countDone = resolve;
  });

  const settingsTx = a.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SETTINGS_LOCK_KEY})`;
    const enDolares = await tx.account.count({ where: { currency: "USD" } });
    countDone();
    await insertDoneP; // le da tiempo a B de commitear
    if (enDolares === 0) {
      await tx.appSettings.upsert({
        where: { id: 1 },
        update: { enabledCurrencies: ["ARS"] },
        create: { id: 1, enabledCurrencies: ["ARS"] },
      });
    }
    return enDolares;
  });

  const created = await (async () => {
    // El orden importa: se espera a que la ruta haya CONTADO (ya con el lock)
    // y recién ahí entra el alta. Si el alta gana antes del count, la ruta
    // devolvería 409 y no habría nada que demostrar.
    await countDoneP;
    return b.account.create({
      data: { name: "tq-race-2-usd", kind: "CASH", currency: "USD", openingBalance: "0" },
    });
  })();
  createdIds.push(created.id);
  insertDone();

  const countedAt = await settingsTx;
  const after = await a.appSettings.findUnique({ where: { id: 1 } });
  const accountsInDisabled = await a.account.count({ where: { currency: "USD" } });
  console.log(
    `info carrera: usdBefore=${usdBefore} countedAt=${countedAt} usdDespues=${accountsInDisabled} enabled=${JSON.stringify(after.enabledCurrencies)}`,
  );

  check(
    "la invariante «ninguna cuenta en una moneda apagada» se sostiene en la carrera de alta",
    !(
      countedAt === usdBefore &&
      accountsInDisabled > countedAt &&
      after.enabledCurrencies.includes("USD") === false
    ),
    `count=${countedAt} → cuentas USD=${accountsInDisabled} → enabledCurrencies=${JSON.stringify(after.enabledCurrencies)}`,
  );

  /* ── 7b · El mismo estado, sin concurrencia (camino determinista) ─────── */
  // `PATCH /api/accounts` acepta `currency` y sólo valida la FORMA; la regla de
  // "sin historia" la hace cumplir un trigger de la base. Nadie mira si la
  // moneda está habilitada, así que una cuenta sin movimientos se muda a una
  // moneda apagada sin ninguna carrera.
  await a.appSettings.update({ where: { id: 1 }, data: { enabledCurrencies: ["ARS"] } });
  const movable = await a.account.create({
    data: { name: "tq-movable-ars", kind: "CASH", currency: "ARS", openingBalance: "0" },
  });
  createdIds.push(movable.id);

  let movedOk = false;
  let movedError = "";
  try {
    await a.account.update({
      where: { id: movable.id },
      data: { currency: "USD" },
    });
    movedOk = true;
  } catch (error) {
    movedError = error?.message?.slice(0, 120) ?? String(error);
  }
  const enabledNow = await a.appSettings.findUnique({ where: { id: 1 } });
  check(
    "la invariante se sostiene SIN concurrencia (mudar una cuenta a una moneda apagada)",
    !(movedOk && !enabledNow.enabledCurrencies.includes("USD")),
    movedOk
      ? `la cuenta se mudó a USD con enabledCurrencies=${JSON.stringify(enabledNow.enabledCurrencies)}`
      : movedError,
  );

  // El caso del PATCH idempotente se mide contra la RUTA (no contra este
  // modelo) en `scripts/tester-quality/repro-settings.repro.ts`.
} finally {
  /* ── Restauración ──────────────────────────────────────────────────────── */
  if (createdIds.length > 0) {
    await a.account.deleteMany({ where: { id: { in: createdIds } } }).catch(() => {});
  }
  if (savedEnabled) {
    await a.appSettings
      .update({ where: { id: 1 }, data: { enabledCurrencies: savedEnabled } })
      .catch(() => {});
  }
  const after = await a.appSettings.findUnique({ where: { id: 1 } });
  const cuentas = await a.account.count();
  const limpio =
    JSON.stringify(after?.enabledCurrencies) === JSON.stringify(savedEnabled) &&
    cuentas === before;
  console.log(
    `\ninfo restauración: enabledCurrencies=${JSON.stringify(after?.enabledCurrencies)} cuentas=${cuentas} ${limpio ? "OK" : "REVISAR"}`,
  );
  await a.$disconnect();
  await b.$disconnect();

  console.log(`\nRESULT ok=${ok} fail=${fails.length}`);
  if (fails.length > 0) {
    for (const name of fails) console.log(`  ✗ ${name}`);
    process.exit(1);
  }
}
