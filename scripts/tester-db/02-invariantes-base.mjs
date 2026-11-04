#!/usr/bin/env node
/**
 * Batería 02 · Los invariantes de la base (F4.1) y su metadata.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ SE ATACA
 * ─────────────────────────────────────────────────────────────────────────────
 * Se intenta GUARDAR lo imposible y se exige que la base lo NIEGUE, con el
 * marcador estable que la app traduce a un 400:
 *
 *   · transferencia entre monedas sin `toAmount`;
 *   · `toAmount` en una transferencia de la misma moneda;
 *   · `toAmount` en un gasto o un ingreso;
 *   · `toAmount` ≤ 0, con 20 dígitos o con 3 decimales;
 *   · cambiar la moneda de una cuenta con historia (por cualquiera de las dos
 *     patas: origen o destino);
 *   · origen = destino;
 *   · índice único de cuenta por (nombre, moneda), no por nombre;
 *   · presupuesto único por (categoría, mes, moneda);
 *   · singleton de `AppSettings` y al menos una moneda habilitada.
 *
 * Además se verifica que cada candado esté en la MIGRACIÓN que lo creó (no en un
 * `db push` posterior) y que la migración esté aplicada en `finanzas_test`.
 *
 * No usa HTTP: acá la pregunta es "¿la base se niega?", no "¿la API explica?".
 */

import { readFileSync } from "node:fs";
import {
  check,
  checkAccepts,
  checkMoney,
  checkRejects,
  checkTrue,
  db,
  makeAccount,
  makeCategory,
  makeMovement,
  newTag,
  runBattery,
  section,
} from "./helpers.mjs";

const TAG = newTag("t02");
const day = (value) => new Date(`${value}T00:00:00.000Z`);

await runBattery({
  tag: TAG,
  withHttp: false,
  main: async () => {
    /* ── Escenario mínimo ───────────────────────────────────────────────── */
    const ars = await makeAccount(TAG, "ARS", { currency: "ARS", kind: "BANK" });
    const ars2 = await makeAccount(TAG, "ARS-2", { currency: "ARS", kind: "CASH" });
    const usd = await makeAccount(TAG, "USD", { currency: "USD", kind: "BANK" });
    const gastos = await makeCategory(TAG, "Gastos", "EXPENSE");
    const sueldo = await makeCategory(TAG, "Sueldo", "INCOME");

    const base = (extra) => ({
      date: day("2031-06-01"),
      description: `${TAG} sonda`,
      ...extra,
    });

    /* ── 1 · La forma de una transferencia entre monedas ────────────────── */
    section("Transferencias entre monedas");

    await checkRejects(
      "ARS→USD sin toAmount: la base la rechaza",
      () =>
        makeMovement(
          base({ kind: "TRANSFER", amount: "120000", accountId: ars.id, toAccountId: usd.id }),
        ),
      "[finanzas:transferencia_entre_monedas_sin_monto_destino]",
    );

    await checkRejects(
      "ARS→ARS con toAmount: la base la rechaza",
      () =>
        makeMovement(
          base({
            kind: "TRANSFER",
            amount: "10000",
            toAmount: "10000",
            accountId: ars.id,
            toAccountId: ars2.id,
          }),
        ),
      "[finanzas:monto_destino_en_misma_moneda]",
    );

    const cruce = await checkAccepts("ARS→USD con toAmount: se acepta", () =>
      makeMovement(
        base({
          kind: "TRANSFER",
          amount: "120000",
          toAmount: "100",
          accountId: ars.id,
          toAccountId: usd.id,
        }),
      ),
    );
    checkTrue("la transferencia válida tiene id", Boolean(cruce?.id));

    await checkAccepts("ARS→ARS sin toAmount: se acepta", () =>
      makeMovement(
        base({ kind: "TRANSFER", amount: "10000", accountId: ars.id, toAccountId: ars2.id }),
      ),
    );

    await checkRejects(
      "TRANSFER a la misma cuenta: la base la rechaza",
      () =>
        makeMovement(
          base({ kind: "TRANSFER", amount: "1000", accountId: ars.id, toAccountId: ars.id }),
        ),
      "movement_transfer_to_other_account",
    );

    /* ── 2 · toAmount fuera de lugar o imposible ────────────────────────── */
    section("toAmount imposible");

    await checkRejects(
      "EXPENSE con toAmount: la base lo rechaza",
      () =>
        makeMovement(
          base({ kind: "EXPENSE", amount: "100", toAmount: "1", accountId: ars.id, categoryId: gastos.id }),
        ),
      "movement_to_amount_only_on_transfer",
    );

    await checkRejects(
      "INCOME con toAmount: la base lo rechaza",
      () =>
        makeMovement(
          base({ kind: "INCOME", amount: "100", toAmount: "1", accountId: ars.id, categoryId: sueldo.id }),
        ),
      "movement_to_amount_only_on_transfer",
    );

    for (const [label, value] of [
      ["cero", "0"],
      ["negativo", "-5"],
    ]) {
      await checkRejects(
        `toAmount ${label}: la base lo rechaza`,
        () =>
          makeMovement(
            base({
              kind: "TRANSFER",
              amount: "100",
              toAmount: value,
              accountId: ars.id,
              toAccountId: usd.id,
            }),
          ),
        "movement_to_amount_positive",
      );
    }

    await checkRejects(
      "toAmount con 20 dígitos: la base lo rechaza (no lo trunca)",
      () =>
        makeMovement(
          base({
            kind: "TRANSFER",
            amount: "100",
            toAmount: "12345678901234567890",
            accountId: ars.id,
            toAccountId: usd.id,
          }),
        ),
    );

    await checkRejects(
      "amount con 20 dígitos: la base lo rechaza (no lo trunca)",
      () =>
        makeMovement(
          base({
            kind: "EXPENSE",
            amount: "12345678901234567890",
            accountId: ars.id,
            categoryId: gastos.id,
          }),
        ),
    );

    // Tres decimales: `numeric(18,2)` redondea. Se documenta el valor guardado
    // (no es un invariante: es la precisión declarada de la columna).
    const tresDecimales = await checkAccepts(
      "toAmount con 3 decimales: se acepta (numeric(18,2) redondea)",
      () =>
        makeMovement(
          base({
            kind: "TRANSFER",
            amount: "100",
            toAmount: "100.005",
            accountId: ars.id,
            toAccountId: usd.id,
          }),
        ),
    );
    if (tresDecimales) {
      const stored = await db.movement.findUnique({
        where: { id: tresDecimales.id },
        select: { toAmount: true },
      });
      console.log(`        (toAmount "100.005" quedó guardado como ${stored?.toAmount.toFixed(2)})`);
      checkMoney("el valor guardado es 100,01", stored?.toAmount.toFixed(2), "100.01");
    }

    /* ── 3 · UPDATE: la puerta de atrás ─────────────────────────────────── */
    section("UPDATE de una transferencia (el trigger también corre acá)");

    const mismo = await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "10000",
        date: day("2031-06-02"),
        accountId: ars.id,
        toAccountId: ars2.id,
        description: `${TAG} misma moneda`,
      },
    });
    await checkRejects(
      "cambiar el destino a otra moneda sin toAmount: se rechaza",
      () => db.movement.update({ where: { id: mismo.id }, data: { toAccountId: usd.id } }),
      "[finanzas:transferencia_entre_monedas_sin_monto_destino]",
    );

    await checkRejects(
      "agregar toAmount sin cambiar el destino: se rechaza",
      () => db.movement.update({ where: { id: mismo.id }, data: { toAmount: "100" } }),
      "[finanzas:monto_destino_en_misma_moneda]",
    );

    await checkRejects(
      "cambiar el ORIGEN de la transferencia entre monedas a una cuenta USD: se rechaza",
      () => db.movement.update({ where: { id: cruce.id }, data: { accountId: usd.id } }),
      "[finanzas:monto_destino_en_misma_moneda]",
    );

    await checkRejects(
      "poner toAmount en 0 con un UPDATE: se rechaza",
      () => db.movement.update({ where: { id: cruce.id }, data: { toAmount: "0" } }),
      "movement_to_amount_positive",
    );

    await checkRejects(
      "quitar el toAmount de una transferencia entre monedas: se rechaza",
      () => db.movement.update({ where: { id: cruce.id }, data: { toAmount: null } }),
      "[finanzas:transferencia_entre_monedas_sin_monto_destino]",
    );

    /* ── 4 · La moneda de una cuenta con historia es inmutable ──────────── */
    section("Moneda de una cuenta con historia");

    await checkRejects(
      "cambiar la moneda del ORIGEN de un movimiento: se rechaza",
      () => db.account.update({ where: { id: ars.id }, data: { currency: "USD" } }),
      "[finanzas:cuenta_en_uso_no_cambia_moneda]",
    );

    await checkRejects(
      "cambiar la moneda del DESTINO de una transferencia: se rechaza",
      () => db.account.update({ where: { id: usd.id }, data: { currency: "ARS" } }),
      "[finanzas:cuenta_en_uso_no_cambia_moneda]",
    );

    const vacia = await makeAccount(TAG, "Vacía", { currency: "ARS" });
    const corregida = await checkAccepts(
      "una cuenta SIN historia puede corregir su moneda",
      () => db.account.update({ where: { id: vacia.id }, data: { currency: "USD" } }),
    );
    check("la corrección quedó guardada", corregida?.currency, "USD");
    await checkAccepts("y se puede volver a corregir", () =>
      db.account.update({ where: { id: vacia.id }, data: { currency: "ARS" } }),
    );

    /* ── 5 · Unicidad por (nombre, moneda) ──────────────────────────────── */
    section("Unicidad de cuentas por (nombre, moneda)");

    await checkRejects(
      "mismo nombre en la MISMA moneda: se rechaza",
      () =>
        db.account.create({
          data: { name: `${TAG} ARS`, kind: "CASH", currency: "ARS" },
        }),
      "Unique constraint failed",
    );

    const homonima = await checkAccepts(
      "mismo nombre en OTRA moneda: se acepta",
      () =>
        db.account.create({
          data: { name: `${TAG} ARS`, kind: "CASH", currency: "USD" },
        }),
    );
    check("la homónima quedó en USD", homonima?.currency, "USD");

    /* ── 6 · Presupuestos por moneda ────────────────────────────────────── */
    section("Presupuestos por (categoría, mes, moneda)");
    const mes = day("2031-07-01");
    await checkAccepts("presupuesto ARS: se acepta", () =>
      db.budget.create({
        data: { categoryId: gastos.id, month: mes, amount: "1000", currency: "ARS" },
      }),
    );
    await checkAccepts("el MISMO mes y categoría en USD: se acepta", () =>
      db.budget.create({
        data: { categoryId: gastos.id, month: mes, amount: "10", currency: "USD" },
      }),
    );
    await checkRejects(
      "el mismo presupuesto repetido en ARS: se rechaza",
      () =>
        db.budget.create({
          data: { categoryId: gastos.id, month: mes, amount: "2000", currency: "ARS" },
        }),
      "Unique constraint failed",
    );

    /* ── 7 · AppSettings singleton y no vacío ───────────────────────────── */
    section("AppSettings");
    await checkRejects(
      "una segunda fila de preferencias: se rechaza (PK y singleton)",
      () =>
        db.appSettings.create({
          data: { id: 2, enabledCurrencies: ["ARS"] },
        }),
    );
    const settingsRows = await db.appSettings.count();
    check("AppSettings sigue teniendo UNA sola fila", settingsRows, 1);
    await checkRejects(
      "quedarse sin ninguna moneda habilitada: se rechaza",
      () =>
        db.appSettings.update({
          where: { id: 1 },
          data: { enabledCurrencies: [] },
        }),
      "app_settings_at_least_one_currency",
    );
    const settings = await db.appSettings.findUnique({ where: { id: 1 } });
    check("la fila 1 sigue con ARS habilitado", settings?.enabledCurrencies.join(","), "ARS");

    /* ── 8 · Entradas hostiles ──────────────────────────────────────────── */
    section("Entradas hostiles en la base");
    await checkRejects(
      "descripción con byte NUL: la base la rechaza",
      () =>
        makeMovement(
          base({
            kind: "EXPENSE",
            amount: "1",
            accountId: ars.id,
            categoryId: gastos.id,
            description: `${TAG} nul\u0000byte`,
          }),
        ),
    );
    const stillAlive = await db.movement.count({ where: { description: { startsWith: TAG } } });
    checkTrue("después del NUL la conexión sigue sana", stillAlive >= 0);

    // Un texto gigante no viola ningún invariante (las columnas son TEXT): se
    // documenta que la base lo acepta y que el tope, si existe, vive en la API.
    const gigante = "x".repeat(10_000);
    const conGigante = await checkAccepts("un texto de 10.000 caracteres se acepta", () =>
      makeMovement(
        base({
          kind: "EXPENSE",
          amount: "1",
          accountId: ars.id,
          categoryId: gastos.id,
          description: `${TAG} ${gigante}`,
        }),
      ),
    );
    checkTrue("el texto gigante se guardó entero", Boolean(conGigante?.id));

    /* ── 9 · Metadata: los candados y dónde viven ───────────────────────── */
    section("Metadata de la base");

    const constraints = await db.$queryRawUnsafe(
      `SELECT conname, contype::text AS contype, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'public."Movement"'::regclass AND conname LIKE 'movement_%'`,
    );
    const byName = new Map(constraints.map((row) => [row.conname, row]));
    checkTrue(
      "existe movement_to_amount_positive (CHECK)",
      byName.get("movement_to_amount_positive")?.contype === "c",
    );
    checkTrue(
      "existe movement_to_amount_only_on_transfer (CHECK)",
      byName.get("movement_to_amount_only_on_transfer")?.contype === "c",
    );
    checkTrue(
      "el CHECK de positividad exige > 0",
      /toAmount.*>.*0/i.test(byName.get("movement_to_amount_positive")?.def ?? ""),
      byName.get("movement_to_amount_positive")?.def,
    );

    const triggers = await db.$queryRawUnsafe(
      `SELECT tgname, tgenabled::text AS enabled
         FROM pg_trigger
        WHERE tgrelid = 'public."Movement"'::regclass AND NOT tgisinternal`,
    );
    const triggerNames = triggers.map((row) => row.tgname);
    checkTrue(
      "existe el trigger movement_currency_shape_check y está habilitado",
      triggers.some((row) => row.tgname === "movement_currency_shape_check" && row.enabled === "O"),
      JSON.stringify(triggerNames),
    );

    const accountTriggers = await db.$queryRawUnsafe(
      `SELECT tgname, tgenabled::text AS enabled
         FROM pg_trigger
        WHERE tgrelid = 'public."Account"'::regclass AND NOT tgisinternal`,
    );
    checkTrue(
      "existe el trigger account_currency_immutable_check y está habilitado",
      accountTriggers.some(
        (row) => row.tgname === "account_currency_immutable_check" && row.enabled === "O",
      ),
    );

    const indexes = await db.$queryRawUnsafe(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename IN ('Account','Budget') AND indexname LIKE '%currency%'`,
    );
    const indexByName = new Map(indexes.map((row) => [row.indexname, row.indexdef]));
    checkTrue(
      "el único de cuentas es (name, currency)",
      /\(name, currency\)/i.test(indexByName.get("Account_name_currency_key") ?? ""),
      indexByName.get("Account_name_currency_key"),
    );
    checkTrue(
      "el único de presupuestos es (categoryId, month, currency)",
      /\(\s*"?categoryId"?,\s*"?month"?,\s*"?currency"?\s*\)/i.test(
        indexByName.get("Budget_categoryId_month_currency_key") ?? "",
      ),
      indexByName.get("Budget_categoryId_month_currency_key"),
    );

    const appSettingsConstraints = await db.$queryRawUnsafe(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'public."AppSettings"'::regclass`,
    );
    const appNames = appSettingsConstraints.map((row) => row.conname);
    checkTrue("existe app_settings_singleton", appNames.includes("app_settings_singleton"));
    checkTrue(
      "existe app_settings_at_least_one_currency",
      appNames.includes("app_settings_at_least_one_currency"),
    );

    /* ── 10 · La migración aplicada y su archivo ────────────────────────── */
    section("Migración");

    const applied = await db.$queryRawUnsafe(
      `SELECT migration_name, finished_at, rolled_back_at
         FROM _prisma_migrations ORDER BY started_at`,
    );
    const monedas = applied.find((row) => row.migration_name === "20261104120000_fase4_monedas");
    checkTrue("la migración de monedas está aplicada", Boolean(monedas?.finished_at));
    checkTrue("no está revertida", monedas?.rolled_back_at === null);
    const fallidas = applied.filter((row) => row.finished_at === null && row.rolled_back_at === null);
    check("no hay migraciones fallidas a medias", fallidas.length, 0);

    const sql = readFileSync(
      new URL("../../prisma/migrations/20261104120000_fase4_monedas/migration.sql", import.meta.url),
      "utf8",
    );
    for (const name of [
      "movement_to_amount_positive",
      "movement_to_amount_only_on_transfer",
      "movement_currency_shape_check",
      "account_currency_immutable_check",
      "Account_name_currency_key",
      "Budget_categoryId_month_currency_key",
      "app_settings_singleton",
      "app_settings_at_least_one_currency",
    ]) {
      checkTrue(`el archivo de la migración crea ${name}`, sql.includes(name));
    }
  },
});
