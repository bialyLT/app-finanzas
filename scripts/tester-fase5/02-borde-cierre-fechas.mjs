#!/usr/bin/env node
/**
 * 02 — Borde del día de cierre (criterio 5), clamp a fin de mes y el caso
 * "el cierre es HOY".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ESCENARIO (hoy = 2026-10-17)
 * ─────────────────────────────────────────────────────────────────────────────
 * Tarjeta A (cierre 25, vencimiento 5) — LA REGLA DEL BORDE:
 *   · Gasto de 110,10 el 2026-09-25 (EN el día de cierre) → resumen de
 *     septiembre (el banco cierra al terminar el día).
 *   · Gasto de 222,20 el 2026-09-26 (un día después) → período octubre.
 *   · Plan de 1.000,00 en 1 cuota el 25/09 → item de septiembre.
 *   · Plan de 1.000,00 en 1 cuota el 26/09 → item de octubre.
 *   A MANO: resumen de septiembre = 1.000 + 110,10 = 1.110,10; si la regla
 *   fuera exclusiva (compra del 25 al período siguiente), sería 1.000. Y si la
 *   compra del 26 contara en septiembre, sería 2.110,10. Ninguno de los dos.
 *   Mínimo = 5% de 1.110,10 = 55,505 → hacia arriba → 55,51.
 *
 * Tarjeta B (cierre 17 = HOY, vencimiento 25) — EL CIERRE ES HOY:
 *   · Gasto de 333,00 el 10/10 y plan de 3.000,00 en 3 cuotas (items
 *     octubre/noviembre/diciembre) del 01/10.
 *   · La corrida emite el resumen de octubre (el cierre de HOY cuenta):
 *     1.000 + 333 = 1.333,00; mínimo 66,65; cierra 2026-10-17 y vence
 *     2026-10-25.
 *   · Compromisos: el período de octubre YA está facturado (existe el
 *     documento), así que la ventana arranca en noviembre — las cuotas de
 *     octubre viven en el resumen, no en "lo que va a llegar" (D10). Se
 *     esperan 2.000,00 a 6 y 12 meses (noviembre + diciembre).
 *
 * Tarjeta C (cierre 31, vencimiento 5) — CLAMP Y MESES CORTOS:
 *   · Plan de 500,00 en 1 cuota el 2026-02-28 (febrero de 2026 no tiene 31:
 *     el ancla clampea al 28) → resumen de febrero, cierre 2026-02-28.
 *   · Plan de 6.000,00 en 3 cuotas (2.000 c/u) el 2026-04-30 (abril tiene 30:
 *     el ancla clampea al 30) → items abril/mayo/junio.
 *   · Gasto de 100,00 el 2026-06-30 (clamp de junio) → junio.
 *   · Gasto de 200,00 el 2026-07-01 → julio.
 *   A MANO: resúmenes emitidos (último período cerrado: septiembre, porque el
 *   cierre de octubre es el 31 y todavía no pasó): febrero 500,00 · abril
 *   2.000,00 · mayo 2.000,00 · junio 2.100,00 · julio 200,00. Marzo y agosto
 *   no tienen nada facturado y NO se emiten (un documento de $0 no se inventa).
 */

import {
  check,
  checkTrue,
  checkDeep,
  correrResumenes,
  crearGasto,
  crearPlan,
  crearTarjeta,
  guardToday,
  runScript,
  section,
  sumItems as sumaMontos,
  tarjetaDe,
  vistaTarjetas,
} from "./helpers.mjs";

const TAG = "T_TESTER_F5_02";
guardToday("2026-10-17");

await runScript({
  tag: TAG,
  main: async (prisma) => {
    /* ══ Tarjeta A: el borde exacto del cierre ═══════════════════════════ */

    section("Tarjeta A · compra EN el cierre y el día anterior");
    const cardA = await crearTarjeta(`${TAG}_A`, {
      closingDay: 25,
      dueDay: 5,
      creditLimit: "100000",
    });
    check("crea la tarjeta A (201)", cardA.status, 201);
    const idA = cardA.body.id;

    await crearGasto({
      accountId: idA,
      amount: "110.10",
      date: "2026-09-25",
      categoryName: `${TAG}_CAT`,
      description: `${TAG}_EN el cierre 25`,
    });
    await crearGasto({
      accountId: idA,
      amount: "222.20",
      date: "2026-09-26",
      categoryName: `${TAG}_CAT`,
      description: `${TAG}_después del cierre`,
    });
    const planA1 = await crearPlan({
      cardId: idA,
      label: `${TAG}_Plan borde (25)`,
      totalAmount: "1000",
      installments: 1,
      purchaseDate: "2026-09-25",
      categoryName: `${TAG}_CAT`,
    });
    check("plan del 25/09 (en el cierre) creado (201)", planA1.status, 201);
    checkDeep(
      "su única cuota cae en el resumen que cierra en septiembre",
      [
        planA1.body.plan.items[0].periodYear,
        planA1.body.plan.items[0].periodMonth,
      ],
      [2026, 9],
    );
    const planA2 = await crearPlan({
      cardId: idA,
      label: `${TAG}_Plan borde (26)`,
      totalAmount: "1000",
      installments: 1,
      purchaseDate: "2026-09-26",
      categoryName: `${TAG}_CAT`,
    });
    check("plan del 26/09 (un día después) creado (201)", planA2.status, 201);
    checkDeep(
      "su cuota cae en el resumen que cierra en octubre",
      [
        planA2.body.plan.items[0].periodYear,
        planA2.body.plan.items[0].periodMonth,
      ],
      [2026, 10],
    );

    const runA = await correrResumenes(idA);
    const resA = (runA.body?.results ?? []).find((r) => r.card.id === idA);
    check("la corrida de A crea 1 resumen (septiembre)", resA?.created, 1);
    const sepA = (resA?.statements ?? []).find((s) => s.month === 9);
    check(
      "total de septiembre = 1.000 (plan EN el cierre) + 110,10 = 1.110,10",
      sepA?.totalDue,
      "1110.10",
    );
    check(
      "mínimo = 5% de 1.110,10 = 55,505 → hacia arriba = 55,51",
      sepA?.minimumDue,
      "55.51",
    );

    const vistaA = await vistaTarjetas();
    const a = tarjetaDe(vistaA, idA);
    check(
      "proyección de octubre = 1.000 (plan del 26) + 222,20 = 1.222,20",
      a?.currentPeriod?.totalDue,
      "1222.20",
    );
    check(
      "mínimo proyectado = 5% de 1.222,20 = 61,11 exacto",
      a?.currentPeriod?.minimumDue,
      "61.11",
    );
    check(
      "compromisos a 6 meses = sólo el item de octubre = 1.000,00",
      a?.commitments?.next6Months,
      "1000.00",
    );
    check(
      "compromisos a 12 meses = 1.000,00 (el item de septiembre ya se facturó)",
      a?.commitments?.next12Months,
      "1000.00",
    );
    check("deuda de A = 110,10 + 222,20 + 1.000 + 1.000 = 2.332,30", a?.debt, "2332.30");

    /* ══ Tarjeta B: el cierre es HOY ═════════════════════════════════════ */

    section("Tarjeta B · el cierre es HOY (17/10)");
    const cardB = await crearTarjeta(`${TAG}_B`, { closingDay: 17, dueDay: 25 });
    check("crea la tarjeta B (201)", cardB.status, 201);
    const idB = cardB.body.id;

    await crearGasto({
      accountId: idB,
      amount: "333",
      date: "2026-10-10",
      categoryName: `${TAG}_CAT`,
      description: `${TAG}_B directo`,
    });
    const planB = await crearPlan({
      cardId: idB,
      label: `${TAG}_B plan 3 cuotas`,
      totalAmount: "3000",
      installments: 3,
      purchaseDate: "2026-10-01",
      categoryName: `${TAG}_CAT`,
    });
    check("plan de B creado (201)", planB.status, 201);
    checkDeep(
      "items de B: octubre, noviembre y diciembre",
      planB.body.plan.items.map((i) => [i.periodYear, i.periodMonth]),
      [
        [2026, 10],
        [2026, 11],
        [2026, 12],
      ],
    );

    const runB = await correrResumenes(idB);
    const resB = (runB.body?.results ?? []).find((r) => r.card.id === idB);
    check("la corrida de B emite el período que cierra HOY", resB?.created, 1);
    const octB = (resB?.statements ?? []).find((s) => s.month === 10);
    check(
      "total de octubre = 1.000 + 333 = 1.333,00",
      octB?.totalDue,
      "1333.00",
    );
    check("mínimo = 5% de 1.333 = 66,65", octB?.minimumDue, "66.65");
    check("cierra HOY", octB?.closingDate, "2026-10-17");
    check("vence el 2026-10-25 (primer día 25 después del cierre)", octB?.dueDate, "2026-10-25");

    const vistaB = await vistaTarjetas();
    const b = tarjetaDe(vistaB, idB);
    check("el período en curso es octubre", b?.currentPeriod?.month, 10);
    check("y está cerrado", b?.currentPeriod?.closed, true);
    check("con documento persistido", b?.currentPeriod?.persisted, true);
    check(
      "el número es el del documento (1.333,00), no una proyección",
      b?.currentPeriod?.totalDue,
      "1333.00",
    );
    check(
      "compromisos a 6 meses = noviembre + diciembre = 2.000,00 (octubre YA está facturado y vive en su resumen, D10)",
      b?.commitments?.next6Months,
      "2000.00",
    );
    check(
      "compromisos a 12 meses = 2.000,00",
      b?.commitments?.next12Months,
      "2000.00",
    );
    checkDeep(
      "la ventana de compromisos arranca en noviembre",
      [
        b?.commitments?.months?.[0]?.year,
        b?.commitments?.months?.[0]?.month,
        b?.commitments?.months?.[0]?.amount,
      ],
      [2026, 11, "1000.00"],
    );
    check(
      "el resumen de octubre sigue impago en la vista",
      b?.statements?.[0]?.paid,
      false,
    );

    /* ══ Tarjeta C: clamp 31 en meses cortos ═════════════════════════════ */

    section("Tarjeta C · cierre 31 clampeado (febrero, abril, junio)");
    const cardC = await crearTarjeta(`${TAG}_C`, { closingDay: 31, dueDay: 5 });
    check("crea la tarjeta C (201)", cardC.status, 201);
    const idC = cardC.body.id;

    const planF = await crearPlan({
      cardId: idC,
      label: `${TAG}_C febrero`,
      totalAmount: "500",
      installments: 1,
      purchaseDate: "2026-02-28",
      categoryName: `${TAG}_CAT`,
    });
    check("plan del 28/02 (febrero clampeado) creado (201)", planF.status, 201);
    checkDeep(
      "la cuota cae en el resumen que cierra en febrero",
      [planF.body.plan.items[0].periodYear, planF.body.plan.items[0].periodMonth],
      [2026, 2],
    );

    const planAb = await crearPlan({
      cardId: idC,
      label: `${TAG}_C abril`,
      totalAmount: "6000",
      installments: 3,
      purchaseDate: "2026-04-30",
      categoryName: `${TAG}_CAT`,
    });
    check("plan del 30/04 (abril clampeado) creado (201)", planAb.status, 201);
    checkDeep(
      "items: abril, mayo, junio",
      planAb.body.plan.items.map((i) => [i.periodYear, i.periodMonth]),
      [
        [2026, 4],
        [2026, 5],
        [2026, 6],
      ],
    );

    await crearGasto({
      accountId: idC,
      amount: "100",
      date: "2026-06-30",
      categoryName: `${TAG}_CAT`,
      description: `${TAG}_C junio 30`,
    });
    await crearGasto({
      accountId: idC,
      amount: "200",
      date: "2026-07-01",
      categoryName: `${TAG}_CAT`,
      description: `${TAG}_C julio 1`,
    });

    const runC = await correrResumenes(idC);
    const resC = (runC.body?.results ?? []).find((r) => r.card.id === idC);
    check("la corrida de C crea 5 resúmenes (feb, abr, may, jun, jul)", resC?.created, 5);

    const porMes = new Map((resC?.statements ?? []).map((s) => [s.month, s]));
    check(
      "febrero: total 500,00, cierra el 28 (clamp)",
      `${porMes.get(2)?.totalDue} ${porMes.get(2)?.closingDate}`,
      "500.00 2026-02-28",
    );
    check("febrero vence el 2026-03-05", porMes.get(2)?.dueDate, "2026-03-05");
    check(
      "abril: total 2.000,00, cierra el 30 (clamp)",
      `${porMes.get(4)?.totalDue} ${porMes.get(4)?.closingDate}`,
      "2000.00 2026-04-30",
    );
    check(
      "junio: 2.000 + 100 = 2.100,00, cierra el 30 (clamp)",
      `${porMes.get(6)?.totalDue} ${porMes.get(6)?.closingDate}`,
      "2100.00 2026-06-30",
    );
    check("junio: mínimo 105,00", porMes.get(6)?.minimumDue, "105.00");
    check(
      "julio: 200,00 (el gasto del 01/07 no entra a junio), cierra el 31",
      `${porMes.get(7)?.totalDue} ${porMes.get(7)?.closingDate}`,
      "200.00 2026-07-31",
    );
    checkTrue(
      "no hay resumen de marzo (nada facturado: un documento de $0 no se inventa)",
      !porMes.has(3),
    );

    const dbC = await prisma.statement.findMany({ where: { accountId: idC } });
    check("la base tiene exactamente 5 resúmenes de C", dbC.length, 5);
    check(
      "Σ de los resúmenes de C == Σ de sus gastos: 500+2.000+2.000+2.100+200 = 6.800,00",
      sumaMontos(dbC, (s) => s.totalDue),
      "6800.00",
    );
  },
});
