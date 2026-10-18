#!/usr/bin/env node
/**
 * 03 — El pago: orden, idempotencia, extra, cancelación anticipada y sistemas.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA (brief punto 4 + clase de ataque "doble ejecución")
 * ─────────────────────────────────────────────────────────────────────────────
 *   A. FRENCH normal: sólo la próxima impaga; "en orden" → 400; el reintento
 *      de la MISMA petición no escribe nada (200 created:false); una
 *      TRANSFER manual por fuera de /pay avanza el prefijo (documentado).
 *   B. Capital extra (el interés de la cuota NO cambia) y cancelación
 *      anticipada (capital restante, SIN interés, una sola pata); `cancel` no
 *      combina con cuota ni extra; pagar de más → 400 con el saldo exacto.
 *   C. Patas de $0 se omiten: cuota sin interés → UNA sola pata TRANSFER.
 *   D. Rotativo (INTEREST_ONLY): /pay rechaza cuotas; `cancel` paga todo el
 *      capital en una pata; `interestPaid` es null (no derivable); vencidos 0.
 *   E. AMERICAN (interés periódico + bullet): REPRO del hallazgo B1 — las
 *      cuotas de sólo interés no son "cubiertas" gratis, no se pagan por /pay
 *      (el interés del mes va como gasto manual) y el cierre es el bullet.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA ARITMÉTICA, A MANO (i = TNA/12, half-even a 2 decimales)
 * ─────────────────────────────────────────────────────────────────────────────
 * A y B — FRENCH (i = 5%):
 *   A 100.000/6:  cuota 19.701,75  → c1 5.000,00/14.701,75; c2 4.264,91/15.436,84;
 *                 c3 3.493,07/16.208,68; c4 2.682,64/17.019,11; c5 1.831,68/17.870,07;
 *                 c6 938,18/18.763,55 (pago 19.701,73: la última absorbe el resto).
 *   B 300.000/6:  cuota 59.105,24  → c1 15.000,00/44.105,24; c2 12.794,74/46.310,50;
 *                 c3 10.479,21/48.626,03; c4 8.047,91/51.057,33; c5 5.495,04/53.610,20;
 *                 c6 2.814,54/56.290,70.
 *   En B con extra de 100.000 en la c3: capital = 44.105,24+46.310,50+48.626,03+100.000
 *   = 239.041,77 → cubre 4 cuotas (Σ capital c1..c4 = 190.099,10 ≤ 239.041,77 <
 *   Σ c1..c5 = 243.709,30) → restante = 300.000 − 239.041,77 = 60.958,23.
 * C — FRENCH TNA 0% (i = 0): 100.000/3 → 33.333,33 + 33.333,33 + 33.333,34, interés 0.
 * D — INTEREST_ONLY 200.000 al 36% (i = 3%): interés = 6.000,00 por cuota; el
 *   capital nunca amortiza por contrato → cancelar paga 200.000,00 sin interés.
 * E — AMERICAN 100.000 al 24% (i = 2%): cuotas 1 y 2 = 2.000,00 de interés y
 *   capital 0; cuota 3 (el cierre) = 2.000,00 + 100.000,00 = 102.000,00.
 *   Con la semántica arreglada: cobertura 0/3 hasta el cierre, interestPaid
 *   null (el interés de los meses 1 y 2 se registra como GASTO manual, no es
 *   derivable del saldo) y compromisos = 2.000 + 2.000 + 102.000 = 106.000,00.
 */

import {
  cents,
  check,
  checkDeep,
  checkIncluye,
  checkTrue,
  crearCuenta,
  crearMovimiento,
  crearPrestamo,
  cuentaDe,
  get,
  pagarPrestamo,
  prestamoDe,
  reconciliacion,
  runScript,
  section,
} from "./helpers.mjs";

const TAG = "T_TESTER_F4_03";

runScript({
  tag: TAG,
  main: async (prisma) => {
    /** Transferencias que ENTRARON al préstamo (la definición de "capital pagado"). */
    const transferenciasHacia = (prestamoId) =>
      prisma.movement.count({
        where: { kind: "TRANSFER", toAccountId: prestamoId },
      });

    const banco = await crearCuenta(`${TAG}_Banco`, "BANK", "0");
    check("alta del banco responde 201", banco.status, 201);
    const bancoId = banco.body?.id;

    /* ────────────────────────────────────────────────────────────────────────
     * A — FRENCH: orden, idempotencia del reintento, transferencia manual
     * ──────────────────────────────────────────────────────────────────────── */
    section("A · FRENCH 100.000 al 60% en 6 cuotas (primera 2028-05-10)");
    const prestamoA = await crearPrestamo({
      name: `${TAG}_A`,
      kind: "LOAN",
      principal: "100000",
      tnaPercent: "60",
      installmentCount: 6,
      firstInstallmentDate: "2028-05-10",
      amortizationSystem: "FRENCH",
    });
    check("alta del préstamo A responde 201", prestamoA.status, 201);
    const aId = prestamoA.body?.id;

    const desembolsoA = await crearMovimiento({
      kind: "TRANSFER",
      amount: "100000",
      date: "2028-05-01",
      accountId: aId,
      toAccountId: bancoId,
      description: `${TAG}_A desembolso`,
    });
    check("desembolso de A responde 201", desembolsoA.status, 201);

    {
      const vista = await get("/api/loans?asOf=2028-05-01");
      const mio = prestamoDe(vista, aId);
      checkTrue("la vista fresca trae el préstamo A", mio !== null);
      check("sistema FRENCH", mio?.system, "FRENCH");
      check("dirección I_OWE", mio?.direction, "I_OWE");
      check("capital pagado 0,00", mio?.capitalPaid, "0.00");
      check("interés pagado 0,00", mio?.interestPaid, "0.00");
      check("progreso 0,00%", mio?.progressPercent, "0.00");
      check("plan: cuota 19.701,75", mio?.plan?.payment, "19701.75");
      check("plan: 0 pagadas", mio?.plan?.paidCount, 0);
      check("plan: 6 restantes", mio?.plan?.remainingCount, 6);
      check("la próxima cuota es la 1", mio?.nextInstallment?.number, 1);
      check(
        "la última del cronograma absorbe el redondeo: pago 19.701,73",
        mio?.installments?.[5]?.payment,
        "19701.73",
      );
      check(
        "la cuota 1 es 5.000,00 de interés + 14.701,75 de capital",
        `${mio?.installments?.[0]?.interest}/${mio?.installments?.[0]?.principal}`,
        "5000.00/14701.75",
      );
    }

    // Saltarse cuotas no se puede: la cobertura es un prefijo, no un set.
    const salteada = await pagarPrestamo({
      accountId: aId,
      cashAccountId: bancoId,
      date: "2028-05-10",
      installmentNumber: 3,
    });
    check("pagar la 3 con la 1 pendiente: 400", salteada.status, 400);
    checkIncluye("explica el orden", salteada.body?.error, "en orden");
    checkIncluye("dice cuál es la próxima", salteada.body?.error, "la 1 de 6");
    check(
      "no escribió ninguna transferencia",
      await transferenciasHacia(aId),
      0,
    );

    // La cuota 1: dos patas exactas.
    const pagoA1 = await pagarPrestamo({
      accountId: aId,
      cashAccountId: bancoId,
      date: "2028-05-10",
    });
    check("pagar la próxima (sin número) responde 201", pagoA1.status, 201);
    check("created = true", pagoA1.body?.created, true);
    check("la cuota pagada es la 1", pagoA1.body?.installment?.number, 1);
    check("capital 14.701,75", pagoA1.body?.principalPaid, "14701.75");
    check("interés 5.000,00", pagoA1.body?.interestPaid, "5000.00");
    check("dos patas", pagoA1.body?.movements?.length, 2);
    check(
      "pata TRANSFER 14.701,75 hacia el préstamo",
      `${pagoA1.body?.movements?.[0]?.kind}/${pagoA1.body?.movements?.[0]?.amount}/${pagoA1.body?.movements?.[0]?.toAccount?.id === aId}`,
      "TRANSFER/14701.75/true",
    );
    check(
      "pata EXPENSE 5.000,00 de interés",
      `${pagoA1.body?.movements?.[1]?.kind}/${pagoA1.body?.movements?.[1]?.amount}`,
      "EXPENSE/5000.00",
    );
    check("una sola transferencia escrita", await transferenciasHacia(aId), 1);

    // REINTENTO de la MISMA petición (sin número): no puede pagar la 2.
    // [REPRO B2] Hoy: expected = cubiertas+1 = 2 y el reintento paga la cuota 2.
    const reintentoA = await pagarPrestamo({
      accountId: aId,
      cashAccountId: bancoId,
      date: "2028-05-10",
    });
    check("el reintento responde 200 (idempotente)", reintentoA.status, 200);
    check("created = false", reintentoA.body?.created, false);
    check("sin movimientos nuevos", reintentoA.body?.movements?.length, 0);
    check("sin cuota nueva", reintentoA.body?.installment, null);
    check(
      "sin transferencia nueva (sigue habiendo 1)",
      await transferenciasHacia(aId),
      1,
    );

    // La cuota 2 con número explícito: sí se paga (ya venció a esa fecha).
    const pagoA2 = await pagarPrestamo({
      accountId: aId,
      cashAccountId: bancoId,
      date: "2028-06-10",
      installmentNumber: 2,
    });
    check("pagar la 2 explícita responde 201", pagoA2.status, 201);
    check("capital de la 2: 15.436,84", pagoA2.body?.principalPaid, "15436.84");
    check("interés de la 2: 4.264,91", pagoA2.body?.interestPaid, "4264.91");

    const reintentoA2 = await pagarPrestamo({
      accountId: aId,
      cashAccountId: bancoId,
      date: "2028-06-10",
      installmentNumber: 2,
    });
    check("reintento de la 2: 200", reintentoA2.status, 200);
    check("created = false", reintentoA2.body?.created, false);
    check(
      "sigue habiendo 2 transferencias",
      await transferenciasHacia(aId),
      2,
    );

    // La 3 ya es la próxima impaga: mandar la 4 → 400.
    const saltoA = await pagarPrestamo({
      accountId: aId,
      cashAccountId: bancoId,
      date: "2028-07-10",
      installmentNumber: 4,
    });
    check("pagar la 4 con la 3 pendiente: 400", saltoA.status, 400);
    checkIncluye("dice cuál es la próxima", saltoA.body?.error, "la 3 de 6");

    const pagoA3 = await pagarPrestamo({
      accountId: aId,
      cashAccountId: bancoId,
      date: "2028-07-10",
    });
    check("pagar la 3 (sin número, a su vencimiento) responde 201", pagoA3.status, 201);
    check("capital de la 3: 16.208,68", pagoA3.body?.principalPaid, "16208.68");

    {
      const vista = await get("/api/loans?asOf=2028-07-31");
      const mio = prestamoDe(vista, aId);
      check(
        "capital pagado 46.347,27 (14.701,75+15.436,84+16.208,68)",
        mio?.capitalPaid,
        "46347.27",
      );
      check(
        "interés pagado 12.757,98 (Σ de las 3 cubiertas)",
        mio?.interestPaid,
        "12757.98",
      );
      check("progreso 46,35%", mio?.progressPercent, "46.35");
      check("plan: 3 pagadas", mio?.plan?.paidCount, 3);
      check("plan: 3 restantes", mio?.plan?.remainingCount, 3);
      check("la próxima es la 4", mio?.nextInstallment?.number, 4);
      check("la 4 vence el 2028-08-10", mio?.nextInstallment?.dueDate, "2028-08-10");
      check("deuda viva 53.652,73 (100.000 − 46.347,27)", mio?.debt, "53652.73");
    }

    // Una TRANSFER a mano por fuera de /pay también avanza el prefijo: la
    // cobertura se DERIVA de la plata, no de una tabla de pagos (documentado).
    const manualA = await crearMovimiento({
      kind: "TRANSFER",
      amount: "17019.11", // el capital de la cuota 4
      date: "2028-07-20",
      accountId: bancoId,
      toAccountId: aId,
      description: `${TAG}_A amortización manual`,
    });
    check("la transferencia manual responde 201", manualA.status, 201);

    {
      const vista = await get("/api/loans?asOf=2028-07-31");
      const mio = prestamoDe(vista, aId);
      check(
        "la manual completa el capital de la cuota 4: 63.366,38",
        mio?.capitalPaid,
        "63366.38",
      );
      check("la cobertura avanza a 4 (el prefijo es de platas)", mio?.plan?.paidCount, 4);
      check("la próxima impaga es la 5", mio?.nextInstallment?.number, 5);
      check(
        "el interés derivado incluye la 4: 15.440,62",
        mio?.interestPaid,
        "15440.62",
      );
      check("progreso 63,37%", mio?.progressPercent, "63.37");
      check("deuda viva 36.633,62", mio?.debt, "36633.62");
    }

    const saltoManual = await pagarPrestamo({
      accountId: aId,
      cashAccountId: bancoId,
      date: "2028-08-10",
      installmentNumber: 6,
    });
    check(
      "tras la manual, /pay sigue pidiendo la 5: 400",
      saltoManual.status,
      400,
    );
    checkIncluye("y lo dice", saltoManual.body?.error, "la 5 de 6");

    // Reportes de mayo: pagar sube Gastos SÓLO por el interés (5.000,00).
    section("A · los números del mes (2028-05)");
    {
      const rep = await get("/api/reports?from=2028-05-01&to=2028-05-31");
      check("ingresos 0,00", rep.body?.totals?.income, "0.00");
      check("gastos 5.000,00 (sólo el interés)", rep.body?.totals?.expenses, "5000.00");
      check(
        "transferencias 114.701,75 (desembolso + capital de la 1)",
        rep.body?.totals?.transfers,
        "114701.75",
      );
      check(
        "flujo de caja 80.298,25 (100.000 − 14.701,75 − 5.000)",
        rep.body?.totals?.cashFlow,
        "80298.25",
      );

      const rec = await reconciliacion("2028-05", "2028-05-31");
      check("ΔPatrimonio −5.000,00 (sólo el interés)", rec.body?.reconciliation?.netDelta, "-5000.00");
      check("Ahorro −5.000,00", rec.body?.reconciliation?.saving, "-5000.00");
      check("diferencia 0,00", rec.body?.reconciliation?.difference, "0.00");
    }

    /* ────────────────────────────────────────────────────────────────────────
     * B — FRENCH: capital extra y cancelación anticipada
     * ──────────────────────────────────────────────────────────────────────── */
    section("B · FRENCH 300.000 al 60% en 6 cuotas (primera 2028-09-10)");
    const prestamoB = await crearPrestamo({
      name: `${TAG}_B`,
      kind: "LOAN",
      principal: "300000",
      tnaPercent: "60",
      installmentCount: 6,
      firstInstallmentDate: "2028-09-10",
      amortizationSystem: "FRENCH",
    });
    check("alta del préstamo B responde 201", prestamoB.status, 201);
    const bId = prestamoB.body?.id;

    const desembolsoB = await crearMovimiento({
      kind: "TRANSFER",
      amount: "300000",
      date: "2028-09-01",
      accountId: bId,
      toAccountId: bancoId,
      description: `${TAG}_B desembolso`,
    });
    check("desembolso de B responde 201", desembolsoB.status, 201);

    const pagoB1 = await pagarPrestamo({
      accountId: bId,
      cashAccountId: bancoId,
      date: "2028-09-10",
    });
    check("cuota 1 responde 201", pagoB1.status, 201);
    check(
      "capital 44.105,24 / interés 15.000,00",
      `${pagoB1.body?.principalPaid}/${pagoB1.body?.interestPaid}`,
      "44105.24/15000.00",
    );

    const pagoB2 = await pagarPrestamo({
      accountId: bId,
      cashAccountId: bancoId,
      date: "2028-10-10",
      installmentNumber: 2,
    });
    check("cuota 2 responde 201", pagoB2.status, 201);
    check(
      "capital 46.310,50 / interés 12.794,74",
      `${pagoB2.body?.principalPaid}/${pagoB2.body?.interestPaid}`,
      "46310.50/12794.74",
    );

    // Cuota 3 + 100.000 de capital extra: el interés de la cuota NO cambia.
    const pagoB3 = await pagarPrestamo({
      accountId: bId,
      cashAccountId: bancoId,
      date: "2028-11-10",
      installmentNumber: 3,
      extraCapital: "100000",
    });
    check("cuota 3 con extra responde 201", pagoB3.status, 201);
    check(
      "capital del pago 148.626,03 (48.626,03 + 100.000)",
      pagoB3.body?.principalPaid,
      "148626.03",
    );
    check(
      "interés del pago 10.479,21 (el de la cuota: NO se recalcula)",
      pagoB3.body?.interestPaid,
      "10479.21",
    );
    check("dos patas (capital + interés)", pagoB3.body?.movements?.length, 2);

    {
      const vista = await get("/api/loans?asOf=2028-11-30");
      const mio = prestamoDe(vista, bId);
      check(
        "capital acumulado 239.041,77 (44.105,24+46.310,50+48.626,03+100.000)",
        mio?.capitalPaid,
        "239041.77",
      );
      check("el extra cubrió una cuota más: 4/6", mio?.plan?.paidCount, 4);
      check("restan 2", mio?.plan?.remainingCount, 2);
      check("progreso 79,68%", mio?.progressPercent, "79.68");
      check(
        "interés derivado 46.321,86 (Σ c1..c4)",
        mio?.interestPaid,
        "46321.86",
      );
      check("la próxima es la 5 (2028-12-10)", mio?.nextInstallment?.number, 5);
      check("saldo restante exacto 60.958,23", mio?.debt, "60958.23");
      check(
        "compromisos: c5 + c6 = 118.210,48",
        mio?.commitments?.next6Months,
        "118210.48",
      );
      check(
        "los 12 meses comprometen lo mismo (c5 + c6)",
        mio?.commitments?.next12Months,
        "118210.48",
      );
      check("nada vencido", mio?.commitments?.overdue, "0.00");
    }

    // Cancelar no combina con cuota ni con extra.
    const cancelConCuota = await pagarPrestamo({
      accountId: bId,
      cashAccountId: bancoId,
      date: "2028-11-20",
      installmentNumber: 5,
      cancel: true,
    });
    check("cancel + cuota → 400", cancelConCuota.status, 400);
    checkIncluye(
      "explica que no se combinan",
      cancelConCuota.body?.error,
      "no se combina",
    );
    const cancelConExtra = await pagarPrestamo({
      accountId: bId,
      cashAccountId: bancoId,
      date: "2028-11-20",
      extraCapital: "1000",
      cancel: true,
    });
    check("cancel + extra → 400", cancelConExtra.status, 400);
    checkIncluye(
      "explica que no se combinan",
      cancelConExtra.body?.error,
      "no se combina",
    );

    // Pagar de más: el capital del pago no puede superar el saldo restante.
    const deMasB = await pagarPrestamo({
      accountId: bId,
      cashAccountId: bancoId,
      date: "2028-12-10",
      installmentNumber: 5,
      extraCapital: "20000",
    });
    check("cuota 5 + extra 20.000 (53.610,20+20.000 > 60.958,23): 400", deMasB.status, 400);
    checkIncluye("dice el saldo exacto", deMasB.body?.error, "60958.23");
    checkIncluye("guía a la cancelación", deMasB.body?.error, "cancelación");
    check(
      "no escribió nada",
      await transferenciasHacia(bId),
      3,
    );

    // Cancelación: capital restante, SIN interés, UNA pata.
    const cancelB = await pagarPrestamo({
      accountId: bId,
      cashAccountId: bancoId,
      date: "2028-11-20",
      cancel: true,
    });
    check("cancelar responde 201", cancelB.status, 201);
    check("created = true", cancelB.body?.created, true);
    check("cancelled = true", cancelB.body?.cancelled, true);
    check("cancela 60.958,23", cancelB.body?.principalPaid, "60958.23");
    check("sin interés en la cancelación", cancelB.body?.interestPaid, null);
    check("sin cuota asociada", cancelB.body?.installment, null);
    check("una sola pata", cancelB.body?.movements?.length, 1);
    check(
      "la pata es TRANSFER 60.958,23 banco → préstamo",
      `${cancelB.body?.movements?.[0]?.kind}/${cancelB.body?.movements?.[0]?.amount}/${cancelB.body?.movements?.[0]?.account?.id === bancoId}/${cancelB.body?.movements?.[0]?.toAccount?.id === bId}`,
      "TRANSFER/60958.23/true/true",
    );
    check(
      "con la descripción de cancelación",
      cancelB.body?.movements?.[0]?.description,
      "Cancelación anticipada · capital",
    );

    {
      const vista = await get("/api/loans?asOf=2028-11-30");
      const mio = prestamoDe(vista, bId);
      check("capital pagado 300.000,00", mio?.capitalPaid, "300000.00");
      check("progreso 100,00%", mio?.progressPercent, "100.00");
      check("plan: 6 pagadas", mio?.plan?.paidCount, 6);
      check("plan: 0 restantes", mio?.plan?.remainingCount, 0);
      check("sin próxima cuota", mio?.nextInstallment, null);
      check("deuda 0,00", mio?.debt, "0.00");
      check("saldo contable 0,00", mio?.balance, "0.00");
      check(
        "interés derivado: Σ de las 6 cuotas = 54.631,44",
        mio?.interestPaid,
        "54631.44",
      );
      check("compromisos 0,00", mio?.commitments?.next12Months, "0.00");
    }

    const recancelar = await pagarPrestamo({
      accountId: bId,
      cashAccountId: bancoId,
      date: "2028-11-21",
      cancel: true,
    });
    check("cancelar dos veces: 200", recancelar.status, 200);
    check("created = false", recancelar.body?.created, false);
    check("cancelled = false (no fue una cancelación nueva)", recancelar.body?.cancelled, false);

    const pagoPostCierre = await pagarPrestamo({
      accountId: bId,
      cashAccountId: bancoId,
      date: "2028-12-10",
    });
    check("pagar una cuota con el préstamo cerrado: 200", pagoPostCierre.status, 200);
    check("created = false", pagoPostCierre.body?.created, false);
    check(
      "sigue habiendo 4 transferencias (3 pagos + la cancelación)",
      await transferenciasHacia(bId),
      4,
    );

    section("B · los números del mes (2028-11)");
    {
      const rep = await get("/api/reports?from=2028-11-01&to=2028-11-30");
      check("gastos 10.479,21 (sólo el interés de la cuota 3)", rep.body?.totals?.expenses, "10479.21");
      check(
        "transferencias 209.584,26 (148.626,03 + 60.958,23)",
        rep.body?.totals?.transfers,
        "209584.26",
      );
      check(
        "flujo de caja −220.063,47",
        rep.body?.totals?.cashFlow,
        "-220063.47",
      );

      const rec = await reconciliacion("2028-11", "2028-11-30");
      check("ΔPatrimonio −10.479,21 (sólo el interés)", rec.body?.reconciliation?.netDelta, "-10479.21");
      check("Ahorro −10.479,21", rec.body?.reconciliation?.saving, "-10479.21");
      check("diferencia 0,00", rec.body?.reconciliation?.difference, "0.00");
    }

    /* ────────────────────────────────────────────────────────────────────────
     * C — Patas de $0 se omiten (FRENCH sin interés)
     * ──────────────────────────────────────────────────────────────────────── */
    section("C · FRENCH 100.000 al 0% en 3 cuotas (primera 2029-01-20)");
    const prestamoC = await crearPrestamo({
      name: `${TAG}_C`,
      kind: "LOAN",
      principal: "100000",
      tnaPercent: "0",
      installmentCount: 3,
      firstInstallmentDate: "2029-01-20",
      amortizationSystem: "FRENCH",
    });
    check("alta del préstamo C responde 201", prestamoC.status, 201);
    const cId = prestamoC.body?.id;

    const desembolsoC = await crearMovimiento({
      kind: "TRANSFER",
      amount: "100000",
      date: "2029-01-15",
      accountId: cId,
      toAccountId: bancoId,
      description: `${TAG}_C desembolso`,
    });
    check("desembolso de C responde 201", desembolsoC.status, 201);

    const pagoC1 = await pagarPrestamo({
      accountId: cId,
      cashAccountId: bancoId,
      date: "2029-01-20",
    });
    check("cuota 1 responde 201", pagoC1.status, 201);
    check("capital 33.333,33", pagoC1.body?.principalPaid, "33333.33");
    check("interés 0,00", pagoC1.body?.interestPaid, "0.00");
    check("una SOLA pata: la de interés de $0 se omite", pagoC1.body?.movements?.length, 1);
    check("y es la TRANSFER del capital", pagoC1.body?.movements?.[0]?.kind, "TRANSFER");

    const pagoC2 = await pagarPrestamo({
      accountId: cId,
      cashAccountId: bancoId,
      date: "2029-02-20",
      installmentNumber: 2,
    });
    check("cuota 2 responde 201", pagoC2.status, 201);
    check("capital 33.333,33", pagoC2.body?.principalPaid, "33333.33");

    const pagoC3 = await pagarPrestamo({
      accountId: cId,
      cashAccountId: bancoId,
      date: "2029-03-20",
      installmentNumber: 3,
    });
    check("cuota 3 responde 201", pagoC3.status, 201);
    check("la última absorbe el resto: 33.333,34", pagoC3.body?.principalPaid, "33333.34");

    {
      const vista = await get("/api/loans?asOf=2029-03-31");
      const mio = prestamoDe(vista, cId);
      check("capital pagado 100.000,00", mio?.capitalPaid, "100000.00");
      check("interés pagado 0,00 (no 0,02 ni null)", mio?.interestPaid, "0.00");
      check("progreso 100,00%", mio?.progressPercent, "100.00");
      check("deuda 0,00", mio?.debt, "0.00");
      check("sin próxima cuota", mio?.nextInstallment, null);
    }

    {
      const rep = await get("/api/reports?from=2029-01-01&to=2029-01-31");
      check("enero: ingresos 0,00", rep.body?.totals?.income, "0.00");
      check("enero: gastos 0,00", rep.body?.totals?.expenses, "0.00");
      check("enero: ningún gasto", rep.body?.totals?.expenseCount, 0);
      check(
        "enero: transferencias 133.333,33 (desembolso + cuota 1)",
        rep.body?.totals?.transfers,
        "133333.33",
      );

      const repMar = await get("/api/reports?from=2029-03-01&to=2029-03-31");
      check("marzo: gastos 0,00", repMar.body?.totals?.expenses, "0.00");
      check("marzo: transferencias 33.333,34", repMar.body?.totals?.transfers, "33333.34");
      check("marzo: flujo de caja −33.333,34", repMar.body?.totals?.cashFlow, "-33333.34");
    }

    /* ────────────────────────────────────────────────────────────────────────
     * D — INTEREST_ONLY: el rotativo
     * ──────────────────────────────────────────────────────────────────────── */
    section("D · INTEREST_ONLY 200.000 al 36% en 6 cuotas (primera 2029-05-25)");
    const prestamoD = await crearPrestamo({
      name: `${TAG}_D`,
      kind: "LOAN",
      principal: "200000",
      tnaPercent: "36",
      installmentCount: 6,
      firstInstallmentDate: "2029-05-25",
      amortizationSystem: "INTEREST_ONLY",
    });
    check("alta del préstamo D responde 201", prestamoD.status, 201);
    const dId = prestamoD.body?.id;

    const desembolsoD = await crearMovimiento({
      kind: "TRANSFER",
      amount: "200000",
      date: "2029-05-20",
      accountId: dId,
      toAccountId: bancoId,
      description: `${TAG}_D desembolso`,
    });
    check("desembolso de D responde 201", desembolsoD.status, 201);

    {
      const vista = await get("/api/loans?asOf=2029-05-01");
      const mio = prestamoDe(vista, dId);
      check("sistema INTEREST_ONLY", mio?.system, "INTEREST_ONLY");
      check("cuota 6.000,00 (sólo interés)", mio?.plan?.payment, "6000.00");
      check("6 cuotas", mio?.plan?.installmentCount, 6);
      check("capital pagado 0,00", mio?.capitalPaid, "0.00");
      check("interés pagado null (no derivable)", mio?.interestPaid, null);
      check("progreso 0,00%", mio?.progressPercent, "0.00");
      check("sin próxima cuota pagable por la ruta", mio?.nextInstallment, null);
      check(
        "compromisos: 6 × 6.000,00 = 36.000,00",
        mio?.commitments?.next12Months,
        "36000.00",
      );
      check("vencidos 0,00 (no hay fuente de verdad)", mio?.commitments?.overdue, "0.00");
      check("cuotas vencidas 0", mio?.commitments?.overdueCount, 0);
    }

    const pagoD = await pagarPrestamo({
      accountId: dId,
      cashAccountId: bancoId,
      date: "2029-05-25",
    });
    check("pagar una cuota de un rotativo: 400", pagoD.status, 400);
    checkIncluye("explica por qué", pagoD.body?.error, "solo interés");
    checkIncluye("y qué hacer", pagoD.body?.error, "gasto");
    const pagoD2 = await pagarPrestamo({
      accountId: dId,
      cashAccountId: bancoId,
      date: "2029-05-25",
      installmentNumber: 1,
    });
    check("tampoco con número explícito: 400", pagoD2.status, 400);
    check("no escribió nada", await transferenciasHacia(dId), 0);

    const cancelD = await pagarPrestamo({
      accountId: dId,
      cashAccountId: bancoId,
      date: "2029-05-28",
      cancel: true,
    });
    check("cancelar el rotativo responde 201", cancelD.status, 201);
    check("cancelled = true", cancelD.body?.cancelled, true);
    check("paga el capital entero: 200.000,00", cancelD.body?.principalPaid, "200000.00");
    check("sin interés", cancelD.body?.interestPaid, null);
    check("una sola pata", cancelD.body?.movements?.length, 1);
    check(
      "TRANSFER 200.000,00 banco → préstamo",
      `${cancelD.body?.movements?.[0]?.kind}/${cancelD.body?.movements?.[0]?.amount}/${cancelD.body?.movements?.[0]?.toAccount?.id === dId}`,
      "TRANSFER/200000.00/true",
    );

    {
      const vista = await get("/api/loans?asOf=2029-05-31");
      const mio = prestamoDe(vista, dId);
      check("capital pagado 200.000,00", mio?.capitalPaid, "200000.00");
      check("interés pagado null (sigue sin derivarse)", mio?.interestPaid, null);
      check("progreso 100,00%", mio?.progressPercent, "100.00");
      check("plan: 6/6 (cancelado)", mio?.plan?.paidCount, 6);
      check("sin próxima cuota", mio?.nextInstallment, null);
      check("deuda 0,00", mio?.debt, "0.00");
      check("compromisos 0,00 (todo cubierto)", mio?.commitments?.next12Months, "0.00");
      check("vencidos 0,00", mio?.commitments?.overdue, "0.00");
    }

    const recancelarD = await pagarPrestamo({
      accountId: dId,
      cashAccountId: bancoId,
      date: "2029-05-29",
      cancel: true,
    });
    check("re-cancelar: 200", recancelarD.status, 200);
    check("created = false", recancelarD.body?.created, false);
    const postCierreD = await pagarPrestamo({
      accountId: dId,
      cashAccountId: bancoId,
      date: "2029-06-25",
    });
    check("pagar después de cancelar: 400 (rotativo)", postCierreD.status, 400);

    /* ────────────────────────────────────────────────────────────────────────
     * E — AMERICAN: el repro del hallazgo B1
     * ──────────────────────────────────────────────────────────────────────── */
    section("E · AMERICAN 100.000 al 24% en 3 cuotas (primera 2029-06-10)");
    const prestamoE = await crearPrestamo({
      name: `${TAG}_E`,
      kind: "LOAN",
      principal: "100000",
      tnaPercent: "24",
      installmentCount: 3,
      firstInstallmentDate: "2029-06-10",
      amortizationSystem: "AMERICAN",
    });
    check("alta del préstamo E responde 201", prestamoE.status, 201);
    const eId = prestamoE.body?.id;

    const desembolsoE = await crearMovimiento({
      kind: "TRANSFER",
      amount: "100000",
      date: "2029-06-01",
      accountId: eId,
      toAccountId: bancoId,
      description: `${TAG}_E desembolso`,
    });
    check("desembolso de E responde 201", desembolsoE.status, 201);

    // [REPRO B1] Fresco, sin un solo pago: la cobertura debe ser 0/3.
    {
      const vista = await get("/api/loans?asOf=2029-06-05");
      const mio = prestamoDe(vista, eId);
      check("sistema AMERICAN", mio?.system, "AMERICAN");
      check("FRESCO: capital pagado 0,00", mio?.capitalPaid, "0.00");
      check("FRESCO: progreso 0,00%", mio?.progressPercent, "0.00");
      check("FRESCO: 0 de 3 cuotas cubiertas", mio?.plan?.paidCount, 0);
      check("FRESCO: 3 restantes", mio?.plan?.remainingCount, 3);
      check(
        "FRESCO: interés pagado null (no derivable: va como gasto)",
        mio?.interestPaid,
        null,
      );
      check(
        "FRESCO: las cuotas de sólo interés NO están cubiertas",
        `${mio?.installments?.[0]?.covered}/${mio?.installments?.[1]?.covered}`,
        "false/false",
      );
      check(
        "la próxima cuota es el cierre (la 3)",
        mio?.nextInstallment?.number,
        3,
      );
      check(
        "el cierre vence el 2029-08-10",
        mio?.nextInstallment?.dueDate,
        "2029-08-10",
      );
      check("la cuota mostrada del plan es 2.000,00 (sólo interés)", mio?.plan?.payment, "2000.00");
      check(
        "el bullet paga 102.000,00",
        mio?.installments?.[2]?.payment,
        "102000.00",
      );
      check(
        "compromisos 6 meses 106.000,00 (2.000 + 2.000 + 102.000)",
        mio?.commitments?.next6Months,
        "106000.00",
      );
      check(
        "compromisos 12 meses 106.000,00",
        mio?.commitments?.next12Months,
        "106000.00",
      );
      check("sin vencidos todavía", mio?.commitments?.overdue, "0.00");
      check("deuda viva 100.000,00", mio?.debt, "100000.00");
    }

    // Las cuotas de sólo interés NO se pagan por /pay: el interés del mes va
    // como gasto y el cierre es la última cuota.
    const pagoE1 = await pagarPrestamo({
      accountId: eId,
      cashAccountId: bancoId,
      date: "2029-06-10",
      installmentNumber: 1,
    });
    check("pagar la cuota 1 (sólo interés): 400", pagoE1.status, 400);
    checkIncluye("explica que es de solo interés", pagoE1.body?.error, "solo interés");
    checkIncluye("y cuál es el cierre", pagoE1.body?.error, "la cuota 3");
    check(
      "no escribió ninguna transferencia",
      await transferenciasHacia(eId),
      0,
    );

    const pagoE2 = await pagarPrestamo({
      accountId: eId,
      cashAccountId: bancoId,
      date: "2029-06-10",
      installmentNumber: 2,
    });
    check("pagar la cuota 2 (sólo interés): 400", pagoE2.status, 400);

    // Sin número: la próxima pagable es el cierre, que todavía no venció.
    const pagoENull = await pagarPrestamo({
      accountId: eId,
      cashAccountId: bancoId,
      date: "2029-06-10",
    });
    check("pagar sin número antes del cierre: 200 (nada vencido)", pagoENull.status, 200);
    check("created = false", pagoENull.body?.created, false);
    check("sin movimientos", pagoENull.body?.movements?.length, 0);
    check("sin cuota nueva", pagoENull.body?.installment, null);

    // El interés de los meses 1 y 2: gasto manual, como manda el contrato.
    const interesManual1 = await crearMovimiento({
      kind: "EXPENSE",
      amount: "2000",
      date: "2029-06-10",
      accountId: bancoId,
      categoryName: "Intereses",
      description: `${TAG}_E interés manual del mes 1`,
    });
    check("el interés manual del mes 1 responde 201", interesManual1.status, 201);
    const interesManual2 = await crearMovimiento({
      kind: "EXPENSE",
      amount: "2000",
      date: "2029-07-10",
      accountId: bancoId,
      categoryName: "Intereses",
      description: `${TAG}_E interés manual del mes 2`,
    });
    check("el interés manual del mes 2 responde 201", interesManual2.status, 201);

    {
      const vista = await get("/api/loans?asOf=2029-07-15");
      const mio = prestamoDe(vista, eId);
      check("sin pagos de cuota, sigue 0/3", mio?.plan?.paidCount, 0);
      check("interés pagado null (los gastos manuales no se derivan)", mio?.interestPaid, null);
      check("la próxima sigue siendo el cierre", mio?.nextInstallment?.number, 3);
      check(
        "compromisos desde julio: c2 + bullet = 104.000,00",
        mio?.commitments?.next12Months,
        "104000.00",
      );
      check(
        "la cuota 1 de junio, impaga, NO se declara vencida (no hay fuente)",
        mio?.commitments?.overdue,
        "0.00",
      );
      check("cuotas vencidas 0", mio?.commitments?.overdueCount, 0);
      check("deuda 100.000,00", mio?.debt, "100000.00");
    }

    // El cierre: 100.000 de capital + 2.000 de interés, en dos patas.
    const pagoE3 = await pagarPrestamo({
      accountId: eId,
      cashAccountId: bancoId,
      date: "2029-08-10",
      installmentNumber: 3,
    });
    check("pagar el cierre responde 201", pagoE3.status, 201);
    check("created = true", pagoE3.body?.created, true);
    check("la cuota es la 3", pagoE3.body?.installment?.number, 3);
    check("capital 100.000,00", pagoE3.body?.principalPaid, "100000.00");
    check("interés 2.000,00 (el del cierre)", pagoE3.body?.interestPaid, "2000.00");
    check("dos patas", pagoE3.body?.movements?.length, 2);
    check(
      "TRANSFER 100.000,00 hacia el préstamo",
      `${pagoE3.body?.movements?.[0]?.kind}/${pagoE3.body?.movements?.[0]?.amount}/${pagoE3.body?.movements?.[0]?.toAccount?.id === eId}`,
      "TRANSFER/100000.00/true",
    );
    check(
      "EXPENSE 2.000,00 de interés",
      `${pagoE3.body?.movements?.[1]?.kind}/${pagoE3.body?.movements?.[1]?.amount}`,
      "EXPENSE/2000.00",
    );

    {
      const vista = await get("/api/loans?asOf=2029-08-31");
      const mio = prestamoDe(vista, eId);
      check("CERRADO: capital pagado 100.000,00", mio?.capitalPaid, "100000.00");
      check("CERRADO: progreso 100,00%", mio?.progressPercent, "100.00");
      check("CERRADO: 3 de 3 cubiertas", mio?.plan?.paidCount, 3);
      check("CERRADO: 0 restantes", mio?.plan?.remainingCount, 0);
      check("CERRADO: sin próxima cuota", mio?.nextInstallment, null);
      check("CERRADO: deuda 0,00", mio?.debt, "0.00");
      check("CERRADO: saldo 0,00", mio?.balance, "0.00");
      check(
        "CERRADO: interés pagado null (NO 6.000,00: el gasto real fueron 3 × 2.000)",
        mio?.interestPaid,
        null,
      );
      check(
        "CERRADO: las 3 cuotas quedaron cubiertas",
        (mio?.installments ?? []).filter((f) => f.covered).length,
        3,
      );
      check("CERRADO: compromisos 0,00", mio?.commitments?.next12Months, "0.00");
    }

    const repeticionE = await pagarPrestamo({
      accountId: eId,
      cashAccountId: bancoId,
      date: "2029-08-31",
    });
    check("reintento sin número con el préstamo cerrado: 200", repeticionE.status, 200);
    check("created = false", repeticionE.body?.created, false);
    const repeticionE2 = await pagarPrestamo({
      accountId: eId,
      cashAccountId: bancoId,
      date: "2029-08-31",
      installmentNumber: 3,
    });
    check("reintento explícito del cierre: 200 created:false", repeticionE2.body?.created, false);
    check(
      "sigue habiendo 1 sola transferencia al préstamo",
      await transferenciasHacia(eId),
      1,
    );

    section("E · los números de los meses (interés como gasto, capital como transferencia)");
    {
      const repJun = await get("/api/reports?from=2029-06-01&to=2029-06-30");
      check(
        "junio: gastos 2.000,00 (el interés manual)",
        repJun.body?.totals?.expenses,
        "2000.00",
      );
      check(
        "junio: transferencias 100.000,00 (el desembolso)",
        repJun.body?.totals?.transfers,
        "100000.00",
      );
      check("junio: flujo de caja +98.000,00", repJun.body?.totals?.cashFlow, "98000.00");

      const repJul = await get("/api/reports?from=2029-07-01&to=2029-07-31");
      check("julio: gastos 2.000,00", repJul.body?.totals?.expenses, "2000.00");
      check("julio: transferencias 0,00", repJul.body?.totals?.transfers, "0.00");
      check("julio: flujo de caja −2.000,00", repJul.body?.totals?.cashFlow, "-2000.00");

      const repAgo = await get("/api/reports?from=2029-08-01&to=2029-08-31");
      check(
        "agosto: gastos 2.000,00 (el interés del cierre)",
        repAgo.body?.totals?.expenses,
        "2000.00",
      );
      check(
        "agosto: transferencias 100.000,00 (el capital del cierre)",
        repAgo.body?.totals?.transfers,
        "100000.00",
      );
      check("agosto: flujo de caja −102.000,00", repAgo.body?.totals?.cashFlow, "-102000.00");

      const recAgo = await reconciliacion("2029-08", "2029-08-31");
      check(
        "agosto: ΔPatrimonio −2.000,00 (sólo el interés)",
        recAgo.body?.reconciliation?.netDelta,
        "-2000.00",
      );
      check("agosto: Ahorro −2.000,00", recAgo.body?.reconciliation?.saving, "-2000.00");
      check("agosto: diferencia 0,00", recAgo.body?.reconciliation?.difference, "0.00");
    }

    /* ────────────────────────────────────────────────────────────────────────
     * Cierre: los préstamos de esta corrida no dejaron basura
     * ──────────────────────────────────────────────────────────────────────── */
    section("Verificación final de cuentas");
    {
      const bancoFinal = await cuentaDe(bancoId, "?asOf=2029-09-01");
      checkTrue("el banco sigue existiendo", bancoFinal !== null);
      for (const [nombre, id] of [
        ["A", aId],
        ["B", bId],
        ["C", cId],
        ["D", dId],
        ["E", eId],
      ]) {
        const cuenta = await cuentaDe(id, "?asOf=2029-09-01");
        check(`${nombre}: la cuenta sigue viva`, cuenta?.id, id);
      }
    }
  },
});
