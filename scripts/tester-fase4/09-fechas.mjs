#!/usr/bin/env node
/**
 * 09 — Las fechas del cronograma: serie ANCLADA (bisiesto y meses cortos) y el
 *      borde del DÍA del vencimiento en el pago sin número.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA (contrato de fechas + borde de calendario)
 * ─────────────────────────────────────────────────────────────────────────────
 *   A. Preview: `addMonths` clampa al fin de mes CONTRA el ANCLA, no contra el
 *      mes anterior. La cuota de febrero de una serie que arranca el 31 se
 *      corre al 29 (bisiesto), y en marzo VUELVE al 31 — el clamp no se
 *      arrastra (un `addMonths` ingenuo sobre "2028-02-29" daría 2028-03-29).
 *   B. Alta: el cronograma materializado guarda EXACTAMENTE las fechas del
 *      preview — no hay dos implementaciones de la serie.
 *   C. El borde del día, sin número: se paga sólo si `dueDate ≤ date`.
 *        víspera (03-30) → 200 created:false, NADA se escribe;
 *        el día (03-31) → 201 con la cuota 1;
 *        víspera de la 2 (04-29) → 200 created:false;
 *        el día de la 2 (04-30)   → 201 con la cuota 2.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA ARITMÉTICA, A MANO
 * ─────────────────────────────────────────────────────────────────────────────
 *   A. 700 al 0% en 7 cuotas → 700/7 = 100,00 exactos (sin interés, sin resto).
 *      300 al 0% en 3 cuotas → 100,00 exactos.
 *      Serie 2027-12-31: 12-31, 01-31, 02-29 (2028 bisiesto: último día 29),
 *      03-31 (el ancla es el 31), 04-30, 05-31, 06-30.
 *      Serie 2027-01-31: 01-31, 02-28 (2027 no bisiesto), 03-31.
 *   C. 1.000 al 0% en 2 cuotas → 500,00 + 500,00. Fechas: 2028-03-31 y
 *      2028-04-30 (30 días después del 31 de marzo; abril tiene 30).
 *      Después de pagar las dos: capital pagado 1.000,00 = 100,00%.
 */

import {
  check,
  checkDeep,
  checkSin500,
  checkTrue,
  crearCuenta,
  crearPrestamo,
  cuentaDe,
  pagarPrestamo,
  prestamoDe,
  runScript,
  section,
  sumItems,
  vistaPrestamos,
  vistasPreview,
} from "./helpers.mjs";

const TAG = "T_TESTER_F4_09";

runScript({
  tag: TAG,
  main: async () => {
    /* ────────────────────────────────────────────────────────────────────────
     * A — Preview: la serie anclada sobre fin de mes y bisiesto
     * ──────────────────────────────────────────────────────────────────────── */
    section("A · Preview: ancla 2027-12-31 (febrero bisiesto) y 2027-01-31 (mes corto)");

    const p1 = await vistasPreview(
      "principal=700&tnaPercent=0&installmentCount=7&firstInstallmentDate=2027-12-31",
    );
    check("preview 700/7 responde 200", p1.status, 200);
    checkDeep(
      "fechas ancladas al 31 (febrero cae al 29 y marzo VUELVE al 31)",
      (p1.body?.schedule ?? []).map((f) => f.dueDate),
      [
        "2027-12-31",
        "2028-01-31",
        "2028-02-29",
        "2028-03-31",
        "2028-04-30",
        "2028-05-31",
        "2028-06-30",
      ],
    );
    checkDeep(
      "700/7 sin interés: siete cuotas de 100.00",
      (p1.body?.schedule ?? []).map((f) => f.payment),
      ["100.00", "100.00", "100.00", "100.00", "100.00", "100.00", "100.00"],
    );

    const p2 = await vistasPreview(
      "principal=300&tnaPercent=0&installmentCount=3&firstInstallmentDate=2027-01-31",
    );
    check("preview 300/3 responde 200", p2.status, 200);
    checkDeep(
      "2027 no bisiesto: 31 → 28 → 31 (el clamp no se arrastra)",
      (p2.body?.schedule ?? []).map((f) => f.dueDate),
      ["2027-01-31", "2027-02-28", "2027-03-31"],
    );

    const p3 = await vistasPreview("principal=700&tnaPercent=0&installmentCount=7");
    check("preview sin fecha responde 200", p3.status, 200);
    checkTrue(
      "sin firstInstallmentDate el plan es el mismo y todo dueDate es null",
      (p3.body?.schedule ?? []).length === 7 &&
        (p3.body?.schedule ?? []).every((f) => f.dueDate === null),
    );

    const invalidas = [];
    for (const fecha of ["2028-02-30", "2028-13-01", "31-12-2028", "2028-2-3", "20280229"]) {
      invalidas.push(
        await vistasPreview(
          `principal=700&tnaPercent=0&installmentCount=7&firstInstallmentDate=${fecha}`,
        ),
      );
    }
    checkSin500("preview con fechas inválidas: nunca 500", invalidas);
    checkDeep(
      "preview con fechas inválidas: todo 400",
      invalidas.map((r) => r.status),
      [400, 400, 400, 400, 400],
    );

    /* ────────────────────────────────────────────────────────────────────────
     * B — Alta: el cronograma materializado repite las fechas del preview
     * ──────────────────────────────────────────────────────────────────────── */
    section("B · Alta 700/7 desde 2027-12-31: el GET devuelve las mismas fechas");

    const alta = await crearPrestamo({
      name: `${TAG}_Bisiesto`,
      kind: "LOAN",
      principal: "700",
      tnaPercent: "0",
      installmentCount: 7,
      firstInstallmentDate: "2027-12-31",
    });
    check("alta responde 201", alta.status, 201);
    const idBisiesto = alta.body?.id;

    const vistaB = await vistaPrestamos("?asOf=2027-12-31");
    const mio = prestamoDe(vistaB, idBisiesto);
    checkTrue("la vista trae el préstamo", mio !== null);
    check("firstInstallmentDate en la vista", mio?.firstInstallmentDate, "2027-12-31");
    checkDeep(
      "el cronograma materializa la serie anclada",
      (mio?.installments ?? []).map((f) => f.dueDate),
      [
        "2027-12-31",
        "2028-01-31",
        "2028-02-29",
        "2028-03-31",
        "2028-04-30",
        "2028-05-31",
        "2028-06-30",
      ],
    );
    check(
      "Σ cuotas = 700.00",
      sumItems(mio?.installments ?? [], (f) => f.payment),
      "700.00",
    );

    /* ────────────────────────────────────────────────────────────────────────
     * C — El borde del DÍA: sin número sólo vence lo vencido
     * ──────────────────────────────────────────────────────────────────────── */
    section("C · 1000/2 desde 2028-03-31: la víspera no paga, el día sí");

    const banco = await crearCuenta(`${TAG}_Banco`, "BANK", "0");
    check("alta del banco responde 201", banco.status, 201);
    const bancoId = banco.body?.id;

    const prestamo = await crearPrestamo({
      name: `${TAG}_Borde`,
      kind: "LOAN",
      principal: "1000",
      tnaPercent: "0",
      installmentCount: 2,
      firstInstallmentDate: "2028-03-31",
    });
    check("alta del préstamo responde 201", prestamo.status, 201);
    const loanId = prestamo.body?.id;

    const vistaC = await vistaPrestamos("?asOf=2028-03-01");
    const miC = prestamoDe(vistaC, loanId);
    checkDeep(
      "cuotas 2028-03-31 y 2028-04-30 (abril tiene 30)",
      (miC?.installments ?? []).map((f) => f.dueDate),
      ["2028-03-31", "2028-04-30"],
    );

    // La víspera del vencimiento: dueDate (03-31) > date (03-30) → idempotente sin escribir.
    const vispera1 = await pagarPrestamo({
      accountId: loanId,
      cashAccountId: bancoId,
      date: "2028-03-30",
    });
    check("30/03 responde 200", vispera1.status, 200);
    check("30/03 created:false (no venció)", vispera1.body?.created, false);
    check("30/03 sin movimientos", (vispera1.body?.movements ?? []).length, 0);

    // El día: dueDate (03-31) ≤ date (03-31) → paga.
    const dia1 = await pagarPrestamo({
      accountId: loanId,
      cashAccountId: bancoId,
      date: "2028-03-31",
    });
    check("31/03 responde 201", dia1.status, 201);
    check("31/03 paga la cuota 1", dia1.body?.installment?.number, 1);
    check("31/03 cuota de 500.00", dia1.body?.installment?.payment, "500.00");

    const vispera2 = await pagarPrestamo({
      accountId: loanId,
      cashAccountId: bancoId,
      date: "2028-04-29",
    });
    check("29/04 responde 200", vispera2.status, 200);
    check("29/04 created:false (la 2 vence el 30)", vispera2.body?.created, false);

    const dia2 = await pagarPrestamo({
      accountId: loanId,
      cashAccountId: bancoId,
      date: "2028-04-30",
    });
    check("30/04 responde 201", dia2.status, 201);
    check("30/04 paga la cuota 2", dia2.body?.installment?.number, 2);

    const finC = prestamoDe(await vistaPrestamos("?asOf=2028-05-01"), loanId);
    check(
      "las dos cuotas cubiertas",
      (finC?.installments ?? []).filter((f) => f.covered).length,
      2,
    );
    check("capital pagado 1000.00", finC?.capitalPaid, "1000.00");
    check("progreso 100.00", finC?.progressPercent, "100.00");

    const bancoFin = await cuentaDe(bancoId, "?asOf=2028-05-01");
    check("el banco pagó 1.000,00", bancoFin?.balance, "-1000.00");
  },
});
