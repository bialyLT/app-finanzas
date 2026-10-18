#!/usr/bin/env node
/**
 * ui-04 - El contrato de `POST /api/loans/pay`: patas exactas, idempotencia y
 * los sistemas especiales.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA (brief, criterios 4 y 5 + clases de ataque)
 * ─────────────────────────────────────────────────────────────────────────────
 * La ruta de pago es la que MUEVE PLATA: una transferencia por el capital (la
 * única que baja la deuda) y un gasto/ingreso por el interés (el único costo
 * real). Este script verifica con números exactos que:
 *
 *   · el split que devuelve la ruta == las patas que quedan registradas;
 *   · `created: false` es un ESTADO idempotente (doble toque), no un error;
 *   · sin `installmentNumber` no se adelanta una cuota futura;
 *   · cinco pagos en paralelo de la misma cuota escriben UNA sola verdad
 *     (la tx lockea la cuenta con `FOR UPDATE`);
 *   · `extraCapital` avanza la cobertura;
 *   · la cancelación anticipada paga el capital que queda SIN interés;
 *   · INTEREST_ONLY no tiene "pagar cuota" y se cancela por anticipado;
 *   · AMERICAN sólo acepta el cierre (sus cuotas de sólo interés se rechazan
 *     con el porqué completo).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LOS NÚMEROS A MANO
 * ─────────────────────────────────────────────────────────────────────────────
 * L1 - 100.000 al 24% TNA (2% mensual) en 6 cuotas FRENCH (primera 20/06/2028):
 *   cuota fija 17.852,58.
 *   · cuota 1: interés 100.000 × 0,02 = 2.000,00 · capital 15.852,58.
 *   · cuota 2: saldo 84.147,42 → interés 1.682,95 (1.682,9484 redondeado a
 *     centavos) · capital 17.852,58 − 1.682,95 = 16.169,63.
 *   · cuota 3: saldo 67.977,79 → interés 1.359,56 (1.359,5558) · capital
 *     17.852,58 − 1.359,56 = 16.493,02.
 *   · cancelación tras pagar 1, 2 y 3 (+10.000 de extra en la 3):
 *     capital pagado 15.852,58 + 16.169,63 + 26.493,02 = 58.515,23;
 *     queda 100.000 − 58.515,23 = 41.484,77 → es lo que paga la cancelación,
 *     sin un solo centavo de interés.
 * R1 - RECEIVABLE 50.000 al 0% en 5 cuotas: cada cuota 10.000,00 = capital
 *   10.000,00 + interés 0,00 (sin pata de interés).
 * I1 - INTEREST_ONLY 120.000 al 24% en 6: cuota de sólo interés 2.400,00; el
 *   capital se cancela de una: 120.000,00.
 * A1 - AMERICAN 500.000 al 60% en 12: cuotas 1..11 sólo interés 25.000,00; el
 *   cierre (cuota 12) paga 500.000,00 de capital + 25.000,00 de interés.
 */

import {
  apiNoAuth,
  check,
  checkIncluye,
  checkTrue,
  crearCuenta,
  crearPrestamo,
  post,
  postRaw,
  prestamoDe,
  runScript,
  section,
  vistaPrestamos,
} from "./helpers.mjs";

const TAG = "T_TESTER_F4R2_04";
const BANCO_APERTURA = "5000000";

runScript({
  tag: TAG,
  main: async (prisma) => {
    /* ───────────────────────────────────────────────────────────────────────
     * El borde de la ruta: sin sesión y cuerpos hostiles (400, nunca 500)
     * ─────────────────────────────────────────────────────────────────────── */
    section("La ruta de pago: bordes de entrada");
    const sinSesion = await apiNoAuth("/api/loans/pay", {
      method: "POST",
      body: JSON.stringify({}),
    });
    check("sin sesión: 401 (no 500)", sinSesion.status, 401);

    const cuerpoNull = await postRaw("/api/loans/pay", "null");
    check("cuerpo `null`: 400 (no 500)", cuerpoNull.status, 400);
    const cuerpoArray = await postRaw("/api/loans/pay", "[]");
    check("cuerpo `[]`: 400 (no 500)", cuerpoArray.status, 400);

    /* ───────────────────────────────────────────────────────────────────────
     * Preparación: banco, préstamo a pagar y cobro por cobrar
     * ─────────────────────────────────────────────────────────────────────── */
    section("Preparación");
    const banco = await crearCuenta(`${TAG}_Banco`, "BANK", BANCO_APERTURA);
    check("el banco responde 201", banco.status, 201);
    const bancoId = banco.body?.id;

    const l1 = await crearPrestamo({
      name: `${TAG}_L1`,
      kind: "LOAN",
      principal: "100000",
      tnaPercent: "24",
      installmentCount: 6,
      firstInstallmentDate: "2028-06-20",
    });
    check("L1 responde 201", l1.status, 201);
    const desembolsoL1 = await post("/api/transactions", {
      kind: "TRANSFER",
      amount: "100000",
      date: "2028-06-01",
      accountId: l1.body?.id,
      toAccountId: bancoId,
      description: `${TAG}_Desembolso_L1`,
    });
    check("el desembolso de L1 responde 201", desembolsoL1.status, 201);

    const r1 = await crearPrestamo({
      name: `${TAG}_R1`,
      kind: "RECEIVABLE",
      principal: "50000",
      tnaPercent: "0",
      installmentCount: 5,
      firstInstallmentDate: "2028-06-20",
    });
    check("R1 responde 201", r1.status, 201);
    const desembolsoR1 = await post("/api/transactions", {
      kind: "TRANSFER",
      amount: "50000",
      date: "2028-06-01",
      accountId: bancoId,
      toAccountId: r1.body?.id,
      description: `${TAG}_Desembolso_R1`,
    });
    check("el desembolso de R1 responde 201", desembolsoR1.status, 201);

    /* ───────────────────────────────────────────────────────────────────────
     * L1 - el pago de la cuota 1: split exacto y patas exactas
     * ─────────────────────────────────────────────────────────────────────── */
    section("L1 - cuota 1: 15.852,58 de capital + 2.000,00 de interés");
    const pagoC1 = await post("/api/loans/pay", {
      accountId: l1.body?.id,
      cashAccountId: bancoId,
      date: "2028-07-01",
      installmentNumber: 1,
    });
    check("la cuota 1 responde 201", pagoC1.status, 201);
    check("la cuota 1 creó", pagoC1.body?.created, true);
    check("la cuota 1: capital 15.852,58", pagoC1.body?.principalPaid, "15852.58");
    check("la cuota 1: interés 2.000,00", pagoC1.body?.interestPaid, "2000.00");
    check("la respuesta trae las DOS patas (capital + interés)", pagoC1.body?.movements?.length, 2);
    // OJO (observación documentada, no bug de la UI): la vista que viaja en el
    // POST se arma con "hoy" REAL —`payLoanInstallment` no recibe `today`—, no
    // con la fecha del pago ni con un `asOf`. En una base con fechas futuras
    // (esta batería), su `loan.debt` no refleja el pago recién escrito. La
    // página NO usa esa vista: después de pagar recarga la lista. El estado se
    // verifica con `GET /api/loans?asOf=`, que es la fuente de verdad.
    check("la respuesta trae la vista del préstamo", pagoC1.body?.loan?.id, l1.body?.id);
    check("la respuesta marca la cuota pagada como cubierta", pagoC1.body?.installment?.covered, true);

    // Las descripciones "Cuota N · capital/interés" NO son únicas en la base
    // (el seed ya trae préstamos pagados): toda aserción de movimientos tiene
    // que filtrar por las CUENTAS de este escenario, nunca sólo por descripción.
    const pataCapitalC1 = await prisma.movement.findMany({
      where: {
        description: "Cuota 1 · capital",
        accountId: bancoId,
        toAccountId: l1.body?.id,
      },
      select: { kind: true, accountId: true, toAccountId: true, amount: true },
    });
    checkTrue(
      "la pata de capital es UNA transferencia banco → préstamo",
      pataCapitalC1.length === 1 &&
        pataCapitalC1[0].kind === "TRANSFER" &&
        pataCapitalC1[0].accountId === bancoId &&
        pataCapitalC1[0].toAccountId === l1.body?.id &&
        pataCapitalC1[0].amount.toFixed(2) === "15852.58",
      JSON.stringify(pataCapitalC1),
    );
    const pataInteresC1 = await prisma.movement.findMany({
      where: {
        description: "Cuota 1 · interés",
        accountId: bancoId,
        kind: "EXPENSE",
      },
      select: { kind: true, accountId: true, amount: true },
    });
    checkTrue(
      "la pata de interés es UN gasto del banco por 2.000,00",
      pataInteresC1.length === 1 &&
        pataInteresC1[0].kind === "EXPENSE" &&
        pataInteresC1[0].accountId === bancoId &&
        pataInteresC1[0].amount.toFixed(2) === "2000.00",
      JSON.stringify(pataInteresC1),
    );

    /* ───────────────────────────────────────────────────────────────────────
     * L1 - idempotencia: el doble toque NO duplica y NO adelanta
     * ─────────────────────────────────────────────────────────────────────── */
    section("L1 - idempotencia");
    const repetido = await post("/api/loans/pay", {
      accountId: l1.body?.id,
      cashAccountId: bancoId,
      date: "2028-07-01",
      installmentNumber: 1,
    });
    check("repetir la cuota 1: 200 (no error)", repetido.status, 200);
    check("repetir la cuota 1: created false", repetido.body?.created, false);
    check("repetir la cuota 1 no escribió capital", repetido.body?.principalPaid, null);

    const sinNumero = await post("/api/loans/pay", {
      accountId: l1.body?.id,
      cashAccountId: bancoId,
      date: "2028-07-01",
    });
    check("sin número y con la cuota 2 futura: 200", sinNumero.status, 200);
    check("sin número no adelanta la cuota futura: created false", sinNumero.body?.created, false);

    const vistaTrasIdem = prestamoDe(await vistaPrestamos("?asOf=2028-07-31"), l1.body?.id);
    check("la deuda no se movió con los reintentos: 84.147,42", vistaTrasIdem?.debt, "84147.42");
    const capitalC1Total = await prisma.movement.count({
      where: {
        description: "Cuota 1 · capital",
        accountId: bancoId,
        toAccountId: l1.body?.id,
      },
    });
    check("sigue habiendo UNA sola pata de capital de la cuota 1", capitalC1Total, 1);

    /* ───────────────────────────────────────────────────────────────────────
     * L1 - cinco pagos EN PARALELO de la cuota 2: una sola verdad
     * ─────────────────────────────────────────────────────────────────────── */
    section("L1 - 5 pagos en paralelo de la cuota 2");
    const paralelos = await Promise.all(
      Array.from({ length: 5 }, () =>
        post("/api/loans/pay", {
          accountId: l1.body?.id,
          cashAccountId: bancoId,
          date: "2028-08-01",
          installmentNumber: 2,
        }),
      ),
    );
    const creadores = paralelos.filter((r) => r.body?.created === true);
    const ganadora = creadores[0];
    const estados = paralelos.map((r) => r.status);
    console.log(`  ·  estados: ${estados.join(",")} · created true: ${creadores.length}`);
    checkTrue(
      "los 5 pedidos responden sin error (200 o 201)",
      paralelos.every((r) => r.status === 200 || r.status === 201),
      JSON.stringify(estados),
    );
    checkTrue(
      "exactamente UNO pagó la cuota (los otros vieron la cobertura)",
      creadores.length === 1 && paralelos.filter((r) => r.body?.created === false).length === 4,
      `true: ${creadores.length}`,
    );
    check("la cuota 2: capital 16.169,63", ganadora?.body?.principalPaid, "16169.63");
    check("la cuota 2: interés 1.682,95", ganadora?.body?.interestPaid, "1682.95");
    const capitalC2Total = await prisma.movement.count({
      where: {
        description: "Cuota 2 · capital",
        accountId: bancoId,
        toAccountId: l1.body?.id,
      },
    });
    const interesC2Total = await prisma.movement.count({
      where: {
        description: "Cuota 2 · interés",
        accountId: bancoId,
        kind: "EXPENSE",
      },
    });
    check("quedó UNA pata de capital de la cuota 2", capitalC2Total, 1);
    check("quedó UNA pata de interés de la cuota 2", interesC2Total, 1);

    /* ───────────────────────────────────────────────────────────────────────
     * L1 - capital extra: la cobertura avanza
     * ─────────────────────────────────────────────────────────────────────── */
    section("L1 - cuota 3 + 10.000 de capital extra");
    const pagoExtra = await post("/api/loans/pay", {
      accountId: l1.body?.id,
      cashAccountId: bancoId,
      date: "2028-08-15",
      installmentNumber: 3,
      extraCapital: "10000",
    });
    check("la cuota 3 + extra responde 201", pagoExtra.status, 201);
    check("la pata de capital es 16.493,02 + 10.000 = 26.493,02", pagoExtra.body?.principalPaid, "26493.02");
    check("la pata de interés es la de la cuota: 1.359,56", pagoExtra.body?.interestPaid, "1359.56");

    const vistaTrasExtra = prestamoDe(await vistaPrestamos("?asOf=2028-08-31"), l1.body?.id);
    check("capital pagado: 58.515,23", vistaTrasExtra?.capitalPaid, "58515.23");
    check("cuotas cubiertas: 3", vistaTrasExtra?.plan?.paidCount, 3);
    check("deuda viva: 41.484,77", vistaTrasExtra?.debt, "41484.77");

    /* ───────────────────────────────────────────────────────────────────────
     * L1 - cancelación anticipada: capital que queda, sin interés
     * ─────────────────────────────────────────────────────────────────────── */
    section("L1 - cancelación anticipada");
    const cancelacion = await post("/api/loans/pay", {
      accountId: l1.body?.id,
      cashAccountId: bancoId,
      date: "2028-08-20",
      cancel: true,
    });
    check("la cancelación responde 201", cancelacion.status, 201);
    check("la cancelación creó", cancelacion.body?.created, true);
    check("pagó EXACTAMENTE el capital que quedaba: 41.484,77", cancelacion.body?.principalPaid, "41484.77");
    check("sin interés: interestPaid null", cancelacion.body?.interestPaid, null);

    const pataCancel = await prisma.movement.findMany({
      where: {
        description: "Cancelación anticipada · capital",
        accountId: bancoId,
        toAccountId: l1.body?.id,
      },
      select: { accountId: true, toAccountId: true, amount: true },
    });
    checkTrue(
      "la cancelación es UNA transferencia banco → préstamo por 41.484,77",
      pataCancel.length === 1 &&
        pataCancel[0].accountId === bancoId &&
        pataCancel[0].toAccountId === l1.body?.id &&
        pataCancel[0].amount.toFixed(2) === "41484.77",
      JSON.stringify(pataCancel),
    );
    const patasCancelInteres = await prisma.movement.count({
      where: {
        description: { contains: "Cancelación anticipada" },
        kind: "EXPENSE",
        accountId: bancoId,
      },
    });
    check("la cancelación NO dejó ninguna pata de interés", patasCancelInteres, 0);

    const vistaCancelada = prestamoDe(await vistaPrestamos("?asOf=2028-08-31"), l1.body?.id);
    check("tras cancelar: deuda 0,00", vistaCancelada?.debt, "0.00");
    check("tras cancelar: capital pagado 100.000,00", vistaCancelada?.capitalPaid, "100000.00");
    check("tras cancelar: no queda próxima cuota", vistaCancelada?.nextInstallment, null);

    const cancelacionRepetida = await post("/api/loans/pay", {
      accountId: l1.body?.id,
      cashAccountId: bancoId,
      date: "2028-08-20",
      cancel: true,
    });
    check("cancelar de nuevo: 200 (estado, no error)", cancelacionRepetida.status, 200);
    check("cancelar de nuevo: created false", cancelacionRepetida.body?.created, false);

    /* ───────────────────────────────────────────────────────────────────────
     * R1 - el cobro es el espejo: capital entra, interés (0) no aparece
     * ─────────────────────────────────────────────────────────────────────── */
    section("R1 - cobro de la cuota 1 (0%: sin pata de interés)");
    const cobroC1 = await post("/api/loans/pay", {
      accountId: r1.body?.id,
      cashAccountId: bancoId,
      date: "2028-07-01",
      installmentNumber: 1,
    });
    check("el cobro responde 201", cobroC1.status, 201);
    check("el cobro creó", cobroC1.body?.created, true);
    check("capital cobrado: 10.000,00", cobroC1.body?.principalPaid, "10000.00");
    check("interés 0: la respuesta lo dice en 0.00", cobroC1.body?.interestPaid, "0.00");
    check("el cobro trae UNA sola pata (la de interés sería de 0)", cobroC1.body?.movements?.length, 1);

    const pataCobro = await prisma.movement.findMany({
      where: { description: "Cuota 1 · capital", accountId: r1.body?.id },
      select: { kind: true, toAccountId: true, amount: true },
    });
    checkTrue(
      "la pata del cobro es UNA transferencia cuenta → banco por 10.000,00",
      pataCobro.length === 1 &&
        pataCobro[0].kind === "TRANSFER" &&
        pataCobro[0].toAccountId === bancoId &&
        pataCobro[0].amount.toFixed(2) === "10000.00",
      JSON.stringify(pataCobro),
    );
    const interesesC1 = await prisma.movement.count({
      where: {
        description: "Cuota 1 · interés",
        accountId: bancoId,
        kind: "EXPENSE",
      },
    });
    check("sigue habiendo UNA sola pata de interés de cuota 1 (la de L1)", interesesC1, 1);

    const vistaCobro = prestamoDe(await vistaPrestamos("?asOf=2028-07-31"), r1.body?.id);
    check("te deben: 50.000 − 10.000 = 40.000,00", vistaCobro?.receivable, "40000.00");
    check("un RECEIVABLE no tiene deuda (debt null)", vistaCobro?.debt, null);

    /* ───────────────────────────────────────────────────────────────────────
     * I1 - INTEREST_ONLY: no hay cuota que pagar; se cancela por anticipado
     * ─────────────────────────────────────────────────────────────────────── */
    section("I1 - INTEREST_ONLY 120.000");
    const i1 = await crearPrestamo({
      name: `${TAG}_I1`,
      kind: "LOAN",
      principal: "120000",
      tnaPercent: "24",
      installmentCount: 6,
      firstInstallmentDate: "2028-06-20",
      amortizationSystem: "INTEREST_ONLY",
    });
    check("I1 responde 201", i1.status, 201);
    const desembolsoI1 = await post("/api/transactions", {
      kind: "TRANSFER",
      amount: "120000",
      date: "2028-06-01",
      accountId: i1.body?.id,
      toAccountId: bancoId,
      description: `${TAG}_Desembolso_I1`,
    });
    check("el desembolso de I1 responde 201", desembolsoI1.status, 201);

    const vistaI1 = prestamoDe(await vistaPrestamos("?asOf=2028-07-31"), i1.body?.id);
    check("I1 no ofrece cuota: nextInstallment null", vistaI1?.nextInstallment, null);

    const pagoI1 = await post("/api/loans/pay", {
      accountId: i1.body?.id,
      cashAccountId: bancoId,
      date: "2028-07-01",
      installmentNumber: 1,
    });
    check("pagar una cuota de I1: 400 (la ruta lo rechaza)", pagoI1.status, 400);
    checkIncluye("I1 explica POR QUÉ: solo interés", pagoI1.body?.error, "solo interés");

    const cancelacionI1 = await post("/api/loans/pay", {
      accountId: i1.body?.id,
      cashAccountId: bancoId,
      date: "2028-07-01",
      cancel: true,
    });
    check("cancelar I1 responde 201", cancelacionI1.status, 201);
    check("la cancelación de I1 paga el capital entero: 120.000,00", cancelacionI1.body?.principalPaid, "120000.00");
    check("la cancelación de I1 no paga interés", cancelacionI1.body?.interestPaid, null);

    const vistaI1Saldada = prestamoDe(await vistaPrestamos("?asOf=2028-07-31"), i1.body?.id);
    check("I1 queda en deuda 0,00", vistaI1Saldada?.debt, "0.00");

    /* ───────────────────────────────────────────────────────────────────────
     * A1 - AMERICAN: sólo el cierre
     * ─────────────────────────────────────────────────────────────────────── */
    section("A1 - AMERICAN 500.000: sólo el cierre de 525.000,00");
    const a1 = await crearPrestamo({
      name: `${TAG}_A1`,
      kind: "LOAN",
      principal: "500000",
      tnaPercent: "60",
      installmentCount: 12,
      firstInstallmentDate: "2028-06-20",
      amortizationSystem: "AMERICAN",
    });
    check("A1 responde 201", a1.status, 201);
    const desembolsoA1 = await post("/api/transactions", {
      kind: "TRANSFER",
      amount: "500000",
      date: "2028-06-01",
      accountId: a1.body?.id,
      toAccountId: bancoId,
      description: `${TAG}_Desembolso_A1`,
    });
    check("el desembolso de A1 responde 201", desembolsoA1.status, 201);

    const vistaA1 = prestamoDe(await vistaPrestamos("?asOf=2028-07-31"), a1.body?.id);
    check("A1 ofrece el CIERRE como próxima cuota", vistaA1?.nextInstallment?.number, 12);
    check("el cierre paga 525.000,00", vistaA1?.nextInstallment?.payment, "525000.00");

    const pagoInteresA1 = await post("/api/loans/pay", {
      accountId: a1.body?.id,
      cashAccountId: bancoId,
      date: "2028-07-01",
      installmentNumber: 1,
    });
    check("pagar sólo-interés de A1: 400 (la ruta lo rechaza)", pagoInteresA1.status, 400);
    checkIncluye("A1 explica POR QUÉ: americano", pagoInteresA1.body?.error, "americano");
    checkIncluye("A1 nombra el cierre", pagoInteresA1.body?.error, "cuota 12");

    const cierreA1 = await post("/api/loans/pay", {
      accountId: a1.body?.id,
      cashAccountId: bancoId,
      date: "2028-07-01",
      installmentNumber: 12,
    });
    check("el cierre responde 201", cierreA1.status, 201);
    check("el cierre paga 500.000,00 de capital", cierreA1.body?.principalPaid, "500000.00");
    check("el cierre paga 25.000,00 de interés", cierreA1.body?.interestPaid, "25000.00");

    const vistaA1Cerrada = prestamoDe(await vistaPrestamos("?asOf=2028-07-31"), a1.body?.id);
    check("A1 queda en deuda 0,00", vistaA1Cerrada?.debt, "0.00");
    check("A1 queda con el capital entero pagado", vistaA1Cerrada?.capitalPaid, "500000.00");

    const cierreRepetido = await post("/api/loans/pay", {
      accountId: a1.body?.id,
      cashAccountId: bancoId,
      date: "2028-07-01",
      installmentNumber: 12,
    });
    check("repetir el cierre: 200 (estado, no error)", cierreRepetido.status, 200);
    check("repetir el cierre: created false", cierreRepetido.body?.created, false);
  },
});
