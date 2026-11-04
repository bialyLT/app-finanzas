#!/usr/bin/env node
/**
 * Batería 01 · Transferencias entre monedas, totales, torta/barras y reconciliación.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ SE ATACA
 * ─────────────────────────────────────────────────────────────────────────────
 * La promesa de F4.2: ninguna consulta suma pesos con dólares. El escenario
 * mezcla las dos monedas a propósito y en las DOS direcciones, porque el error
 * caro no es "no filtra" sino "la pata entrante usa el monto equivocado":
 *
 *   · ARS→USD: salen 120.000 ARS y entran 100 USD. La cuenta destino tiene que
 *     acreditar 100, no 120.000.
 *   · USD→ARS: salen 50 USD y entran 60.000 ARS. La pata entrante vale
 *     `toAmount`; la saliente, `amount`.
 *
 * Los números esperados están calculados A MANO (comentados al lado de cada
 * assertion) y se contrastan con SQL propio, no con las funciones de `lib/`.
 * Después se comparan contra la respuesta HTTP real de los endpoints.
 *
 * Mes elegido: 2031-03 (lejos de la siembra del smoke y de "hoy") para que el
 * período no tenga datos de otras corridas. El patrimonio se mide como DELTA
 * contra una línea base capturada antes de sembrar: así la batería no depende de
 * lo que otra suite haya dejado en `finanzas_test`.
 */

import {
  api,
  cents,
  centsToMoney,
  check,
  checkDeep,
  checkMoney,
  checkTrue,
  get,
  makeAccount,
  makeCategory,
  makeMovement,
  newTag,
  runBattery,
  section,
  sqlBalance,
  sqlCashFlow,
  sqlKindTotals,
  sqlTransferNet,
} from "./helpers.mjs";

const MES = "2031-03";
const FROM = `${MES}-01`;
const TO = `${MES}-31`;
const ASOF = `${MES}-31`;
const TAG = newTag("t01");

await runBattery({
  tag: TAG,
  main: async () => {
    /* ── Línea base del patrimonio (delta) ───────────────────────────────── */
    section("Línea base del patrimonio");
    const baseArs = await get(`/api/accounts?currency=ARS&asOf=${ASOF}`);
    const baseUsd = await get(`/api/accounts?currency=USD&asOf=${ASOF}`);
    check("línea base ARS responde 200", baseArs.status, 200);
    check("línea base USD responde 200", baseUsd.status, 200);
    const netBaseArs = cents(baseArs.body.netWorth.net);
    const netBaseUsd = cents(baseUsd.body.netWorth.net);
    console.log(`  base ARS ${centsToMoney(netBaseArs)} · base USD ${centsToMoney(netBaseUsd)}`);

    /* ── Siembra ─────────────────────────────────────────────────────────── */
    section("Siembra del escenario mixto");
    const bancoArs = await makeAccount(TAG, "ARS-Banco", {
      currency: "ARS",
      kind: "BANK",
      openingBalance: "100000",
    });
    const cajaArs = await makeAccount(TAG, "ARS-Caja", {
      currency: "ARS",
      kind: "CASH",
      openingBalance: "5000",
    });
    const visaArs = await makeAccount(TAG, "ARS-Visa", {
      currency: "ARS",
      kind: "CREDIT_CARD",
    });
    const cajaUsd = await makeAccount(TAG, "USD-Caja", {
      currency: "USD",
      kind: "CASH",
      openingBalance: "100",
    });
    const bancoUsd = await makeAccount(TAG, "USD-Banco", {
      currency: "USD",
      kind: "BANK",
      openingBalance: "50",
      archived: true,
    });
    const visaUsd = await makeAccount(TAG, "USD-Visa", {
      currency: "USD",
      kind: "CREDIT_CARD",
    });

    const gastos = await makeCategory(TAG, "Gastos", "EXPENSE");
    const gastosUsd = await makeCategory(TAG, "Gastos USD", "EXPENSE");
    const sueldo = await makeCategory(TAG, "Sueldo", "INCOME");

    const mov = await Promise.all([
      // 1 · ingreso ARS 800.000
      makeMovement({
        kind: "INCOME",
        amount: "800000",
        date: new Date(`${FROM}T00:00:00.000Z`),
        accountId: bancoArs.id,
        categoryId: sueldo.id,
        description: `${TAG} ingreso ARS`,
      }),
      // 2 · gasto ARS 250.000 (banco)
      makeMovement({
        kind: "EXPENSE",
        amount: "250000",
        date: new Date("2031-03-03T00:00:00.000Z"),
        accountId: bancoArs.id,
        categoryId: gastos.id,
        description: `${TAG} gasto ARS banco`,
      }),
      // 3 · ARS→USD: salen 120.000, llegan 100
      makeMovement({
        kind: "TRANSFER",
        amount: "120000",
        toAmount: "100",
        date: new Date("2031-03-05T00:00:00.000Z"),
        accountId: bancoArs.id,
        toAccountId: cajaUsd.id,
        description: `${TAG} cambio ARS a USD`,
      }),
      // 4 · USD→ARS: salen 50, llegan 60.000
      makeMovement({
        kind: "TRANSFER",
        amount: "50",
        toAmount: "60000",
        date: new Date("2031-03-06T00:00:00.000Z"),
        accountId: cajaUsd.id,
        toAccountId: cajaArs.id,
        description: `${TAG} cambio USD a ARS`,
      }),
      // 5 · ingreso USD 1.000
      makeMovement({
        kind: "INCOME",
        amount: "1000",
        date: new Date("2031-03-07T00:00:00.000Z"),
        accountId: cajaUsd.id,
        categoryId: sueldo.id,
        description: `${TAG} ingreso USD`,
      }),
      // 6 · gasto USD 400
      makeMovement({
        kind: "EXPENSE",
        amount: "400",
        date: new Date("2031-03-08T00:00:00.000Z"),
        accountId: cajaUsd.id,
        categoryId: gastos.id,
        description: `${TAG} gasto USD caja`,
      }),
      // 7 · transferencia ARS→ARS: 10.000 (no debe tocar el flujo USD)
      makeMovement({
        kind: "TRANSFER",
        amount: "10000",
        date: new Date("2031-03-09T00:00:00.000Z"),
        accountId: bancoArs.id,
        toAccountId: cajaArs.id,
        description: `${TAG} pase ARS`,
      }),
      // 8 · gasto con tarjeta ARS 3.000 (no toca el flujo de caja)
      makeMovement({
        kind: "EXPENSE",
        amount: "3000",
        date: new Date("2031-03-10T00:00:00.000Z"),
        accountId: visaArs.id,
        categoryId: gastos.id,
        description: `${TAG} gasto tarjeta ARS`,
      }),
      // 9 · gasto USD 200 con una categoría que SÓLO existe en dólares
      makeMovement({
        kind: "EXPENSE",
        amount: "200",
        date: new Date("2031-03-11T00:00:00.000Z"),
        accountId: visaUsd.id,
        categoryId: gastosUsd.id,
        description: `${TAG} gasto tarjeta USD`,
      }),
    ]);
    const gastoUsd200 = mov[8];
    check("se sembraron 9 movimientos", mov.length, 9);

    /* ── La verdad independiente: SQL propio ─────────────────────────────── */
    section("Saldo de cada cuenta (SQL propio)");
    // Banco ARS: 100.000 + 800.000 − 250.000 − 120.000 − 10.000 = 520.000
    checkMoney("ARS-Banco = 520.000,00", await sqlBalance(bancoArs.id, ASOF), "520000.00");
    // Caja ARS: 5.000 + 60.000 (toAmount) + 10.000 = 75.000
    checkMoney("ARS-Caja = 75.000,00 (entra toAmount, no 50)", await sqlBalance(cajaArs.id, ASOF), "75000.00");
    checkMoney("ARS-Visa = −3.000,00", await sqlBalance(visaArs.id, ASOF), "-3000.00");
    // Caja USD: 100 + 100 (toAmount) − 50 + 1.000 − 400 = 750
    checkMoney("USD-Caja = 750,00 (no 120.650)", await sqlBalance(cajaUsd.id, ASOF), "750.00");
    checkMoney("USD-Banco archivada = 50,00", await sqlBalance(bancoUsd.id, ASOF), "50.00");
    checkMoney("USD-Visa = −200,00", await sqlBalance(visaUsd.id, ASOF), "-200.00");

    section("Flujo de caja (SQL propio)");
    // ARS: (800.000 + 10.000 + 60.000) − (250.000 + 120.000 + 10.000) = 490.000
    checkMoney("flujo ARS = 490.000,00", await sqlCashFlow("ARS", FROM, TO), "490000.00");
    // USD: (1.000 + 100) − (400 + 50) = 650
    checkMoney("flujo USD = 650,00", await sqlCashFlow("USD", FROM, TO), "650.00");

    section("Totales por tipo (SQL propio)");
    const arsKinds = await sqlKindTotals("ARS", FROM, TO);
    checkMoney("Σ INCOME ARS = 800.000,00", arsKinds.INCOME.total, "800000.00");
    check("conteo INCOME ARS = 1", arsKinds.INCOME.count, 1);
    checkMoney("Σ EXPENSE ARS = 253.000,00", arsKinds.EXPENSE.total, "253000.00");
    check("conteo EXPENSE ARS = 2", arsKinds.EXPENSE.count, 2);
    checkMoney("Σ TRANSFER ARS = 130.000,00 (sólo las que salen)", arsKinds.TRANSFER.total, "130000.00");
    check("conteo TRANSFER ARS = 2", arsKinds.TRANSFER.count, 2);

    const usdKinds = await sqlKindTotals("USD", FROM, TO);
    checkMoney("Σ INCOME USD = 1.000,00", usdKinds.INCOME.total, "1000.00");
    checkMoney("Σ EXPENSE USD = 600,00", usdKinds.EXPENSE.total, "600.00");
    checkMoney("Σ TRANSFER USD = 50,00", usdKinds.TRANSFER.total, "50.00");
    check("conteo TRANSFER USD = 1", usdKinds.TRANSFER.count, 1);

    /* ── HTTP · /api/accounts ────────────────────────────────────────────── */
    section("HTTP · /api/accounts");
    const accountsArs = await get(`/api/accounts?currency=ARS&asOf=${ASOF}`);
    const accountsUsd = await get(`/api/accounts?currency=USD&asOf=${ASOF}`);
    check("accounts ARS responde 200", accountsArs.status, 200);
    check("accounts USD responde 200", accountsUsd.status, 200);

    const byId = (res) => new Map((res.body.accounts ?? []).map((a) => [a.id, a]));
    const arsById = byId(accountsArs);
    const usdById = byId(accountsUsd);

    checkMoney("HTTP · ARS-Banco = 520.000,00", arsById.get(bancoArs.id)?.balance, "520000.00");
    checkMoney("HTTP · ARS-Caja = 75.000,00", arsById.get(cajaArs.id)?.balance, "75000.00");
    checkMoney("HTTP · ARS-Visa = −3.000,00", arsById.get(visaArs.id)?.balance, "-3000.00");
    checkMoney("HTTP · USD-Caja = 750,00", usdById.get(cajaUsd.id)?.balance, "750.00");
    checkMoney("HTTP · USD-Banco = 50,00 (archivada)", usdById.get(bancoUsd.id)?.balance, "50.00");
    checkMoney("HTTP · USD-Visa = −200,00", usdById.get(visaUsd.id)?.balance, "-200.00");

    check(
      "HTTP · la cuenta dice su moneda",
      `${arsById.get(bancoArs.id)?.currency}/${usdById.get(cajaUsd.id)?.currency}`,
      "ARS/USD",
    );

    const netArs = cents(accountsArs.body.netWorth.net) - netBaseArs;
    const netUsd = cents(accountsUsd.body.netWorth.net) - netBaseUsd;
    checkMoney("HTTP · Δ patrimonio ARS = 592.000,00 (595.000 − 3.000)", centsToMoney(netArs), "592000.00");
    checkMoney("HTTP · Δ patrimonio USD = 600,00 (800 − 200)", centsToMoney(netUsd), "600.00");

    const lastArs = accountsArs.body.netWorthSeries.at(-1);
    check("HTTP · la serie ARS termina en el mes del asOf", lastArs?.month, MES);
    checkMoney(
      "HTTP · último punto de la serie ARS = patrimonio de hoy",
      cents(lastArs?.net ?? "0") - netBaseArs,
      "592000.00",
    );

    /* ── HTTP · /api/transactions ────────────────────────────────────────── */
    section("HTTP · /api/transactions");
    const txArs = await get(`/api/transactions?from=${FROM}&to=${TO}&currency=ARS`);
    const txUsd = await get(`/api/transactions?from=${FROM}&to=${TO}&currency=USD`);
    check("transactions ARS responde 200", txArs.status, 200);
    check("transactions USD responde 200", txUsd.status, 200);

    const tArs = txArs.body.totals;
    checkMoney("HTTP · income ARS = 800.000,00", tArs.income, "800000.00");
    checkMoney("HTTP · expenses ARS = 253.000,00", tArs.expenses, "253000.00");
    checkMoney("HTTP · transfers ARS = 130.000,00", tArs.transfers, "130000.00");
    checkMoney("HTTP · cashFlow ARS = 490.000,00", tArs.cashFlow, "490000.00");
    check("HTTP · conteo income ARS = 1", tArs.incomeCount, 1);
    check("HTTP · conteo expenses ARS = 2", tArs.expenseCount, 2);
    check("HTTP · conteo transfers ARS = 2", tArs.transferCount, 2);

    const tUsd = txUsd.body.totals;
    checkMoney("HTTP · income USD = 1.000,00", tUsd.income, "1000.00");
    checkMoney("HTTP · expenses USD = 600,00", tUsd.expenses, "600.00");
    checkMoney("HTTP · transfers USD = 50,00", tUsd.transfers, "50.00");
    checkMoney("HTTP · cashFlow USD = 650,00", tUsd.cashFlow, "650.00");
    check("HTTP · conteo expenses USD = 2", tUsd.expenseCount, 2);
    check("HTTP · conteo transfers USD = 1", tUsd.transferCount, 1);

    // La lista ARS no puede traer los movimientos de cuentas USD.
    const idsArs = new Set((txArs.body.movements ?? []).map((m) => m.id));
    checkTrue(
      "HTTP · la lista ARS no trae el gasto de la tarjeta USD",
      !idsArs.has(gastoUsd200.id),
    );
    check(
      "HTTP · la lista ARS tiene 5 movimientos (2 gastos, 1 ingreso, 2 transferencias)",
      txArs.body.movements.length,
      5,
    );

    /* ── HTTP · /api/reports (torta y barras) ────────────────────────────── */
    section("HTTP · /api/reports");
    const repArs = await get(`/api/reports?from=${FROM}&to=${TO}&currency=ARS`);
    const repUsd = await get(`/api/reports?from=${FROM}&to=${TO}&currency=USD`);
    check("reports ARS responde 200", repArs.status, 200);
    check("reports USD responde 200", repUsd.status, 200);

    checkMoney("HTTP · torta ARS suma 253.000,00", repArs.body.totals.expenses, "253000.00");
    checkDeep(
      "HTTP · torta ARS: una sola porción (Gastos, 253.000)",
      repArs.body.byCategory.map((row) => [row.name, row.amount]),
      [[`${TAG} Gastos`, "253000.00"]],
    );
    checkDeep(
      "HTTP · barras ARS: tres días, sin los días USD",
      repArs.body.byDate.map((row) => [row.date, row.kind, row.amount]),
      [
        ["2031-03-01", "INCOME", "800000.00"],
        ["2031-03-03", "EXPENSE", "250000.00"],
        ["2031-03-10", "EXPENSE", "3000.00"],
      ],
    );
    checkDeep(
      "HTTP · torta USD: Gastos 400 y Gastos USD 200",
      repUsd.body.byCategory.map((row) => [row.name, row.amount]),
      [
        [`${TAG} Gastos`, "400.00"],
        [`${TAG} Gastos USD`, "200.00"],
      ],
    );
    checkDeep(
      "HTTP · barras USD",
      repUsd.body.byDate.map((row) => [row.date, row.kind, row.amount]),
      [
        ["2031-03-07", "INCOME", "1000.00"],
        ["2031-03-08", "EXPENSE", "400.00"],
        ["2031-03-11", "EXPENSE", "200.00"],
      ],
    );

    // ── El selector de categorías es de la pantalla: no puede ofrecer una
    //    categoría que sólo tiene movimientos en la OTRA moneda. Si aparece,
    //    elegirla deja la torta y las barras en cero sin explicación.
    checkDeep(
      "HTTP · categorías del selector ARS (sólo las usadas en ARS)",
      (repArs.body.categories ?? []).map((c) => c.name).sort(),
      [`${TAG} Gastos`, `${TAG} Sueldo`].sort(),
    );
    checkDeep(
      "HTTP · categorías del selector USD (incluye la de USD)",
      (repUsd.body.categories ?? []).map((c) => c.name).sort(),
      [`${TAG} Gastos`, `${TAG} Gastos USD`, `${TAG} Sueldo`].sort(),
    );

    // ── Burn: un gasto en otra moneda no participa.
    check(
      "HTTP · burn de un gasto USD con currency=ARS es null",
      repArs.body.burn,
      null,
    );
    checkDeep(
      "HTTP · candidatos de burn ARS: los dos gastos en pesos",
      (repArs.body.burnCandidates ?? []).map((c) => c.amount),
      ["250000.00", "3000.00"],
    );
    checkDeep(
      "HTTP · candidatos de burn USD: los dos gastos en dólares",
      (repUsd.body.burnCandidates ?? []).map((c) => c.amount),
      ["400.00", "200.00"],
    );

    const burnUsd = await get(
      `/api/reports?from=${FROM}&to=${TO}&currency=USD&burn=${gastoUsd200.id}`,
    );
    check("HTTP · burn USD responde 200", burnUsd.status, 200);
    check("HTTP · burn USD existe para su propia moneda", burnUsd.body.burn !== null, true);
    checkMoney("HTTP · burn USD · monthlyShare = 16,67", burnUsd.body.burn?.monthlyShare, "16.67");
    checkMoney("HTTP · burn USD · burnExpenses = 416,67", burnUsd.body.burn?.burnExpenses, "416.67");
    checkMoney("HTTP · burn USD · cashResult = 400,00", burnUsd.body.burn?.cashResult, "400.00");
    checkMoney("HTTP · burn USD · burnResult = 583,33", burnUsd.body.burn?.burnResult, "583.33");

    /* ── HTTP · /api/reconciliation ──────────────────────────────────────── */
    section("HTTP · /api/reconciliation");
    const recArs = await get(`/api/reconciliation?month=${MES}&asOf=${ASOF}&currency=ARS`);
    const recUsd = await get(`/api/reconciliation?month=${MES}&asOf=${ASOF}&currency=USD`);
    check("reconciliation ARS responde 200", recArs.status, 200);
    check("reconciliation USD responde 200", recUsd.status, 200);

    // ARS: Δpatrimonio = 592.000 − 105.000 = 487.000; ahorro = 800.000 − 253.000 = 547.000;
    // transferNet = (10.000 + 60.000) − (120.000 + 10.000) = −60.000.
    // diferencia = 487.000 − 547.000 + 0 − (−60.000) = 0.
    checkMoney("rec ARS · netStart = base + 105.000", cents(recArs.body.reconciliation.netStart) - netBaseArs, "105000.00");
    checkMoney("rec ARS · netEnd = base + 592.000", cents(recArs.body.reconciliation.netEnd) - netBaseArs, "592000.00");
    checkMoney("rec ARS · netDelta = 487.000,00", recArs.body.reconciliation.netDelta, "487000.00");
    checkMoney("rec ARS · saving = 547.000,00", recArs.body.reconciliation.saving, "547000.00");
    checkMoney("rec ARS · transferNet implícito = −60.000,00", await sqlTransferNet("ARS", FROM, TO), "-60000.00");
    checkMoney("rec ARS · difference = 0,00", recArs.body.reconciliation.difference, "0.00");
    check("rec ARS · balanced", recArs.body.reconciliation.balanced, true);
    check("rec ARS · mes cerrado (partial=false)", recArs.body.reconciliation.partial, false);
    check("rec ARS · cutAt", recArs.body.reconciliation.cutAt, ASOF);

    // USD: Δpatrimonio = 600 − 150 = 450; ahorro = 1.000 − 600 = 400;
    // transferNet = 100 − 50 = 50. diferencia = 450 − 400 − 50 = 0.
    checkMoney("rec USD · netStart = base + 150,00", cents(recUsd.body.reconciliation.netStart) - netBaseUsd, "150.00");
    checkMoney("rec USD · netEnd = base + 600,00", cents(recUsd.body.reconciliation.netEnd) - netBaseUsd, "600.00");
    checkMoney("rec USD · netDelta = 450,00", recUsd.body.reconciliation.netDelta, "450.00");
    checkMoney("rec USD · saving = 400,00", recUsd.body.reconciliation.saving, "400.00");
    checkMoney("rec USD · transferNet implícito = 50,00", await sqlTransferNet("USD", FROM, TO), "50.00");
    checkMoney("rec USD · difference = 0,00", recUsd.body.reconciliation.difference, "0.00");
    check("rec USD · balanced", recUsd.body.reconciliation.balanced, true);

    // Reconciliación al centavo, sin redondeo: una diferencia de un centavo tiene
    // que verse. Se inserta un movimiento de 0,01 por fuera del flujo esperado.
    section("HTTP · reconciliación · un centavo se ve");
    const intruso = await makeMovement({
      kind: "INCOME",
      amount: "0.01",
      date: new Date("2031-03-20T00:00:00.000Z"),
      accountId: bancoArs.id,
      categoryId: sueldo.id,
      description: `${TAG} centavo`,
    });
    const recCentavo = await get(`/api/reconciliation?month=${MES}&asOf=${ASOF}&currency=ARS`);
    // El ingreso entra en los dos caminos (patrimonio y ahorro), así que sigue
    // cuadrando: 0,00. Lo que se prueba es que el cálculo no trunca el centavo.
    checkMoney("rec ARS · con 0,01 más sigue en 0,00", recCentavo.body.reconciliation.difference, "0.00");
    checkMoney(
      "rec ARS · el centavo sí movió el ahorro (547.000,01)",
      recCentavo.body.reconciliation.saving,
      "547000.01",
    );
    await api(`/api/transactions/${intruso.id}`, { method: "DELETE" });

    /* ── Conteo de la lista vs totales (B4) ──────────────────────────────── */
    section("Tope de filas: la lista se recorta, los totales no");
    // No hace falta sembrar 500 filas para el scoping por moneda: la batería 12
    // del proyecto ya cubre el tope. Acá se verifica que el total de ARS no
    // incluya el gasto USD, que es la parte que esta fase puede romper.
    checkMoney(
      "el total ARS no incluye los 200 USD de la tarjeta",
      tArs.expenses,
      "253000.00",
    );
  },
});
