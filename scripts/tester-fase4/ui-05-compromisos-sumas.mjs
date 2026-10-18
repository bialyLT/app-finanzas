#!/usr/bin/env node
/**
 * ui-05 - Los compromisos y las sumas de la página: números a mano.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA (brief, clases de ataque de UI)
 * ─────────────────────────────────────────────────────────────────────────────
 * La página /prestamos vive de dos números que el server calcula y el cliente
 * vuelve a sumar: los COMPROMISOS de cada préstamo (vencido + próximos meses)
 * y los TOTALES de las secciones. Este script fija ese contrato con aritmética
 * a mano, sin copiar nada del código:
 *
 *   · la ventana de 12 meses arranca en el mes de `asOf` (08/2028);
 *   · "vencido" es un número aparte (cuotas de meses anteriores) que NUNCA se
 *     suma a los próximos 12 meses;
 *   · los rotativos (INTEREST_ONLY) no acumulan vencido (0/0 a propósito);
 *   · `next6Months` es la suma de los PRIMEROS 6 buckets, no de los meses con
 *     plata;
 *   · un RECEIVABLE tiene compromisos en el server pero la página NO los suma
 *     (control de exclusión con el número que contaminaría);
 *   · el alta por duplicado en paralelo: uno gana (201), el otro lee el índice
 *     único (409 con copy) y queda UNA cuenta con UN cronograma.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LOS NÚMEROS A MANO (asOf = 31/08/2028 → ventana 08/2028..07/2029)
 * ─────────────────────────────────────────────────────────────────────────────
 * L1 - LOAN 100.000 al 24% TNA (2% mensual) en 6 FRENCH, primera 20/06/2028.
 *   Cuota fija 17.852,58; la ÚLTIMA absorbe el redondeo: 17.852,60.
 *   · Vencidas (meses 06 y 07): 17.852,58 × 2 = 35.705,16 (2 cuotas).
 *   · Ventana: cuotas 3..6 = 17.852,58 × 3 + 17.852,60 = 71.410,34.
 * L2 - LOAN 300.000 al 0% en 3 FRENCH, primera 30/09/2028 → 100.000,00 c/u
 *   en 09..11/2028: 6m = 12m = 300.000,00.
 * L3 - LOAN 50.000 al 24% INTEREST_ONLY en 6, primera 20/06/2028 →
 *   1.000,00/mes; meses 08..11 dentro de la ventana → 6m = 12m = 4.000,00;
 *   vencido 0,00/0 por rotativo (el interés va como gasto manual).
 * L5 - LOAN 120.000 al 0% en 12 FRENCH, primera 10/08/2028 → 10.000,00 c/u
 *   en los 12 meses de la ventana: 6m = 60.000,00 · 12m = 120.000,00.
 * R1 - RECEIVABLE 200.000 al 24% en 4 FRENCH, primera 05/08/2028: control de
 *   EXCLUSIÓN — sus compromisos existen en el server (y son > 0), pero la
 *   página sólo suma los LOAN.
 *
 * Las sumas de la página (réplica de la aritmética de app/prestamos/page.tsx):
 *   deuda    = 100.000 + 300.000 + 50.000 + 120.000 = 570.000,00
 *   a cobrar = 200.000,00
 *   vencido  = 35.705,16 (2 cuotas)
 *   próximos 6  = 71.410,34 + 300.000,00 + 4.000,00 + 60.000,00 = 435.410,34
 *   próximos 12 = 435.410,34 + 60.000,00 (L5, 02..07/2029) = 495.410,34
 *
 * Chips por mes (unión de los buckets de todos los LOAN):
 *   08/2028: 17.852,58 + 10.000 + 1.000 = 28.852,58
 *   09/2028: 17.852,58 + 100.000 + 10.000 + 1.000 = 128.852,58
 *   10/2028: 17.852,58 + 100.000 + 10.000 + 1.000 = 128.852,58
 *   11/2028: 17.852,60 + 100.000 + 10.000 + 1.000 = 128.852,60
 *   12/2028..07/2029: 10.000,00 (sólo L5)
 *   Total de chips = 28.852,58 + 128.852,58 × 2 + 128.852,60 + 10.000 × 8
 *                  = 495.410,34 = los "próximos 12 meses" (control cruzado).
 *
 * DUP - dos POST /api/accounts en paralelo con el mismo nombre → {201, 409}
 *   (P2002 → 409 "Ya existe una cuenta con ese nombre."): UNA sola cuenta y
 *   UN solo cronograma (2 cuotas). El perdedor no deja filas huérfanas: la
 *   cuenta y su cronograma se crean en la MISMA transacción.
 */

import {
  apiNoAuth,
  cents,
  centsToMoney,
  check,
  checkIncluye,
  checkTrue,
  crearCuenta,
  crearPrestamo,
  get,
  post,
  runScript,
  section,
  sumItems,
  vistaPrestamos,
} from "./helpers.mjs";

const TAG = "T_TESTER_F4R2_05";
const ASOF = "2028-08-31";
const VISTA = `?asOf=${ASOF}&includeArchived=false`;
const BANCO_APERTURA = "5000000";

runScript({
  tag: TAG,
  main: async (prisma) => {
    /* ───────────────────────────────────────────────────────────────────────
     * El borde de la ruta: sin sesión y `asOf` hostil
     * ─────────────────────────────────────────────────────────────────────── */
    section("La vista de préstamos: bordes de entrada");
    const sinSesion = await apiNoAuth(`/api/loans${VISTA}`);
    check("sin sesión: 401 (no 500)", sinSesion.status, 401);

    const asOfMalo = await get("/api/loans?asOf=2028-13-40");
    check("`asOf` inválido: 400 (no 500)", asOfMalo.status, 400);
    checkIncluye(
      "explica que `asOf` tiene que ser una fecha",
      asOfMalo.body?.error,
      "válida",
    );

    /* ───────────────────────────────────────────────────────────────────────
     * Preparación: banco + 4 préstamos propios + 1 a cobrar, desembolsados
     * ─────────────────────────────────────────────────────────────────────── */
    section("Preparación: banco y cinco contratos");
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

    const l2 = await crearPrestamo({
      name: `${TAG}_L2`,
      kind: "LOAN",
      principal: "300000",
      tnaPercent: "0",
      installmentCount: 3,
      firstInstallmentDate: "2028-09-30",
    });
    check("L2 responde 201", l2.status, 201);

    const l3 = await crearPrestamo({
      name: `${TAG}_L3`,
      kind: "LOAN",
      principal: "50000",
      tnaPercent: "24",
      installmentCount: 6,
      firstInstallmentDate: "2028-06-20",
      amortizationSystem: "INTEREST_ONLY",
    });
    check("L3 (solo interés) responde 201", l3.status, 201);

    const l5 = await crearPrestamo({
      name: `${TAG}_L5`,
      kind: "LOAN",
      principal: "120000",
      tnaPercent: "0",
      installmentCount: 12,
      firstInstallmentDate: "2028-08-10",
    });
    check("L5 responde 201", l5.status, 201);

    const r1 = await crearPrestamo({
      name: `${TAG}_R1`,
      kind: "RECEIVABLE",
      principal: "200000",
      tnaPercent: "24",
      installmentCount: 4,
      firstInstallmentDate: "2028-08-05",
    });
    check("R1 (a cobrar) responde 201", r1.status, 201);

    section("Desembolsos (la deuda y el a-cobrar necesitan saldo real)");
    const desembolsos = [
      ["L1", l1, "100000"],
      ["L2", l2, "300000"],
      ["L3", l3, "50000"],
      ["L5", l5, "120000"],
    ];
    for (const [nombre, creado, monto] of desembolsos) {
      const movimiento = await post("/api/transactions", {
        kind: "TRANSFER",
        amount: monto,
        date: "2028-06-01",
        accountId: creado.body?.id,
        toAccountId: bancoId,
        description: `${TAG}_Desembolso_${nombre}`,
      });
      check(`el desembolso de ${nombre} responde 201`, movimiento.status, 201);
    }
    const desembolsoR1 = await post("/api/transactions", {
      kind: "TRANSFER",
      amount: "200000",
      date: "2028-06-01",
      accountId: bancoId,
      toAccountId: r1.body?.id,
      description: `${TAG}_Desembolso_R1`,
    });
    check("el desembolso de R1 responde 201", desembolsoR1.status, 201);

    /* ───────────────────────────────────────────────────────────────────────
     * La vista: los cinco contratos, con `asOf` y `includeArchived=false`
     * (exactamente la query que usa la página por defecto)
     * ─────────────────────────────────────────────────────────────────────── */
    section("La vista anclada a 31/08/2028");
    const vista = await vistaPrestamos(VISTA);
    check("la vista responde 200", vista.status, 200);

    const mios = (vista.body?.loans ?? []).filter((loan) =>
      loan.name.startsWith(TAG),
    );
    check("los 5 préstamos del escenario están en la vista", mios.length, 5);
    const porNombre = (nombre) =>
      mios.find((loan) => loan.name === `${TAG}_${nombre}`) ?? null;
    const l1v = porNombre("L1");
    const l2v = porNombre("L2");
    const l3v = porNombre("L3");
    const l5v = porNombre("L5");
    const r1v = porNombre("R1");

    check("L1 figura como desembolsado", l1v?.disbursed, true);

    /* ───────────────────────────────────────────────────────────────────────
     * L1 - vencidas y ventana (la cuota 6 absorbe el redondeo)
     * ─────────────────────────────────────────────────────────────────────── */
    section("L1 - 100.000 al 24% en 6: vencido 35.705,16 y ventana 71.410,34");
    check("L1: deuda 100.000,00", l1v?.debt, "100000.00");
    check("L1: vencido 35.705,16 (cuotas 1 y 2)", l1v?.commitments?.overdue, "35705.16");
    check("L1: dos cuotas vencidas", l1v?.commitments?.overdueCount, 2);
    check("L1: próximos 6 meses 71.410,34", l1v?.commitments?.next6Months, "71410.34");
    check("L1: próximos 12 meses 71.410,34", l1v?.commitments?.next12Months, "71410.34");

    /* ───────────────────────────────────────────────────────────────────────
     * L2 - 0% en 3: capital repartido exacto, todo dentro de la ventana
     * ─────────────────────────────────────────────────────────────────────── */
    section("L2 - 300.000 al 0% en 3: 300.000,00 en la ventana");
    check("L2: deuda 300.000,00", l2v?.debt, "300000.00");
    check("L2: sin nada vencido", l2v?.commitments?.overdue, "0.00");
    check("L2: 0 cuotas vencidas", l2v?.commitments?.overdueCount, 0);
    check("L2: próximos 6 meses 300.000,00", l2v?.commitments?.next6Months, "300000.00");
    check("L2: próximos 12 meses 300.000,00", l2v?.commitments?.next12Months, "300000.00");

    /* ───────────────────────────────────────────────────────────────────────
     * L3 - rotativo: los próximos meses sí, el "vencido" no
     * ─────────────────────────────────────────────────────────────────────── */
    section("L3 - 50.000 al 24% solo interés: 4.000,00 y vencido 0/0");
    check("L3: deuda 50.000,00", l3v?.debt, "50000.00");
    check("L3: el vencido queda en 0,00 (rotativo)", l3v?.commitments?.overdue, "0.00");
    check("L3: 0 cuotas vencidas (rotativo)", l3v?.commitments?.overdueCount, 0);
    check("L3: próximos 6 meses 4.000,00", l3v?.commitments?.next6Months, "4000.00");
    check("L3: próximos 12 meses 4.000,00", l3v?.commitments?.next12Months, "4000.00");
    check("L3: no ofrece cuota para pagar", l3v?.nextInstallment, null);

    /* ───────────────────────────────────────────────────────────────────────
     * L5 - la ventana entera: 6 buckets vs 12 buckets
     * ─────────────────────────────────────────────────────────────────────── */
    section("L5 - 120.000 al 0% en 12: 60.000,00 a 6 meses, 120.000,00 a 12");
    check("L5: deuda 120.000,00", l5v?.debt, "120000.00");
    check("L5: sin nada vencido", l5v?.commitments?.overdue, "0.00");
    check("L5: 0 cuotas vencidas", l5v?.commitments?.overdueCount, 0);
    check("L5: próximos 6 meses 60.000,00", l5v?.commitments?.next6Months, "60000.00");
    check("L5: próximos 12 meses 120.000,00", l5v?.commitments?.next12Months, "120000.00");

    /* ───────────────────────────────────────────────────────────────────────
     * R1 - control de exclusión: el server sí calcula sus compromisos
     * ─────────────────────────────────────────────────────────────────────── */
    section("R1 - a cobrar 200.000,00: compromisos > 0 que la página no suma");
    check("R1: a cobrar 200.000,00", r1v?.receivable, "200000.00");
    check("R1: no tiene deuda (debt null)", r1v?.debt, null);
    checkTrue(
      "R1 tiene compromisos calculados en el server (control positivo)",
      r1v?.commitments !== null && r1v?.commitments !== undefined,
      JSON.stringify(r1v?.commitments ?? null),
    );
    checkTrue(
      "R1: sus próximos 12 meses son > 0 (si entrara, contaminaría)",
      cents(r1v?.commitments?.next12Months ?? "0") > 0n,
      `next12: ${r1v?.commitments?.next12Months}`,
    );
    check("R1: sin nada vencido", r1v?.commitments?.overdue, "0.00");
    check("R1: 0 cuotas vencidas", r1v?.commitments?.overdueCount, 0);

    /* ───────────────────────────────────────────────────────────────────────
     * Las sumas de la página (misma aritmética del cliente, sobre mis loans)
     * ─────────────────────────────────────────────────────────────────────── */
    section("Las sumas de la página");
    const loanDebts = mios.filter((loan) => loan.kind === "LOAN");
    const receivables = mios.filter((loan) => loan.kind === "RECEIVABLE");
    check("4 préstamos propios (LOAN)", loanDebts.length, 4);
    check("1 préstamo a cobrar (RECEIVABLE)", receivables.length, 1);

    const totalDebt = sumItems(loanDebts, (loan) => loan.debt ?? "0");
    const totalReceivable = sumItems(receivables, (loan) => loan.receivable ?? "0");
    check("Total debo: 570.000,00", totalDebt, "570000.00");
    check("Total me deben: 200.000,00", totalReceivable, "200000.00");

    const debtCommitments = loanDebts
      .map((loan) => loan.commitments)
      .filter((value) => value !== null);
    const commitOverdue = sumItems(debtCommitments, (c) => c.overdue);
    const commitOverdueCount = debtCommitments.reduce(
      (sum, c) => sum + c.overdueCount,
      0,
    );
    const commit6 = sumItems(debtCommitments, (c) => c.next6Months);
    const commit12 = sumItems(debtCommitments, (c) => c.next12Months);

    check("Vencido agregado: 35.705,16", commitOverdue, "35705.16");
    check("Dos cuotas vencidas agregadas", commitOverdueCount, 2);
    check("Próximos 6 meses: 435.410,34", commit6, "435410.34");
    check("Próximos 12 meses: 495.410,34", commit12, "495410.34");

    for (const loan of loanDebts) {
      console.log(
        `  · ${loan.name}: deuda ${loan.debt} · vencido ${loan.commitments?.overdue}/${loan.commitments?.overdueCount} · 6m ${loan.commitments?.next6Months} · 12m ${loan.commitments?.next12Months}`,
      );
    }

    /* ───────────────────────────────────────────────────────────────────────
     * El control de exclusión, en números: sin el filtro los totales cambian
     * ─────────────────────────────────────────────────────────────────────── */
    section("Control de exclusión: con el RECEIVABLE adentro, los totales NO cierran");
    const todos = mios
      .map((loan) => loan.commitments)
      .filter((value) => value !== null);
    const commit12SinFiltro = sumItems(todos, (c) => c.next12Months);
    checkTrue(
      "sin el filtro por kind, los 12 meses darían otro número",
      cents(commit12SinFiltro) !== cents(commit12),
      `${commit12SinFiltro} vs ${commit12}`,
    );

    /* ───────────────────────────────────────────────────────────────────────
     * Los chips por mes: unión de los 12 buckets de cada LOAN
     * ─────────────────────────────────────────────────────────────────────── */
    section("Los chips por mes (unión de buckets, suma en centavos)");
    const chips = new Map();
    for (const commitments of debtCommitments) {
      for (const month of commitments.months) {
        const key = `${month.year}-${String(month.month).padStart(2, "0")}`;
        chips.set(key, (chips.get(key) ?? 0n) + cents(month.amount));
      }
    }
    const esperados = [
      ["2028-08", "28852.58"],
      ["2028-09", "128852.58"],
      ["2028-10", "128852.58"],
      ["2028-11", "128852.60"],
      ["2028-12", "10000.00"],
      ["2029-01", "10000.00"],
      ["2029-02", "10000.00"],
      ["2029-03", "10000.00"],
      ["2029-04", "10000.00"],
      ["2029-05", "10000.00"],
      ["2029-06", "10000.00"],
      ["2029-07", "10000.00"],
    ];
    check("la ventana tiene UN chip por mes", chips.size, 12);
    for (const [key, amount] of esperados) {
      check(`chip ${key}: ${amount}`, centsToMoney(chips.get(key) ?? 0n), amount);
    }

    /* ───────────────────────────────────────────────────────────────────────
     * El alta por duplicado: dos POST en paralelo, mismo nombre
     * ─────────────────────────────────────────────────────────────────────── */
    section("Alta por duplicado: dos POST en paralelo con el mismo nombre");
    const cuerpoDup = {
      name: `${TAG}_Dup`,
      kind: "LOAN",
      principal: "1000",
      tnaPercent: "24",
      installmentCount: 2,
      firstInstallmentDate: "2028-09-20",
    };
    const dup = await Promise.all([
      post("/api/accounts", cuerpoDup),
      post("/api/accounts", cuerpoDup),
    ]);
    const estados = dup
      .map((r) => r.status)
      .sort((a, b) => a - b);
    check("los dos POST: uno 201 y uno 409", estados.join(","), "201,409");
    const perdedor = dup.find((r) => r.status === 409);
    checkIncluye(
      "el 409 explica el nombre duplicado",
      perdedor?.body?.error,
      "Ya existe una cuenta con ese nombre.",
    );
    const ganador = dup.find((r) => r.status === 201);
    const cuentasDup = await prisma.account.count({
      where: { name: `${TAG}_Dup` },
    });
    check("quedó UNA sola cuenta con ese nombre", cuentasDup, 1);
    const filasDup = await prisma.installment.count({
      where: { accountId: ganador?.body?.id },
    });
    check("quedó UN solo cronograma (2 cuotas)", filasDup, 2);
  },
});
