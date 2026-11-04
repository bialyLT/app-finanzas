#!/usr/bin/env node
/**
 * Batería 04 · El borde HTTP de los 5 endpoints.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ SE ATACA
 * ─────────────────────────────────────────────────────────────────────────────
 * `?currency=` es la unidad del número que viaja. Un valor inválido no puede
 * caer en un default silencioso (mentiría sobre la unidad) ni en un 500:
 *
 *   · `?currency=EUR`, `?currency=`, `?currency=usd`, `?currency=%20ARS`,
 *     `?currency=ARS%00`, `?currency=Usd` → 400 accionable en los CINCO
 *     endpoints (accounts, reports, transactions, reconciliation, debts);
 *   · sin parámetro → exactamente los mismos números que `?currency=ARS` (el
 *     comportamiento histórico);
 *   · `?currency=USD` → los números de dólares, distintos;
 *   · el 400 no filtra datos (no trae totales a medio calcular).
 *
 * Mes: 2031-09, con una cuenta por moneda y un ingreso en cada una.
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

const TAG = newTag("t04");
const MES = "2031-09";
const FROM = `${MES}-01`;
const TO = `${MES}-30`;
const ASOF = `${MES}-30`;
const day = (value) => new Date(`${value}T00:00:00.000Z`);

/** Los cinco endpoints con sus parámetros de período. */
const ENDPOINTS = [
  { name: "accounts", path: (q) => `/api/accounts?asOf=${ASOF}${q}` },
  { name: "reports", path: (q) => `/api/reports?from=${FROM}&to=${TO}${q}` },
  { name: "transactions", path: (q) => `/api/transactions?from=${FROM}&to=${TO}${q}` },
  { name: "reconciliation", path: (q) => `/api/reconciliation?month=${MES}&asOf=${ASOF}${q}` },
  { name: "debts", path: (q) => `/api/debts?month=${MES}&asOf=${ASOF}${q}` },
];

await runBattery({
  tag: TAG,
  main: async () => {
    /* ── Siembra mínima ─────────────────────────────────────────────────── */
    section("Siembra");
    const bancoArs = await makeAccount(TAG, "ARS", {
      currency: "ARS",
      kind: "BANK",
      openingBalance: "1000",
    });
    const cajaUsd = await makeAccount(TAG, "USD", {
      currency: "USD",
      kind: "CASH",
      openingBalance: "10",
    });
    const sueldo = await makeCategory(TAG, "Sueldo", "INCOME");
    await makeMovement({
      kind: "INCOME",
      amount: "100",
      date: day("2031-09-02"),
      accountId: bancoArs.id,
      categoryId: sueldo.id,
      description: `${TAG} ingreso ARS`,
    });
    await makeMovement({
      kind: "INCOME",
      amount: "1",
      date: day("2031-09-03"),
      accountId: cajaUsd.id,
      categoryId: sueldo.id,
      description: `${TAG} ingreso USD`,
    });
    check("siembra lista", `${bancoArs.currency}/${cajaUsd.currency}`, "ARS/USD");

    /* ── 1 · Valores inválidos: 400 en los cinco ────────────────────────── */
    section("Valores inválidos → 400 accionable");
    const invalidos = ["&currency=EUR", "&currency=", "&currency=usd", "&currency=%20ARS", "&currency=ARS%00", "&currency=Usd"];
    for (const endpoint of ENDPOINTS) {
      for (const query of invalidos) {
        const res = await get(endpoint.path(query));
        const label = `${endpoint.name} · ${query} → 400`;
        check(label, res.status, 400);
        if (res.status !== 400) {
          console.log(`        cuerpo: ${JSON.stringify(res.body).slice(0, 160)}`);
          continue;
        }
        checkTrue(
          `${endpoint.name} · ${query} · mensaje menciona ARS/USD`,
          /ARS/.test(res.body?.error ?? "") && /USD/.test(res.body?.error ?? ""),
          JSON.stringify(res.body),
        );
        checkTrue(
          `${endpoint.name} · ${query} · no filtra datos`,
          res.body?.totals === undefined &&
            res.body?.accounts === undefined &&
            res.body?.reconciliation === undefined &&
            res.body?.debtReport === undefined,
        );
      }
    }

    /* ── 2 · Sin parámetro = ARS ────────────────────────────────────────── */
    section("Sin parámetro → los mismos números que ARS");
    const sinParametro = {};
    const enArs = {};
    const enUsd = {};
    for (const endpoint of ENDPOINTS) {
      sinParametro[endpoint.name] = await get(endpoint.path(""));
      enArs[endpoint.name] = await get(endpoint.path("&currency=ARS"));
      enUsd[endpoint.name] = await get(endpoint.path("&currency=USD"));
      check(`${endpoint.name} · sin parámetro responde 200`, sinParametro[endpoint.name].status, 200);
      check(`${endpoint.name} · ?currency=ARS responde 200`, enArs[endpoint.name].status, 200);
      check(`${endpoint.name} · ?currency=USD responde 200`, enUsd[endpoint.name].status, 200);
    }

    checkDeep(
      "accounts · sin parámetro === ARS (patrimonio)",
      sinParametro.accounts.body.netWorth,
      enArs.accounts.body.netWorth,
    );
    checkDeep(
      "accounts · sin parámetro === ARS (saldos por cuenta)",
      sinParametro.accounts.body.accounts.map((a) => [a.id, a.balance]),
      enArs.accounts.body.accounts.map((a) => [a.id, a.balance]),
    );
    checkDeep(
      "reports · sin parámetro === ARS (totales, torta y barras)",
      {
        totals: sinParametro.reports.body.totals,
        byCategory: sinParametro.reports.body.byCategory,
        byDate: sinParametro.reports.body.byDate,
      },
      {
        totals: enArs.reports.body.totals,
        byCategory: enArs.reports.body.byCategory,
        byDate: enArs.reports.body.byDate,
      },
    );
    checkDeep(
      "transactions · sin parámetro === ARS (totales)",
      sinParametro.transactions.body.totals,
      enArs.transactions.body.totals,
    );
    checkDeep(
      "reconciliation · sin parámetro === ARS",
      sinParametro.reconciliation.body.reconciliation,
      enArs.reconciliation.body.reconciliation,
    );
    checkDeep(
      "debts · sin parámetro === ARS (total y DTI)",
      {
        totalDebt: sinParametro.debts.body.debtReport.totalDebt,
        dti: sinParametro.debts.body.debtReport.dti,
      },
      {
        totalDebt: enArs.debts.body.debtReport.totalDebt,
        dti: enArs.debts.body.debtReport.dti,
      },
    );

    /* ── 3 · Los números de USD son los de USD ──────────────────────────── */
    section("?currency=USD devuelve los números de dólares");
    checkMoney(
      "transactions USD · ingreso 1,00 (no 100)",
      enUsd.transactions.body.totals.income,
      "1.00",
    );
    checkMoney(
      "reports USD · gasto 0,00 (no ve el ingreso ARS)",
      enUsd.reports.body.totals.expenses,
      "0.00",
    );
    checkMoney(
      "transactions ARS · ingreso 100,00 (no 1)",
      enArs.transactions.body.totals.income,
      "100.00",
    );

    const cuentaUsd = enUsd.accounts.body.accounts.find((a) => a.id === cajaUsd.id);
    const cuentaArs = enArs.accounts.body.accounts.find((a) => a.id === bancoArs.id);
    checkMoney("accounts USD · la caja USD = 11,00 (10 + 1)", cuentaUsd?.balance, "11.00");
    checkMoney("accounts ARS · el banco ARS = 1.100,00 (1.000 + 100)", cuentaArs?.balance, "1100.00");

    // El patrimonio de /api/accounts es de UNA moneda: el de ARS no puede ser
    // el de USD (si lo fuera, alguien sumó las dos).
    checkTrue(
      "accounts ARS y USD devuelven patrimonios distintos",
      enArs.accounts.body.netWorth.net !== enUsd.accounts.body.netWorth.net,
      `${enArs.accounts.body.netWorth.net} vs ${enUsd.accounts.body.netWorth.net}`,
    );

    /* ── 4 · Duplicado: gana el primero, no rompe ───────────────────────── */
    section("Parámetro repetido");
    const repetido = await get(`/api/reports?from=${FROM}&to=${TO}&currency=ARS&currency=USD`);
    check("?currency=ARS&currency=USD responde 200", repetido.status, 200);
    checkMoney(
      "gana el PRIMER valor (ARS): ingreso 100,00",
      repetido.body.totals.income,
      "100.00",
    );

    /* ── 5 · Números canónicos del mes sin datos ────────────────────────── */
    section("Un mes vacío no inventa números");
    const vacio = await get(`/api/reports?from=2032-01-01&to=2032-01-31&currency=USD`);
    check("reports de un mes vacío responde 200", vacio.status, 200);
    checkMoney("totales en cero", vacio.body.totals.income, "0.00");
    check("sin categorías", vacio.body.byCategory.length, 0);
    check("sin barras", vacio.body.byDate.length, 0);
    check("sin burn", vacio.body.burn, null);
  },
});
