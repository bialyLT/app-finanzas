#!/usr/bin/env node
/**
 * 13 — El saldo negativo NO se clampa: sobrepago y legado sin fecha.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA (brief punto 5 y borde de "plata de más")
 * ─────────────────────────────────────────────────────────────────────────────
 *   A. Un préstamo sobrepagado a mano (TRANSFER por fuera de /pay) queda con
 *      saldo contable POSITIVO: la deuda mostrada es NEGATIVA (crédito a
 *      favor), no se clampa a cero. El capital pagado SÍ va clampeado a
 *      [0, principal] (es cobertura, no saldo), la cobertura es 10/10 y el
 *      plan deja de comprometer su cuota en el DTI.
 *      · /pay ya no escribe nada: reintento con número → created:false; sin
 *        número (todas cubiertas) → created:false; cancel → created:false.
 *      · La transferencia mueve banco y deuda en la misma magnitud: el
 *        patrimonio neto no cambia.
 *   B. Un legado sin `firstInstallmentDate` (cuenta anterior a la fase, creada
 *      por fuera de la API) NO tiene cronograma posible: la vista va sin plan,
 *      /pay (cuota explícita o cancelación) → 400 "no tiene cronograma" y no
 *      materializa filas fantasma ni escribe movimientos.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA ARITMÉTICA, A MANO (i = 0: cuotas exactas)
 * ─────────────────────────────────────────────────────────────────────────────
 * FRENCH 100.000/10 al 0% (primera 2028-06-10): cada cuota es 10.000,00 de
 * capital, interés 0,00. Serie de vencimientos: 10/06, 10/07, …, 10/03/2029.
 *
 *   · Desembolso 2028-05-01 (TRANSFER préstamo → banco, 100.000,00):
 *     saldo del préstamo −100.000,00.
 *   · Sobrepago 2028-06-01 (TRANSFER banco → préstamo, 120.000,00):
 *     −100.000 + 120.000 = +20.000,00 → balance 20.000,00
 *     deuda mostrada = −balance = −20.000,00 (SIN clamp: es el saldo real).
 *   · Capital pagado (Σ transferencias que entraron) = 120.000,00, clampeado
 *     a [0, 100.000] → 100.000,00 de cobertura; interés cubierto 0,00 (0%).
 *   · Cobertura 10/10 → sin próxima cuota; el plan no compromete más cuota.
 *   · DTI: el plan fresco compromete su cuota (10.000,00) desde el día uno
 *     (aunque venza después); cubierto el plan, deja de comprometer:
 *       mayo  (asOf 31/05) = base + 10.000,00
 *       junio (asOf 30/06) = base
 *   · Patrimonio: banco −120.000 y deuda −120.000 respecto del corte anterior
 *     → neto sin cambio (sólo se movió plata entre dos cuentas propias).
 *
 * Legado B: 5.000,00 al 0% en 3 cuotas sin primera fecha → sin serie de
 * vencimientos no hay cronograma: 0 filas, plan null, /pay 400.
 */

import {
  cents,
  centsToMoney,
  check,
  checkIncluye,
  checkTrue,
  crearCuenta,
  crearMovimiento,
  crearPrestamo,
  cuentaDe,
  deudaDelMes,
  get,
  pagarPrestamo,
  prestamoDe,
  runScript,
  section,
  sumItems,
} from "./helpers.mjs";

const TAG = "T_TESTER_F4_13";

runScript({
  tag: TAG,
  main: async (prisma) => {
    /** Transferencias que ENTRARON al préstamo (la definición de "capital pagado"). */
    const transferenciasHacia = (prestamoId) =>
      prisma.movement.count({
        where: { kind: "TRANSFER", toAccountId: prestamoId },
      });

    /** `despues − antes` como string canónico de dinero (centavos exactos). */
    const delta = (despues, antes) => centsToMoney(cents(despues) - cents(antes));

    const banco = await crearCuenta(`${TAG}_Banco`, "BANK", "0");
    check("alta del banco responde 201", banco.status, 201);
    const bancoId = banco.body?.id;

    // Las bases del DTI se toman ANTES de que exista el préstamo: así el
    // "vuelve a la base" se mide contra la misma foto, sin contaminación.
    const baseMayo = (await deudaDelMes("2028-05", "2028-05-31")).body?.debtReport
      ?.dti?.monthlyCommitment;
    const baseJunio = (await deudaDelMes("2028-06", "2028-06-30")).body?.debtReport
      ?.dti?.monthlyCommitment;
    checkTrue("hay base de compromiso en mayo", baseMayo !== undefined);
    checkTrue("hay base de compromiso en junio", baseJunio !== undefined);

    /* ────────────────────────────────────────────────────────────────────────
     * A — Sobrepago: la deuda negativa se muestra, no se clampa
     * ──────────────────────────────────────────────────────────────────────── */
    section("A · FRENCH 100.000/10 al 0% (primera 2028-06-10)");
    const sobr = await crearPrestamo({
      name: `${TAG}_Sobrepago`,
      kind: "LOAN",
      principal: "100000",
      tnaPercent: "0",
      installmentCount: 10,
      firstInstallmentDate: "2028-06-10",
      amortizationSystem: "FRENCH",
    });
    check("alta del préstamo responde 201", sobr.status, 201);
    const sobrId = sobr.body?.id;

    const desembolso = await crearMovimiento({
      kind: "TRANSFER",
      amount: "100000",
      date: "2028-05-01",
      accountId: sobrId,
      toAccountId: bancoId,
      description: `${TAG}_desembolso`,
    });
    check("desembolso responde 201", desembolso.status, 201);

    {
      // Foto previa al sobrepago: deuda viva completa.
      const vista = await get("/api/loans?asOf=2028-05-31");
      const mio = prestamoDe(vista, sobrId);
      checkTrue("la vista trae el préstamo", mio !== null);
      check("deuda viva 100.000,00", mio?.debt, "100000.00");
      check("saldo contable −100.000,00", mio?.balance, "-100000.00");
      check("capital pagado 0,00", mio?.capitalPaid, "0.00");
      check("progreso 0,00%", mio?.progressPercent, "0.00");
      check("plan: 0 de 10", mio?.plan?.paidCount, 0);
      check("la próxima es la 1 (10/06)", mio?.nextInstallment?.dueDate, "2028-06-10");

      const deudaMayo = await deudaDelMes("2028-05", "2028-05-31");
      const filaMayo = (deudaMayo.body?.debtReport?.rows ?? []).find(
        (fila) => fila.accountId === sobrId,
      );
      check("reporte de mayo: fila con la deuda viva", filaMayo?.debt, "100000.00");
      check(
        "reporte de mayo: el plan fresco compromete su cuota (base + 10.000)",
        deudaMayo.body?.debtReport?.dti?.monthlyCommitment,
        centsToMoney(cents(baseMayo) + 1000000n),
      );
    }

    // El sobrepago: 120.000 desde el banco, la mitad de nuevo (por fuera de /pay).
    const sobrepago = await crearMovimiento({
      kind: "TRANSFER",
      amount: "120000",
      date: "2028-06-01",
      accountId: bancoId,
      toAccountId: sobrId,
      description: `${TAG}_sobrepago`,
    });
    check("sobrepago responde 201", sobrepago.status, 201);

    {
      section("A1 · la deuda negativa viaja (vista, cuentas y reporte)");
      const vista = await get("/api/loans?asOf=2028-06-30");
      const mio = prestamoDe(vista, sobrId);
      checkTrue("la vista sigue trayendo el préstamo", mio !== null);
      check("saldo contable +20.000,00 (crédito a favor)", mio?.balance, "20000.00");
      check("deuda mostrada −20.000,00 (SIN clamp)", mio?.debt, "-20000.00");
      check("capital pagado clampeado: 100.000,00", mio?.capitalPaid, "100000.00");
      check("interés pagado 0,00", mio?.interestPaid, "0.00");
      check("progreso 100,00%", mio?.progressPercent, "100.00");
      check("plan: 10 de 10 cubiertas", mio?.plan?.paidCount, 10);
      check("plan: 0 restantes", mio?.plan?.remainingCount, 0);
      check("sin próxima cuota", mio?.nextInstallment, null);
      check(
        "la última cuota queda marcada como cubierta",
        mio?.installments?.[9]?.covered,
        true,
      );
      check(
        "el plan terminado ya no compromete (6 meses)",
        mio?.commitments?.next6Months,
        "0.00",
      );

      const cuenta = await cuentaDe(sobrId, "?asOf=2028-06-30");
      check("cuenta: balance +20.000,00", cuenta?.balance, "20000.00");
      check("cuenta: debt −20.000,00", cuenta?.debt, "-20000.00");
      check("cuenta: sigue siendo pasivo", cuenta?.isLiability, true);

      const bancoDato = await cuentaDe(bancoId, "?asOf=2028-06-30");
      check("banco: −20.000,00 (el sobrepago salió de ahí)", bancoDato?.balance, "-20000.00");

      const deudaJunio = await deudaDelMes("2028-06", "2028-06-30");
      const reporteJunio = deudaJunio.body?.debtReport;
      const fila = (reporteJunio?.rows ?? []).find(
        (fila) => fila.accountId === sobrId,
      );
      checkTrue("reporte de junio: la fila existe (no se esconde)", fila !== undefined);
      check("reporte de junio: deuda −20.000,00", fila?.debt, "-20000.00");
      check(
        "el total = Σ filas, negativo incluido",
        sumItems(reporteJunio?.rows ?? [], (f) => f.debt),
        reporteJunio?.totalDebt,
      );
      check(
        "el DTI de junio vuelve a la base (el plan cubierto no compromete)",
        reporteJunio?.dti?.monthlyCommitment,
        baseJunio,
      );
    }

    {
      section("A2 · el patrimonio no se mueve (banco y deuda, misma magnitud)");
      // Los cortes: 31/05 (desembolso hecho, sobrepago no) y 30/06 (después).
      const antes = (await get("/api/accounts?asOf=2028-05-31")).body?.netWorth;
      const despues = (await get("/api/accounts?asOf=2028-06-30")).body?.netWorth;
      check(
        "activos: −120.000,00 (salió del banco)",
        delta(despues?.assets, antes?.assets),
        "-120000.00",
      );
      check(
        "pasivos: −120.000,00 (la deuda bajó de más)",
        delta(despues?.liabilities, antes?.liabilities),
        "-120000.00",
      );
      check("patrimonio neto: sin cambio", delta(despues?.net, antes?.net), "0.00");
    }

    {
      section("A3 · /pay sobre un plan cubierto no escribe nada");
      const sinNumero = await pagarPrestamo({
        accountId: sobrId,
        cashAccountId: bancoId,
        date: "2028-07-05",
      });
      check("sin número: 200 idempotente", sinNumero.status, 200);
      check("created = false", sinNumero.body?.created, false);
      check("cancelled = false", sinNumero.body?.cancelled, false);
      check("sin cuota asociada", sinNumero.body?.installment, null);
      check("sin patas", sinNumero.body?.movements?.length, 0);

      const conNumero = await pagarPrestamo({
        accountId: sobrId,
        cashAccountId: bancoId,
        date: "2028-06-05",
        installmentNumber: 1,
      });
      check("con número ya cubierto: 200 idempotente", conNumero.status, 200);
      check("created = false", conNumero.body?.created, false);
      check("la cuota devuelta es la 1", conNumero.body?.installment?.number, 1);

      const cancelar = await pagarPrestamo({
        accountId: sobrId,
        cashAccountId: bancoId,
        date: "2028-07-05",
        cancel: true,
      });
      check("cancel: 200 idempotente", cancelar.status, 200);
      check("created = false", cancelar.body?.created, false);
      check("cancelled = false (no queda capital)", cancelar.body?.cancelled, false);
      check("sin patas", cancelar.body?.movements?.length, 0);

      check(
        "la única transferencia al préstamo sigue siendo el sobrepago",
        await transferenciasHacia(sobrId),
        1,
      );
      const filas = await prisma.installment.count({ where: { accountId: sobrId } });
      check("las 10 cuotas materializadas siguen intactas", filas, 10);
    }

    /* ────────────────────────────────────────────────────────────────────────
     * B — Legado sin primera fecha: sin cronograma, sin fantasmas
     * ──────────────────────────────────────────────────────────────────────── */
    section("B · legado sin firstInstallmentDate: /pay 400, sin escrituras");
    const legado = await prisma.account.create({
      data: {
        name: `${TAG}_Legado`,
        kind: "LOAN",
        principal: "5000.00",
        tnaPercent: "0.0000",
        installmentCount: 3,
        // firstInstallmentDate NULL a propósito: cuenta anterior a la fase.
        // Sin serie de vencimientos no hay cronograma que materializar.
      },
    });

    {
      const vista = await get("/api/loans?asOf=2029-06-30");
      check("la vista responde 200 igual", vista.status, 200);
      const mio = prestamoDe(vista, legado.id);
      checkTrue("el legado aparece", mio !== null);
      check("sin plan (no hay contrato fechado)", mio?.plan, null);
      check("sin capital pagado derivable", mio?.capitalPaid, null);
      check("sin interés pagado derivable", mio?.interestPaid, null);
      check("sin progreso", mio?.progressPercent, null);
      check("sin próxima cuota", mio?.nextInstallment, null);
      check("sin cuotas en la vista", mio?.installments?.length, 0);
      check("deuda 0,00 (no hay movimientos)", mio?.debt, "0.00");
      check("el sistema se lee como FRENCH", mio?.system, "FRENCH");
      check("sin fecha cargada", mio?.firstInstallmentDate, null);
      check("los parámetros declarados siguen visibles", mio?.installmentCount, 3);
    }

    {
      const cuota = await pagarPrestamo({
        accountId: legado.id,
        cashAccountId: bancoId,
        date: "2029-06-30",
        installmentNumber: 1,
      });
      check("pagar una cuota: 400", cuota.status, 400);
      checkIncluye("explica que no hay cronograma", cuota.body?.error, "no tiene cronograma");

      const cancelar = await pagarPrestamo({
        accountId: legado.id,
        cashAccountId: bancoId,
        date: "2029-06-30",
        cancel: true,
      });
      check("cancelar: 400", cancelar.status, 400);
      checkIncluye("mismo mensaje", cancelar.body?.error, "no tiene cronograma");

      check(
        "el intento de curación no materializó filas",
        await prisma.installment.count({ where: { accountId: legado.id } }),
        0,
      );
      check("no escribió movimientos", await transferenciasHacia(legado.id), 0);

      // Un GET más: el heal reintenta y sigue sin poder: la vista no se cae.
      const reintento = await get("/api/loans?asOf=2029-06-30");
      check("segundo GET: 200", reintento.status, 200);
      check("segundo GET: sigue sin plan", prestamoDe(reintento, legado.id)?.plan, null);
      check(
        "segundo GET: sigue sin filas",
        await prisma.installment.count({ where: { accountId: legado.id } }),
        0,
      );
    }
  },
});
