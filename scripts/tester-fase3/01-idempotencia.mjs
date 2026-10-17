#!/usr/bin/env node
/**
 * Test 01 — Doble posteo, idempotencia y concurrencia.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA Y POR QUÉ IMPORTA
 * ─────────────────────────────────────────────────────────────────────────────
 * Aceptar una ocurrencia crea un movimiento: plata que existe. Que dos pedidos
 * de "aceptar" (doble clic, dos pestañas, reintento) puedan crear DOS movimientos
 * por la misma fecha es el peor defecto posible de una app de finanzas.
 *
 * Se verifica en las tres capas que el dev promete en su informe:
 *   1. aceptar dos veces la misma ocurrencia → un solo movimiento, `created:false`
 *      en el segundo (idempotencia de la API);
 *   2. five accepts EN PARALELO (`Promise.all`) → un solo movimiento, el mismo id
 *      en todas las respuestas (reclamo condicional + transacción);
 *   3. insertar a mano por Prisma un segundo movimiento con el mismo
 *      (recurrenceRuleId, date) → P2002 del índice parcial (la base como última
 *      defensa).
 *
 * Además: correr el generador dos veces seguidas no duplica nada, y dos
 * movimientos MANUALES de la misma fecha en la misma cuenta siguen permitidos
 * (el índice parcial no puede romper casos legítimos).
 *
 * Cálculo a mano del caso central:
 *   regla DAILY, startDate = hoy, monto 100 → una ocurrencia (hoy).
 *   Tras aceptar (por cualquier vía): 1 movimiento de 100,00 en total.
 */

import {
  PrismaClient,
  api,
  check,
  checkTrue,
  cleanupTag,
  login,
  localToday,
  occurrenceDates,
  section,
  summary,
  post,
} from "./helpers.mjs";

const TAG = "T_TESTER_01_";

const prisma = new PrismaClient();

async function main() {
  const hoy = localToday();
  await login();
  await cleanupTag(prisma, TAG);

  section(`Setup (hoy = ${hoy})`);
  const banco = await post("/api/accounts", {
    name: `${TAG}Banco`,
    kind: "BANK",
    openingBalance: "0",
  });
  check("crea la cuenta de prueba (201)", banco.status, 201);
  const accountId = banco.body?.id;

  const mkRule = (title) =>
    post("/api/recurrence/rules", {
      title: `${TAG}${title}`,
      kind: "EXPENSE",
      amount: "100",
      accountId,
      categoryName: `${TAG}Cat`,
      freq: "DAILY",
      startDate: hoy,
      postingMode: "NOTIFY",
    });

  /* ── 1. Aceptar dos veces la MISMA ocurrencia ──────────────────────────── */
  section("1 · Aceptar dos veces la misma ocurrencia");
  const r1 = await mkRule("secuencial");
  check("crea la regla (201)", r1.status, 201);
  const run1 = await post("/api/recurrence/run", {});
  check("la corrida materializa 1 ocurrencia", run1.body?.materialized, 1);

  const pending1 = (await api("/api/recurrence")).body?.pending ?? [];
  const occ1 = pending1.find((o) => o.ruleId === r1.body?.id);
  checkTrue("la ocurrencia está en la bandeja", Boolean(occ1), JSON.stringify(pending1));

  const accept1 = await post("/api/recurrence/occurrences", { id: occ1.id, action: "accept" });
  check("primer accept → 201 creado", accept1.status, 201);
  check("  created=true", accept1.body?.created, true);

  const accept2 = await post("/api/recurrence/occurrences", { id: occ1.id, action: "accept" });
  check("segundo accept → 200 idempotente", accept2.status, 200);
  check("  created=false", accept2.body?.created, false);
  check(
    "  devuelve el MISMO movimiento",
    accept2.body?.occurrence?.movementId,
    accept1.body?.occurrence?.movementId,
  );

  const movsR1 = await prisma.movement.count({ where: { recurrenceRuleId: r1.body?.id } });
  check("en la base hay UN solo movimiento de la regla", movsR1, 1);

  /* ── 2. Accepts EN PARALELO ────────────────────────────────────────────── */
  section("2 · Cinco accepts en paralelo (Promise.all)");
  const r2 = await mkRule("paralela");
  await post("/api/recurrence/run", {});
  const pending2 = (await api("/api/recurrence")).body?.pending ?? [];
  const occ2 = pending2.find((o) => o.ruleId === r2.body?.id);
  checkTrue("la ocurrencia está en la bandeja", Boolean(occ2));

  const paralelos = await Promise.all(
    Array.from({ length: 5 }, () =>
      post("/api/recurrence/occurrences", { id: occ2.id, action: "accept" }),
    ),
  );
  const statuses = paralelos.map((r) => r.status).sort();
  const createdFlags = paralelos.map((r) => r.body?.created).sort();
  const movementIds = new Set(paralelos.map((r) => r.body?.occurrence?.movementId));

  check("los 5 status son [200,200,200,200,201]", JSON.stringify(statuses), "[200,200,200,200,201]");
  check(
    "created = [false,false,false,false,true] (uno solo creó)",
    JSON.stringify(createdFlags),
    "[false,false,false,false,true]",
  );
  check("las 5 respuestas apuntan al MISMO movimiento", movementIds.size, 1);
  const movsR2 = await prisma.movement.count({ where: { recurrenceRuleId: r2.body?.id } });
  check("en la base hay UN solo movimiento de la regla (pese a 5 accepts)", movsR2, 1);

  /* ── 3. Correr el generador dos veces seguidas ─────────────────────────── */
  section("3 · Correr el generador dos veces seguidas");
  const antes = await prisma.recurrenceOccurrence.count();
  const run2 = await post("/api/recurrence/run", {});
  check("segunda corrida materializa 0", run2.body?.materialized, 0);
  check("  posted 0", run2.body?.posted, 0);
  check("  pending 0", run2.body?.pending, 0);
  check("  capped false", run2.body?.capped, false);
  const despues = await prisma.recurrenceOccurrence.count();
  check("no cambió el total de ocurrencias en la base", despues, antes);

  /* ── 4. Doble posteo por Prisma DIRECTO (la base es la última defensa) ── */
  section("4 · Doble posteo intentado por Prisma directo");
  const postedRow = await prisma.movement.findFirst({
    where: { recurrenceRuleId: r2.body?.id },
    select: { date: true },
  });
  let directError = null;
  try {
    await prisma.movement.create({
      data: {
        kind: "EXPENSE",
        amount: "999.99",
        date: postedRow.date,
        description: `${TAG}intento directo`,
        accountId,
        categoryId: (
          await prisma.movement.findFirst({
            where: { recurrenceRuleId: r2.body?.id },
            select: { categoryId: true },
          })
        ).categoryId,
        recurrenceRuleId: r2.body?.id,
      },
    });
  } catch (error) {
    directError = error;
  }
  checkTrue("la base RECHAZA el segundo movimiento de la misma fecha", directError !== null);
  check("  el código es P2002 (índice parcial)", directError?.code, "P2002");
  const movsR2Despues = await prisma.movement.count({ where: { recurrenceRuleId: r2.body?.id } });
  check("sigue habiendo 1 solo movimiento de la regla", movsR2Despues, 1);

  /* ── 5. Dos movimientos MANUALES de la misma fecha siguen permitidos ──── */
  section("5 · El índice parcial no rompe casos legítimos");
  const manual = (n) =>
    post("/api/transactions", {
      kind: "EXPENSE",
      amount: "10",
      date: hoy,
      accountId,
      categoryName: `${TAG}Cat`,
      description: `${TAG}manual ${n}`,
    });
  const m1 = await manual(1);
  const m2 = await manual(2);
  check("un gasto manual del mismo día (201)", m1.status, 201);
  check("otro gasto manual del mismo día (201)", m2.status, 201);

  section("Limpieza");
  await cleanupTag(prisma, TAG);
  const resto = await prisma.recurrenceRule.count({ where: { title: { startsWith: TAG } } });
  check("quedan 0 reglas de prueba", resto, 0);
}

main()
  .then(() => {
    const ok = summary();
    process.exitCode = ok ? 0 : 1;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
