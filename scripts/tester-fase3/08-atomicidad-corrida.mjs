#!/usr/bin/env node
/**
 * Test 08 — La corrida es UNA transacción DE VERDAD (prueba por rollback).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA Y POR QUÉ IMPORTA
 * ─────────────────────────────────────────────────────────────────────────────
 * El dev promete: "o se materializa todo, o no se materializa nada; reintentar
 * es seguro". Eso se puede probar forzando un fallo a mitad de la corrida:
 *
 *   1. Se crean dos reglas: una AUTO (va a postear) y una NOTIFY (va a encolar).
 *   2. Se inserta por Prisma un movimiento "colado" con (recurrenceRuleId, date)
 *      de la regla AUTO: el índice parcial lo único que hace es reventar el
 *      INSERT de la corrida con P2002, a mitad del trabajo.
 *   3. La corrida falla → NINGUNA de las dos reglas puede haber dejado filas:
 *      ni las ocurrencias de la regla NOTIFY, que ya se habrían creado antes
 *      del fallo si la transacción no abarcara todo.
 *   4. Se borra el movimiento colado y la corrida siguiente completa las dos.
 *
 * Si la transacción no abarcara lo que dice, el paso 3 mostraría filas huérfanas
 * (una puesta al día a medias): exactamente el estado que nadie sabe deshacer.
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
  post,
  section,
  summary,
} from "./helpers.mjs";

const TAG = "T_TESTER_08_";
const prisma = new PrismaClient();

async function main() {
  const hoy = localToday();
  await login();
  await cleanupTag(prisma, TAG);

  const banco = await post("/api/accounts", { name: `${TAG}Banco`, kind: "BANK" });
  const accountId = banco.body?.id;

  const mk = (suffix, postingMode) =>
    post("/api/recurrence/rules", {
      title: `${TAG}${suffix}`,
      kind: "EXPENSE",
      amount: "100",
      accountId,
      categoryName: `${TAG}Cat`,
      freq: "DAILY",
      startDate: hoy,
      postingMode,
    });

  section("Fallando la corrida a mitad de camino (movimiento colado + P2002)");
  // El ORDEN de creación importa para que la prueba sea fuerte: el generador
  // procesa por `createdAt`, así que la NOTIFY va PRIMERO (sus filas ya están
  // escritas cuando la AUTO revienta con P2002) y el rollback tiene que
  // llevárselas. Si se creara al revés, el fallo ocurriría antes de escribir
  // nada y la prueba no demostraría nada.
  const notify = await mk("notify", "NOTIFY");
  const auto = await mk("auto", "AUTO");
  check("reglas creadas (201)", [notify.status, auto.status], [201, 201]);

  const categoria = await prisma.category.findFirst({ where: { normalizedName: TAG.toLowerCase() + "cat" } });
  const colado = await prisma.movement.create({
    data: {
      kind: "EXPENSE",
      amount: "50",
      date: new Date(Date.UTC(Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7)) - 1, Number(hoy.slice(8, 10)))),
      description: `${TAG}colado`,
      accountId,
      categoryId: categoria.id,
      recurrenceRuleId: auto.body?.id,
    },
  });
  checkTrue("el movimiento colado existe (la DB lo permite: no hay ocurrencia)", Boolean(colado.id));

  const corrida = await post("/api/recurrence/run", {});
  console.log(`      (la corrida falló con status ${corrida.status}: ${JSON.stringify(corrida.body)})`);
  checkTrue("la corrida NO responde 2xx", corrida.status >= 400, `status=${corrida.status}`);

  const occAuto = await prisma.recurrenceOccurrence.count({ where: { ruleId: auto.body?.id } });
  const occNotify = await prisma.recurrenceOccurrence.count({ where: { ruleId: notify.body?.id } });
  check("la regla AUTO no dejó ocurrencias a medias", occAuto, 0);
  check("la regla NOTIFY tampoco (eso es el rollback de la transacción)", occNotify, 0);
  const movsPosteados = await prisma.movement.count({
    where: { recurrenceRuleId: { in: [auto.body?.id, notify.body?.id] } },
  });
  check("y no quedó ningún movimiento de la corrida (sólo el colado)", movsPosteados, 1);

  section("Reintento: sacado el colado, la corrida completa las dos");
  await prisma.movement.delete({ where: { id: colado.id } });

  const reintento = await post("/api/recurrence/run", {});
  check("el reintento responde 200", reintento.status, 200);
  check("materializó las dos ocurrencias", reintento.body?.materialized, 2);
  check("posteó 1 (la AUTO)", reintento.body?.posted, 1);
  check("encoló 1 (la NOTIFY)", reintento.body?.pending, 1);
  checkTrue("fechas de la AUTO", JSON.stringify(await occurrenceDates(prisma, auto.body?.id)) === JSON.stringify([hoy]));
  checkTrue("fechas de la NOTIFY", JSON.stringify(await occurrenceDates(prisma, notify.body?.id)) === JSON.stringify([hoy]));

  section("Limpieza");
  await cleanupTag(prisma, TAG);
  check("quedan 0 reglas de prueba", await prisma.recurrenceRule.count({ where: { title: { startsWith: TAG } } }), 0);
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
