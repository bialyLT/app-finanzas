#!/usr/bin/env node
/**
 * 08 — Cambiar el día de cierre DESPUÉS de emitir resúmenes (D7 / D10).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ESCENARIO A: resumen IMPAGO (se puede recalcular)
 * ─────────────────────────────────────────────────────────────────────────────
 * Tarjeta A (cierre 25, vence 5) con un gasto directo de 100,00 del 10/09.
 *   Con cierre 25 la compra cae en septiembre: resumen 100,00, impago.
 *   Se cambia el cierre a 5 (vence 20): la compra del 10/09 ahora cae en
 *   octubre. La corrida siguiente:
 *     · septiembre (impago) se recalcula a 0,00 — MISMO documento;
 *     · octubre se crea con 100,00.
 *   Σ resúmenes = 100,00: la compra se facturó una sola vez, en el documento
 *   que corresponde a la regla nueva.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ESCENARIO B: resumen PAGADO (historia congelada) — hallazgo B2
 * ─────────────────────────────────────────────────────────────────────────────
 * Tarjeta B, mismo gasto de 100,00 del 10/09 con cierre 25; se corre el
 * resumen de septiembre y se PAGA.
 *   Si se permite cambiar el cierre a 5, la corrida siguiente deja:
 *     · septiembre CONGELADO con 100,00 (pagado), y
 *     · octubre NUEVO con los mismos 100,00 (la compra re-repartida).
 *   Σ resúmenes = 200,00 por una compra de 100,00: el mismo gasto facturado dos
 *   veces. Pagar octubre sacaría 200,00 del banco por una deuda de 100,00.
 *
 *   Decisión (fix B2): PATCH /api/accounts devuelve 409 al cambiar `closingDay`
 *   si la tarjeta tiene al menos un resumen pagado. Cambiar sólo `dueDay` sigue
 *   permitido (no re-reparte compras; los pagados están congelados). La salida
 *   es explícita: borrar el pago reabre el resumen y entonces el cambio es
 *   seguro (escenario B3, verificado al final de este script).
 */

import {
  check,
  checkIncluye,
  checkTrue,
  correrResumenes,
  crearCuenta,
  crearGasto,
  crearTarjeta,
  del,
  get,
  guardToday,
  pagarResumen,
  patch,
  runScript,
  section,
  tarjetaDe,
  vistaTarjetas,
} from "./helpers.mjs";

const TAG = "T_TESTER_F5_08";
guardToday("2026-10-17");

const sumaResumenes = (rows) =>
  rows.reduce((total, row) => total + Number(row.totalDue), 0).toFixed(2);

await runScript({
  tag: TAG,
  main: async (prisma) => {
    section("Montaje");
    const banco = await crearCuenta(`${TAG}_BANCO`, "BANK", "100000");
    const bancoId = banco.body.id;

    /* ── A: resumen impago ───────────────────────────────────────────────── */

    section("A: cambiar el cierre con el resumen IMPAGO");
    const a = await crearTarjeta(`${TAG}_A`, { closingDay: 25, dueDay: 5 });
    const aId = a.body.id;
    const gastoA = await crearGasto({
      accountId: aId,
      amount: "100",
      date: "2026-09-10",
      categoryName: `${TAG}_CAT`,
      description: `${TAG}_A compra`,
    });
    check("gasto A creado (201)", gastoA.status, 201);

    const runA1 = await correrResumenes(aId);
    const rA1 = (runA1.body?.results ?? []).find((r) => r.card.id === aId);
    const sepA = (rA1?.statements ?? []).find((s) => s.month === 9);
    check("A: septiembre 100,00 (cierre 25)", sepA?.totalDue, "100.00");
    check("A: impago", sepA?.paid, false);

    const patchA = await patch("/api/accounts", {
      id: aId,
      closingDay: 5,
      dueDay: 20,
    });
    check("A: cambiar 25/5 → 5/20 sin resúmenes pagados: 200", patchA.status, 200);
    check("A: closingDay 5", patchA.body?.closingDay, 5);
    check("A: dueDay 20", patchA.body?.dueDay, 20);

    const runA2 = await correrResumenes(aId);
    check("A: corrida 200", runA2.status, 200);
    const rA2 = (runA2.body?.results ?? []).find((r) => r.card.id === aId);
    check("A: 1 resumen actualizado", rA2?.updated, 1);
    check("A: 1 resumen creado", rA2?.created, 1);
    check("A: 0 congelados", rA2?.frozen, 0);

    const filasA = await prisma.statement.findMany({
      where: { accountId: aId },
      orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
    });
    check("A: hay 2 documentos (sep y oct)", filasA.length, 2);
    check("A: septiembre es EL MISMO documento", filasA[0]?.id, sepA?.id);
    check("A: septiembre recalcula a 0,00", filasA[0]?.totalDue.toFixed(2), "0.00");
    check("A: octubre nuevo con 100,00", filasA[1]?.totalDue.toFixed(2), "100.00");
    check("A: octubre cierra 2026-10-05", filasA[1]?.closingDate.toISOString().slice(0, 10), "2026-10-05");
    check("A: octubre vence 2026-10-20", filasA[1]?.dueDate.toISOString().slice(0, 10), "2026-10-20");
    check("A: Σ resúmenes = 100,00 (una sola facturación)", sumaResumenes(filasA), "100.00");

    check(
      "A: el gasto sigue siendo UNO de 100,00",
      await prisma.movement.count({
        where: { accountId: aId, kind: "EXPENSE", description: { startsWith: `${TAG}_A` } },
      }),
      1,
    );
    const totalA = await prisma.movement.aggregate({
      where: { accountId: aId, kind: "EXPENSE" },
      _sum: { amount: true },
    });
    check("A: Σ gastos = 100,00 (no se duplicó)", totalA._sum.amount?.toFixed(2), "100.00");

    const vistaA = await vistaTarjetas();
    const cardA = tarjetaDe(vistaA, aId);
    check("A: deuda del panel 100,00", cardA?.debt, "100.00");
    check(
      "A: el panel lista septiembre en 0,00 y octubre en 100,00",
      JSON.stringify(
        (cardA?.statements ?? [])
          .filter((s) => s.month === 9 || s.month === 10)
          .map((s) => [s.month, s.totalDue]),
      ),
      JSON.stringify([[10, "100.00"], [9, "0.00"]]),
    );

    const repA = await get(`/api/reports?from=2026-09-01&to=2026-09-30&q=${TAG}_A`);
    check("A: reporte de septiembre = 100,00 (el cambio de cierre no duplica)", repA.body?.totals?.expenses, "100.00");
    check("A: sin transferencias en septiembre", repA.body?.totals?.transfers, "0.00");

    /* ── B: resumen pagado (repro de B2) ─────────────────────────────────── */

    section("B: cambiar el cierre con el resumen PAGADO");
    const b = await crearTarjeta(`${TAG}_B`, { closingDay: 25, dueDay: 5 });
    const bId = b.body.id;
    await crearGasto({
      accountId: bId,
      amount: "100",
      date: "2026-09-10",
      categoryName: `${TAG}_CAT`,
      description: `${TAG}_B compra`,
    });

    const runB1 = await correrResumenes(bId);
    const rB1 = (runB1.body?.results ?? []).find((r) => r.card.id === bId);
    const sepB = (rB1?.statements ?? []).find((s) => s.month === 9);
    check("B: septiembre 100,00", sepB?.totalDue, "100.00");
    const pagoB = await pagarResumen(sepB.id, bancoId);
    check("B: se paga septiembre (201)", pagoB.status, 201);
    const pagoBMovementId = pagoB.body.movement.id;

    const patchB = await patch("/api/accounts", {
      id: bId,
      closingDay: 5,
      dueDay: 20,
    });
    check("B: cambiar el cierre con un resumen pagado: 409", patchB.status, 409);
    checkIncluye("B: lo explica (resumen pagado)", patchB.body?.error, "resumen pagado");
    checkIncluye("B: da la salida (borrar el pago)", patchB.body?.error, "Borrá primero el pago");

    const bDespues = await prisma.account.findUnique({ where: { id: bId } });
    check("B: el cierre NO cambió (sigue 25)", bDespues?.closingDay, 25);
    check("B: el vencimiento NO cambió (sigue 5)", bDespues?.dueDay, 5);

    const runB2 = await correrResumenes(bId);
    const rB2 = (runB2.body?.results ?? []).find((r) => r.card.id === bId);
    check("B: la corrida no crea nada", rB2?.created, 0);
    check("B: el resumen pagado queda congelado", rB2?.frozen, 1);

    const filasB = await prisma.statement.findMany({ where: { accountId: bId } });
    check("B: sigue habiendo UN solo documento", filasB.length, 1);
    check("B: Σ resúmenes = 100,00 (no 200,00)", sumaResumenes(filasB), "100.00");
    check("B: el documento está pagado", filasB[0]?.paidMovementId, pagoBMovementId);

    /* ── B2: cambiar sólo el vencimiento sí se permite ───────────────────── */

    section("B2: cambiar sólo el vencimiento (no re-reparte compras)");
    const patchDue = await patch("/api/accounts", {
      id: bId,
      closingDay: 25,
      dueDay: 10,
    });
    check("B2: 25/5 → 25/10 con resumen pagado: 200", patchDue.status, 200);
    check("B2: dueDay 10", patchDue.body?.dueDay, 10);
    check("B2: closingDay sigue 25", patchDue.body?.closingDay, 25);

    const sepBDespues = await prisma.statement.findUnique({ where: { id: sepB.id } });
    check("B2: el resumen pagado conserva su vencimiento original (2026-10-05)", sepBDespues?.dueDate.toISOString().slice(0, 10), "2026-10-05");

    const runB3 = await correrResumenes(bId);
    const rB3 = (runB3.body?.results ?? []).find((r) => r.card.id === bId);
    check("B2: corrida sin novedades (created 0, frozen 1)", `${rB3?.created} ${rB3?.frozen}`, "0 1");
    check(
      "B2: sigue habiendo UN documento de 100,00",
      sumaResumenes(await prisma.statement.findMany({ where: { accountId: bId } })),
      "100.00",
    );

    /* ── B3: la salida documentada — borrar el pago y cambiar ────────────── */

    section("B3: borrar el pago reabre el resumen y habilita el cambio");
    const borrarPago = await del(`/api/transactions?id=${pagoBMovementId}`);
    check("B3: borra el pago (204)", borrarPago.status, 204);
    const reabierto = await prisma.statement.findUnique({ where: { id: sepB.id } });
    check("B3: el resumen quedó impago", reabierto?.paidMovementId, null);

    const patchB3 = await patch("/api/accounts", {
      id: bId,
      closingDay: 5,
      dueDay: 20,
    });
    check("B3: ahora el cambio de cierre: 200", patchB3.status, 200);
    check("B3: closingDay 5", patchB3.body?.closingDay, 5);

    const runB4 = await correrResumenes(bId);
    const rB4 = (runB4.body?.results ?? []).find((r) => r.card.id === bId);
    check("B3: septiembre se recalcula (updated 1) y octubre se crea (created 1)", `${rB4?.updated} ${rB4?.created}`, "1 1");
    const filasB3 = await prisma.statement.findMany({ where: { accountId: bId } });
    check("B3: septiembre 0,00", filasB3.find((s) => s.periodMonth === 9)?.totalDue.toFixed(2), "0.00");
    check("B3: octubre 100,00", filasB3.find((s) => s.periodMonth === 10)?.totalDue.toFixed(2), "100.00");
    check("B3: Σ = 100,00 (una sola facturación)", sumaResumenes(filasB3), "100.00");
  },
});
