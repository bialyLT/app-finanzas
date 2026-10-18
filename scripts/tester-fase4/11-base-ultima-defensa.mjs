#!/usr/bin/env node
/**
 * 11 — La ÚLTIMA defensa: la base. Los CHECKs, el índice único del cronograma
 *      y el trigger del pasivo, probados por Prisma DIRECTO (sin la API).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTA BATERÍA EXISTE
 * ─────────────────────────────────────────────────────────────────────────────
 * Las validaciones de la API dan mensajes claros; las de la BASE existen para
 * que ni un script, ni una consola SQL, ni un camino futuro de la app puedan
 * dejar la base describiendo un contrato que no es. Acá se escribe SIN pasar
 * por la API a propósito: cada intento tiene que morir en la base.
 *
 *   A. Installment: `number ≥ 1`, `payment > 0`, interés y capital no
 *      negativos, `payment = interest + principal` al centavo, saldo no
 *      negativo, y la cuota única por (accountId, number).
 *   B. Account: un préstamo sin tasa necesita sistema IMPORTED
 *      (`loan_has_parameters`, con NULL ≠ 'IMPORTED' — el caso del préstamo
 *      legado sin sistema), y los parámetros de préstamo no existen fuera de
 *      un préstamo (`loan_parameters_only_on_loans`).
 *   C. El trigger `check_no_income_on_liability_account`: un INCOME no puede
 *      entrar a un LOAN, una CREDIT_CARD ni un RECEIVABLE — y SÍ entra a una
 *      cuenta de dinero (control: el trigger no dispara de más).
 *
 * La aritmética es de una sola línea por caso y está en el propio CHECK: no
 * hace falta calcular nada, sólo elegir datos que violen UNA sola regla.
 */

import {
  check,
  checkTrue,
  crearCuenta,
  crearPrestamo,
  post,
  runScript,
  section,
} from "./helpers.mjs";

const TAG = "T_TESTER_F4_11";

runScript({
  tag: TAG,
  main: async (prisma) => {
    /* ────────────────────────────────────────────────────────────────────────
     * Preparación: cuentas reales por API (el escenario de fondo)
     * ──────────────────────────────────────────────────────────────────────── */
    section("Preparación: préstamo, tarjeta y préstamo a cobrar por API");

    const prestamo = await crearPrestamo({
      name: `${TAG}_Prestamo`,
      kind: "LOAN",
      principal: "100000",
      tnaPercent: "60",
      installmentCount: 6,
      firstInstallmentDate: "2028-05-10",
    });
    check("alta del préstamo 201", prestamo.status, 201);
    const loanId = prestamo.body?.id;

    const tarjeta = await post("/api/accounts", {
      name: `${TAG}_Tarjeta`,
      kind: "CREDIT_CARD",
    });
    check("alta de la tarjeta 201", tarjeta.status, 201);
    const tarjetaId = tarjeta.body?.id;

    const cobrar = await crearPrestamo({
      name: `${TAG}_Cobrar`,
      kind: "RECEIVABLE",
      principal: "10000",
      tnaPercent: "0",
      installmentCount: 2,
      firstInstallmentDate: "2028-05-10",
    });
    check("alta del préstamo a cobrar 201", cobrar.status, 201);
    const cobrarId = cobrar.body?.id;

    const caja = await crearCuenta(`${TAG}_Caja`, "CASH", "0");
    check("alta de la caja 201", caja.status, 201);
    const cajaId = caja.body?.id;

    /**
     * Intenta `fn` y exige que la BASE lo rechace con el marcador dado.
     * Devuelve el texto del error para inspecciones extra.
     */
    async function rechazaCon(label, marcador, fn) {
      let ok = false;
      let texto = "no falló: el estado imposible se guardó";
      try {
        await fn();
      } catch (error) {
        texto = String(error?.message ?? error);
        ok = texto.includes(marcador);
      }
      checkTrue(`${label} → la base rechaza con ${marcador}`, ok, texto.slice(0, 200));
      return texto;
    }

    /* ────────────────────────────────────────────────────────────────────────
     * A — Installment: cada CHECK, con UNA sola regla violada por caso
     * ──────────────────────────────────────────────────────────────────────── */
    section("A · Installment: los CHECKs del cronograma");

    const filaBase = {
      accountId: loanId,
      number: 901,
      dueDate: new Date("2030-01-10T00:00:00.000Z"),
      payment: "100.00",
      interest: "10.00",
      principal: "90.00",
      remainingBalance: "900.00",
    };
    const cuota = (extra) => ({ data: { ...filaBase, ...extra } });

    // número desde 1
    await rechazaCon("cuota con number 0", "installment_number_positive", () =>
      prisma.installment.create(cuota({ number: 0 })),
    );
    // pago > 0 (0 = 0 + 0: la identidad del split NO se viola)
    await rechazaCon("cuota de pago 0", "installment_payment_positive", () =>
      prisma.installment.create(
        cuota({ payment: "0.00", interest: "0.00", principal: "0.00" }),
      ),
    );
    // interés no negativo (100 = −1 + 101: el split cierra, payment > 0)
    await rechazaCon("interés negativo", "installment_interest_nonnegative", () =>
      prisma.installment.create(
        cuota({ payment: "100.00", interest: "-1.00", principal: "101.00" }),
      ),
    );
    // capital no negativo (100 = 101 + −1)
    await rechazaCon("capital negativo", "installment_principal_nonnegative", () =>
      prisma.installment.create(
        cuota({ payment: "100.00", interest: "101.00", principal: "-1.00" }),
      ),
    );
    // la identidad del split: 100 ≠ 10 + 80
    await rechazaCon(
      "cuota que no descompone (100 ≠ 10 + 80)",
      "installment_split_matches_payment",
      () =>
        prisma.installment.create(
          cuota({ payment: "100.00", interest: "10.00", principal: "80.00" }),
        ),
    );
    // saldo no negativo
    await rechazaCon("saldo final negativo", "installment_remaining_nonnegative", () =>
      prisma.installment.create(cuota({ remainingBalance: "-0.01" })),
    );
    // única por (accountId, number): la 1 ya existe
    await rechazaCon(
      "cuota duplicada (accountId, number)",
      "Unique constraint failed",
      () => prisma.installment.create(cuota({ number: 1 })),
    );

    const filas = await prisma.installment.count({ where: { accountId: loanId } });
    check("ningún intento dejó filas: el cronograma sigue con 6", filas, 6);

    /* ────────────────────────────────────────────────────────────────────────
     * B — Account: los parámetros del préstamo
     * ──────────────────────────────────────────────────────────────────────── */
    section("B · Account: loan_has_parameters y loan_parameters_only_on_loans");

    // Sin tasa y sin sistema: el NULL NO es 'IMPORTED' → debe fallar. Es el
    // caso del préstamo legado sin sistema (lectura = FRENCH), que igual
    // necesita tasa para existir como contrato.
    await rechazaCon(
      "LOAN sin tasa ni sistema (NULL)",
      "loan_has_parameters",
      () =>
        prisma.account.create({
          data: {
            name: `${TAG}_SinTasa`,
            kind: "LOAN",
            principal: "1000.00",
            installmentCount: 3,
            tnaPercent: null,
            amortizationSystem: null,
          },
        }),
    );
    await rechazaCon(
      "RECEIVABLE sin tasa ni sistema (NULL)",
      "loan_has_parameters",
      () =>
        prisma.account.create({
          data: {
            name: `${TAG}_CobrarSinTasa`,
            kind: "RECEIVABLE",
            principal: "1000.00",
            installmentCount: 3,
            tnaPercent: null,
            amortizationSystem: null,
          },
        }),
    );

    // La excepción estructural: IMPORTED sin tasa SÍ puede (la composición la
    // dicta el cronograma del banco).
    const importado = await prisma.account.create({
      data: {
        name: `${TAG}_ImportadoSinTasa`,
        kind: "LOAN",
        principal: "1000.00",
        installmentCount: 3,
        tnaPercent: null,
        amortizationSystem: "IMPORTED",
      },
    });
    checkTrue("IMPORTED sin tasa SÍ se puede", Boolean(importado?.id));

    await rechazaCon("CASH con principal", "loan_parameters_only_on_loans", () =>
      prisma.account.create({
        data: { name: `${TAG}_CajaConPrincipal`, kind: "CASH", principal: "100.00" },
      }),
    );
    await rechazaCon(
      "CASH con sistema de amortización",
      "loan_parameters_only_on_loans",
      () =>
        prisma.account.create({
          data: {
            name: `${TAG}_CajaConSistema`,
            kind: "CASH",
            amortizationSystem: "FRENCH",
          },
        }),
    );

    /* ────────────────────────────────────────────────────────────────────────
     * C — El trigger: el pasivo no recibe ingresos
     * ──────────────────────────────────────────────────────────────────────── */
    section("C · Trigger: INCOME muere en LOAN/CREDIT_CARD/RECEIVABLE");

    const dia = new Date("2029-01-10T00:00:00.000Z");
    const ingresoEn = (accountId) =>
      prisma.movement.create({
        data: {
          kind: "INCOME",
          amount: "10.00",
          date: dia,
          description: `${TAG} ingreso imposible`,
          accountId,
        },
      });

    const textoLoans = await rechazaCon(
      "INCOME en LOAN",
      "[finanzas:pasivo_no_recibe_ingreso]",
      () => ingresoEn(loanId),
    );
    checkTrue(
      "el rechazo reporta ERRCODE 23514 (check_violation)",
      textoLoans.includes("23514"),
      textoLoans.slice(0, 200),
    );
    await rechazaCon("INCOME en CREDIT_CARD", "[finanzas:pasivo_no_recibe_ingreso]", () =>
      ingresoEn(tarjetaId),
    );
    await rechazaCon("INCOME en RECEIVABLE", "[finanzas:pasivo_no_recibe_ingreso]", () =>
      ingresoEn(cobrarId),
    );

    // Control: en una cuenta de dinero el mismo INCOME SÍ entra. INCOME/EXPENSE
    // exigen categoría (`movement_shape_by_kind`), así que la creamos acá.
    const categoria = await prisma.category.create({
      data: {
        name: `${TAG}_CatControl`,
        normalizedName: `${TAG}_catcontrol`.toLowerCase(),
        kind: "INCOME",
      },
    });
    const control = await prisma.movement.create({
      data: {
        kind: "INCOME",
        amount: "10.00",
        date: dia,
        description: `${TAG} ingreso legítimo`,
        accountId: cajaId,
        categoryId: categoria.id,
      },
    });
    checkTrue("control: el mismo INCOME en una CASH sí entra", Boolean(control?.id));
    check(
      "el control quedó en la base",
      await prisma.movement.count({ where: { accountId: cajaId } }),
      1,
    );
  },
});
