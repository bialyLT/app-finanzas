#!/usr/bin/env node
/**
 * 07 — IMPORTED: el cronograma lo dicta el banco; acá se valida y NUNCA se
 * recalcula.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA (brief punto 7 + criterio 1 de la fase, sistema IMPORTED)
 * ─────────────────────────────────────────────────────────────────────────────
 *   · La validación estricta del alta: fechas ESTRICTAMENTE crecientes,
 *     interés ≥ 0, pago > 0, pago ≥ interés (capital ≥ 0), el saldo no cae bajo
 *     cero y —la invariante grande— Σ capital == principal EXACTO al centavo.
 *   · La cantidad de cuotas y la primera fecha SE DERIVAN del cronograma (el
 *     cliente no las manda y el servidor las ignora si vienen).
 *   · El documento MANDA: la vista muestra las filas materializadas tal cual,
 *     aunque los parámetros digan otra cosa (probado torciendo una fila).
 *   · NO es healeable: si faltan TODAS las filas, la vista va sin plan, no se
 *     inventan cuotas, y el pago responde 400 "no tiene cronograma".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA ARITMÉTICA, A MANO
 * ─────────────────────────────────────────────────────────────────────────────
 * Cronograma válido: principal 92.000,00
 *   c1 05/11/2028: pago 30.000,00, interés 5.000,00 → capital 25.000,00 (saldo 67.000,00)
 *   c2 05/12/2028: pago 40.000,00, interés 3.000,00 → capital 37.000,00 (saldo 30.000,00)
 *   c3 05/01/2029: pago 32.000,00, interés 2.000,00 → capital 30.000,00 (saldo 0,00)
 *   Σ capital = 25.000 + 37.000 + 30.000 = 92.000,00 EXACTO ✓
 * Cobro de la c1: capital 25.000 / 92.000 = 27,1739…% → 27,17%.
 */

import {
  check,
  checkIncluye,
  checkTrue,
  crearCuenta,
  crearPrestamo,
  get,
  pagarPrestamo,
  prestamoDe,
  runScript,
  section,
} from "./helpers.mjs";

const TAG = "T_TESTER_F4_07";

const CRONOGRAMA = [
  { dueDate: "2028-11-05", payment: "30000", interest: "5000" },
  { dueDate: "2028-12-05", payment: "40000", interest: "3000" },
  { dueDate: "2029-01-05", payment: "32000", interest: "2000" },
];

runScript({
  tag: TAG,
  main: async (prisma) => {
    const banco = await crearCuenta(`${TAG}_Banco`, "BANK", "0");
    check("alta del banco responde 201", banco.status, 201);
    const bancoId = banco.body?.id;

    /* ────────────────────────────────────────────────────────────────────────
     * Los 400 del alta (validación estricta)
     * ──────────────────────────────────────────────────────────────────────── */
    section("Alta · los rechazos del cronograma importado");
    {
      const casos = [
        {
          label: "fechas repetidas → 400",
          body: {
            principal: "92000",
            imported: [
              { dueDate: "2028-11-05", payment: "30000", interest: "5000" },
              { dueDate: "2028-11-05", payment: "40000", interest: "3000" },
            ],
          },
          needle: "estrictamente crecientes",
        },
        {
          label: "fechas en bajada → 400",
          body: {
            principal: "92000",
            imported: [
              { dueDate: "2028-12-05", payment: "30000", interest: "5000" },
              { dueDate: "2028-11-05", payment: "40000", interest: "3000" },
            ],
          },
          needle: "estrictamente crecientes",
        },
        {
          label: "pago menor al interés → 400",
          body: {
            principal: "92000",
            imported: [
              { dueDate: "2028-11-05", payment: "4000", interest: "5000" },
            ],
          },
          needle: "no cubre ni su propio interés",
        },
        {
          label: "interés negativo → 400",
          body: {
            principal: "92000",
            imported: [
              { dueDate: "2028-11-05", payment: "30000", interest: "-1" },
            ],
          },
          needle: "no puede ser negativo",
        },
        {
          label: "capital mayor al saldo → 400",
          body: {
            principal: "100000",
            imported: [
              { dueDate: "2028-11-05", payment: "60000", interest: "10000" },
              { dueDate: "2028-12-05", payment: "70000", interest: "10000" },
            ],
          },
          needle: "supera el saldo que queda",
        },
        {
          label: "Σ capital ≠ principal → 400",
          body: { principal: "100000", imported: CRONOGRAMA },
          needle: "no coincide con el monto",
        },
        {
          label: "cronograma vacío → 400",
          body: { principal: "92000", imported: [] },
          needle: "al menos una cuota",
        },
        {
          label: "más de 600 cuotas → 400",
          body: {
            principal: "601",
            imported: Array.from({ length: 601 }, (_, index) => ({
              dueDate: `2028-${String((index % 12) + 1).padStart(2, "0")}-05`,
              payment: "1",
              interest: "0",
            })),
          },
          needle: "más de 600",
        },
        {
          label: "cuota que no es objeto → 400",
          body: { principal: "92000", imported: [42] },
          needle: "no es un objeto",
        },
        {
          label: "fecha inválida → 400",
          body: {
            principal: "20000",
            imported: [{ dueDate: "2028-02-31", payment: "25000", interest: "5000" }],
          },
          needle: "no es una fecha válida",
        },
        {
          label: "pago cero → 400",
          body: {
            principal: "20000",
            imported: [{ dueDate: "2028-11-05", payment: "0", interest: "0" }],
          },
          needle: "mayor a cero",
        },
        {
          label: "imported con sistema FRENCH → 400",
          body: {
            principal: "92000",
            tnaPercent: "60",
            installmentCount: 3,
            firstInstallmentDate: "2028-11-05",
            imported: CRONOGRAMA,
          },
          system: "FRENCH",
          needle: "sólo se usa con el sistema IMPORTED",
        },
        {
          label: "sistema IMPORTED sin cronograma → 400",
          body: { principal: "92000" },
          system: "IMPORTED",
          needle: "el cronograma del banco",
        },
        {
          label: "sin monto → 400",
          body: { imported: CRONOGRAMA },
          system: "IMPORTED",
          needle: "el monto",
        },
      ];

      for (const caso of casos) {
        const res = await crearPrestamo({
          name: `${TAG}_rechazo`,
          kind: "LOAN",
          amortizationSystem: caso.system ?? "IMPORTED",
          ...caso.body,
        });
        check(caso.label, res.status, 400);
        checkIncluye(`  · y explica por qué (${caso.needle})`, res.body?.error, caso.needle);
      }
    }

    /* ────────────────────────────────────────────────────────────────────────
     * El cronograma válido: se materializa tal cual y deriva count/fecha
     * ──────────────────────────────────────────────────────────────────────── */
    section("Alta válida · principal 92.000 con el cronograma del banco");
    const importado = await crearPrestamo({
      name: `${TAG}_Importado`,
      kind: "LOAN",
      principal: "92000",
      amortizationSystem: "IMPORTED",
      imported: CRONOGRAMA,
    });
    check("responde 201", importado.status, 201);
    const importadoId = importado.body?.id;
    {
      const vista = await get("/api/loans?asOf=2028-11-01");
      const mio = prestamoDe(vista, importadoId);
      checkTrue("la vista trae el importado", mio !== null);
      check("sistema IMPORTED", mio?.system, "IMPORTED");
      check("sin tasa (la composición la dicta el banco)", mio?.tnaPercent, null);
      check("cuotas derivadas: 3", mio?.installmentCount, 3);
      check("plan: cuotas derivadas 3", mio?.plan?.installmentCount, 3);
      check("primera fecha derivada: 2028-11-05", mio?.firstInstallmentDate, "2028-11-05");
      check("cuota del plan = primera del banco (30.000,00)", mio?.plan?.payment, "30000.00");
      check("principal del plan 92.000,00", mio?.plan?.principal, "92000.00");
      check("12 buckets de compromisos (misma ventana)", mio?.commitments?.months?.length, 12);
      check("next12 = 102.000,00 (los 3 pagos del banco)", mio?.commitments?.next12Months, "102000.00");

      const filas = (mio?.installments ?? []).map(
        (f) => `${f.number}|${f.dueDate}|${f.payment}|${f.interest}|${f.principal}|${f.remainingBalance}`,
      );
      check(
        "las 3 filas EXACTAS del banco (pago/interés/capital/saldo)",
        filas.join(" "),
        [
          "1|2028-11-05|30000.00|5000.00|25000.00|67000.00",
          "2|2028-12-05|40000.00|3000.00|37000.00|30000.00",
          "3|2029-01-05|32000.00|2000.00|30000.00|0.00",
        ].join(" "),
      );
    }

    /* ────────────────────────────────────────────────────────────────────────
     * El pago de una cuota importada: composición del documento
     * ──────────────────────────────────────────────────────────────────────── */
    section("Pago · la c1 del banco (capital 25.000 + interés 5.000)");
    {
      const pago = await pagarPrestamo({
        accountId: importadoId,
        cashAccountId: bancoId,
        date: "2028-11-05",
      });
      check("responde 201", pago.status, 201);
      check("capital 25.000,00", pago.body?.principalPaid, "25000.00");
      check("interés 5.000,00", pago.body?.interestPaid, "5000.00");

      const vista = await get("/api/loans?asOf=2028-11-05");
      const mio = prestamoDe(vista, importadoId);
      check("cobertura 1 de 3", mio?.plan?.paidCount, 1);
      check("capital 25.000,00", mio?.capitalPaid, "25000.00");
      check("interés 5.000,00", mio?.interestPaid, "5000.00");
      // 25.000 / 92.000 = 27,17391…% → 27,17.
      check("progreso 27,17%", mio?.progressPercent, "27.17");
      check("la próxima es la c2", mio?.nextInstallment?.number, 2);
    }

    /* ────────────────────────────────────────────────────────────────────────
     * El documento manda: una fila torcida a mano NO se recalcula
     * ──────────────────────────────────────────────────────────────────────── */
    section("Documento manda · se tuerce la c2 y la vista la muestra tal cual");
    {
      const torcida = await prisma.installment.update({
        where: { accountId_number: { accountId: importadoId, number: 2 } },
        data: {
          payment: "41000.00",
          interest: "3000.00",
          principal: "38000.00",
          remainingBalance: "29000.00",
        },
      });
      check("la fila torcida quedó guardada", torcida.payment.toFixed(2), "41000.00");

      const vista = await get("/api/loans?asOf=2028-11-05");
      const mio = prestamoDe(vista, importadoId);
      const c2 = mio?.installments?.[1];
      check("la vista muestra el pago torcido (41.000,00)", c2?.payment, "41000.00");
      check("la vista muestra el capital torcido (38.000,00)", c2?.principal, "38000.00");
      check("cuotas: siguen 3 (no se recalcula el largo)", mio?.plan?.installmentCount, 3);
      check("la cobertura se mide contra el documento", mio?.plan?.paidCount, 1);

      // Y no se "arregla" sola: varios GET más no la reescriben.
      await get("/api/loans?asOf=2028-11-05");
      await get("/api/loans?asOf=2028-11-06");
      const sigue = await prisma.installment.findUnique({
        where: { accountId_number: { accountId: importadoId, number: 2 } },
      });
      check("sigue torcida: el importado no se recalcula ni se cura", sigue?.payment.toFixed(2), "41000.00");
    }

    /* ────────────────────────────────────────────────────────────────────────
     * No healeable: sin filas, no hay plan inventado
     * ──────────────────────────────────────────────────────────────────────── */
    section("No healeable · se borran TODAS las filas del importado");
    {
      await prisma.installment.deleteMany({ where: { accountId: importadoId } });
      await get("/api/loans?asOf=2028-11-05");
      await get("/api/loans?asOf=2028-11-06");

      const filas = await prisma.installment.count({ where: { accountId: importadoId } });
      check("los GET no inventaron cuotas", filas, 0);

      const vista = await get("/api/loans?asOf=2028-11-05");
      const mio = prestamoDe(vista, importadoId);
      checkTrue("la vista sigue mostrando el préstamo", mio !== null);
      check("sin plan (no se puede adivinar lo del banco)", mio?.plan, null);
      check("sin cronograma en la vista", mio?.installments?.length, 0);
      check("sin próxima cuota", mio?.nextInstallment, null);
      check("sin compromisos", mio?.commitments, null);
      check("los parámetros siguen: 3 cuotas", mio?.installmentCount, 3);
      check("la primera fecha derivada sigue guardada", mio?.firstInstallmentDate, "2028-11-05");

      const pago = await pagarPrestamo({
        accountId: importadoId,
        cashAccountId: bancoId,
        date: "2028-11-10",
      });
      check("pagar sin cronograma → 400", pago.status, 400);
      checkIncluye("explica que no hay contrato que pagar", pago.body?.error, "no tiene cronograma");
    }
  },
});
