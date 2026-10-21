#!/usr/bin/env node
/**
 * 18-generador-intereses-cuotas · EL GENERADOR Y EL BUG QUE DESTAPÓ EL
 * INVARIANTE
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * QUÉ VERIFICA
 *
 * D · EL GENERADOR: una regla con la categoría del OTRO TIPO no postea; sus
 *     ocurrencias quedan en la bandeja; `acceptOccurrence` devuelve 409; y la
 *     CORRIDA SIGUE con las demás reglas (una regla rota no puede voltear la
 *     corrida).
 *
 * E · EL BUG DE LOS INTERESES (el que destapó el trigger): el interés que
 *     PAGÁS es un Gasto con su categoría; el que COBRÁS es un Ingreso con
 *     OTRA categoría. Una categoría tiene un solo tipo, así que los dos
 *     intereses no pueden llamarse igual. Y si la persona manda explícitamente
 *     la categoría del tipo contrario, tiene que haber un 400 accionable.
 *
 * F · LA COMPRA EN CUOTAS: una categoría de Ingreso para un gasto → 400 con el
 *     mensaje compartido, nunca un 500.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LOS NÚMEROS (calculados a mano, no tomados de la app)
 *
 * Préstamo de 100.000,00 al 5% TNA, 6 cuotas, sistema francés:
 *
 *   cuota      = 100.000 × 0,05 / (1 − 1,05⁻⁶) = 19.701,75
 *   interés 1  = 100.000 × 5%                  =  5.000,00
 *   capital 1  = 19.701,75 − 5.000,00          = 14.701,75
 *   queda debe = 100.000,00 − 14.701,75        = 85.298,25
 *
 * El interés de la PRIMERA cuota es siempre el 5% del capital: no depende de
 * la fecha ni del sistema (es el interés sobre el saldo inicial). Por eso los
 * números son los mismos en las dos direcciones.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { randomUUID } from "node:crypto";
import {
  check,
  checkIncluye,
  checkTrue,
  correrBateria,
  get,
  post,
  section,
  sql,
  sqlWrite,
} from "./lib-fase9r3.mjs";

const TAG = "T F9R3 ";

const creados = { cuentas: [], categorias: [], reglas: [], movimientos: [], planes: [] };
/** Los ids de regla que la batería creó (para borrarlos aunque el título no matchee). */
const idsReglasPropios = [];

const pad2 = (n) => String(n).padStart(2, "0");
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

async function crearCuenta(body) {
  const res = await post("/api/accounts", body);
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`No se pudo crear la cuenta: ${res.status} ${res.rawText}`);
  }
  creados.cuentas.push(res.body.id);
  return res.body;
}

async function crearCategoria(nombre, kind) {
  const res = await post("/api/categories", { name: nombre, kind });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`No se pudo crear la categoría «${nombre}»: ${res.status} ${res.rawText}`);
  }
  if (res.body?.id) creados.categorias.push(res.body.id);
  return res.body;
}

/** Limpieza: por id y por prefijo propio, en el orden que la base exige. */
async function limpiar(prisma) {
  section("Limpieza (18-generador-intereses-cuotas)");
  const cuentas = await prisma.account.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = cuentas.map((c) => c.id);
  const reglas = await prisma.recurrenceRule.findMany({
    where: { title: { startsWith: TAG } },
    select: { id: true },
  });
  const idsReglas = [...new Set([...idsReglasPropios, ...reglas.map((r) => r.id)])];

  // EL ORDEN IMPORTA (lo dice la base con sus FK):
  //   1 · los PLANES (apuntan al gasto de la compra: FK Restrict);
  //   2 · los MOVIMIENTOS (algunos los posteó una regla y la referencian);
  //   3 · las OCURRENCIAS;
  //   4 · las REGLAS (referencian cuentas y categorías);
  //   5 · las cuotas, los resúmenes y las plantillas;
  //   6 · las CUENTAS;
  //   7 · las CATEGORÍAS (una categoría usada por una regla no se puede borrar).
  if (ids.length) {
    await prisma.cardPlan.deleteMany({ where: { accountId: { in: ids } } });
    await prisma.statement.deleteMany({ where: { accountId: { in: ids } } });
    await prisma.favoriteTemplate.deleteMany({ where: { accountId: { in: ids } } });
  }
  const movimientos = await prisma.movement.findMany({
    where: {
      OR: [
        { accountId: { in: ids } },
        { toAccountId: { in: ids } },
        { description: { startsWith: TAG } },
      ],
    },
    select: { id: true },
  });
  const idsMovimientos = movimientos.map((m) => m.id);
  if (idsMovimientos.length) {
    await prisma.recurrenceOccurrence.updateMany({
      where: { movementId: { in: idsMovimientos } },
      data: { movementId: null, status: "PENDING", postedAt: null },
    });
    await prisma.movement.deleteMany({ where: { id: { in: idsMovimientos } } });
  }
  if (idsReglas.length) {
    await prisma.recurrenceOccurrence.deleteMany({
      where: { ruleId: { in: idsReglas } },
    });
    await prisma.recurrenceRule.deleteMany({ where: { id: { in: idsReglas } } });
  }
  if (ids.length) {
    await prisma.movement.deleteMany({
      where: {
        OR: [
          { accountId: { in: ids } },
          { toAccountId: { in: ids } },
        ],
      },
    });
    await prisma.installment.deleteMany({ where: { accountId: { in: ids } } });
    await prisma.account.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.movement.deleteMany({ where: { description: { startsWith: TAG } } });
  await prisma.category.deleteMany({ where: { name: { startsWith: TAG } } });
  console.log("  lista");
}

await correrBateria({
  etiqueta: "18-generador-intereses-cuotas",
  limpiar,
  main: async (prisma) => {
    const hoy = localToday();

    const banco = await crearCuenta({
      name: `${TAG}Banco`,
      kind: "CASH",
      openingBalance: "0",
    });
    const gastoCat = await crearCategoria(`${TAG}Gasto`, "EXPENSE");
    const ingresoCat = await crearCategoria(`${TAG}Ingreso`, "INCOME");

    /* ────────────────────────────────────────────────────────────────────────
     * D · EL GENERADOR
     * ──────────────────────────────────────────────────────────────────────── */
    section("D · El generador: una regla imposible no postea");

    // D0 · una regla COHERENTE en modo AUTO: postea sola.
    const reglaOk = await post("/api/recurrence/rules", {
      title: `${TAG}Regla buena`,
      kind: "EXPENSE",
      amount: "123.45",
      freq: "MONTHLY",
      startDate: hoy,
      accountId: banco.id,
      categoryName: gastoCat.name,
      postingMode: "AUTO",
    });
    check("D0 · (andamiaje) la regla coherente se creó", reglaOk.status, 201);
    if (reglaOk.body?.id) { creados.reglas.push(reglaOk.body.id); idsReglasPropios.push(reglaOk.body.id); }

    // D1 · una regla IMPOSIBLE (Ingreso con categoría de Gasto) escrita por
    //      SQL con el trigger apagado: es el caso que el trigger ya no deja
    //      crear, pero que puede existir en una base vieja.
    const idImposible = randomUUID();
    await sqlWrite(
      prisma,
      `ALTER TABLE "RecurrenceRule" DISABLE TRIGGER "recurrence_category_kind_check"`,
    );
    const d1a = await sqlWrite(
      prisma,
      `INSERT INTO "RecurrenceRule" ("id","title","kind","amount","freq","startDate","accountId","categoryId","postingMode","updatedAt")
       VALUES ($1,$2,'INCOME',$3::numeric,'MONTHLY',$4::date,$5,$6,'AUTO',now())`,
      [idImposible, `${TAG}Regla imposible`, "77.00", hoy, banco.id, gastoCat.id],
    );
    await sqlWrite(
      prisma,
      `ALTER TABLE "RecurrenceRule" ENABLE TRIGGER "recurrence_category_kind_check"`,
    );
    checkTrue(
      "D1 · (andamiaje) la regla imposible se pudo escribir con el trigger apagado",
      d1a.ok,
      d1a.error ?? "",
    );
    if (d1a.ok) { creados.reglas.push(idImposible); idsReglasPropios.push(idImposible); }

    // D2 · la corrida: la imposible NO postea y la buena SÍ.
    const corrida = await post("/api/recurrence/run", {});
    check("D2 · la corrida responde 200", corrida.status, 200);

    const filaImposible = (corrida.body?.rules ?? []).find(
      (r) => r.ruleId === idImposible,
    );
    checkTrue("D2 · la regla imposible aparece en el resultado de la corrida", !!filaImposible);
    check("D2 · y no posteó nada", filaImposible?.posted ?? -1, 0);
    checkTrue(
      "D2 · sus ocurrencias quedaron pendientes (en la bandeja)",
      (filaImposible?.pending ?? 0) > 0,
      `pending=${filaImposible?.pending}`,
    );

    const bloqueada = (corrida.body?.blocked ?? []).find(
      (b) => b.ruleId === idImposible,
    );
    checkTrue("D2 · la corrida reporta la regla como bloqueada", !!bloqueada);
    checkIncluye(
      "D2 · el motivo dice el nombre de la categoría",
      bloqueada?.reason ?? "",
      gastoCat.name,
    );
    checkIncluye(
      "D2 · el motivo dice el tipo de la categoría",
      bloqueada?.reason ?? "",
      "Gasto",
    );
    checkIncluye(
      "D2 · el motivo dice el tipo de la regla",
      bloqueada?.reason ?? "",
      "Ingreso",
    );

    const filaBuena = (corrida.body?.rules ?? []).find(
      (r) => r.ruleId === reglaOk.body?.id,
    );
    checkTrue(
      "D3 · la corrida SIGUE: la otra regla también se materializó",
      !!filaBuena,
    );
    check("D3 · y la regla coherente posteó su movimiento", filaBuena?.posted ?? -1, 1);

    // D4 · el movimiento de la regla imposible NO existe.
    const movImposible = await prisma.movement.findFirst({
      where: { recurrenceRuleId: idImposible },
    });
    checkTrue("D4 · no se escribió ningún movimiento de la regla imposible", !movImposible);

    // D5 · la ocurrencia está en la bandeja.
    const bandeja = await get("/api/recurrence");
    const pendiente = (bandeja.body?.pending ?? []).find(
      (o) => o.ruleId === idImposible,
    );
    checkTrue("D5 · la ocurrencia de la regla imposible está en la bandeja", !!pendiente);
    check("D5 · y su monto es el de la regla", pendiente?.amount, "77.00");

    // D6 · aceptarla a mano → 409 con el motivo.
    if (pendiente) {
      const aceptar = await post("/api/recurrence/occurrences", {
        id: pendiente.id,
        action: "accept",
      });
      check("D6 · aceptar una ocurrencia imposible es un 409", aceptar.status, 409);
      checkIncluye(
        "D6 · el mensaje dice por qué no se puede postear",
        aceptar.rawText,
        "no puede postear",
      );
      checkIncluye(
        "D6 · el mensaje nombra la categoría",
        aceptar.rawText,
        gastoCat.name,
      );
    }

    // D7 · la regla imposible, ¿quedó con su categoría imposible? (la fila es
    //      la que el generador tiene que_crossar)
    const filaImposibleDb = await prisma.recurrenceRule.findUnique({
      where: { id: idImposible },
      include: { category: true },
    });
    check("D7 · la regla conserva su categoría de Gasto", filaImposibleDb?.category?.kind, "EXPENSE");
    check("D7 · y la regla es de Ingreso", filaImposibleDb?.kind, "INCOME");

    // D8 · y el generador no dejó nada a medias: la regla buena sí tiene su
    //      movimiento, con la categoría del tipo correcto.
    const movBueno = await prisma.movement.findFirst({
      where: { recurrenceRuleId: reglaOk.body?.id },
      include: { category: true },
    });
    check("D8 · el movimiento de la regla buena es un gasto", movBueno?.kind, "EXPENSE");
    check("D8 · con una categoría de Gasto", movBueno?.category?.kind, "EXPENSE");
    check("D8 · y el monto exacto", movBueno?.amount?.toFixed(2), "123.45");
    if (movBueno) creados.movimientos.push(movBueno.id);

    /* ────────────────────────────────────────────────────────────────────────
     * E · EL BUG DE LOS INTERESES
     * ──────────────────────────────────────────────────────────────────────── */
    section("E · El interés que pagás y el que cobrás");

    // E0 · el préstamo que YO DEBO (LOAN) y el que ME DEBEN (RECEIVABLE).
    const prestamo = await crearCuenta({
      name: `${TAG}Préstamo`,
      kind: "LOAN",
      openingBalance: "0",
      principal: "100000.00",
      tnaPercent: "60",
      installmentCount: 6,
      firstInstallmentDate: hoy,
      amortizationSystem: "FRENCH",
    });
    const porCobrar = await crearCuenta({
      name: `${TAG}Por cobrar`,
      kind: "RECEIVABLE",
      openingBalance: "0",
      principal: "100000.00",
      tnaPercent: "60",
      installmentCount: 6,
      firstInstallmentDate: hoy,
      amortizationSystem: "FRENCH",
    });

    // Los adelantos: el préstamo de un lado, el préstamo del otro.
    const adelantoPrestamo = await post("/api/transactions", {
      kind: "TRANSFER",
      amount: "100000.00",
      date: hoy,
      accountId: prestamo.id,
      toAccountId: banco.id,
      description: `${TAG}Adelanto del préstamo`,
    });
    check("E0 · (andamiaje) el adelanto del préstamo se registró", adelantoPrestamo.status, 201);
    if (adelantoPrestamo.body?.id) creados.movimientos.push(adelantoPrestamo.body.id);

    const adelantoCobrar = await post("/api/transactions", {
      kind: "TRANSFER",
      amount: "100000.00",
      date: hoy,
      accountId: banco.id,
      toAccountId: porCobrar.id,
      description: `${TAG}Adelento de lo que presté`,
    });
    check("E0 · (andamiaje) el adelanto de lo que presté se registró", adelantoCobrar.status, 201);
    if (adelantoCobrar.body?.id) creados.movimientos.push(adelantoCobrar.body.id);

    // E1 · pagar la cuota 1 del préstamo que DEBO: el interés es un GASTO.
    const pagoPrestamo = await post("/api/loans/pay", {
      accountId: prestamo.id,
      cashAccountId: banco.id,
      date: hoy,
      installmentNumber: 1,
    });
    check("E1 · el pago de la cuota 1 del préstamo responde 201", pagoPrestamo.status, 201);
    check("E1 · el capital pagado es 14.701,75", pagoPrestamo.body?.principalPaid, "14701.75");
    check("E1 · el interés pagado es 5.000,00", pagoPrestamo.body?.interestPaid, "5000.00");

    const patasPrestamo = pagoPrestamo.body?.movements ?? [];
    const capitalPrestamo = patasPrestamo.find((m) => m.kind === "TRANSFER");
    const interesPrestamo = patasPrestamo.find((m) => m.kind === "EXPENSE");
    checkTrue("E1 · una pata es la transferencia del capital", !!capitalPrestamo);
    checkTrue("E1 · la otra pata es un GASTO (el interés que pagás)", !!interesPrestamo);
    check("E1 · el interés pagado es 5.000,00", interesPrestamo?.amount, "5000.00");
    for (const pata of patasPrestamo) {
      if (pata.id) creados.movimientos.push(pata.id);
    }

    const movInteresPagado = await prisma.movement.findUnique({
      where: { id: interesPrestamo?.id },
      include: { category: true },
    });
    check("E1 · el interés que PAGÁS es un Gasto", movInteresPagado?.kind, "EXPENSE");
    check("E1 · con una categoría de Gasto", movInteresPagado?.category?.kind, "EXPENSE");
    check("E1 · y la categoría se llama «Intereses»", movInteresPagado?.category?.name, "Intereses");

    // E2 · cobrar la cuota 1 de lo que ME DEBEN: el interés es un INGRESO.
    const pagoCobrar = await post("/api/loans/pay", {
      accountId: porCobrar.id,
      cashAccountId: banco.id,
      date: hoy,
      installmentNumber: 1,
    });
    check("E2 · el cobro de la cuota 1 responde 201", pagoCobrar.status, 201);
    check("E2 · el capital recuperado es 14.701,75", pagoCobrar.body?.principalPaid, "14701.75");
    check("E2 · el interés cobrado es 5.000,00", pagoCobrar.body?.interestPaid, "5000.00");

    const patasCobrar = pagoCobrar.body?.movements ?? [];
    const capitalCobrar = patasCobrar.find((m) => m.kind === "TRANSFER");
    const interesCobrar = patasCobrar.find((m) => m.kind === "INCOME");
    checkTrue("E2 · una pata es la transferencia del capital", !!capitalCobrar);
    checkTrue("E2 · la otra pata es un INGRESO (el interés que cobrás)", !!interesCobrar);
    check("E2 · el interés cobrado es 5.000,00", interesCobrar?.amount, "5000.00");
    for (const pata of patasCobrar) {
      if (pata.id) creados.movimientos.push(pata.id);
    }

    const movInteresCobrado = await prisma.movement.findUnique({
      where: { id: interesCobrar?.id },
      include: { category: true },
    });
    check("E2 · el interés que COBRÁS es un Ingreso", movInteresCobrado?.kind, "INCOME");
    check("E2 · con una categoría de Ingreso", movInteresCobrado?.category?.kind, "INCOME");
    check(
      "E2 · y la categoría NO es la misma que la del que pagás",
      movInteresCobrado?.category?.id === movInteresPagado?.category?.id,
      false,
    );

    // E3 · mandar explícitamente la categoría del tipo contrario → 400.
    const catGastoPropia = await crearCategoria(`${TAG}Intereses que pago`, "EXPENSE");
    const pagoConMalaCategoria = await post("/api/loans/pay", {
      accountId: porCobrar.id,
      cashAccountId: banco.id,
      date: hoy,
      installmentNumber: 2,
      categoryName: catGastoPropia.name,
    });
    check(
      "E3 · cobrar mandando una categoría de Gasto es un 400",
      pagoConMalaCategoria.status,
      400,
    );
    checkIncluye(
      "E3 · el mensaje nombra la categoría",
      pagoConMalaCategoria.rawText,
      catGastoPropia.name,
    );
    checkIncluye(
      "E3 · el mensaje dice el tipo de la categoría",
      pagoConMalaCategoria.rawText,
      "Gasto",
    );
    checkIncluye(
      "E3 · el mensaje dice el tipo del movimiento",
      pagoConMalaCategoria.rawText,
      "ingreso",
    );

    // E4 · el 400 no dejó nada a medias: la cuota 2 sigue impaga.
    const vista = await get(`/api/loans`);
    const vistaCobrar = (vista.body?.loans ?? []).find((l) => l.id === porCobrar.id);
    check("E4 · la cuota 2 sigue sin cubrir", vistaCobrar?.plan?.paidCount, 1);
    check("E4 · y quedan 5 cuotas", vistaCobrar?.plan?.remainingCount, 5);

    // E5 · el mismo en el otro sentido: pagar mandando una categoría de Ingreso.
    const catIngresoPropia = await crearCategoria(`${TAG}Intereses que cobro`, "INCOME");
    const pagoConMalaCategoria2 = await post("/api/loans/pay", {
      accountId: prestamo.id,
      cashAccountId: banco.id,
      date: hoy,
      installmentNumber: 2,
      categoryName: catIngresoPropia.name,
    });
    check(
      "E5 · pagar mandando una categoría de Ingreso es un 400",
      pagoConMalaCategoria2.status,
      400,
    );
    checkIncluye(
      "E5 · el mensaje nombra la categoría",
      pagoConMalaCategoria2.rawText,
      catIngresoPropia.name,
    );

    /* ────────────────────────────────────────────────────────────────────────
     * F · LA COMPRA EN CUOTAS
     * ──────────────────────────────────────────────────────────────────────── */
    section("F · La compra en cuotas");

    const tarjeta = await crearCuenta({
      name: `${TAG}Tarjeta`,
      kind: "CREDIT_CARD",
      openingBalance: "0",
      closingDay: 15,
      dueDay: 5,
    });

    // F1 · una categoría de INGRESO para un gasto → 400 con el mensaje
    //      compartido (no un 500).
    const compraMala = await post("/api/cards/plans", {
      cardId: tarjeta.id,
      label: `${TAG}Compra mala`,
      totalAmount: "120000.00",
      installments: 12,
      categoryName: ingresoCat.name,
    });
    check("F1 · una compra con categoría de Ingreso es un 400", compraMala.status, 400);
    checkIncluye(
      "F1 · el mensaje nombra la categoría",
      compraMala.rawText,
      ingresoCat.name,
    );
    checkIncluye(
      "F1 · el mensaje dice el tipo de la categoría",
      compraMala.rawText,
      "Ingreso",
    );
    checkIncluye(
      "F1 · el mensaje dice el tipo del movimiento",
      compraMala.rawText,
      "gasto",
    );
    checkTrue(
      "F1 · y no es un 500",
      compraMala.status < 500,
      `status ${compraMala.status}`,
    );

    // F2 · la compra con la categoría correcta entra, y es UN gasto por el total.
    const compraBuena = await post("/api/cards/plans", {
      cardId: tarjeta.id,
      label: `${TAG}Compra buena`,
      totalAmount: "120000.00",
      installments: 12,
      categoryName: gastoCat.name,
    });
    check("F2 · la compra con categoría de Gasto se registra", compraBuena.status, 201);
    if (compraBuena.body?.id) creados.planes.push(compraBuena.body.id);
    check("F2 · son 12 cuotas", compraBuena.body?.plan?.installments, 12);
    check("F2 · y el total es 120.000,00", compraBuena.body?.plan?.totalAmount, "120000.00");
    check("F2 · el movimiento es un gasto", compraBuena.body?.plan?.movement?.kind, "EXPENSE");
    check(
      "F2 · con la categoría de Gasto",
      compraBuena.body?.plan?.movement?.category?.kind,
      "EXPENSE",
    );
    if (compraBuena.body?.plan?.movement?.id) {
      creados.movimientos.push(compraBuena.body.plan.movement.id);
    }

    // F3 · el 400 de F1 no dejó un plan a medias.
    const planes = await prisma.cardPlan.findMany({
      where: { accountId: tarjeta.id },
    });
    check("F3 · sólo quedó el plan de la compra buena", planes.length, 1);
  },
});
