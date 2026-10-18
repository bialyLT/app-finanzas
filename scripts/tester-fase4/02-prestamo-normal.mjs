#!/usr/bin/env node
/**
 * 02 — Préstamo normal (I_OWE): el escenario del §3.2, de punta a punta.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA
 * ─────────────────────────────────────────────────────────────────────────────
 * Los criterios 1–5 de la fase sobre el caso del ROADMAP §3.2 (500.000 al 60%
 * TNA en 12 cuotas francesas), todo en el mes AISLADO 2028-03 (la siembra del
 * smoke no llega ahí: la batería no depende del "hoy" real):
 *
 *   1. El desembolso (TRANSFER préstamo → banco) NO infla Ingresos.
 *   2. Pagar una cuota sube Gastos SÓLO por el interés; el capital es TRANSFER.
 *   3. La tasa de ahorro del mes es 21,88% (NO el 49,51% de contar el
 *      desembolso como ingreso).
 *   4. El saldo del préstamo llega a 0,00 en la última cuota.
 *   5. ΔPatrimonio del mes reconcilia al centavo con el Ahorro (difference 0).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA ARITMÉTICA, A MANO (i = 0,60/12 = 0,05 mensual)
 * ─────────────────────────────────────────────────────────────────────────────
 * Cuota francesa = 56.412,71 (el §3.2). Cuota 1:
 *   interés  = round(500.000,00 × 0,05) = 25.000,00
 *   capital  = 56.412,71 − 25.000,00     = 31.412,71
 *   saldo    = 500.000,00 − 31.412,71    = 468.587,29
 *
 * El mes 2028-03 con el desembolso (05/03, 500.000) y la cuota 1 (15/03):
 *   Ingresos    = 800.000,00 (el sueldo; el desembolso es TRANSFER)
 *   Gastos      = 600.000,00 + 25.000,00 = 625.000,00
 *   Ahorro      = 175.000,00 → tasa = 175.000/800.000 = 21,875% → 21,88
 *   Flujo caja  = 800.000 − 600.000 + 500.000 − 31.412,71 − 25.000 = 643.587,29
 *   Banco       = 643.587,29 (el mismo número: es la cuenta de dinero)
 *   ΔPatrimonio = +175.000,00 (el desembolso mueve banco +500.000 y préstamo
 *                 −500.000: neto cero — deuda no es riqueza)
 *
 * Después se pagan las cuotas 2..12 en sus vencimientos (2028-04-15 ..
 * 2029-02-15) y el préstamo cierra: capital 500.000,00, interés 176.952,44
 * (Σ del cronograma), saldo y deuda 0,00, progreso 100,00.
 * El mes 2029-02 cierra con ΔPatrimonio = Ahorro = −2.686,32 (cuota 12:
 * capital 53.726,31 + interés 2.686,32; el interés es el único gasto).
 */

import {
  addMonthsCal,
  cents,
  centsToMoney,
  check,
  checkDeep,
  checkTrue,
  crearCuenta,
  crearMovimiento,
  crearPrestamo,
  cuentaDe,
  deudaDelMes,
  get,
  pagarPrestamo,
  prestamoDe,
  reconciliacion,
  reportesDelMes,
  runScript,
  section,
} from "./helpers.mjs";

const TAG = "T_TESTER_F4_02";
const MES = "2028-03";

runScript({
  tag: TAG,
  main: async () => {
    /* ──────────────────────────────────────────────────────────────────────
     * Punto de partida: 2028-03 está vacío (la siembra no llega hasta acá)
     * ────────────────────────────────────────────────────────────────────── */
    section("Punto de partida: 2028-03 sin movimientos");
    const deudaAntes = await deudaDelMes(MES, "2028-03-31");
    const compromisoAntes = cents(
      deudaAntes.body?.debtReport?.dti?.monthlyCommitment ?? "0",
    );
    const deudaTotalAntes = cents(
      deudaAntes.body?.debtReport?.totalDebt ?? "0",
    );
    const planCountAntes = deudaAntes.body?.debtReport?.dti?.planCount ?? 0;
    {
      const rep = await reportesDelMes(MES);
      check("ingresos del mes: 0,00", rep.body?.totals?.income, "0.00");
      check("gastos del mes: 0,00", rep.body?.totals?.expenses, "0.00");
      check("transferencias del mes: 0,00", rep.body?.totals?.transfers, "0.00");
      check("flujo de caja del mes: 0,00", rep.body?.totals?.cashFlow, "0.00");
    }

    /* ──────────────────────────────────────────────────────────────────────
     * El escenario: banco, sueldo, gasto, préstamo y desembolso
     * ────────────────────────────────────────────────────────────────────── */
    section("Alta: banco, ingreso, gasto, préstamo y desembolso");
    const banco = await crearCuenta(`${TAG}_Banco`, "BANK", "0");
    check("alta del banco responde 201", banco.status, 201);
    const bancoId = banco.body?.id;

    const creado = await crearPrestamo({
      name: `${TAG}_Prestamo`,
      kind: "LOAN",
      principal: "500000",
      tnaPercent: "60",
      installmentCount: 12,
      firstInstallmentDate: "2028-03-15",
      amortizationSystem: "FRENCH",
    });
    check("alta del préstamo responde 201", creado.status, 201);
    const prestamoId = creado.body?.id;

    const antesDeTodo = await cuentaDe(prestamoId, "?asOf=2028-03-01");
    check(
      "el préstamo nace con saldo 0,00: la deuda la crea el desembolso",
      antesDeTodo?.balance,
      "0.00",
    );

    const ingreso = await crearMovimiento({
      kind: "INCOME",
      amount: "800000",
      date: "2028-03-01",
      accountId: bancoId,
      categoryName: `${TAG}_Sueldo`,
      description: `${TAG} sueldo`,
    });
    check("ingreso de 800.000 responde 201", ingreso.status, 201);

    const gasto = await crearMovimiento({
      kind: "EXPENSE",
      amount: "600000",
      date: "2028-03-02",
      accountId: bancoId,
      categoryName: `${TAG}_Gastos`,
      description: `${TAG} gastos del mes`,
    });
    check("gasto de 600.000 responde 201", gasto.status, 201);

    // El desembolso: TRANSFER préstamo → banco (plata que entra, deuda que sube).
    const desembolso = await crearMovimiento({
      kind: "TRANSFER",
      amount: "500000",
      date: "2028-03-05",
      accountId: prestamoId,
      toAccountId: bancoId,
      description: `${TAG} desembolso`,
    });
    check("desembolso responde 201", desembolso.status, 201);

    const bancoTrasDesembolso = await cuentaDe(bancoId, "?asOf=2028-03-05");
    check(
      "el banco tiene 700.000,00 (800.000 − 600.000 + 500.000)",
      bancoTrasDesembolso?.balance,
      "700000.00",
    );
    const prestamoTrasDesembolso = await cuentaDe(
      prestamoId,
      "?asOf=2028-03-05",
    );
    check(
      "la cuenta del préstamo queda en −500.000,00",
      prestamoTrasDesembolso?.balance,
      "-500000.00",
    );
    check(
      "la deuda viva es 500.000,00 (positiva, es pasivo)",
      prestamoTrasDesembolso?.debt,
      "500000.00",
    );
    checkTrue(
      "la cuenta está marcada como pasivo",
      prestamoTrasDesembolso?.isLiability === true,
    );

    {
      const vista = await get("/api/loans?asOf=2028-03-05");
      const mio = prestamoDe(vista, prestamoId);
      checkTrue("la vista trae el préstamo antes de pagar", mio !== null);
      check("capital pagado 0,00", mio?.capitalPaid, "0.00");
      check("progreso 0,00%", mio?.progressPercent, "0.00");
      check("la próxima cuota es la 1", mio?.nextInstallment?.number, 1);
      check(
        "la cuota 1 vence el 2028-03-15",
        mio?.nextInstallment?.dueDate,
        "2028-03-15",
      );
      check(
        "un préstamo impago no libera su cuota de compromisos",
        // Ventana 2028-03..2029-02: los primeros 6 buckets son las cuotas 1..6:
        // 6 × 56.412,71 = 338.476,26. Los 12 son las 12 cuotas enteras:
        // 11 × 56.412,71 + 56.412,63 = 676.952,44.
        mio?.commitments?.next6Months,
        "338476.26",
      );
      check(
        "los 12 meses comprometen el total del contrato 676.952,44",
        mio?.commitments?.next12Months,
        "676952.44",
      );
    }

    // El desembolso NO es ingreso: sigue habiendo un solo INCOME de 800.000.
    section("El desembolso no infla Ingresos");
    {
      const rep = await reportesDelMes(MES);
      check(
        "ingresos 800.000,00 (NO 1.300.000,00)",
        rep.body?.totals?.income,
        "800000.00",
      );
      check("gastos 600.000,00", rep.body?.totals?.expenses, "600000.00");
      check(
        "transferencias 500.000,00",
        rep.body?.totals?.transfers,
        "500000.00",
      );
      check(
        "flujo de caja 700.000,00 (800.000 − 600.000 + 500.000)",
        rep.body?.totals?.cashFlow,
        "700000.00",
      );
      check("hay un solo ingreso", rep.body?.totals?.incomeCount, 1);
      check("hay un solo gasto", rep.body?.totals?.expenseCount, 1);
      check("hay una sola transferencia", rep.body?.totals?.transferCount, 1);
    }

    /* ──────────────────────────────────────────────────────────────────────
     * Pago de la cuota 1: dos patas exactas
     * ────────────────────────────────────────────────────────────────────── */
    section("Pago de la cuota 1 (2028-03-15)");
    const pago1 = await pagarPrestamo({
      accountId: prestamoId,
      cashAccountId: bancoId,
      date: "2028-03-15",
    });
    check("responde 201 (escribió)", pago1.status, 201);
    check("created = true", pago1.body?.created, true);
    check("cancelled = false", pago1.body?.cancelled, false);
    check("la cuota pagada es la 1", pago1.body?.installment?.number, 1);
    check("capital pagado 31.412,71", pago1.body?.principalPaid, "31412.71");
    check("interés pagado 25.000,00", pago1.body?.interestPaid, "25000.00");

    {
      const patas = pago1.body?.movements ?? [];
      check("el pago escribe DOS patas", patas.length, 2);
      const capital = patas.find((m) => m.kind === "TRANSFER");
      const interes = patas.find((m) => m.kind === "EXPENSE");
      checkTrue("hay una TRANSFER de capital", Boolean(capital));
      checkTrue("hay un EXPENSE de interés", Boolean(interes));

      check("TRANSFER 31.412,71", capital?.amount, "31412.71");
      check("TRANSFER desde el banco", capital?.account?.id, bancoId);
      check("TRANSFER hacia el préstamo", capital?.toAccount?.id, prestamoId);
      check("TRANSFER fechada 2028-03-15", capital?.date, "2028-03-15");
      check(
        "la descripción del capital dice cuota 1",
        capital?.description,
        "Cuota 1 · capital",
      );

      check("EXPENSE 25.000,00", interes?.amount, "25000.00");
      check("EXPENSE desde el banco", interes?.account?.id, bancoId);
      check("EXPENSE fechado 2028-03-15", interes?.date, "2028-03-15");
      check(
        "el interés va a la categoría Intereses",
        interes?.category?.name,
        "Intereses",
      );
      check(
        "la descripción del interés dice cuota 1",
        interes?.description,
        "Cuota 1 · interés",
      );
    }

    // El estado real se relee con `asOf` (la vista del response usa el hoy real).
    section("Estado del préstamo tras la cuota 1 (asOf 2028-03-31)");
    const vista = await get("/api/loans?asOf=2028-03-31");
    const mine = prestamoDe(vista, prestamoId);
    checkTrue("la vista trae el préstamo", mine !== null);
    check("dirección I_OWE", mine?.direction, "I_OWE");
    check("sistema FRENCH", mine?.system, "FRENCH");
    check("saldo contable −468.587,29", mine?.balance, "-468587.29");
    check("deuda viva 468.587,29", mine?.debt, "468587.29");
    check("capital pagado 31.412,71", mine?.capitalPaid, "31412.71");
    check("interés pagado 25.000,00", mine?.interestPaid, "25000.00");
    check("progreso 6,28% (31.412,71/500.000)", mine?.progressPercent, "6.28");
    check("plan: cuota 56.412,71", mine?.plan?.payment, "56412.71");
    check("plan: principal 500.000,00", mine?.plan?.principal, "500000.00");
    check("plan: 12 cuotas", mine?.plan?.installmentCount, 12);
    check("plan: 1 pagada", mine?.plan?.paidCount, 1);
    check("plan: 11 restantes", mine?.plan?.remainingCount, 11);
    check("la próxima cuota es la 2", mine?.nextInstallment?.number, 2);
    check(
      "la cuota 2 vence el 2028-04-15",
      mine?.nextInstallment?.dueDate,
      "2028-04-15",
    );
    checkDeep(
      "cobertura [true, false, ...]: sólo la cuota 1 está pagada",
      (mine?.installments ?? []).slice(0, 2).map((f) => f.covered),
      [true, false],
    );
    check(
      "la última cuota del cronograma sigue echa un documento exacto",
      mine?.installments?.[11]?.payment,
      "56412.63",
    );
    check(
      "los vencimientos son la serie anclada (2028-03-15 + k meses)",
      (mine?.installments ?? []).every(
        (fila, index) => fila.dueDate === addMonthsCal("2028-03-15", index),
      ),
      true,
    );

    // El banco bajó exactamente la cuota: 700.000 − 56.412,71 = 643.587,29.
    const bancoTrasCuota1 = await cuentaDe(bancoId, "?asOf=2028-03-31");
    check(
      "el banco queda en 643.587,29",
      bancoTrasCuota1?.balance,
      "643587.29",
    );

    /* ──────────────────────────────────────────────────────────────────────
     * Los números del mes: reportes, tasa de ahorro y reconciliación
     * ────────────────────────────────────────────────────────────────────── */
    section("Reportes de 2028-03: el desembolso no es ingreso, el capital no es gasto");
    {
      const rep = await reportesDelMes(MES);
      check("ingresos 800.000,00", rep.body?.totals?.income, "800000.00");
      check(
        "gastos 625.000,00 (600.000 + 25.000 de interés)",
        rep.body?.totals?.expenses,
        "625000.00",
      );
      check(
        "transferencias 531.412,71 (500.000 + 31.412,71)",
        rep.body?.totals?.transfers,
        "531412.71",
      );
      check(
        "flujo de caja 643.587,29 (800.000 − 625.000 + 468.587,29)",
        rep.body?.totals?.cashFlow,
        "643587.29",
      );
      check("dos gastos (el manual y el interés)", rep.body?.totals?.expenseCount, 2);
      check(
        "dos transferencias (desembolso y capital)",
        rep.body?.totals?.transferCount,
        2,
      );

      // La tasa del panel: (ingresos − gastos)/ingresos = 175.000/800.000.
      // 175.000/800.000 = 0,21875 → 21,875% → 21,88 (acá half-even y
      // half-up coinciden: el tercer decimal es 5 y el segundo queda par).
      const ahorro = cents(rep.body?.totals?.income) - cents(rep.body?.totals?.expenses);
      check("el ahorro del mes es 175.000,00", centsToMoney(ahorro), "175000.00");
      const tasa = (Number(ahorro) / Number(cents(rep.body?.totals?.income))) * 100;
      check(
        "tasa de ahorro 21,88% (no el 49,51% de contar el desembolso)",
        tasa.toFixed(2),
        "21.88",
      );
    }

    section("Reconciliación 2028-03: ΔPatrimonio = Ahorro");
    {
      const rec = await reconciliacion(MES, "2028-03-31");
      const r = rec.body?.reconciliation;
      check("ΔPatrimonio = 175.000,00", r?.netDelta, "175000.00");
      check("Ahorro = 175.000,00", r?.saving, "175000.00");
      check("diferencia 0,00", r?.difference, "0.00");
      check("balanced = true", r?.balanced, true);
      check("el corte es el fin del mes", r?.cutAt, "2028-03-31");
    }

    section("DTI: el préstamo compromete su cuota");
    {
      const deudaDesp = await deudaDelMes(MES, "2028-03-31");
      const compromisoDesp = cents(
        deudaDesp.body?.debtReport?.dti?.monthlyCommitment ?? "0",
      );
      check(
        "el compromiso mensual sube exactamente 56.412,71",
        centsToMoney(compromisoDesp - compromisoAntes),
        "56412.71",
      );
      check(
        "el DTI del mes ve el ingreso de 800.000,00",
        deudaDesp.body?.debtReport?.dti?.income,
        "800000.00",
      );
      // (56.412,71 (sembrado) + 56.412,71 (mío)) / 800.000 = 14,1031775% → 14,10.
      check(
        "DTI 14,10%",
        deudaDesp.body?.debtReport?.dti?.percent,
        "14.10",
      );
      check(
        "el préstamo suma un plan al conteo",
        deudaDesp.body?.debtReport?.dti?.planCount,
        planCountAntes + 1,
      );

      const fila = (deudaDesp.body?.debtReport?.rows ?? []).find(
        (row) => row.accountId === prestamoId,
      );
      checkTrue("el préstamo está en las filas de deuda", Boolean(fila));
      check("su deuda es 468.587,29", fila?.debt, "468587.29");
      check("su progreso es 6,28%", fila?.progressPercent, "6.28");
      check("su interés pagado es 25.000,00", fila?.interestPaid, "25000.00");
    }

    /* ──────────────────────────────────────────────────────────────────────
     * Pagar las cuotas 2..12 en sus vencimientos: el préstamo cierra en 0
     * ────────────────────────────────────────────────────────────────────── */
    section("Cuotas 2..12 en orden, cada una en su vencimiento");
    const filas = mine?.installments ?? [];
    check("el cronograma tiene 12 filas", filas.length, 12);

    for (let numero = 2; numero <= 12; numero += 1) {
      const fila = filas[numero - 1];
      const pago = await pagarPrestamo({
        accountId: prestamoId,
        cashAccountId: bancoId,
        date: fila?.dueDate,
      });
      check(`cuota ${numero} responde 201`, pago.status, 201);
      check(
        `cuota ${numero} capital ${fila?.principal}`,
        pago.body?.principalPaid,
        fila?.principal,
      );
      check(
        `cuota ${numero} interés ${fila?.interest}`,
        pago.body?.interestPaid,
        fila?.interest,
      );
    }

    section("Cierre del préstamo (asOf 2029-03-01)");
    {
      const vistaFinal = await get("/api/loans?asOf=2029-03-01");
      const fin = prestamoDe(vistaFinal, prestamoId);
      checkTrue("la vista sigue trayendo el préstamo", fin !== null);
      check("saldo contable 0,00", fin?.balance, "0.00");
      check("deuda 0,00", fin?.debt, "0.00");
      check("capital pagado 500.000,00", fin?.capitalPaid, "500000.00");
      check("interés pagado 176.952,44", fin?.interestPaid, "176952.44");
      check("progreso 100,00%", fin?.progressPercent, "100.00");
      check("no hay próxima cuota", fin?.nextInstallment, null);
      check("plan: 12 pagadas", fin?.plan?.paidCount, 12);
      check("plan: 0 restantes", fin?.plan?.remainingCount, 0);
      check("compromisos 6 meses: 0,00", fin?.commitments?.next6Months, "0.00");
      check("compromisos 12 meses: 0,00", fin?.commitments?.next12Months, "0.00");
      check("vencido: 0,00", fin?.commitments?.overdue, "0.00");
      check("cuotas vencidas: 0", fin?.commitments?.overdueCount, 0);

      // Σ del cronograma materializado: capital y interés EXACTOS.
      const sumaCapital = centsToMoney(
        (fin?.installments ?? []).reduce((acc, f) => acc + cents(f.principal), 0n),
      );
      const sumaInteres = centsToMoney(
        (fin?.installments ?? []).reduce((acc, f) => acc + cents(f.interest), 0n),
      );
      const sumaPago = centsToMoney(
        (fin?.installments ?? []).reduce((acc, f) => acc + cents(f.payment), 0n),
      );
      check("Σ capital = 500.000,00 exacto", sumaCapital, "500000.00");
      check("Σ interés = 176.952,44 exacto", sumaInteres, "176952.44");
      check("Σ pagos = 676.952,44", sumaPago, "676952.44");
      check(
        "las 12 cuotas están cubiertas",
        (fin?.installments ?? []).filter((f) => f.covered).length,
        12,
      );
    }

    section("El préstamo terminado libera su cuota del DTI");
    {
      const deudaFin = await deudaDelMes("2029-03", "2029-03-31");
      check(
        "el compromiso mensual volvió al punto de partida",
        centsToMoney(
          cents(deudaFin.body?.debtReport?.dti?.monthlyCommitment ?? "0"),
        ),
        centsToMoney(compromisoAntes),
      );
      check(
        "la deuda total volvió al punto de partida",
        centsToMoney(cents(deudaFin.body?.debtReport?.totalDebt ?? "0")),
        centsToMoney(deudaTotalAntes),
      );
      const fila = (deudaFin.body?.debtReport?.rows ?? []).find(
        (row) => row.accountId === prestamoId,
      );
      checkTrue("el préstamo sigue en las filas (con deuda 0)", Boolean(fila));
      check("su deuda es 0,00", fila?.debt, "0.00");
      check("su progreso es 100,00%", fila?.progressPercent, "100.00");
      check("plan pagado completo", fila?.plan?.paidCount, 12);
      check("plan sin restantes", fila?.plan?.remainingCount, 0);
    }

    section("El último mes (2029-02): ΔPatrimonio = Ahorro = −2.686,32");
    {
      // Cuota 12: capital 53.726,31 (TRANSFER banco→préstamo, neto patrimonio 0)
      // + interés 2.686,32 (EXPENSE). El único cambio de riqueza es −2.686,32.
      const rec = await reconciliacion("2029-02", "2029-02-28");
      const r = rec.body?.reconciliation;
      check("ΔPatrimonio = −2.686,32", r?.netDelta, "-2686.32");
      check("Ahorro = −2.686,32", r?.saving, "-2686.32");
      check("diferencia 0,00", r?.difference, "0.00");
      check("balanced = true", r?.balanced, true);

      const rep = await get("/api/reports?from=2029-02-01&to=2029-02-28");
      check("gastos del mes 2.686,32", rep.body?.totals?.expenses, "2686.32");
      check("ingresos del mes 0,00", rep.body?.totals?.income, "0.00");
      check(
        "flujo de caja −56.412,63 (interés 2.686,32 + capital 53.726,31)",
        rep.body?.totals?.cashFlow,
        "-56412.63",
      );
    }
  },
});
