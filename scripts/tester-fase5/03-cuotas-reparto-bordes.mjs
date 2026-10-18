#!/usr/bin/env node
/**
 * 03 — Reparto de cuotas (D5/D6): floor + la última absorbe el resto, Σ exacta,
 * bordes de rechazo, N=1 y N=120, montos de un centavo y millones.
 *
 * A MANO (todos los casos):
 *   · 100.000 en 3  → base 33.333,33 y última 33.333,34 (Σ 100.000,00).
 *   · 100.000 en 7  → base 14.285,71 (floor de 1.000.000.000/7 centavos) y
 *                     última 14.285,74 (Σ 100.000,00).
 *   · 0,04 en 4     → 0,01 ×4 (mínimo un centavo por cuota).
 *   · 0,03 en 4     → rechaza: 3 centavos no alcanzan para 4 cuotas.
 *   · 0,12 en 12    → 0,01 ×12.
 *   · 1,00 en 120   → rechaza: 100 centavos < 120.
 *   · 1,20 en 120   → 0,01 ×120.
 *   · 9.999.999,99 en 3 → 3.333.333,33 ×3 (división exacta).
 *   · 120.000 en 7  → base 17.142,85 y última 17.142,90 (Σ 120.000,00).
 */

import {
  check,
  checkTrue,
  checkIncluye,
  correrResumenes,
  crearPlan,
  crearTarjeta,
  get,
  guardToday,
  runScript,
  section,
  sumItems as sumaMontos,
} from "./helpers.mjs";

const TAG = "T_TESTER_F5_03";
guardToday("2026-10-17");

const preview = (query) => get(`/api/cards/plans/preview?${query}`);

await runScript({
  tag: TAG,
  main: async (prisma) => {
    section("Preview · reparto exacto");

    const p3 = await preview("total=100000&installments=3");
    check("100.000 en 3 responde 200", p3.status, 200);
    check("cuota base 33.333,33", p3.body?.installmentAmount, "33333.33");
    check("última 33.333,34", p3.body?.lastInstallmentAmount, "33333.34");
    check("Σ 100.000,00", p3.body?.totalPaid, "100000.00");
    check("sin precio de contado no hay tasa", p3.body?.implicitRate, null);

    const p7 = await preview("total=100000&installments=7");
    check("100.000 en 7: base 14.285,71", p7.body?.installmentAmount, "14285.71");
    check("100.000 en 7: última 14.285,74", p7.body?.lastInstallmentAmount, "14285.74");
    check(
      "Σ 100.000,00 (17.142,85… no: 14.285,71 ×6 + 14.285,74)",
      p7.body?.totalPaid,
      "100000.00",
    );

    const pCents = await preview("total=0.04&installments=4");
    check("0,04 en 4: 0,01", pCents.body?.installmentAmount, "0.01");
    check("0,04 en 4: última 0,01", pCents.body?.lastInstallmentAmount, "0.01");

    const p12 = await preview("total=0.12&installments=12");
    check("0,12 en 12: 0,01 ×12", `${p12.body?.installmentAmount}/${p12.body?.lastInstallmentAmount}`, "0.01/0.01");

    const pN1 = await preview("total=1000.01&installments=1");
    check("N=1: la única cuota es el total 1.000,01", pN1.body?.installmentAmount, "1000.01");
    check("N=1: última = 1.000,01", pN1.body?.lastInstallmentAmount, "1000.01");

    const pMill = await preview("total=9999999.99&installments=3");
    check("millones en 3: base 3.333.333,33", pMill.body?.installmentAmount, "3333333.33");
    check("millones en 3: última 3.333.333,33", pMill.body?.lastInstallmentAmount, "3333333.33");

    section("Preview · bordes de rechazo");
    const pRech = await preview("total=0.03&installments=4");
    check("0,03 en 4 responde 400", pRech.status, 400);
    checkIncluye("y explica el piso de un centavo", pRech.body?.error, "un centavo");

    const p120 = await preview("total=1&installments=120");
    check("1,00 en 120 responde 400 (100 centavos < 120)", p120.status, 400);

    const p120ok = await preview("total=1.2&installments=120");
    check("1,20 en 120 responde 200", p120ok.status, 200);
    check("con cuota 0,01", p120ok.body?.installmentAmount, "0.01");

    const p121 = await preview("total=1000&installments=121");
    check("121 cuotas responde 400 (tope 120)", p121.status, 400);
    const p0 = await preview("total=1000&installments=0");
    check("0 cuotas responde 400", p0.status, 400);
    const pNeg = await preview("total=1000&installments=-5");
    check("−5 cuotas responde 400", pNeg.status, 400);
    const pHalf = await preview("total=1000&installments=1.5");
    check("1,5 cuotas responde 400", pHalf.status, 400);
    const pAbc = await preview("total=1000&installments=abc");
    check("installments=abc responde 400", pAbc.status, 400);
    const pZero = await preview("total=0&installments=3");
    check("total 0 responde 400", pZero.status, 400);
    const pNegM = await preview("total=-100&installments=3");
    check("total negativo responde 400", pNegM.status, 400);
    const pTres = await preview("total=0.0005&installments=1");
    check("total con decimales de más (0,0005) responde 400, nunca 500", pTres.status, 400);
    const pMilesRaro = await preview("total=0.005&installments=1");
    check(
      "«0.005» cae en la regla de miles documentada de parseMoneyInput: es 5,00",
      pMilesRaro.body?.totalAmount,
      "5.00",
    );

    section("Preview · parseo de plata escrito por una persona");
    const pMiles = await preview("total=1.500&installments=3");
    check("«1.500» se interpreta como 1.500 (separador de miles)", pMiles.body?.totalAmount, "1500.00");
    const pComa = await preview("total=1.234,56&installments=3");
    check("«1.234,56» → 1.234,56", pComa.body?.totalAmount, "1234.56");
    check(
      "y la cuota es 411,52 (1.234,56 ¬ 3: base floor 411,52, última 411,52)",
      pComa.body?.installmentAmount,
      "411.52",
    );

    section("POST real · 120 cuotas y repartos finos");
    const card = await crearTarjeta(`${TAG}_VISA`, { closingDay: 25, dueDay: 5 });
    check("crea la tarjeta (201)", card.status, 201);
    const cardId = card.body.id;

    const plan120 = await crearPlan({
      cardId,
      label: `${TAG}_120 cuotas`,
      totalAmount: "120",
      installments: 120,
      purchaseDate: "2026-09-10",
      categoryName: `${TAG}_CAT`,
    });
    check("120 cuotas de 1,00 se aceptan (201)", plan120.status, 201);
    check("el plan tiene 120 items", plan120.body?.plan?.items?.length, 120);
    checkTrue(
      "todas las cuotas son de 1,00",
      (plan120.body?.plan?.items ?? []).every((i) => i.amount === "1.00"),
      "alguna cuota distinta de 1.00",
    );
    const ultimo = plan120.body?.plan?.items?.[119];
    check(
      "la cuota 120 cae en agosto de 2036 (septiembre 2026 + 119 meses)",
      `${ultimo?.periodYear}-${ultimo?.periodMonth}`,
      "2036-8",
    );
    check(
      "Σ items = 120,00 exacto (contra los 120,00 del plan)",
      sumaMontos(plan120.body.plan.items),
      plan120.body.plan.totalAmount,
    );

    const plan7 = await crearPlan({
      cardId,
      label: `${TAG}_7 cuotas`,
      totalAmount: "120000",
      installments: 7,
      purchaseDate: "2026-09-10",
      categoryName: `${TAG}_CAT`,
    });
    check("120.000 en 7 se acepta (201)", plan7.status, 201);
    check("base 17.142,85", plan7.body?.plan?.items?.[0]?.amount, "17142.85");
    check("última 17.142,90 (absorbe los 5 centavos)", plan7.body?.plan?.items?.[6]?.amount, "17142.90");
    check(
      "Σ items = 120.000,00",
      sumaMontos(plan7.body.plan.items),
      "120000.00",
    );
    const dbItems7 = await prisma.cardPlanItem.findMany({
      where: { planId: plan7.body.plan.id },
      orderBy: { number: "asc" },
    });
    check("en la base hay 7 items del plan", dbItems7.length, 7);
    checkTrue(
      "y la última es la mayor (nunca menor que las demás)",
      dbItems7.every((i) => i.amount.greaterThanOrEqualTo(dbItems7[0].amount)),
      "alguna cuota menor que la base",
    );

    const planCent = await crearPlan({
      cardId,
      label: `${TAG}_un centavo`,
      totalAmount: "0.05",
      installments: 5,
      purchaseDate: "2026-09-12",
      categoryName: `${TAG}_CAT`,
    });
    check("0,05 en 5 se acepta (201)", planCent.status, 201);
    checkTrue(
      "cinco cuotas de 0,01",
      (planCent.body?.plan?.items ?? []).every((i) => i.amount === "0.01"),
      JSON.stringify(planCent.body?.plan?.items?.map((i) => i.amount)),
    );

    section("POST real · rechazos con mensaje");
    const rech = await crearPlan({
      cardId,
      label: `${TAG}_rechazado`,
      totalAmount: "0.04",
      installments: 5,
      purchaseDate: "2026-09-10",
      categoryName: `${TAG}_CAT`,
    });
    check("0,04 en 5 responde 400", rech.status, 400);
    checkIncluye("con el motivo del centavo", rech.body?.error, "un centavo");

    const rech121 = await crearPlan({
      cardId,
      label: `${TAG}_121`,
      totalAmount: "1000",
      installments: 121,
      purchaseDate: "2026-09-10",
      categoryName: `${TAG}_CAT`,
    });
    check("121 cuotas responde 400", rech121.status, 400);
    checkIncluye("dice el tope", rech121.body?.error, "120");

    const rech0 = await crearPlan({
      cardId,
      label: `${TAG}_cero`,
      totalAmount: "1000",
      installments: 0,
      purchaseDate: "2026-09-10",
      categoryName: `${TAG}_CAT`,
    });
    check("0 cuotas responde 400", rech0.status, 400);

    section("La corrida factura el reparto EXACTO");
    const run = await correrResumenes(cardId);
    const res = (run.body?.results ?? []).find((r) => r.card.id === cardId);
    // Septiembre (ya cerrado) factura las cuotas 1: 1,00 + 17.142,85 + 0,01
    // = 17.143,86.  (¡Ojo con la suma a mano! 17.142,85 + 1,00 = 17.143,85.)
    const sep = (res?.statements ?? []).find((s) => s.month === 9);
    check(
      "resumen de septiembre = 1,00 + 17.142,85 + 0,01 = 17.143,86",
      sep?.totalDue,
      "17143.86",
    );
    check(
      "mínimo = 5% de 17.143,86 = 857,193 → hacia arriba = 857,20",
      sep?.minimumDue,
      "857.20",
    );
  },
});
