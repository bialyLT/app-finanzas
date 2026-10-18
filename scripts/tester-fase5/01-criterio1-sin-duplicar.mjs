#!/usr/bin/env node
/**
 * 01 — Criterio 1 (el gasto se cuenta UNA vez), criterio 3 (el pago del resumen
 * no aparece en ninguna categoría de gasto) y criterio 6 (Statement con total,
 * cierre, vencimiento y mínimo EXACTOS).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ESCENARIO (hoy = 2026-10-17, tarjeta con cierre 25 y vencimiento 5)
 * ─────────────────────────────────────────────────────────────────────────────
 *   · Compra de $120.000 en 12 cuotas el 2026-09-10 (antes del cierre de
 *     septiembre) → primera cuota en el resumen que cierra el 25/09.
 *   · Gasto directo de $5.000 el 2026-09-20 → mismo resumen de septiembre.
 *   · Gasto directo de $900 el 2026-10-12 → período en curso (octubre).
 *
 * A MANO:
 *   · Resumen de septiembre = cuota 1 (10.000,00) + directo 5.000,00
 *     = 15.000,00.  Mínimo = 5% = 750,00 exacto.
 *     Si el gasto del plan se contara dos veces, sería 135.000,00: el número
 *     que este script descarta.
 *   · Vence 2026-10-05 (primer día 5 estrictamente posterior al cierre 25/09).
 *   · Deuda de la tarjeta al 17/10 = 120.000 + 5.000 + 900 = 125.900,00.
 *     Utilización = 125.900 / 600.000 × 100 = 20,9833… → 20,98.
 *   · Pago del resumen: TRANSFER de 15.000,00 banco → tarjeta. Deuda después =
 *     110.900,00.  Utilización = 18,4833… → 18,48.
 *   · Compromisos desde octubre: cuotas 2..12 de 10.000 → 110.000,00 en 12
 *     meses; 6 meses = 60.000,00.
 */

import {
  check,
  checkTrue,
  checkDeep,
  correrResumenes,
  crearCuenta,
  crearGasto,
  crearPlan,
  crearTarjeta,
  cuentaDe,
  guardToday,
  pagarResumen,
  runScript,
  section,
  sumItems as sumaMontos,
  tarjetaDe,
  vistaTarjetas,
  get,
} from "./helpers.mjs";

const TAG = "T_TESTER_F5_01";
const TODAY = guardToday("2026-10-17");

await runScript({
  tag: TAG,
  main: async (prisma) => {
    section("Montaje: tarjeta, banco y compras");
    const visa = await crearTarjeta(`${TAG}_VISA`, {
      closingDay: 25,
      dueDay: 5,
      creditLimit: "600000",
    });
    check("crea la tarjeta Visa con cierre 25 (201)", visa.status, 201);
    check("devuelve closingDay 25", visa.body?.closingDay, 25);
    check("devuelve dueDay 5", visa.body?.dueDay, 5);
    check("devuelve creditLimit", visa.body?.creditLimit, "600000.00");
    const cardId = visa.body.id;

    const banco = await crearCuenta(`${TAG}_BANCO`, "BANK", "500000");
    check("crea el banco con saldo 500.000 (201)", banco.status, 201);
    const bancoId = banco.body.id;

    const plan = await crearPlan({
      cardId,
      label: `${TAG}_Heladera 12 cuotas`,
      totalAmount: "120000",
      installments: 12,
      purchaseDate: "2026-09-10",
      categoryName: `${TAG}_CAT`,
    });
    check("crea el plan de 12 cuotas (201)", plan.status, 201);
    check("el plan tiene 12 cuotas", plan.body?.plan?.items?.length, 12);
    checkTrue(
      "todas las cuotas son de 10.000,00 (120.000 ÷ 12 exacto)",
      (plan.body?.plan?.items ?? []).every((i) => i.amount === "10000.00"),
      JSON.stringify(plan.body?.plan?.items?.map((i) => i.amount)),
    );
    checkDeep(
      "las cuotas caen de septiembre 2026 a agosto 2027",
      [plan.body.plan.items[0], plan.body.plan.items[11]].map((i) => [
        i.periodYear,
        i.periodMonth,
      ]),
      [
        [2026, 9],
        [2027, 8],
      ],
    );
    check(
      "el movimiento de la compra es UN EXPENSE de 120.000,00",
      `${plan.body.plan.movement.kind} ${plan.body.plan.movement.amount}`,
      "EXPENSE 120000.00",
    );
    check(
      "con la fecha de la compra",
      plan.body.plan.movement.date,
      "2026-09-10",
    );
    check(
      "sin precio de contado la tasa implícita es null (no se sabe)",
      plan.body.plan.implicitRate,
      null,
    );

    const directoSep = await crearGasto({
      accountId: cardId,
      amount: "5000",
      date: "2026-09-20",
      categoryName: `${TAG}_CAT`,
      description: `${TAG}_Directo septiembre`,
    });
    check("crea el gasto directo de septiembre (201)", directoSep.status, 201);

    const directoOct = await crearGasto({
      accountId: cardId,
      amount: "900",
      date: "2026-10-12",
      categoryName: `${TAG}_CAT`,
      description: `${TAG}_Directo octubre`,
    });
    check("crea el gasto directo de octubre (201)", directoOct.status, 201);

    /* ── Corrida de resúmenes ─────────────────────────────────────────────── */

    section("Corrida: el resumen de septiembre NO duplica la compra");
    const run = await correrResumenes(cardId);
    check("la corrida responde 200", run.status, 200);
    const resultVisa = (run.body?.results ?? []).find((r) => r.card.id === cardId);
    checkTrue("la tarjeta aparece en la corrida", Boolean(resultVisa));
    check("crea 1 resumen (septiembre)", resultVisa?.created, 1);

    const sep = (resultVisa?.statements ?? []).find(
      (s) => s.year === 2026 && s.month === 9,
    );
    checkTrue("existe el resumen de septiembre", Boolean(sep));
    check("total = 10.000 + 5.000 = 15.000,00", sep?.totalDue, "15000.00");
    check("mínimo = 5% de 15.000 = 750,00", sep?.minimumDue, "750.00");
    check("cierre = 2026-09-25", sep?.closingDate, "2026-09-25");
    check("vence el 2026-10-05 (5/10, primer día 5 tras el cierre 25/09)", sep?.dueDate, "2026-10-05");
    check("nace impago", sep?.paid, false);

    const dbStatements = await prisma.statement.findMany({ where: { accountId: cardId } });
    check("la base tiene 1 resumen para la tarjeta", dbStatements.length, 1);
    check("y su totalDue en la base es 15000.00", dbStatements[0]?.totalDue.toFixed(2), "15000.00");

    const dbPlans = await prisma.cardPlan.findMany({
      where: { accountId: cardId },
      include: { items: true },
    });
    check("la base tiene 1 plan", dbPlans.length, 1);
    check("con 12 items", dbPlans[0]?.items.length, 12);
    check(
      "Σ items == totalAmount (invariante al centavo)",
      sumaMontos(dbPlans[0].items),
      "120000.00",
    );

    /* ── Criterio 3: el pago es TRANSFER, jamás gasto ─────────────────────── */

    section("Pago del resumen: TRANSFER y no gasto");
    const pago = await pagarResumen(sep.id, bancoId);
    check("paga el resumen (201)", pago.status, 201);
    check("created: true", pago.body?.created, true);
    check(
      "el pago es una TRANSFER de 15.000,00",
      `${pago.body?.movement?.kind} ${pago.body?.movement?.amount}`,
      "TRANSFER 15000.00",
    );
    check("fechado hoy", pago.body?.movement?.date, TODAY);
    check("desde el banco", pago.body?.movement?.account?.id, bancoId);
    check("hacia la tarjeta", pago.body?.movement?.toAccount?.id, cardId);
    check("el resumen queda pagado", pago.body?.statement?.paid, true);

    const segundoPago = await pagarResumen(sep.id, bancoId);
    check("el segundo pago responde 200 (idempotente)", segundoPago.status, 200);
    check("con created: false", segundoPago.body?.created, false);
    check(
      "y el MISMO movimiento (no duplica la transferencia)",
      segundoPago.body?.movement?.id,
      pago.body?.movement?.id,
    );
    const transferencias = await prisma.movement.count({
      where: { kind: "TRANSFER", toAccountId: cardId },
    });
    check("en la base hay UNA sola transferencia hacia la tarjeta", transferencias, 1);

    const runFrozen = await correrResumenes(cardId);
    const frozen = (runFrozen.body?.results ?? []).find((r) => r.card.id === cardId);
    check("segunda corrida: el resumen pagado queda congelado", frozen?.frozen, 1);
    check("segunda corrida: no crea nada", frozen?.created, 0);

    /* ── Criterio 6 + panel: números exactos después del pago ─────────────── */

    section("Saldos y panel (números a mano)");
    const bancoDespues = await cuentaDe(bancoId);
    check("el banco queda en 500.000 − 15.000 = 485.000,00", bancoDespues?.balance, "485000.00");

    const vista = await vistaTarjetas();
    check("GET /api/cards responde 200", vista.status, 200);
    const card = tarjetaDe(vista, cardId);
    checkTrue("la tarjeta está en la vista", Boolean(card));
    check(
      "deuda = 120.000 + 5.000 + 900 − 15.000 = 110.900,00",
      card?.debt,
      "110900.00",
    );
    check(
      "utilización = 110.900 / 600.000 × 100 = 18,4833… → 18,48",
      card?.utilizationPercent,
      "18.48",
    );
    check("período en curso: octubre 2026", `${card?.currentPeriod?.year}-${card?.currentPeriod?.month}`, "2026-10");
    check(
      "proyección de octubre = cuota 2 (10.000) + directo 900 = 10.900,00",
      card?.currentPeriod?.totalDue,
      "10900.00",
    );
    check("mínimo proyectado = 545,00 (5% exacto)", card?.currentPeriod?.minimumDue, "545.00");
    check("octubre todavía no cerró", card?.currentPeriod?.closed, false);
    check("es una proyección, no un documento", card?.currentPeriod?.persisted, false);
    check("el resumen de septiembre está pagado", card?.statements?.[0]?.paid, true);
    check(
      "compromisos próximos 12 meses = cuotas 2..12 = 110.000,00",
      card?.commitments?.next12Months,
      "110000.00",
    );
    check(
      "compromisos próximos 6 meses = cuotas 2..7 = 60.000,00",
      card?.commitments?.next6Months,
      "60000.00",
    );
    checkDeep(
      "el primer mes comprometido es octubre con 10.000,00",
      [
        card?.commitments?.months?.[0]?.year,
        card?.commitments?.months?.[0]?.month,
        card?.commitments?.months?.[0]?.amount,
      ],
      [2026, 10, "10000.00"],
    );
    check(
      "el mes 12 de la ventana (septiembre 2027) está en 0,00",
      card?.commitments?.months?.[11]?.amount,
      "0.00",
    );
    check("cuotas ya facturadas del plan = 1 (sólo septiembre cerró)", card?.plans?.[0]?.billedInstallments, 1);

    /* ── Criterio 3 en los reportes ───────────────────────────────────────── */

    section("Reportes: septiembre cuenta el gasto UNA vez; octubre no suma el pago");
    // Los reportes mezclan TODA la base (incluido el seed). El filtro `q`
    // recorta por texto sobre descripción y nombres de cuenta/categoría: con
    // el prefijo del script, los totales vuelven a ser números a mano.
    const Q = `q=${TAG}`;
    const repSep = await get(`/api/reports?from=2026-09-01&to=2026-09-30&${Q}`);
    check("reporte de septiembre responde 200", repSep.status, 200);
    check(
      "gastos de septiembre = 120.000 + 5.000 = 125.000,00 (no 135.000)",
      repSep.body?.totals?.expenses,
      "125000.00",
    );
    check("sin transferencias en septiembre", repSep.body?.totals?.transfers, "0.00");
    check("flujo de caja de septiembre 0,00 (todo fue con tarjeta)", repSep.body?.totals?.cashFlow, "0.00");
    const catSep = (repSep.body?.byCategory ?? []).find((c) => c.name === `${TAG}_CAT`);
    check("la categoría del gasto acumula 125.000,00", catSep?.amount, "125000.00");

    const repOct = await get(`/api/reports?from=2026-10-01&to=2026-10-31&${Q}`);
    check(
      "gastos de octubre = 900,00 (el PAGO no es gasto)",
      repOct.body?.totals?.expenses,
      "900.00",
    );
    check(
      "la transferencia se informa aparte: 15.000,00",
      repOct.body?.totals?.transfers,
      "15000.00",
    );
    check(
      "flujo de caja de octubre = −15.000,00 (sale del banco)",
      repOct.body?.totals?.cashFlow,
      "-15000.00",
    );
    check("una sola categoría de gasto en octubre", repOct.body?.byCategory?.length, 1);
    check(
      "y es la del gasto directo, con 900,00 (el pago no aparece acá)",
      repOct.body?.byCategory?.[0]?.amount,
      "900.00",
    );
    const repOctTexto = JSON.stringify(repOct.body);
    checkTrue(
      "el pago no aparece en NINGUNA categoría de gasto",
      !repOctTexto.includes("Pago resumen"),
      "el texto del reporte contiene 'Pago resumen'",
    );
  },
});
