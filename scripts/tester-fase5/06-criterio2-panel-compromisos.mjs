#!/usr/bin/env node
/**
 * 06 — Criterio 2 (cuotas comprometidas 6/12 meses) + criterio 7 (tasa
 * implícita del panel / vista previa).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ESCENARIO (hoy = 2026-10-17)
 * ─────────────────────────────────────────────────────────────────────────────
 * Tarjeta F (cierre 25, vence 5, límite 600.000,00).
 *   · Plan X: 120.000,00 en 12 cuotas de 10.000,00, contado 108.000,00,
 *     compra 10/09/2026 → cuotas septiembre 2026 … agosto 2027.
 *   · Plan Y: 30.000,00 en 6 cuotas de 5.000,00, compra 16/10/2026
 *     → cuotas octubre 2026 … marzo 2027.
 *   · Gasto directo: 4.000,00 del 10/10/2026 → período octubre.
 *
 * Deuda = 120.000 + 30.000 + 4.000 = 154.000,00.
 * Utilización = 154.000 / 600.000 × 100 = 25,666… → 25,67.
 *
 * La ventana de compromisos arranca en el período EN CURSO (octubre 2026:
 * cierra el 25/10, todavía no cerró) y avanza 12 meses:
 *   oct … mar: X 10.000 + Y 5.000 = 15.000,00 por mes (6 meses → 90.000,00)
 *   abr … ago: X 10.000 (Y terminó en marzo) = 10.000,00 por mes (5 meses)
 *   sep 2027: 0,00 (X terminó en agosto)
 *   next6 = 6 × 15.000 = 90.000,00
 *   next12 = 6 × 15.000 + 5 × 10.000 = 140.000,00
 *
 * Proyección del período en curso (octubre): X 10.000 + Y 5.000 + directo
 * 4.000 = 19.000,00; mínimo 5 % = 950,00.
 *
 * Pago del resumen de septiembre (sólo la cuota 1 de X = 10.000,00): la deuda
 * baja a 144.000,00 y la utilización a 24,00; los compromisos NO cambian
 * (septiembre ya está fuera de la ventana).
 *
 * Tasa implícita de X: Σ 10.000 / (1+i)^k = 108.000 → i ≈ 1,6594 % mensual
 * → TEA = (1+i)^12 − 1 ≈ 21,8341 % (el servidor redondea a 1,66 / 21,83).
 * El script resuelve la raíz por bisección INDEPENDIENTE (JS, doubles) y
 * compara con tolerancia de 0,01 punto porcentual.
 */

import {
  check,
  checkCerca,
  checkDeep,
  checkTrue,
  correrResumenes,
  crearCuenta,
  crearGasto,
  crearPlan,
  crearTarjeta,
  guardToday,
  get,
  pagarResumen,
  runScript,
  section,
  tarjetaDe,
  vistaTarjetas,
} from "./helpers.mjs";

const TAG = "T_TESTER_F5_06";
guardToday("2026-10-17");

/** Valor presente de pagos iguales a la tasa mensual `rate` (0,01 = 1 %). */
function presentValue(rate, payments) {
  return payments.reduce(
    (acc, payment, index) => acc + payment / (1 + rate) ** (index + 1),
    0,
  );
}

/** Resuelve Σ pago/(1+i)^k = contado por bisección, sin mirar el servidor. */
function solveMonthlyRate(payments, cash) {
  let low = 0;
  let high = 1;
  while (presentValue(high, payments) > cash) high *= 2;
  for (let index = 0; index < 200; index += 1) {
    const mid = (low + high) / 2;
    if (presentValue(mid, payments) > cash) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

await runScript({
  tag: TAG,
  main: async (prisma) => {
    section("Montaje");
    const banco = await crearCuenta(`${TAG}_BANCO`, "BANK", "100000");
    const bancoId = banco.body.id;

    const tarjeta = await crearTarjeta(`${TAG}_VISA`, {
      closingDay: 25,
      dueDay: 5,
      creditLimit: "600000",
    });
    check("tarjeta creada (201)", tarjeta.status, 201);
    const cardId = tarjeta.body.id;

    const planX = await crearPlan({
      cardId,
      label: `${TAG}_X 12`,
      totalAmount: "120000",
      installments: 12,
      purchaseDate: "2026-09-10",
      cashPrice: "108000",
      categoryName: `${TAG}_CAT`,
    });
    check("plan X (120.000 en 12) creado (201)", planX.status, 201);
    check(
      "X: cuotas de septiembre 2026 a agosto 2027",
      JSON.stringify([
        planX.body?.plan?.items?.[0]?.periodMonth,
        planX.body?.plan?.items?.[11]?.periodMonth,
        planX.body?.plan?.items?.[11]?.periodYear,
      ]),
      JSON.stringify([9, 8, 2027]),
    );
    check("X: precio de contado guardado", planX.body?.plan?.cashPrice, "108000.00");

    const planY = await crearPlan({
      cardId,
      label: `${TAG}_Y 6`,
      totalAmount: "30000",
      installments: 6,
      purchaseDate: "2026-10-16",
      categoryName: `${TAG}_CAT`,
    });
    check("plan Y (30.000 en 6) creado (201)", planY.status, 201);
    check(
      "Y: cuotas de octubre 2026 a marzo 2027",
      JSON.stringify([
        planY.body?.plan?.items?.[0]?.periodMonth,
        planY.body?.plan?.items?.[5]?.periodMonth,
        planY.body?.plan?.items?.[5]?.periodYear,
      ]),
      JSON.stringify([10, 3, 2027]),
    );

    const directo = await crearGasto({
      accountId: cardId,
      amount: "4000",
      date: "2026-10-10",
      categoryName: `${TAG}_CAT`,
      description: `${TAG}_directo octubre`,
    });
    check("gasto directo de octubre creado (201)", directo.status, 201);

    /* ── Tasa implícita: 10 % de descuento al contado ─────────────────────── */

    section("Tasa implícita: 120.000 en 12 con contado 108.000");
    const preview = await get(
      "/api/cards/plans/preview?total=120000&installments=12&cashPrice=108000",
    );
    check("preview: 200", preview.status, 200);
    check("total 120.000,00", preview.body?.totalAmount, "120000.00");
    check("12 cuotas", preview.body?.installments, 12);
    check("cuota 10.000,00", preview.body?.installmentAmount, "10000.00");
    check("última 10.000,00", preview.body?.lastInstallmentAmount, "10000.00");
    check("total pagado 120.000,00", preview.body?.totalPaid, "120000.00");
    check("contado 108.000,00", preview.body?.cashPrice, "108000.00");
    check("sobreprecio 12.000,00", preview.body?.surcharge, "12000.00");

    const cuotasX = Array.from({ length: 12 }, () => 10000);
    const monthly = solveMonthlyRate(cuotasX, 108000);
    const tea = (1 + monthly) ** 12 - 1;
    console.log(
      `    bisección independiente: i = ${(monthly * 100).toFixed(6)} % mensual, TEA = ${(tea * 100).toFixed(6)} %`,
    );
    checkCerca(
      "tasa mensual ≈ 1,6594 % (bisección independiente)",
      preview.body?.implicitRate?.monthlyRatePercent,
      monthly * 100,
      0.01,
    );
    checkCerca(
      "TEA ≈ 21,8341 % (capitaliza, no i×12)",
      preview.body?.implicitRate?.teaPercent,
      tea * 100,
      0.01,
    );
    check(
      "TEA ≠ 12 × mensual (no es una TNA disfrazada)",
      Number(preview.body?.implicitRate?.teaPercent) > 12 * Number(preview.body?.implicitRate?.monthlyRatePercent),
      true,
    );
    check(
      "el plan guardado informa la misma tasa que la vista previa",
      `${planX.body?.plan?.implicitRate?.monthlyRatePercent} ${planX.body?.plan?.implicitRate?.teaPercent}`,
      `${preview.body?.implicitRate?.monthlyRatePercent} ${preview.body?.implicitRate?.teaPercent}`,
    );

    const previewSinInteres = await get(
      "/api/cards/plans/preview?total=120000&installments=12&cashPrice=120000",
    );
    check("contado == total: tasa mensual 0,00", previewSinInteres.body?.implicitRate?.monthlyRatePercent, "0.00");
    check("contado == total: TEA 0,00", previewSinInteres.body?.implicitRate?.teaPercent, "0.00");
    check("contado == total: sobreprecio 0,00", previewSinInteres.body?.surcharge, "0.00");

    const previewSinContado = await get(
      "/api/cards/plans/preview?total=120000&installments=12",
    );
    check("sin contado: cashPrice null", previewSinContado.body?.cashPrice, null);
    check("sin contado: tasa null (no se sabe)", previewSinContado.body?.implicitRate, null);
    check("sin contado: sobreprecio null", previewSinContado.body?.surcharge, null);

    /* ── Criterio 2: la vista de tarjetas ─────────────────────────────────── */

    section("Panel: deuda, utilización, proyección y compromisos");
    const vista = await vistaTarjetas();
    check("GET /api/cards: 200", vista.status, 200);
    const card = tarjetaDe(vista, cardId);
    checkTrue("la tarjeta está en la vista", Boolean(card));
    check("deuda = 120.000 + 30.000 + 4.000 = 154.000,00", card?.debt, "154000.00");
    check(
      "utilización = 154.000 / 600.000 = 25,666… → 25,67",
      card?.utilizationPercent,
      "25.67",
    );

    check(
      "período en curso: octubre 2026",
      `${card?.currentPeriod?.year}-${card?.currentPeriod?.month}`,
      "2026-10",
    );
    check(
      "proyección = X 10.000 + Y 5.000 + directo 4.000 = 19.000,00",
      card?.currentPeriod?.totalDue,
      "19000.00",
    );
    check("mínimo proyectado = 950,00", card?.currentPeriod?.minimumDue, "950.00");
    check("cierra el 2026-10-25", card?.currentPeriod?.closingDate, "2026-10-25");
    check("vence el 2026-11-05", card?.currentPeriod?.dueDate, "2026-11-05");
    check("octubre todavía no cerró", card?.currentPeriod?.closed, false);
    check("es proyección, no documento", card?.currentPeriod?.persisted, false);

    check("compromisos próximos 6 meses = 90.000,00", card?.commitments?.next6Months, "90000.00");
    check("compromisos próximos 12 meses = 140.000,00", card?.commitments?.next12Months, "140000.00");
    check("la ventana tiene 12 meses", card?.commitments?.months?.length, 12);
    checkDeep(
      "mes por mes: oct–mar 15.000; abr–ago 10.000; sep-2027 0 (a mano)",
      (card?.commitments?.months ?? []).map((month) => month.amount),
      [
        "15000.00",
        "15000.00",
        "15000.00",
        "15000.00",
        "15000.00",
        "15000.00",
        "10000.00",
        "10000.00",
        "10000.00",
        "10000.00",
        "10000.00",
        "0.00",
      ],
    );
    check(
      "el primer mes es octubre 2026",
      `${card?.commitments?.months?.[0]?.year}-${card?.commitments?.months?.[0]?.month}`,
      "2026-10",
    );
    check(
      "el último mes es septiembre 2027",
      `${card?.commitments?.months?.[11]?.year}-${card?.commitments?.months?.[11]?.month}`,
      "2027-9",
    );

    const planXEnVista = (card?.plans ?? []).find((plan) => plan.label === `${TAG}_X 12`);
    const planYEnVista = (card?.plans ?? []).find((plan) => plan.label === `${TAG}_Y 6`);
    check("X: 1 cuota ya facturada (septiembre cerró)", planXEnVista?.billedInstallments, 1);
    check("Y: 0 cuotas facturadas (octubre no cerró)", planYEnVista?.billedInstallments, 0);

    /* ── Pago del resumen: baja la deuda, no los compromisos ──────────────── */

    section("Pago de septiembre: deuda y utilización bajan");
    const run = await correrResumenes(cardId);
    const resultado = (run.body?.results ?? []).find((r) => r.card.id === cardId);
    const sep = (resultado?.statements ?? []).find((s) => s.month === 9 && s.year === 2026);
    check("el resumen de septiembre es sólo la cuota 1 de X = 10.000,00", sep?.totalDue, "10000.00");
    check("mínimo 500,00", sep?.minimumDue, "500.00");

    const pago = await pagarResumen(sep.id, bancoId);
    check("pago del resumen de septiembre (201)", pago.status, 201);

    const vista2 = await vistaTarjetas();
    const card2 = tarjetaDe(vista2, cardId);
    check("deuda = 154.000 − 10.000 = 144.000,00", card2?.debt, "144000.00");
    check(
      "utilización = 144.000 / 600.000 = 24,00",
      card2?.utilizationPercent,
      "24.00",
    );
    check("next6 sigue en 90.000,00 (septiembre quedó fuera de la ventana)", card2?.commitments?.next6Months, "90000.00");
    check("next12 sigue en 140.000,00", card2?.commitments?.next12Months, "140000.00");
    check(
      "la proyección de octubre no cambia (el pago es TRANSFER, no gasto)",
      card2?.currentPeriod?.totalDue,
      "19000.00",
    );
    check("el resumen de septiembre figura pagado", card2?.statements?.find((s) => s.month === 9)?.paid, true);

    /* ── Resumen pagado DENTRO de la ventana ──────────────────────────────── */

    section("Un resumen pagado dentro de la ventana excluye sus cuotas");
    // Fixture directo: la API sólo emite períodos YA cerrados y hoy no existe
    // ningún período futuro cerrado. Para probar la exclusión de cuotas de
    // resúmenes pagados hace falta un resumen pagado DENTRO de oct-2026…
    // sep-2027; se inserta el de diciembre con su transferencia. Pagar el
    // resumen de diciembre salda TODO ese período: X 10.000 + Y 5.000.
    const pagoFicticio = await prisma.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "15000.00",
        date: new Date(2026, 9, 17),
        description: `${TAG}_pago ficticio diciembre`,
        accountId: bancoId,
        toAccountId: cardId,
      },
    });
    const diciembre = await prisma.statement.create({
      data: {
        accountId: cardId,
        periodYear: 2026,
        periodMonth: 12,
        closingDate: new Date(2026, 11, 25),
        dueDate: new Date(2027, 0, 5),
        totalDue: "15000.00",
        minimumDue: "750.00",
        paidMovementId: pagoFicticio.id,
      },
    });
    checkTrue("fixture: resumen de diciembre pagado creado", Boolean(diciembre.id));

    const vista3 = await vistaTarjetas();
    const card3 = tarjetaDe(vista3, cardId);
    check(
      "diciembre = 0,00 (X 10.000 + Y 5.000 quedaron pagados con ese resumen)",
      card3?.commitments?.months?.[2]?.amount,
      "0.00",
    );
    check("next6 = 90.000 − 15.000 = 75.000,00", card3?.commitments?.next6Months, "75000.00");
    check("next12 = 140.000 − 15.000 = 125.000,00", card3?.commitments?.next12Months, "125000.00");
    check("deuda = 144.000 − 15.000 = 129.000,00", card3?.debt, "129000.00");
    check("utilización = 129.000 / 600.000 = 21,50", card3?.utilizationPercent, "21.50");
    check(
      "el resumen de diciembre figura pagado en el panel",
      card3?.statements?.find((s) => s.month === 12)?.paid,
      true,
    );
  },
});
