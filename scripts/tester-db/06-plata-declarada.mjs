#!/usr/bin/env node
/**
 * Batería 06 · Plata declarada (la banderita) por moneda.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ SE ATACA
 * ─────────────────────────────────────────────────────────────────────────────
 * El saldo inicial declarado como ingreso es de UNA cuenta y hereda SU moneda.
 * Si `declaredIncomeInPeriod` no filtra por moneda, la cuenta en dólares suma
 * al ingreso en pesos (y al revés), y la reconciliación —que ajusta por la plata
 * declarada— deja de cuadrar en las dos.
 *
 * Mes: 2031-11. La cuenta declarada no tiene movimientos: su apertura ya está
 * en las dos fotos de saldos, y por eso la identidad es
 * `ΔPatrimonio = Ahorro − PlataDeclarada`.
 */

import {
  check,
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

const TAG = newTag("t06");
const MES = "2031-11";
const FROM = `${MES}-01`;
const TO = `${MES}-30`;
const ASOF = `${MES}-30`;
const day = (value) => new Date(`${value}T00:00:00.000Z`);

await runBattery({
  tag: TAG,
  main: async () => {
    /* ── Siembra ─────────────────────────────────────────────────────────── */
    section("Siembra");
    const cajaArs = await makeAccount(TAG, "ARS-Declarada", {
      currency: "ARS",
      kind: "CASH",
      openingBalance: "7000",
      extra: { openingIncomeMonth: day("2031-11-01") },
    });
    const cajaUsd = await makeAccount(TAG, "USD-Declarada", {
      currency: "USD",
      kind: "CASH",
      openingBalance: "100",
      extra: { openingIncomeMonth: day("2031-11-01") },
    });
    const bancoArs = await makeAccount(TAG, "ARS-Banco", {
      currency: "ARS",
      kind: "BANK",
    });
    const sueldo = await makeCategory(TAG, "Sueldo", "INCOME");
    await makeMovement({
      kind: "INCOME",
      amount: "100",
      date: day("2031-11-02"),
      accountId: bancoArs.id,
      categoryId: sueldo.id,
      description: `${TAG} ingreso ARS`,
    });
    check("siembra lista", `${cajaArs.currency}/${cajaUsd.currency}`, "ARS/USD");

    /* ── 1 · Totales por moneda ─────────────────────────────────────────── */
    section("HTTP · /api/transactions");
    const txArs = await get(`/api/transactions?from=${FROM}&to=${TO}&currency=ARS`);
    const txUsd = await get(`/api/transactions?from=${FROM}&to=${TO}&currency=USD`);
    check("transactions ARS responde 200", txArs.status, 200);
    check("transactions USD responde 200", txUsd.status, 200);

    // ARS: ingreso = 100 del movimiento + 7.000 declarados = 7.100.
    checkMoney("ARS · income = 7.100,00", txArs.body.totals.income, "7100.00");
    checkMoney("ARS · declaredIncome = 7.000,00 (sólo la cuenta ARS)", txArs.body.totals.declaredIncome, "7000.00");
    check("ARS · incomeCount = 1 (la declaración no es un movimiento)", txArs.body.totals.incomeCount, 1);
    checkMoney("ARS · cashFlow = 100,00 (la declaración NO es caja)", txArs.body.totals.cashFlow, "100.00");

    // USD: ingreso = 100 declarados (no 7.100).
    checkMoney("USD · income = 100,00", txUsd.body.totals.income, "100.00");
    checkMoney("USD · declaredIncome = 100,00", txUsd.body.totals.declaredIncome, "100.00");
    check("USD · incomeCount = 0", txUsd.body.totals.incomeCount, 0);
    checkMoney("USD · cashFlow = 0,00", txUsd.body.totals.cashFlow, "0.00");

    /* ── 2 · La reconciliación ajusta por la declaración ────────────────── */
    section("HTTP · /api/reconciliation");
    const recArs = await get(`/api/reconciliation?month=${MES}&asOf=${ASOF}&currency=ARS`);
    const recUsd = await get(`/api/reconciliation?month=${MES}&asOf=${ASOF}&currency=USD`);
    check("reconciliation ARS responde 200", recArs.status, 200);
    check("reconciliation USD responde 200", recUsd.status, 200);

    // ARS: Δ = 7.100 − 7.000 = 100; ahorro 7.100; declarada 7.000 → 0.
    checkMoney("ARS · netDelta = 100,00", recArs.body.reconciliation.netDelta, "100.00");
    checkMoney("ARS · saving = 7.100,00", recArs.body.reconciliation.saving, "7100.00");
    checkMoney("ARS · declaredIncome = 7.000,00", recArs.body.reconciliation.declaredIncome, "7000.00");
    checkMoney("ARS · difference = 0,00", recArs.body.reconciliation.difference, "0.00");
    check("ARS · balanced", recArs.body.reconciliation.balanced, true);

    // USD: Δ = 0; ahorro 100 (la declarada); declarada 100 → 0.
    checkMoney("USD · netDelta = 0,00", recUsd.body.reconciliation.netDelta, "0.00");
    checkMoney("USD · saving = 100,00", recUsd.body.reconciliation.saving, "100.00");
    checkMoney("USD · declaredIncome = 100,00", recUsd.body.reconciliation.declaredIncome, "100.00");
    checkMoney("USD · difference = 0,00", recUsd.body.reconciliation.difference, "0.00");
    check("USD · balanced", recUsd.body.reconciliation.balanced, true);

    /* ── 3 · El patrimonio no cambia por la banderita ───────────────────── */
    section("HTTP · /api/accounts");
    const cuentasArs = await get(`/api/accounts?currency=ARS&asOf=${ASOF}`);
    const declarada = (cuentasArs.body.accounts ?? []).find((a) => a.id === cajaArs.id);
    checkMoney("la cuenta declarada conserva su saldo (7.000)", declarada?.balance, "7000.00");
    checkTrue(
      "la cuenta lleva su moneda en el DTO",
      declarada?.currency === "ARS",
      JSON.stringify(declarada?.currency),
    );
    checkMoney(
      "el patrimonio ARS no duplica la declaración",
      declarada?.balance,
      "7000.00",
    );
  },
});
