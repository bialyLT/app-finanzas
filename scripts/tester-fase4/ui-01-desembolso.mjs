#!/usr/bin/env node
/**
 * ui-01 - `disbursed` derivado: el ciclo completo del desembolso.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA (brief, criterio 6 + "área caliente 2")
 * ─────────────────────────────────────────────────────────────────────────────
 * La vista de préstamos dice si el DESEMBOLSO consta como plata registrada:
 *
 *   · LOAN       -> una TRANSFERENCIA que SALE de la cuenta del préstamo.
 *   · RECEIVABLE -> una TRANSFERENCIA que ENTRA a la cuenta por cobrar.
 *   · La apertura que ya declaraba la plata (LOAN negativo / RECEIVABLE
 *     positivo) también cuenta.
 *   · Acotado a `asOf`, como el capital pagado: una transferencia POSTERIOR al
 *     corte no declara nada todavía.
 *   · Es DERIVADO de verdad: borrar la transferencia del desembolso devuelve
 *     `false` (el aviso de la pantalla reaparece) sin tocar nada más.
 *
 * La prueba es por las RUTAS reales (`POST /api/transactions`,
 * `DELETE /api/transactions/:id`) y la lectura por `GET /api/loans?asOf=`.
 * También fija el contrato bidireccional del feed de la página: un LOAN nunca
 * trae `receivable`, un RECEIVABLE nunca trae `debt`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LOS NÚMEROS A MANO
 * ─────────────────────────────────────────────────────────────────────────────
 * A: LOAN 500.000. Tras la transferencia del 01/06: balance −500.000,00 ->
 *    deuda 500.000,00 y banco 500.000,00 (la plata no se crea ni se destruye).
 *    Con el abono suelto de 1.000 del 01/08: deuda 499.000,00 exacta.
 *    Borrando la transferencia del desembolso queda solo el abono: deuda
 *    −1.000,00 (el saldo sin clamp es por diseño de la ronda 1).
 * B: solo un abono HACIA el préstamo no declara el desembolso (el sentido
 *    importa): seguía en 0,00 salvo el abono.
 * C: RECEIVABLE 100.000: la devolución de 5.000 que SALE no declara; la
 *    entrada de 100.000 sí. Saldo resultante: −5.000 + 100.000 = 95.000,00.
 * D: aperturas: −400.000 (LOAN) y +150.000 (RECEIVABLE) declaran; +5.000 y
 *    −100 no.
 */

import {
  check,
  checkTrue,
  crearCuenta,
  crearMovimiento,
  crearPrestamo,
  cuentaDe,
  del,
  prestamoDe,
  runScript,
  section,
  vistaPrestamos,
} from "./helpers.mjs";

const TAG = "T_TESTER_F4R2_01";
/** Un año sin relación con el seed, para que los totales no se mezclen. */
const FIRST = "2028-06-20";
const ASOF = "2028-06-30";

const vista = async (asOf = ASOF) => vistaPrestamos(`?asOf=${asOf}`);

runScript({
  tag: TAG,
  main: async (prisma) => {
    const banco = await crearCuenta(`${TAG}_Banco`, "BANK", "0");
    check("alta del banco responde 201", banco.status, 201);
    const bancoId = banco.body?.id;

    /* ───────────────────────────────────────────────────────────────────────
     * A - LOAN: el ciclo aviso -> desembolso -> borrar -> aviso
     * ─────────────────────────────────────────────────────────────────────── */
    section("A - LOAN 500.000: ciclo completo del desembolso");
    const altaA = await crearPrestamo({
      name: `${TAG}_A`,
      kind: "LOAN",
      principal: "500000",
      tnaPercent: "60",
      installmentCount: 12,
      firstInstallmentDate: FIRST,
    });
    check("A: el alta responde 201", altaA.status, 201);
    const loanA = altaA.body?.id;

    const recienCreado = prestamoDe(await vista(), loanA);
    check("A: recién creado, disbursed false (el aviso tiene que aparecer)", recienCreado?.disbursed, false);
    check("A: la deuda viva arranca en 0,00 (la plata no se movió)", recienCreado?.debt, "0.00");
    check("A: un LOAN no tiene lado «a cobrar»", recienCreado?.receivable, null);
    check("A: un LOAN es pasivo", recienCreado?.isLiability, true);
    check("A: dirección I_OWE", recienCreado?.direction, "I_OWE");

    const desembolso = await crearMovimiento({
      kind: "TRANSFER",
      amount: "500000",
      date: "2028-06-01",
      accountId: loanA,
      toAccountId: bancoId,
      description: "Desembolso del préstamo",
    });
    check("A: la transferencia del desembolso responde 201", desembolso.status, 201);
    const desembolsoId = desembolso.body?.id;

    const antes = prestamoDe(await vista("2028-05-31"), loanA);
    check("A: acotado a asOf: al 31/05 la transferencia del 01/06 no declara", antes?.disbursed, false);

    const elDia = prestamoDe(await vista("2028-06-01"), loanA);
    check("A: el mismo día de la transferencia ya declara (borde inclusivo)", elDia?.disbursed, true);

    const conDesembolso = prestamoDe(await vista(), loanA);
    check("A: con la transferencia, disbursed true", conDesembolso?.disbursed, true);
    check("A: deuda viva 500.000,00 (el saldo de la cuenta)", conDesembolso?.debt, "500000.00");
    check("A: balance −500.000,00", conDesembolso?.balance, "-500000.00");

    const cuentas = await cuentaDe(bancoId, `?asOf=${ASOF}`);
    check("A: el banco recibió 500.000,00 exactos", cuentas?.balance, "500000.00");

    const abono = await crearMovimiento({
      kind: "TRANSFER",
      amount: "1000",
      date: "2028-08-01",
      accountId: bancoId,
      toAccountId: loanA,
      description: "Abono suelto a la deuda",
    });
    check("A: el abono suelto responde 201", abono.status, 201);

    const conAbono = prestamoDe(await vista("2028-08-31"), loanA);
    check("A: con el abono, la deuda baja a 499.000,00", conAbono?.debt, "499000.00");
    check("A: con el abono, sigue declarado el desembolso", conAbono?.disbursed, true);

    const borrado = await del(`/api/transactions/${desembolsoId}`);
    check("A: borrar la transferencia del desembolso responde 200", borrado.status, 200);
    checkTrue("A: la respuesta del borrado es {ok:true}", borrado.body?.ok === true, JSON.stringify(borrado.body));

    const sinDesembolso = prestamoDe(await vista("2028-08-31"), loanA);
    check("A: borrada la transferencia, disbursed vuelve a false (el aviso reaparece)", sinDesembolso?.disbursed, false);
    check("A: solo quedó el abono: deuda −1.000,00 (sin clamp, por diseño)", sinDesembolso?.debt, "-1000.00");

    /* ───────────────────────────────────────────────────────────────────────
     * B - LOAN: un abono HACIA el préstamo no declara el desembolso
     * ─────────────────────────────────────────────────────────────────────── */
    section("B - LOAN 300.000: solo un abono hacia el préstamo");
    const altaB = await crearPrestamo({
      name: `${TAG}_B`,
      kind: "LOAN",
      principal: "300000",
      tnaPercent: "48",
      installmentCount: 6,
      firstInstallmentDate: FIRST,
    });
    check("B: el alta responde 201", altaB.status, 201);
    const loanB = altaB.body?.id;

    const abonoB = await crearMovimiento({
      kind: "TRANSFER",
      amount: "2000",
      date: "2028-05-15",
      accountId: bancoId,
      toAccountId: loanB,
      description: "Abono suelto B",
    });
    check("B: el abono responde 201", abonoB.status, 201);

    const soloAbono = prestamoDe(await vista(), loanB);
    check("B: el sentido importa: solo entrar plata NO declara el desembolso", soloAbono?.disbursed, false);

    /* ───────────────────────────────────────────────────────────────────────
     * C - RECEIVABLE: espejo (lo que ENTRA declara)
     * ─────────────────────────────────────────────────────────────────────── */
    section("C - RECEIVABLE 100.000: espejo del LOAN");
    const altaC = await crearPrestamo({
      name: `${TAG}_C`,
      kind: "RECEIVABLE",
      principal: "100000",
      tnaPercent: "60",
      installmentCount: 6,
      firstInstallmentDate: FIRST,
    });
    check("C: el alta responde 201", altaC.status, 201);
    const recC = altaC.body?.id;

    const recienC = prestamoDe(await vista(), recC);
    check("C: recién creado, disbursed false", recienC?.disbursed, false);
    check("C: te deben 0,00", recienC?.receivable, "0.00");
    check("C: un RECEIVABLE no tiene deuda (es activo)", recienC?.debt, null);
    check("C: un RECEIVABLE no es pasivo", recienC?.isLiability, false);
    check("C: dirección OWED_TO_ME", recienC?.direction, "OWED_TO_ME");

    const devolucion = await crearMovimiento({
      kind: "TRANSFER",
      amount: "5000",
      date: "2028-05-10",
      accountId: recC,
      toAccountId: bancoId,
      description: "Devolución parcial de C",
    });
    check("C: la devolución responde 201", devolucion.status, 201);

    const conDevolucion = prestamoDe(await vista(), recC);
    check("C: una devolución que SALE no declara el desembolso", conDevolucion?.disbursed, false);
    check("C: saldo tras la devolución: −5.000,00 (sin clamp)", conDevolucion?.receivable, "-5000.00");

    const prestado = await crearMovimiento({
      kind: "TRANSFER",
      amount: "100000",
      date: "2028-07-01",
      accountId: bancoId,
      toAccountId: recC,
      description: "Le presté a C",
    });
    check("C: la transferencia que entra responde 201", prestado.status, 201);

    const conPrestamo = prestamoDe(await vista("2028-07-31"), recC);
    check("C: lo que ENTRA sí declara el desembolso", conPrestamo?.disbursed, true);
    check("C: te deben 95.000,00 (−5.000 + 100.000)", conPrestamo?.receivable, "95000.00");

    const borradoC = await del(`/api/transactions/${prestado.body?.id}`);
    check("C: borrar la entrada responde 200", borradoC.status, 200);
    const sinPrestamo = prestamoDe(await vista("2028-07-31"), recC);
    check("C: borrada la entrada, vuelve a false", sinPrestamo?.disbursed, false);

    /* ───────────────────────────────────────────────────────────────────────
     * D - Aperturas que ya declaran la plata (préstamos migrados a mano)
     * ─────────────────────────────────────────────────────────────────────── */
    section("D - aperturas");
    const aperturaNegativa = await crearPrestamo({
      name: `${TAG}_D1`,
      kind: "LOAN",
      openingBalance: "-400000",
      principal: "400000",
      tnaPercent: "48",
      installmentCount: 12,
      firstInstallmentDate: FIRST,
    });
    check("D1: el alta responde 201", aperturaNegativa.status, 201);
    const d1 = prestamoDe(await vista(), aperturaNegativa.body?.id);
    check("D1: LOAN con apertura −400.000 ya declara la plata", d1?.disbursed, true);
    check("D1: su deuda es la apertura: 400.000,00", d1?.debt, "400000.00");

    const aperturaPositiva = await crearPrestamo({
      name: `${TAG}_D2`,
      kind: "LOAN",
      openingBalance: "5000",
      principal: "100000",
      tnaPercent: "48",
      installmentCount: 6,
      firstInstallmentDate: FIRST,
    });
    check("D2: el alta responde 201", aperturaPositiva.status, 201);
    const d2 = prestamoDe(await vista(), aperturaPositiva.body?.id);
    check("D2: LOAN con apertura positiva no declara desembolso", d2?.disbursed, false);

    const recPositiva = await crearPrestamo({
      name: `${TAG}_D3`,
      kind: "RECEIVABLE",
      openingBalance: "150000",
      principal: "150000",
      tnaPercent: "48",
      installmentCount: 12,
      firstInstallmentDate: FIRST,
    });
    check("D3: el alta responde 201", recPositiva.status, 201);
    const d3 = prestamoDe(await vista(), recPositiva.body?.id);
    check("D3: RECEIVABLE con apertura +150.000 ya declara la plata", d3?.disbursed, true);
    check("D3: te deben 150.000,00", d3?.receivable, "150000.00");

    const recNegativa = await crearPrestamo({
      name: `${TAG}_D4`,
      kind: "RECEIVABLE",
      openingBalance: "-100",
      principal: "100000",
      tnaPercent: "48",
      installmentCount: 6,
      firstInstallmentDate: FIRST,
    });
    check("D4: el alta responde 201", recNegativa.status, 201);
    const d4 = prestamoDe(await vista(), recNegativa.body?.id);
    check("D4: RECEIVABLE con apertura negativa no declara", d4?.disbursed, false);

    /* ───────────────────────────────────────────────────────────────────────
     * E - El campo viaja SIEMPRE (la pantalla lo lee en cada tarjeta)
     * ─────────────────────────────────────────────────────────────────────── */
    section("E - el campo `disbursed` en la foto completa");
    const foto = await vista();
    const todos = foto.body?.loans ?? [];
    const nuestros = todos.filter((loan) => loan.name.startsWith(TAG));
    check("E: están los siete préstamos de este script", nuestros.length, 7);
    checkTrue(
      "E: TODOS traen `disbursed` booleano (nunca undefined)",
      todos.every((loan) => typeof loan.disbursed === "boolean"),
      JSON.stringify(todos.map((loan) => [loan.name, loan.disbursed])),
    );
    checkTrue(
      "E: ningún LOAN trae `receivable` y ningún RECEIVABLE trae `debt`",
      todos.every((loan) =>
        loan.kind === "LOAN" ? loan.receivable === null : loan.debt === null,
      ),
      JSON.stringify(todos.filter((l) => (l.kind === "LOAN" ? l.receivable !== null : l.debt !== null)).map((l) => l.name)),
    );
  },
});
