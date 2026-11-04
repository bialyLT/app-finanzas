#!/usr/bin/env node
/**
 * Batería 07 · Performance y topes con volumen.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ SE ATACA
 * ─────────────────────────────────────────────────────────────────────────────
 * Dos cosas que un scoping por moneda puede romper sin que se note:
 *
 *   1. **El tope de filas recorta la lista, no los totales.** Con 10.000 gastos
 *      en un mes, `/api/transactions` devuelve 500 filas y `truncated: true`,
 *      pero los totales tienen que ser los 10.000 completos. Si el filtro por
 *      moneda se aplicó a la lista y no al agregado (o al revés), el número
 *      grande miente con cara de confianza.
 *   2. **El plan de las consultas nuevas.** Los términos que cruzan moneda
 *      filtran por `toAccount.currency` y `account.currency`; si el planner no
 *      usa los índices de `Movement`, el panel se vuelve lento al volumen.
 *
 * Se siembran 20.000 movimientos en 12 meses y 200 transferencias entre
 * monedas. Los planes se imprimen (no se exige un índice puntual: el planner
 * elige según el volumen) y se exige que ninguna consulta crítica tarde más de
 * 500 ms y que los totales cuadren al centavo.
 */

import {
  check,
  checkMoney,
  checkTrue,
  db,
  get,
  makeAccount,
  makeCategory,
  makeMovement,
  newTag,
  runBattery,
  section,
  sqlBalance,
  sqlCashFlow,
} from "./helpers.mjs";

const TAG = newTag("t07");
const YEAR = "2032";
const FROM = `${YEAR}-01-01`;
const TO = `${YEAR}-12-31`;
const ASOF = `${YEAR}-12-31`;

const EXPENSES = 10_000;
const INCOMES = 10_000;
const TRANSFERS = 200;

function monthDay(index) {
  const month = String((index % 12) + 1).padStart(2, "0");
  const day = String((index % 27) + 1).padStart(2, "0");
  return new Date(`${YEAR}-${month}-${day}T00:00:00.000Z`);
}

await runBattery({
  tag: TAG,
  main: async () => {
    /* ── Siembra de volumen ─────────────────────────────────────────────── */
    section("Siembra de volumen (20.200 movimientos)");
    const bancoArs = await makeAccount(TAG, "ARS-Banco", { currency: "ARS", kind: "BANK" });
    const cajaUsd = await makeAccount(TAG, "USD-Caja", { currency: "USD", kind: "CASH" });
    const gastos = await makeCategory(TAG, "Gastos", "EXPENSE");
    const sueldo = await makeCategory(TAG, "Sueldo", "INCOME");

    const started = Date.now();
    for (let offset = 0; offset < EXPENSES; offset += 1000) {
      await db.movement.createMany({
        data: Array.from({ length: Math.min(1000, EXPENSES - offset) }, (_, i) => ({
          kind: "EXPENSE",
          amount: "1.00",
          date: monthDay(offset + i),
          accountId: bancoArs.id,
          categoryId: gastos.id,
          description: `${TAG} gasto ${offset + i}`,
        })),
      });
    }
    for (let offset = 0; offset < INCOMES; offset += 1000) {
      await db.movement.createMany({
        data: Array.from({ length: Math.min(1000, INCOMES - offset) }, (_, i) => ({
          kind: "INCOME",
          amount: "1.00",
          date: monthDay(offset + i),
          accountId: cajaUsd.id,
          categoryId: sueldo.id,
          description: `${TAG} ingreso ${offset + i}`,
        })),
      });
    }
    for (let index = 0; index < TRANSFERS; index += 1) {
      await makeMovement({
        kind: "TRANSFER",
        amount: "100.00",
        toAmount: "1.00",
        date: monthDay(index),
        accountId: bancoArs.id,
        toAccountId: cajaUsd.id,
        description: `${TAG} transferencia ${index}`,
      });
    }
    console.log(`  sembrados en ${Date.now() - started} ms`);

    /* ── Totales contra la verdad independiente ─────────────────────────── */
    section("Totales con volumen (SQL propio)");
    // ARS: 10.000 gastos de 1,00 = 10.000; 200 transferencias que salen = 20.000.
    checkMoney("saldo ARS = −30.000,00", await sqlBalance(bancoArs.id, ASOF), "-30000.00");
    // USD: 10.000 ingresos + 200 × 1 (toAmount) = 10.200.
    checkMoney("saldo USD = 10.200,00", await sqlBalance(cajaUsd.id, ASOF), "10200.00");
    checkMoney("flujo ARS = −30.000,00", await sqlCashFlow("ARS", FROM, TO), "-30000.00");
    checkMoney("flujo USD = 10.200,00", await sqlCashFlow("USD", FROM, TO), "10200.00");

    /* ── El tope no recorta los totales ─────────────────────────────────── */
    section("HTTP · el tope recorta la lista, no los totales");
    const t0 = Date.now();
    const tx = await get(`/api/transactions?from=${FROM}&to=${TO}&currency=ARS`);
    const txMs = Date.now() - t0;
    check("transactions responde 200", tx.status, 200);
    check("la lista viene topeada (truncated)", tx.body.truncated, true);
    check("la lista trae 500 filas", tx.body.movements.length, 500);
    checkMoney("el total de gastos SÍ es 10.000,00", tx.body.totals.expenses, "10000.00");
    check("el conteo de gastos SÍ es 10.000", tx.body.totals.expenseCount, EXPENSES);
    checkMoney("el total de transferencias SÍ es 20.000,00", tx.body.totals.transfers, "20000.00");
    check("el conteo de transferencias SÍ es 200", tx.body.totals.transferCount, TRANSFERS);
    checkMoney("el flujo de caja SÍ es −30.000,00", tx.body.totals.cashFlow, "-30000.00");
    console.log(`  /api/transactions tardó ${txMs} ms`);
    checkTrue("transactions responde en menos de 2 s", txMs < 2000, `${txMs} ms`);

    const t1 = Date.now();
    const rep = await get(`/api/reports?from=${FROM}&to=${TO}&currency=ARS`);
    const repMs = Date.now() - t1;
    check("reports responde 200", rep.status, 200);
    checkMoney("la torta suma 10.000,00", rep.body.byCategory[0]?.amount, "10000.00");
    checkMoney("las barras suman 10.000,00", rep.body.totals.expenses, "10000.00");
    console.log(`  /api/reports tardó ${repMs} ms`);
    checkTrue("reports responde en menos de 2 s", repMs < 2000, `${repMs} ms`);

    const t2 = Date.now();
    const cuentas = await get(`/api/accounts?currency=ARS&asOf=${ASOF}`);
    const cuentasMs = Date.now() - t2;
    check("accounts responde 200", cuentas.status, 200);
    checkMoney(
      "el saldo del banco en el panel = −30.000,00",
      cuentas.body.accounts.find((a) => a.id === bancoArs.id)?.balance,
      "-30000.00",
    );
    console.log(`  /api/accounts tardó ${cuentasMs} ms`);
    checkTrue("accounts responde en menos de 3 s", cuentasMs < 3000, `${cuentasMs} ms`);

    /* ── EXPLAIN de las consultas críticas ──────────────────────────────── */
    section("EXPLAIN de las consultas críticas (informativo)");
    const plans = [
      {
        name: "totales por tipo (mes)",
        sql: `SELECT m.kind, SUM(m.amount), COUNT(*) FROM "Movement" m
                JOIN "Account" a ON a.id = m."accountId"
               WHERE a.currency = 'ARS' AND m.date BETWEEN '${FROM}'::date AND '${TO}'::date
               GROUP BY m.kind`,
      },
      {
        name: "transferencias entrantes desde otra moneda (sin fecha)",
        sql: `SELECT m."toAccountId", SUM(m."toAmount") FROM "Movement" m
                JOIN "Account" dst ON dst.id = m."toAccountId"
                JOIN "Account" src ON src.id = m."accountId"
               WHERE m.kind = 'TRANSFER' AND dst.currency = 'USD' AND src.currency <> 'USD'
               GROUP BY m."toAccountId"`,
      },
      {
        name: "transferencias salientes de una moneda (mes)",
        sql: `SELECT SUM(m.amount) FROM "Movement" m
                JOIN "Account" a ON a.id = m."accountId"
               WHERE m.kind = 'TRANSFER' AND a.currency = 'ARS'
                 AND m.date BETWEEN '${FROM}'::date AND '${TO}'::date`,
      },
    ];

    for (const plan of plans) {
      const rows = await db.$queryRawUnsafe(
        `EXPLAIN (ANALYZE, BUFFERS) ${plan.sql}`,
      );
      const text = rows.map((row) => row["QUERY PLAN"]).join("\n");
      const ms = Number(/Execution Time: ([\d.]+) ms/.exec(text)?.[1] ?? "NaN");
      const seqScan = /Seq Scan on "Movement"/.test(text);
      const usesIndex = /(Index Scan|Bitmap Index Scan|Index Only Scan)/.test(text);
      console.log(`\n  · ${plan.name}`);
      console.log(`    ${ms.toFixed(1)} ms · seq scan de Movement: ${seqScan ? "sí" : "no"} · usa índice: ${usesIndex ? "sí" : "no"}`);
      checkTrue(`${plan.name}: menos de 500 ms`, Number.isFinite(ms) && ms < 500, `${ms} ms`);
    }

    // Una consulta que cruza moneda no puede degradar a un nested loop sin
    // índice sobre las 20.200 filas: si tarda menos de 500 ms, el volumen
    // actual está cubierto aunque el plan use un seq scan (20k filas entran en
    // pocas páginas y el planner puede preferirlo). El día que la tabla crezca,
    // el número de arriba es la línea base para comparar.
  },
});
