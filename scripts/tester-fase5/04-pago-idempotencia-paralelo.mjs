#!/usr/bin/env node
/**
 * 04 — Pago del resumen (D12): doble pago, cinco pagos en paralelo, 409 sin
 * saldo, 400 de origen inválido y borrar el pago REABRE el resumen.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ESCENARIO (hoy = 2026-10-17)
 * ─────────────────────────────────────────────────────────────────────────────
 * Tarjeta C (cierre 25): plan de 30.000,00 en 3 cuotas (10.000 c/u) del 10/09 →
 *   resumen de septiembre = 10.000,00 (mínimo 500,00, vence 2026-10-05).
 * Tarjeta D (cierre 5): plan de 5.000,00 en 5 cuotas (1.000 c/u) del 10/09.
 *   Con cierre 5, la compra del 10/09 cae en el resumen de OCTUBRE (10 > 5):
 *   1.000,00, mínimo 50,00, vence 2026-10-20. Es la víctima de la carrera:
 *   cinco pagos simultáneos deben dejar UNA sola transferencia.
 * Tarjeta E (cierre 25): gasto directo de 777,00 del 12/09 → resumen de
 *   septiembre 777,00 (mínimo 38,85). Se borra el gasto y la corrida deja el
 *   resumen en 0,00: pagar un resumen sin saldo tiene que dar 409.
 * Banco: 100.000,00.  Saldos a mano: tras pagar C y D → 89.000,00; borrar el
 * pago de C → 99.000,00; volver a pagar C → 89.000,00.
 */

import {
  check,
  checkTrue,
  checkDeep,
  checkIncluye,
  correrResumenes,
  crearCuenta,
  crearGasto,
  crearPlan,
  crearTarjeta,
  cuentaDe,
  del,
  guardToday,
  pagarResumen,
  runScript,
  section,
  tarjetaDe,
  vistaTarjetas,
} from "./helpers.mjs";

const TAG = "T_TESTER_F5_04";
guardToday("2026-10-17");

await runScript({
  tag: TAG,
  main: async (prisma) => {
    section("Montaje");
    const banco = await crearCuenta(`${TAG}_BANCO`, "BANK", "100000");
    const bancoId = banco.body.id;

    const cardC = await crearTarjeta(`${TAG}_C`, { closingDay: 25, dueDay: 5 });
    const idC = cardC.body.id;
    const planC = await crearPlan({
      cardId: idC,
      label: `${TAG}_C plan 3`,
      totalAmount: "30000",
      installments: 3,
      purchaseDate: "2026-09-10",
      categoryName: `${TAG}_CAT`,
    });
    check("plan de C (30.000 en 3) creado (201)", planC.status, 201);
    checkTrue(
      "cuotas de 10.000 c/u",
      planC.body.plan.items.every((i) => i.amount === "10000.00"),
      JSON.stringify(planC.body.plan.items.map((i) => i.amount)),
    );

    const cardD = await crearTarjeta(`${TAG}_D`, { closingDay: 5, dueDay: 20 });
    const idD = cardD.body.id;
    await crearPlan({
      cardId: idD,
      label: `${TAG}_D plan 5`,
      totalAmount: "5000",
      installments: 5,
      purchaseDate: "2026-09-10",
      categoryName: `${TAG}_CAT`,
    });

    const cardE = await crearTarjeta(`${TAG}_E`, { closingDay: 25, dueDay: 5 });
    const idE = cardE.body.id;
    const gastoE = await crearGasto({
      accountId: idE,
      amount: "777",
      date: "2026-09-12",
      categoryName: `${TAG}_CAT`,
      description: `${TAG}_E gasto`,
    });
    check("gasto de E creado (201)", gastoE.status, 201);

    const runC = await correrResumenes(idC);
    const resC = (runC.body.results ?? []).find((r) => r.card.id === idC);
    const sepC = (resC?.statements ?? []).find((s) => s.month === 9);
    check("C: resumen de septiembre 10.000,00", sepC?.totalDue, "10000.00");
    check("C: mínimo 500,00", sepC?.minimumDue, "500.00");
    check("C: vence 2026-10-05", sepC?.dueDate, "2026-10-05");

    const runD = await correrResumenes(idD);
    const resD = (runD.body.results ?? []).find((r) => r.card.id === idD);
    const octD = (resD?.statements ?? []).find((s) => s.month === 10);
    checkTrue("D: la compra del 10/09 cae en el resumen de octubre", Boolean(octD));
    check("D: total 1.000,00", octD?.totalDue, "1000.00");
    check("D: vence 2026-10-20 (día 20 posterior al cierre 5)", octD?.dueDate, "2026-10-20");

    const runE = await correrResumenes(idE);
    const resE = (runE.body.results ?? []).find((r) => r.card.id === idE);
    const sepE = (resE?.statements ?? []).find((s) => s.month === 9);
    check("E: resumen de septiembre 777,00", sepE?.totalDue, "777.00");
    check("E: mínimo 38,85 (5% exacto)", sepE?.minimumDue, "38.85");

    /* ── Doble pago secuencial ────────────────────────────────────────────── */

    section("Doble pago de C: una sola transferencia");
    const pago1 = await pagarResumen(sepC.id, bancoId);
    check("primer pago: 201", pago1.status, 201);
    check("created: true", pago1.body?.created, true);

    const pago2 = await pagarResumen(sepC.id, bancoId);
    check("segundo pago: 200 (no 201)", pago2.status, 200);
    check("created: false", pago2.body?.created, false);
    check("mismo movimiento", pago2.body?.movement?.id, pago1.body?.movement?.id);
    check(
      "en la base, UNA transferencia hacia C",
      await prisma.movement.count({ where: { kind: "TRANSFER", toAccountId: idC } }),
      1,
    );
    check("el banco queda en 90.000,00", (await cuentaDe(bancoId))?.balance, "90000.00");

    /* ── Carrera: cinco pagos en paralelo ─────────────────────────────────── */

    section("Carrera: 5 pagos simultáneos de D");
    const resultados = await Promise.all(
      Array.from({ length: 5 }, () => pagarResumen(octD.id, bancoId)),
    );
    const creados = resultados.filter((r) => r.status === 201 && r.body?.created === true);
    const idempotentes = resultados.filter((r) => r.status === 200 && r.body?.created === false);
    const reclamados = resultados.filter((r) => r.status === 409);
    const inesperados = resultados.filter((r) => ![200, 201, 409].includes(r.status));
    console.log(
      `    distribución de status: ${resultados
        .map((r) => `${r.status}/created:${r.body?.created}`)
        .join(", ")}`,
    );

    check("exactamente UN pago crea la transferencia", creados.length, 1);
    check("los demás son idempotentes (200 created:false) o rechazados (409)", creados.length + idempotentes.length + reclamados.length, 5);
    checkDeep("ningún status inesperado (nunca 500)", inesperados.map((r) => r.status), []);
    check(
      "en la base, UNA sola transferencia hacia D",
      await prisma.movement.count({ where: { kind: "TRANSFER", toAccountId: idD } }),
      1,
    );
    const dbD = await prisma.statement.findUnique({ where: { id: octD.id } });
    checkTrue("D queda pagado con el pago ganador", dbD?.paidMovementId !== null);
    check("el banco queda en 89.000,00 (−10.000 de C −1.000 de D, una sola vez)", (await cuentaDe(bancoId))?.balance, "89000.00");

    /* ── 409 sin saldo, 400 de origen, 404 inexistente ────────────────────── */

    section("Errores accionables del pago");
    const borrarGasto = await del(`/api/transactions?id=${gastoE.body.id}`);
    check("borra el gasto de E (204)", borrarGasto.status, 204);
    const runE2 = await correrResumenes(idE);
    const resE2 = (runE2.body.results ?? []).find((r) => r.card.id === idE);
    const sepE2 = (resE2?.statements ?? []).find((s) => s.month === 9);
    check("la corrida deja el resumen de E en 0,00 (impago recalcula)", sepE2?.totalDue, "0.00");
    check("con mínimo 0,00", sepE2?.minimumDue, "0.00");

    const pagoSinSaldo = await pagarResumen(sepE2.id, bancoId);
    check("pagar un resumen sin saldo: 409", pagoSinSaldo.status, 409);
    checkIncluye("y lo explica", pagoSinSaldo.body?.error, "no tiene saldo");

    // El saldo se valida ANTES del origen: para probar los 400 de origen hace
    // falta un resumen con saldo. Gasto nuevo de 100,00 → septiembre 100,00.
    const gastoE2 = await crearGasto({
      accountId: idE,
      amount: "100",
      date: "2026-09-13",
      categoryName: `${TAG}_CAT`,
      description: `${TAG}_E gasto 2`,
    });
    check("gasto nuevo de E creado (201)", gastoE2.status, 201);
    const runE3 = await correrResumenes(idE);
    const resE3 = (runE3.body.results ?? []).find((r) => r.card.id === idE);
    const sepE3 = (resE3?.statements ?? []).find((s) => s.month === 9);
    check("E vuelve a tener 100,00 en septiembre", sepE3?.totalDue, "100.00");

    const pagoMismaTarjeta = await pagarResumen(sepE3.id, idE);
    check("pagar desde la misma tarjeta: 400", pagoMismaTarjeta.status, 400);
    checkIncluye("dice que la cuenta de origen tiene que ser distinta", pagoMismaTarjeta.body?.error, "distinta");

    const pagoOrigenFantasma = await pagarResumen(sepE3.id, "no-existe-999");
    check("pagar desde una cuenta inexistente: 400", pagoOrigenFantasma.status, 400);
    checkIncluye("dice que no existe", pagoOrigenFantasma.body?.error, "no existe");

    const pagoFantasma = await pagarResumen("no-existe-999", bancoId);
    check("pagar un resumen inexistente: 404", pagoFantasma.status, 404);

    const pagoSinCampos = await pagarResumen(undefined, undefined);
    check("pagar sin statementId: 400", pagoSinCampos.status, 400);
    checkIncluye("dice qué falta", pagoSinCampos.body?.error, "resumen");

    /* ── Borrar el pago reabre el resumen ─────────────────────────────────── */

    section("Borrar el pago de C reabre su resumen");
    const borrarPago = await del(`/api/transactions?id=${pago1.body.movement.id}`);
    check("borra la transferencia de pago (204)", borrarPago.status, 204);
    const dbC = await prisma.statement.findUnique({ where: { id: sepC.id } });
    check("el resumen vuelve a estar impago (paidMovementId NULL)", dbC?.paidMovementId, null);
    check("el banco recupera la plata: 99.000,00", (await cuentaDe(bancoId))?.balance, "99000.00");

    const runC2 = await correrResumenes(idC);
    const resC2 = (runC2.body.results ?? []).find((r) => r.card.id === idC);
    check("la corrida siguiente lo recalcula como impago", resC2?.unchanged, 1);
    check("sin congelados", resC2?.frozen, 0);

    const pago3 = await pagarResumen(sepC.id, bancoId);
    check("se puede volver a pagar (201)", pago3.status, 201);
    check("con una transferencia NUEVA", pago3.body?.movement?.id !== pago1.body.movement.id, true);
    check(
      "y otra vez hay UNA sola transferencia hacia C",
      await prisma.movement.count({ where: { kind: "TRANSFER", toAccountId: idC } }),
      1,
    );
    check("el banco queda en 89.000,00 otra vez", (await cuentaDe(bancoId))?.balance, "89000.00");

    const borrarDosVeces = await del(`/api/transactions?id=${pago1.body.movement.id}`);
    check("borrar un pago ya borrado: 404 (no 500)", borrarDosVeces.status, 404);

    const vista = await vistaTarjetas();
    const c = tarjetaDe(vista, idC);
    check(
      "en el panel, C tiene su resumen pagado con la transferencia nueva",
      `${c?.statements?.[0]?.paid} ${c?.statements?.[0]?.paidMovementId === pago3.body.movement.id}`,
      "true true",
    );
  },
});
