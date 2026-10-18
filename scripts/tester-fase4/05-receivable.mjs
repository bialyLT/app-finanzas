#!/usr/bin/env node
/**
 * 05 — RECEIVABLE: la dirección del dinero invertida (me deben).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA (brief: préstamos en las dos direcciones)
 * ─────────────────────────────────────────────────────────────────────────────
 * Un préstamo DADO es lo mismo que un préstamo tomado con el signo al revés:
 * capital + tasa + cronograma. Lo que cambia es la dirección de cada pata y
 * —más importante— QUÉ es ingreso:
 *
 *   · El CAPITAL que te devuelven es una TRANSFERENCIA (de la cuenta por cobrar
 *     a tu cuenta de dinero): NO es ingreso. Si contara como ingreso, devolver
 *     plata que ya era tuya inflaría el "sueldo ganado" de la persona.
 *   · El INTERÉS que cobrás es un INGRESO real, y entra a la cuenta de DINERO
 *     (no a la por cobrar).
 *   · Un INGRESO cargado directamente en la cuenta por cobrar infla un activo
 *     sin que haya entrado un peso: la base lo rechaza con el trigger y la API
 *     lo explica con 400.
 *   · Un préstamo dado NO es deuda: no entra a `/api/debts` (ni a `totalDebt`
 *     ni al DTI) y suma como ACTIVO en el patrimonio.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA ARITMÉTICA, A MANO (i = 5% mensual, half-even)
 * ─────────────────────────────────────────────────────────────────────────────
 * RECEIVABLE 100.000/6 al 60% (cuota 19.701,75):
 *   c1 5.000,00/14.701,75   c2 4.264,91/15.436,84   c3 3.493,07/16.208,68
 *   c4 2.682,64/17.019,11   c5 1.831,68/17.870,07   c6 938,18/18.763,55
 * Desembolso (30/… no: 01/08): banco −100.000, por cobrar +100.000, neto Δ0.
 * Cobro de la c1 (10/08): por cobrar −14.701,75 (85298.25); banco
 *   −100.000 + 14.701,75 + 5.000,00 = −80.298,25. Neto Δ = +5.000,00 (sólo el
 *   interés: el capital no cambió el neto).
 * Cancelación (resto del capital, sin interés): por cobrar 0, banco +5.000,00.
 * El ingreso del mes del DTI es EXACTAMENTE 5.000,00: sólo el interés.
 */

import {
  check,
  checkDeep,
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
} from "./helpers.mjs";

const TAG = "T_TESTER_F4_05";

runScript({
  tag: TAG,
  main: async (prisma) => {
    const banco = await crearCuenta(`${TAG}_Banco`, "BANK", "0");
    check("alta del banco responde 201", banco.status, 201);
    const bancoId = banco.body?.id;

    const porCobrar = await crearPrestamo({
      name: `${TAG}_MeDeben`,
      kind: "RECEIVABLE",
      principal: "100000",
      tnaPercent: "60",
      installmentCount: 6,
      firstInstallmentDate: "2028-08-10",
      amortizationSystem: "FRENCH",
    });
    check("alta del préstamo dado responde 201", porCobrar.status, 201);
    const porCobrarId = porCobrar.body?.id;

    /* ────────────────────────────────────────────────────────────────────────
     * El "antes": las tres bases de comparación (deudas, cuentas, vista)
     * ──────────────────────────────────────────────────────────────────────── */
    section("Antes · las bases de comparación (delta = 0 antes de mover plata)");
    const deudasAntes = await deudaDelMes("2028-08", "2028-08-31");
    const cuentasAntes = await get("/api/accounts?asOf=2028-08-31");
    const netoAntes = cuentasAntes.body?.netWorth?.net;
    check("la base de deudas responde 200", deudasAntes.status, 200);
    check("la base de cuentas responde 200", cuentasAntes.status, 200);

    const deudaDe = (reporte, id) =>
      (reporte.body?.debtReport?.rows ?? []).find((f) => f.accountId === id) ?? null;

    /* ────────────────────────────────────────────────────────────────────────
     * El desembolso: TRANSFER banco → cuenta por cobrar (la plata sale)
     * ──────────────────────────────────────────────────────────────────────── */
    section("Desembolso · 01/08: banco → por cobrar por 100.000");
    {
      const desembolso = await crearMovimiento({
        kind: "TRANSFER",
        amount: "100000",
        date: "2028-08-01",
        accountId: bancoId,
        toAccountId: porCobrarId,
        description: `${TAG}_desembolso`,
      });
      check("el desembolso responde 201", desembolso.status, 201);

      const bancoDato = await cuentaDe(bancoId, "?asOf=2028-08-31");
      const cobrarDato = await cuentaDe(porCobrarId, "?asOf=2028-08-31");
      check("banco −100.000,00", bancoDato?.balance, "-100000.00");
      check("por cobrar +100.000,00 (activo)", cobrarDato?.balance, "100000.00");
      check("por cobrar NO es pasivo", cobrarDato?.isLiability, false);
      check("por cobrar no reporta deuda", cobrarDato?.debt, null);

      const deudas = await deudaDelMes("2028-08", "2028-08-31");
      check("el préstamo dado NO entra al reporte de deudas", deudaDe(deudas, porCobrarId), null);
      check(
        "totalDebt no cambió con el desembolso",
        deudas.body?.debtReport?.totalDebt,
        deudasAntes.body?.debtReport?.totalDebt,
      );

      const cuentas = await get("/api/accounts?asOf=2028-08-31");
      check(
        "el desembolso no cambia el patrimonio neto (mueve activos)",
        cuentas.body?.netWorth?.net,
        netoAntes,
      );
    }

    /* ────────────────────────────────────────────────────────────────────────
     * El cobro de la cuota 1: TRANSFER de capital + INCOME del interés
     * ──────────────────────────────────────────────────────────────────────── */
    section("Cobro · 10/08: la cuota 1 (5.000 de interés + 14.701,75 de capital)");
    {
      const cobro = await pagarPrestamo({
        accountId: porCobrarId,
        cashAccountId: bancoId,
        date: "2028-08-10",
      });
      check("cobrar la cuota 1 responde 201", cobro.status, 201);
      check("pagó la cuota 1", cobro.body?.installment?.number, 1);
      check("interés cobrado 5.000,00", cobro.body?.interestPaid, "5000.00");
      check("capital recuperado 14.701,75", cobro.body?.principalPaid, "14701.75");

      const patas = cobro.body?.movements ?? [];
      check("dos patas", patas.length, 2);

      const capital = patas[0];
      check("pata 1: TRANSFER", capital?.kind, "TRANSFER");
      check("pata 1: sale de la cuenta por cobrar", capital?.account?.id, porCobrarId);
      check("pata 1: entra al banco", capital?.toAccount?.id, bancoId);
      check("pata 1: monto 14.701,75", capital?.amount, "14701.75");
      check("pata 1: sin categoría (no es ingreso ni gasto)", capital?.category, null);

      const interes = patas[1];
      check("pata 2: INCOME (el interés SÍ es ingreso)", interes?.kind, "INCOME");
      check("pata 2: entra al banco (cuenta de dinero)", interes?.account?.id, bancoId);
      check("pata 2: sin cuenta de destino", interes?.toAccount, null);
      check("pata 2: monto 5.000,00", interes?.amount, "5000.00");
      check("pata 2: categoría Intereses", interes?.category?.name, "Intereses");
      // NOTA (diferido LOW, no criterio de la fase): el `kind` de la categoría
      // es el del primer uso del nombre — "Intereses" ya existía como EXPENSE
      // por los pagos de préstamos, así que el INCOME la reutiliza con kind
      // EXPENSE. Es el mismo patrón "primer nombre gana" del POST
      // /api/transactions desde la Fase 2 (upsert con update:{}); el impacto
      // es solo el filtro del modal de categorías (app/page.tsx:1235). El
      // CONTRATO de la fase (movimiento INCOME a la cuenta de dinero) se
      // cumple y se verifica arriba.

      const bancoDato = await cuentaDe(bancoId, "?asOf=2028-08-31");
      const cobrarDato = await cuentaDe(porCobrarId, "?asOf=2028-08-31");
      check(
        "banco: −100.000 + 14.701,75 + 5.000 = −80.298,25",
        bancoDato?.balance,
        "-80298.25",
      );
      check("por cobrar: 100.000 − 14.701,75 = 85.298,25", cobrarDato?.balance, "85298.25");

      const cuentas = await get("/api/accounts?asOf=2028-08-31");
      const netoDespues = cuentas.body?.netWorth?.net;
      // +5.000,00 exactos: el capital no movió el neto (sale del activo y entra
      // al banco), el interés SÍ (es plata nueva).
      const esperado = (BigInt(String(netoAntes).replace(".", "")) + 500000n)
        .toString();
      const esperadoStr = `${esperado.slice(0, -2)}.${esperado.slice(-2)}`;
      check(
        `el patrimonio sube SOLO el interés (${netoAntes} → ${esperadoStr})`,
        netoDespues,
        esperadoStr,
      );

      // La vista del préstamo: dirección, activo, progreso.
      const vista = await get("/api/loans?asOf=2028-08-10");
      const mio = prestamoDe(vista, porCobrarId);
      checkTrue("la vista trae el préstamo dado", mio !== null);
      check("dirección OWED_TO_ME", mio?.direction, "OWED_TO_ME");
      check("no es pasivo", mio?.isLiability, false);
      check("no reporta deuda", mio?.debt, null);
      check("reporta lo por cobrar 85.298,25", mio?.receivable, "85298.25");
      check("capital recuperado 14.701,75", mio?.capitalPaid, "14701.75");
      check("interés cobrado 5.000,00", mio?.interestPaid, "5000.00");
      check("progreso 14,70%", mio?.progressPercent, "14.70");
      check("cobertura 1 de 6", mio?.plan?.paidCount, 1);
      check("restantes 5", mio?.plan?.remainingCount, 5);

      // El reporte de deudas: el ingreso del mes es SÓLO el interés.
      const deudas = await deudaDelMes("2028-08", "2028-08-31");
      const reporte = deudas.body?.debtReport;
      check("totalDebt sigue sin contar el préstamo dado", reporte?.totalDebt, deudasAntes.body?.debtReport?.totalDebt);
      check(
        "el DTI no compromete nada del préstamo dado",
        reporte?.dti?.monthlyCommitment,
        deudasAntes.body?.debtReport?.dti?.monthlyCommitment,
      );
      check(
        "el planCount del DTI tampoco cambia",
        reporte?.dti?.planCount,
        deudasAntes.body?.debtReport?.dti?.planCount,
      );
      check(
        "el ingreso del mes del DTI es EXACTAMENTE el interés (5.000,00)",
        reporte?.dti?.income,
        "5000.00",
      );
    }

    /* ────────────────────────────────────────────────────────────────────────
     * Hostil: un INGRESO cargado en la cuenta por cobrar
     * ──────────────────────────────────────────────────────────────────────── */
    section("Hostil · INCOME directo a la cuenta por cobrar");
    {
      const ingreso = await crearMovimiento({
        kind: "INCOME",
        amount: "1000",
        date: "2028-08-20",
        accountId: porCobrarId,
        categoryName: `${TAG} inventado`,
      });
      check("responde 400 (no 500)", ingreso.status, 400);
      checkIncluye(
        "explica que el interés va a la cuenta de dinero",
        ingreso.body?.error,
        "el interés cobrado es un ingreso, pero entra a tu cuenta de dinero",
      );
      check(
        "no se escribió ningún INGRESO en la cuenta por cobrar",
        await prisma.movement.count({
          where: { accountId: porCobrarId, kind: "INCOME" },
        }),
        0,
      );
      check(
        "la categoría del ingreso rechazado se deshizo con la transacción",
        await prisma.category.count({ where: { name: { startsWith: TAG } } }),
        0,
      );
    }

    /* ────────────────────────────────────────────────────────────────────────
     * Cancelación del préstamo dado: sin interés, una sola pata
     * ──────────────────────────────────────────────────────────────────────── */
    section("Cancelación · el resto del capital vuelve, sin interés");
    {
      const cancelacion = await pagarPrestamo({
        accountId: porCobrarId,
        cashAccountId: bancoId,
        date: "2028-08-15",
        cancel: true,
      });
      check("cancela respondiendo 201", cancelacion.status, 201);
      check("cancelled:true", cancelacion.body?.cancelled, true);
      check("capital 85.298,25", cancelacion.body?.principalPaid, "85298.25");
      check("sin interés", cancelacion.body?.interestPaid, null);
      check("una sola pata", cancelacion.body?.movements?.length, 1);
      check(
        "la pata es una TRANSFER por cobrar → banco",
        `${cancelacion.body?.movements?.[0]?.kind}:${cancelacion.body?.movements?.[0]?.account?.id}:${cancelacion.body?.movements?.[0]?.toAccount?.id}`,
        `TRANSFER:${porCobrarId}:${bancoId}`,
      );

      const bancoDato = await cuentaDe(bancoId, "?asOf=2028-08-31");
      const cobrarDato = await cuentaDe(porCobrarId, "?asOf=2028-08-31");
      check("banco queda en +5.000,00 (sólo el interés)", bancoDato?.balance, "5000.00");
      check("por cobrar queda en 0,00", cobrarDato?.balance, "0.00");

      const vista = await get("/api/loans?asOf=2028-08-15");
      const mio = prestamoDe(vista, porCobrarId);
      check("cobertura 6 de 6", mio?.plan?.paidCount, 6);
      check("capital recuperado 100.000,00", mio?.capitalPaid, "100000.00");
      check("progreso 100,00%", mio?.progressPercent, "100.00");
      check("próxima cuota: ninguna", mio?.nextInstallment, null);

      const cuentas = await get("/api/accounts?asOf=2028-08-31");
      const esperado = (BigInt(String(netoAntes).replace(".", "")) + 500000n)
        .toString();
      const esperadoStr = `${esperado.slice(0, -2)}.${esperado.slice(-2)}`;
      check(
        "el patrimonio final: +5.000,00 (sólo el interés cobrado)",
        cuentas.body?.netWorth?.net,
        esperadoStr,
      );

      const deudas = await deudaDelMes("2028-08", "2028-08-31");
      check(
        "totalDebt final igual al inicial",
        deudas.body?.debtReport?.totalDebt,
        deudasAntes.body?.debtReport?.totalDebt,
      );
      checkDeep(
        "el DTI final tampoco lo ve",
        {
          commitment: deudas.body?.debtReport?.dti?.monthlyCommitment,
          count: deudas.body?.debtReport?.dti?.planCount,
        },
        {
          commitment: deudasAntes.body?.debtReport?.dti?.monthlyCommitment,
          count: deudasAntes.body?.debtReport?.dti?.planCount,
        },
      );
    }
  },
});
