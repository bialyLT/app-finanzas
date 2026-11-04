#!/usr/bin/env node
/**
 * Batería 05 · Deudas y capital pagado entre monedas.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ SE ATACA
 * ─────────────────────────────────────────────────────────────────────────────
 * Un préstamo en dólares se paga, a veces, con pesos. La pata que ENTRA al
 * préstamo vale `toAmount` (el único número en la moneda del préstamo); usar
 * `amount` acredita 120.000 dólares donde llegaron 100.
 *
 * Se prueban DOS caminos que calculan el mismo número:
 *   · `/api/debts?currency=…`  (el reporte de deudas);
 *   · `/api/loans?asOf=…`      (la vista de préstamos).
 * Si los dos no coinciden, uno miente. El reporte de deudas ya usa `toAmount`;
 * la vista de préstamos suma `amount` sin mirar la moneda de origen.
 *
 * Además: un préstamo o un ingreso en USD no puede entrar en `totalDebt` ni en
 * el DTI en pesos.
 */

import {
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
} from "./helpers.mjs";

const TAG = newTag("t05");
const MES = "2031-10";
const ASOF = `${MES}-31`;
const day = (value) => new Date(`${value}T00:00:00.000Z`);

await runBattery({
  tag: TAG,
  main: async () => {
    /* ── Siembra ─────────────────────────────────────────────────────────── */
    section("Siembra");
    const bancoArs = await makeAccount(TAG, "ARS-Banco", {
      currency: "ARS",
      kind: "BANK",
    });
    const cajaUsd = await makeAccount(TAG, "USD-Caja", {
      currency: "USD",
      kind: "CASH",
      openingBalance: "500",
    });
    const prestamoArs = await makeAccount(TAG, "ARS-Prestamo", {
      currency: "ARS",
      kind: "LOAN",
      openingBalance: "-50000",
      extra: {
        principal: "50000",
        tnaPercent: "60",
        installmentCount: 12,
        firstInstallmentDate: day("2031-11-15"),
      },
    });
    const prestamoUsd = await makeAccount(TAG, "USD-Prestamo", {
      currency: "USD",
      kind: "LOAN",
      openingBalance: "-1000",
      extra: {
        principal: "1000",
        tnaPercent: "10",
        installmentCount: 12,
        firstInstallmentDate: day("2031-11-15"),
      },
    });
    const sueldo = await makeCategory(TAG, "Sueldo", "INCOME");

    await makeMovement({
      kind: "INCOME",
      amount: "10000",
      date: day("2031-10-01"),
      accountId: bancoArs.id,
      categoryId: sueldo.id,
      description: `${TAG} ingreso ARS`,
    });
    await makeMovement({
      kind: "INCOME",
      amount: "1000",
      date: day("2031-10-01"),
      accountId: cajaUsd.id,
      categoryId: sueldo.id,
      description: `${TAG} ingreso USD`,
    });

    // Pago del préstamo USD con pesos: salen 120.000 ARS, llegan 100 USD.
    await makeMovement({
      kind: "TRANSFER",
      amount: "120000",
      toAmount: "100",
      date: day("2031-10-05"),
      accountId: bancoArs.id,
      toAccountId: prestamoUsd.id,
      description: `${TAG} pago USD desde ARS`,
    });
    // Pago del préstamo USD en dólares: 50 USD.
    await makeMovement({
      kind: "TRANSFER",
      amount: "50",
      date: day("2031-10-06"),
      accountId: cajaUsd.id,
      toAccountId: prestamoUsd.id,
      description: `${TAG} pago USD en USD`,
    });
    // Pago del préstamo ARS en pesos: 5.000.
    await makeMovement({
      kind: "TRANSFER",
      amount: "5000",
      date: day("2031-10-07"),
      accountId: bancoArs.id,
      toAccountId: prestamoArs.id,
      description: `${TAG} pago ARS`,
    });
    check("siembra lista", "3 transferencias + 2 ingresos", "3 transferencias + 2 ingresos");

    /* ── 1 · Reporte de deudas en ARS ───────────────────────────────────── */
    section("HTTP · /api/debts en ARS");
    const deudaArs = await get(`/api/debts?month=${MES}&asOf=${ASOF}&currency=ARS`);
    check("debts ARS responde 200", deudaArs.status, 200);
    const repArs = deudaArs.body.debtReport;

    checkDeep(
      "ARS · sólo la deuda en pesos (el préstamo USD no aparece)",
      repArs.rows.map((row) => row.name),
      [`${TAG} ARS-Prestamo`],
    );
    // Deuda ARS: apertura −50.000 + 5.000 pagados = −45.000 → debe 45.000.
    checkMoney("ARS · totalDebt = 45.000,00 (sin el préstamo USD)", repArs.totalDebt, "45000.00");
    checkMoney(
      "ARS · capital pagado del préstamo ARS = 5.000,00",
      repArs.rows[0]?.capitalPaid,
      "5000.00",
    );
    checkMoney("ARS · DTI · ingreso = 10.000,00 (sin el ingreso USD)", repArs.dti.income, "10000.00");

    /* ── 2 · Reporte de deudas en USD ───────────────────────────────────── */
    section("HTTP · /api/debts en USD");
    const deudaUsd = await get(`/api/debts?month=${MES}&asOf=${ASOF}&currency=USD`);
    check("debts USD responde 200", deudaUsd.status, 200);
    const repUsd = deudaUsd.body.debtReport;

    checkDeep(
      "USD · sólo la deuda en dólares",
      repUsd.rows.map((row) => row.name),
      [`${TAG} USD-Prestamo`],
    );
    // Deuda USD: apertura −1.000 + 100 (toAmount) + 50 = −850 → debe 850.
    checkMoney("USD · totalDebt = 850,00", repUsd.totalDebt, "850.00");
    checkMoney(
      "USD · capital pagado = 150,00 (100 por toAmount + 50 en USD)",
      repUsd.rows[0]?.capitalPaid,
      "150.00",
    );
    checkMoney(
      "USD · progreso = 15,00 % (150 de 1.000)",
      repUsd.rows[0]?.progressPercent,
      "15.00",
    );
    checkMoney("USD · DTI · ingreso = 1.000,00", repUsd.dti.income, "1000.00");

    /* ── 3 · La vista de préstamos: el MISMO número ─────────────────────── */
    section("HTTP · /api/loans (el otro camino al mismo número)");
    const vista = await get(`/api/loans?asOf=${ASOF}`);
    check("loans responde 200", vista.status, 200);
    const porId = new Map((vista.body.loans ?? []).map((loan) => [loan.id, loan]));
    const usdView = porId.get(prestamoUsd.id);
    const arsView = porId.get(prestamoArs.id);

    checkTrue("la vista incluye el préstamo USD", Boolean(usdView));
    checkTrue("la vista incluye el préstamo ARS", Boolean(arsView));

    checkMoney(
      "loans · capital pagado del préstamo ARS = 5.000,00",
      arsView?.capitalPaid,
      "5000.00",
    );
    // Éste es el número que el reporte de deudas da bien (150). Si la vista
    // suma `amount` en vez de `toAmount`, da 120.050 → clampeado a 1.000.
    checkMoney(
      "loans · capital pagado del préstamo USD = 150,00 (no 1.000)",
      usdView?.capitalPaid,
      "150.00",
    );
    checkMoney(
      "loans · progreso del préstamo USD = 15,00 % (no 100)",
      usdView?.progressPercent,
      "15.00",
    );
    check(
      "los dos caminos coinciden en el capital pagado",
      usdView?.capitalPaid,
      repUsd.rows[0]?.capitalPaid,
    );

    /* ── 4 · La reconciliación también cuadra con préstamos ─────────────── */
    section("HTTP · reconciliación con pagos de préstamo");
    const recArs = await get(`/api/reconciliation?month=${MES}&asOf=${ASOF}&currency=ARS`);
    const recUsd = await get(`/api/reconciliation?month=${MES}&asOf=${ASOF}&currency=USD`);
    checkMoney("rec ARS · difference = 0,00", recArs.body.reconciliation.difference, "0.00");
    checkMoney("rec USD · difference = 0,00", recUsd.body.reconciliation.difference, "0.00");
    check("rec ARS · balanced", recArs.body.reconciliation.balanced, true);
    check("rec USD · balanced", recUsd.body.reconciliation.balanced, true);
    // ARS: Δ = −110.000 (banco −125.000 + deuda −5.000 que baja el pasivo… neto
    // −110.000); ahorro 10.000; transferNet −120.000 → 0.
    checkMoney("rec ARS · netDelta = −110.000,00", recArs.body.reconciliation.netDelta, "-110000.00");
    checkMoney("rec USD · netDelta = 1.100,00", recUsd.body.reconciliation.netDelta, "1100.00");
  },
});
