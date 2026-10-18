#!/usr/bin/env node
/**
 * 09 — Criterio 4: cruce de año. Un resumen de DICIEMBRE pagado en ENERO no
 * descuadra ningún reporte ni la reconciliación de ninguno de los dos meses.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ESCENARIO (hoy = 2026-10-17)
 * ─────────────────────────────────────────────────────────────────────────────
 * Tarjeta (cierre 25, vence 5) con un plan de 120.000,00 en 12 cuotas de
 * 10.000,00 comprado el 20/12/2025 → cuotas diciembre 2025 … noviembre 2026.
 * Gasto directo de 5.000,00 del 22/12/2025 → mismo período: diciembre 2025.
 *
 * La corrida emite 10 resúmenes (diciembre 2025 … septiembre 2026; octubre no
 * cerró todavía). El de diciembre:
 *   total = cuota 10.000 + directo 5.000 = 15.000,00
 *   cierre 2025-12-25, vence 2026-01-05.
 *
 * El pago del resumen de diciembre se hace el 05/01/2026. La API fecha los
 * pagos HOY, así que el pago se arma con Prisma directo (TRANSFER del banco a
 * la tarjeta, fecha 2026-01-05, enlazada al resumen): es exactamente el estado
 * que la API habría producido ese día.
 *
 * Números a mano:
 *   Reporte diciembre 2025 (q=TAG): gastos = 120.000 + 5.000 = 125.000,00;
 *     transferencias 0,00; flujo de caja 0,00 (todo fue con la tarjeta).
 *   Reporte enero 2026 (q=TAG): gastos 0,00; transferencias 15.000,00
 *     (el pago NO es gasto); flujo de caja = −15.000,00.
 *   Reconciliación diciembre 2025: ΔPatrimonio = −125.000,00 = ahorro
 *     −125.000,00 → diferencia 0,00 (la deuda de la tarjeta nació completa).
 *   Reconciliación enero 2026: ΔPatrimonio = 0,00 = ahorro 0,00 → diferencia
 *     0,00 (la transferencia baja banco y deuda por igual: no es gasto).
 *   Panel: deuda = 125.000 − 15.000 = 110.000,00; compromisos futuros = las
 *     cuotas de octubre y noviembre 2026 = 20.000,00.
 */

import {
  check,
  checkDeep,
  checkTrue,
  correrResumenes,
  crearCuenta,
  crearGasto,
  crearPlan,
  crearTarjeta,
  get,
  guardToday,
  runScript,
  section,
  tarjetaDe,
  vistaTarjetas,
} from "./helpers.mjs";

const TAG = "T_TESTER_F5_09";
guardToday("2026-10-17");

const utcDate = (value) => new Date(`${value}T00:00:00.000Z`);

await runScript({
  tag: TAG,
  main: async (prisma) => {
    section("Montaje");
    const banco = await crearCuenta(`${TAG}_BANCO`, "BANK", "100000");
    const bancoId = banco.body.id;

    const tarjeta = await crearTarjeta(`${TAG}_VISA`, { closingDay: 25, dueDay: 5 });
    const cardId = tarjeta.body.id;

    const plan = await crearPlan({
      cardId,
      label: `${TAG}_X 12`,
      totalAmount: "120000",
      installments: 12,
      purchaseDate: "2025-12-20",
      categoryName: `${TAG}_CAT`,
    });
    check("plan del 20/12/2025 creado (201)", plan.status, 201);
    checkDeep(
      "cuotas de diciembre 2025 a noviembre 2026",
      [plan.body.plan.items[0], plan.body.plan.items[11]].map((item) => [
        item.periodYear,
        item.periodMonth,
      ]),
      [
        [2025, 12],
        [2026, 11],
      ],
    );

    const directo = await crearGasto({
      accountId: cardId,
      amount: "5000",
      date: "2025-12-22",
      categoryName: `${TAG}_CAT`,
      description: `${TAG}_directo diciembre`,
    });
    check("gasto directo del 22/12/2025 creado (201)", directo.status, 201);

    /* ── La corrida cruza el año ──────────────────────────────────────────── */

    section("Corrida: 10 resúmenes, de diciembre 2025 a septiembre 2026");
    const run = await correrResumenes(cardId);
    check("corrida 200", run.status, 200);
    const resultado = (run.body?.results ?? []).find((r) => r.card.id === cardId);
    check("se crean 10 resúmenes", resultado?.created, 10);

    const filas = await prisma.statement.findMany({
      where: { accountId: cardId },
      orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
    });
    check("en la base hay 10 documentos", filas.length, 10);
    checkDeep(
      "el primero y el último",
      [
        [filas[0]?.periodYear, filas[0]?.periodMonth],
        [filas[9]?.periodYear, filas[9]?.periodMonth],
      ],
      [
        [2025, 12],
        [2026, 9],
      ],
    );
    check(
      "no existe un resumen de octubre 2026 (todavía no cerró)",
      await prisma.statement.count({
        where: { accountId: cardId, periodYear: 2026, periodMonth: 10 },
      }),
      0,
    );

    const diciembre = filas[0];
    check("diciembre 2025 = cuota 10.000 + directo 5.000 = 15.000,00", diciembre?.totalDue.toFixed(2), "15000.00");
    check("mínimo 750,00", diciembre?.minimumDue.toFixed(2), "750.00");
    check("cierra 2025-12-25", diciembre?.closingDate.toISOString().slice(0, 10), "2025-12-25");
    check("vence 2026-01-05 (el 5 es el primer día 5 posterior al cierre)", diciembre?.dueDate.toISOString().slice(0, 10), "2026-01-05");

    const enero = filas[1];
    check("enero 2026 = cuota 10.000,00 (el directo fue de diciembre)", enero?.totalDue.toFixed(2), "10000.00");
    check("enero vence 2026-02-05", enero?.dueDate.toISOString().slice(0, 10), "2026-02-05");

    /* ── El pago de enero (fecha real del pago) ───────────────────────────── */

    section("Pago del resumen de diciembre, fechado 2026-01-05");
    const pago = await prisma.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "15000.00",
        date: utcDate("2026-01-05"),
        description: `${TAG}_pago resumen diciembre`,
        accountId: bancoId,
        toAccountId: cardId,
      },
    });
    await prisma.statement.update({
      where: { id: diciembre.id },
      data: { paidMovementId: pago.id },
    });
    const diciembrePagado = await prisma.statement.findUnique({ where: { id: diciembre.id } });
    check("diciembre queda pagado", diciembrePagado?.paidMovementId, pago.id);
    checkTrue("y el pago es una TRANSFER (jamás un gasto)", pago.kind === "TRANSFER");

    /* ── Reportes de los dos meses ────────────────────────────────────────── */

    section("Reportes: diciembre y enero no se mezclan");
    const Q = `q=${TAG}`;
    const repDic = await get(`/api/reports?from=2025-12-01&to=2025-12-31&${Q}`);
    check("reporte diciembre 200", repDic.status, 200);
    check(
      "gastos de diciembre = 125.000,00 (plan 120.000 + directo 5.000)",
      repDic.body?.totals?.expenses,
      "125000.00",
    );
    check("transferencias de diciembre 0,00", repDic.body?.totals?.transfers, "0.00");
    check("flujo de caja de diciembre 0,00 (todo con tarjeta)", repDic.body?.totals?.cashFlow, "0.00");
    check(
      "la categoría acumula 125.000,00",
      (repDic.body?.byCategory ?? []).find((c) => c.name === `${TAG}_CAT`)?.amount,
      "125000.00",
    );

    const repEne = await get(`/api/reports?from=2026-01-01&to=2026-01-31&${Q}`);
    check("reporte enero 200", repEne.status, 200);
    check("gastos de enero 0,00 (el pago NO es gasto)", repEne.body?.totals?.expenses, "0.00");
    check("transferencias de enero 15.000,00", repEne.body?.totals?.transfers, "15000.00");
    check(
      "flujo de caja de enero = −15.000,00 (sale del banco hacia la tarjeta)",
      repEne.body?.totals?.cashFlow,
      "-15000.00",
    );
    checkDeep("enero no tiene ninguna categoría de gasto", repEne.body?.byCategory ?? [], []);

    /* ── Reconciliación de los dos meses ──────────────────────────────────── */

    section("Reconciliación: ΔPatrimonio = Ahorro en los dos meses");
    const recDic = await get("/api/reconciliation?month=2025-12&asOf=2025-12-31");
    const dic = recDic.body?.reconciliation;
    check("diciembre: ΔPatrimonio = −125.000,00", dic?.netDelta, "-125000.00");
    check("diciembre: ahorro = −125.000,00", dic?.saving, "-125000.00");
    check("diciembre: diferencia 0,00", dic?.difference, "0.00");
    check("diciembre: cuadra", dic?.balanced, true);

    const recEne = await get("/api/reconciliation?month=2026-01&asOf=2026-01-31");
    const ene = recEne.body?.reconciliation;
    check("enero: ΔPatrimonio = 0,00 (transferencia entre cuentas propias)", ene?.netDelta, "0.00");
    check("enero: ahorro = 0,00", ene?.saving, "0.00");
    check("enero: diferencia 0,00", ene?.difference, "0.00");
    check("enero: cuadra", ene?.balanced, true);

    /* ── El panel después del cruce ───────────────────────────────────────── */

    section("Panel: deuda, resumen pagado y compromisos");
    const vista = await vistaTarjetas();
    const card = tarjetaDe(vista, cardId);
    check("deuda = 125.000 − 15.000 = 110.000,00", card?.debt, "110000.00");
    check(
      "diciembre figura pagado en el panel",
      card?.statements?.find((s) => s.year === 2025 && s.month === 12)?.paid,
      true,
    );
    check("hay 10 resúmenes en el panel", card?.statements?.length, 10);
    check(
      "compromisos próximos 12 meses = cuotas de octubre y noviembre 2026 = 20.000,00",
      card?.commitments?.next12Months,
      "20000.00",
    );
    check("y los 6 primeros meses también 20.000,00", card?.commitments?.next6Months, "20000.00");
    check(
      "el primer mes comprometido es octubre 2026",
      `${card?.commitments?.months?.[0]?.year}-${card?.commitments?.months?.[0]?.month}`,
      "2026-10",
    );
    check(
      "y el segundo, noviembre 2026",
      `${card?.commitments?.months?.[1]?.year}-${card?.commitments?.months?.[1]?.month}`,
      "2026-11",
    );
    check("las 12 cuotas del plan ya se facturaron 10 (diciembre 2025 … septiembre 2026)", card?.plans?.[0]?.billedInstallments, 10);
  },
});
