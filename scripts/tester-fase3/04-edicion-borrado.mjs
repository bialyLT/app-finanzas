#!/usr/bin/env node
/**
 * Test 04 — Editar regla vs. pasado, borrar movimiento (reabre), borrar regla
 * con historia y categoría usada por una regla.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA Y POR QUÉ IMPORTA
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. EDITAR LA REGLA NO REESCRIBE LA HISTORIA. Cambiar monto o frecuencia no
 *    puede tocar ocurrencias ya materializadas ni movimientos ya posteados: es
 *    la misma regla que "un movimiento cargado no se re-escribe solo".
 *    El calendario nuevo SÍ rige para lo que viene (la proyección y las fechas
 *    posteriores a la última materializada).
 *
 * 2. BORRAR UN MOVIMIENTO DE UNA REGLA AUTO reabre la ocurrencia y NO la
 *    re-postea sola (D5 del dev). Se verifica el comportamiento REAL, que es la
 *    única fuente de verdad: un comentario de código que diga otra cosa es un
 *    hallazgo de documentación.
 *
 * 3. BORRAR UNA REGLA CON HISTORIA → 409 con mensaje que manda a archivar, y la
 *    base lo impone igual por Prisma directo (FK Restrict, P2003). El historial
 *    es el producto: sin la regla, los movimientos que posteó no son auditables.
 *
 * 4. BORRAR LA CATEGORÍA QUE USA UNA REGLA: la operación tiene que quedar
 *    bloqueada. Cómo (qué status y qué mensaje) es parte de lo que se evalúa:
 *    un 500 genérico no es una respuesta honesta para un conflicto de dominio.
 *
 * Cálculos a mano:
 *   · MONTHLY ancla 1 con inicio 2026-08-01 → vencidas al 2026-10-17: 08-01, 09-01, 10-01
 *   · tras aceptar la del 08-01: 1 movimiento de 2.000,00 (monto VIGENTE tras el PATCH)
 *   · PATCH a DAILY: fechas estrictamente posteriores a 2026-10-01 → 10-02 … 10-17 = 16
 */

import {
  PrismaClient,
  api,
  check,
  checkDeep,
  checkTrue,
  cleanupTag,
  login,
  localToday,
  post,
  section,
  summary,
} from "./helpers.mjs";

const TAG = "T_TESTER_04_";
const prisma = new PrismaClient();

async function main() {
  const hoy = localToday();
  await login();
  await cleanupTag(prisma, TAG);

  const banco = await post("/api/accounts", {
    name: `${TAG}Banco`,
    kind: "BANK",
    openingBalance: "0",
  });
  const accountId = banco.body?.id;

  /* ────────────────────────────────────────────────────────────────────────
   * 1 · Editar la regla no toca el pasado
   * ──────────────────────────────────────────────────────────────────────── */
  section("1 · Editar monto/frecuencia no toca lo materializado");

  const regla = await post("/api/recurrence/rules", {
    title: `${TAG}alquiler`,
    kind: "EXPENSE",
    amount: "1000",
    accountId,
    categoryName: `${TAG}Cat`,
    freq: "MONTHLY",
    dayOfMonth: 1,
    startDate: "2026-08-01",
    postingMode: "NOTIFY",
  });
  check("crea la regla (201)", regla.status, 201);
  const ruleId = regla.body?.id;
  const categoryId = regla.body?.category?.id;

  const corrida = await post("/api/recurrence/run", {});
  check("materializa las 3 vencidas (08-01, 09-01, 10-01)", corrida.body?.materialized, 3);

  const filasAntes = await prisma.recurrenceOccurrence.findMany({
    where: { ruleId },
    orderBy: { dueDate: "asc" },
  });
  checkDeep(
    "las 3 filas quedaron PENDING en sus fechas",
    filasAntes.map((f) => [f.status, f.dueDate.toISOString().slice(0, 10)]),
    [
      ["PENDING", "2026-08-01"],
      ["PENDING", "2026-09-01"],
      ["PENDING", "2026-10-01"],
    ],
  );

  // PATCH del monto: 1000 → 2000.
  const patchMonto = await api("/api/recurrence/rules", {
    method: "PATCH",
    body: JSON.stringify({ id: ruleId, amount: "2000" }),
  });
  check("PATCH amount → 200", patchMonto.status, 200);
  check("el DTO refleja el monto nuevo", patchMonto.body?.amount, "2000.00");

  const filasDespues = await prisma.recurrenceOccurrence.findMany({
    where: { ruleId },
    orderBy: { dueDate: "asc" },
  });
  check(
    "las filas materializadas son IDÉNTICAS (mismas fechas, mismo estado)",
    JSON.stringify(filasDespues.map((f) => [f.id, f.status, f.dueDate.toISOString().slice(0, 10)])),
    JSON.stringify(filasAntes.map((f) => [f.id, f.status, f.dueDate.toISOString().slice(0, 10)])),
  );

  // Aceptar la de agosto: la ocurrencia no está congelada, se postea con los
  // datos VIGENTES de la regla (comportamiento documentado por el dev, D9).
  const pendienteAgo = (await api("/api/recurrence")).body?.pending?.find(
    (o) => o.ruleId === ruleId && o.dueDate === "2026-08-01",
  );
  const aceptar = await post("/api/recurrence/occurrences", { id: pendienteAgo?.id, action: "accept" });
  check("aceptar la de agosto → 201", aceptar.status, 201);
  check("el movimiento usa el monto VIGENTE (2000)", aceptar.body?.occurrence?.movement?.amount, "2000.00");
  check("y la fecha de la OCURRENCIA", aceptar.body?.occurrence?.movement?.date, "2026-08-01");

  // La proyección futura SÍ cambia al editar la regla.
  const upcomingMensual = (await api("/api/recurrence")).body?.rules?.find((r) => r.id === ruleId)?.upcoming;
  checkDeep("proyección mensual", upcomingMensual, ["2026-11-01", "2026-12-01", "2027-01-01", "2027-02-01", "2027-03-01"]);

  const patchFreq = await api("/api/recurrence/rules", {
    method: "PATCH",
    body: JSON.stringify({ id: ruleId, freq: "DAILY", dayOfMonth: null }),
  });
  check("PATCH freq DAILY (sin ancla) → 200", patchFreq.status, 200);
  const upcomingDiaria = (await api("/api/recurrence")).body?.rules?.find((r) => r.id === ruleId)?.upcoming;
  checkDeep("la proyección futura ahora es diaria", upcomingDiaria, [
    "2026-10-18",
    "2026-10-19",
    "2026-10-20",
    "2026-10-21",
    "2026-10-22",
  ]);

  // Correr con la frecuencia nueva: rige SÓLO después de la última materializada.
  const corridaDiaria = await post("/api/recurrence/run", {});
  check("la corrida diaria materializa 16 (10-02 … 10-17)", corridaDiaria.body?.materialized, 16);

  // Y otro PATCH más: el movimiento YA POSTEADO no se toca nunca.
  const patchMas = await api("/api/recurrence/rules", {
    method: "PATCH",
    body: JSON.stringify({ id: ruleId, amount: "3000" }),
  });
  check("PATCH amount → 3000", patchMas.status, 200);
  const movimientoAgo = await prisma.movement.findFirst({
    where: { recurrenceRuleId: ruleId, date: new Date(Date.UTC(2026, 7, 1)) },
  });
  check("el movimiento del 08-01 sigue en 2000,00 (el pasado no se reescribe)", movimientoAgo?.amount.toFixed(2), "2000.00");
  const ocurrenciaAgo = await prisma.recurrenceOccurrence.findFirst({
    where: { ruleId, dueDate: new Date(Date.UTC(2026, 7, 1)) },
  });
  check("su ocurrencia sigue POSTED y apuntando al mismo movimiento", ocurrenciaAgo?.movementId, movimientoAgo?.id);

  /* ────────────────────────────────────────────────────────────────────────
   * 2 · Borrar el movimiento de una regla AUTO
   * ──────────────────────────────────────────────────────────────────────── */
  section("2 · Borrar el movimiento de una regla AUTO reabre y NO re-postea");

  const reglaAuto = await post("/api/recurrence/rules", {
    title: `${TAG}auto`,
    kind: "EXPENSE",
    amount: "500",
    accountId,
    categoryName: `${TAG}Cat`,
    freq: "DAILY",
    startDate: hoy,
    postingMode: "AUTO",
  });
  const corridaAuto = await post("/api/recurrence/run", {});
  check("la regla AUTO postea sola", corridaAuto.body?.posted >= 1, true);
  const movAuto = await prisma.movement.findFirst({ where: { recurrenceRuleId: reglaAuto.body?.id } });
  checkTrue("existe el movimiento posteado", Boolean(movAuto));

  const borrar = await api(`/api/transactions?id=${movAuto?.id}`, { method: "DELETE" });
  check("DELETE del movimiento → 204", borrar.status, 204);

  const ocurrenciaReabierta = await prisma.recurrenceOccurrence.findFirst({
    where: { ruleId: reglaAuto.body?.id },
  });
  check("la ocurrencia volvió a PENDING", ocurrenciaReabierta?.status, "PENDING");
  check("sin movementId (el CHECK la exige consistente)", ocurrenciaReabierta?.movementId, null);

  const corridaReposteo = await post("/api/recurrence/run", {});
  const movsAuto = await prisma.movement.count({ where: { recurrenceRuleId: reglaAuto.body?.id } });
  check("la corrida siguiente NO la re-postea (materialized 0 para la fecha ya vista)", corridaReposteo.body?.materialized, 0);
  check("y sigue habiendo 0 movimientos de la regla", movsAuto, 0);

  const enBandeja = (await api("/api/recurrence")).body?.pending?.some(
    (o) => o.ruleId === reglaAuto.body?.id,
  );
  check("la ocurrencia reabierta espera en la bandeja", enBandeja, true);

  const aceptarAMano = await post("/api/recurrence/occurrences", {
    id: ocurrenciaReabierta?.id,
    action: "accept",
  });
  check("aceptarla a mano sí la postea (201)", aceptarAMano.status, 201);

  /* ────────────────────────────────────────────────────────────────────────
   * 3 · Borrar la regla con historia
   * ──────────────────────────────────────────────────────────────────────── */
  section("3 · Borrar la regla con historia");

  const borrarRegla = await api(`/api/recurrence/rules?id=${ruleId}`, { method: "DELETE" });
  check("DELETE de la regla con historia → 409", borrarRegla.status, 409);
  checkTrue(
    "el mensaje manda a archivarla",
    typeof borrarRegla.body?.error === "string" && /archiv/i.test(borrarRegla.body.error),
    JSON.stringify(borrarRegla.body),
  );

  let errorPrisma = null;
  try {
    await prisma.recurrenceRule.delete({ where: { id: ruleId } });
  } catch (error) {
    errorPrisma = error;
  }
  checkTrue("Prisma directo tampoco puede borrarla (FK Restrict)", errorPrisma !== null);
  check("  el código es P2003", errorPrisma?.code, "P2003");
  const sigueViva = await prisma.recurrenceRule.findUnique({ where: { id: ruleId } });
  checkTrue("la regla sigue existiendo", sigueViva !== null);

  const archivar = await api("/api/recurrence/rules", {
    method: "PATCH",
    body: JSON.stringify({ id: ruleId, status: "ARCHIVED" }),
  });
  check("archivarla → 200", archivar.status, 200);
  const enVista = (await api("/api/recurrence")).body?.rules?.some((r) => r.id === ruleId);
  check("ya no aparece en la vista", enVista, false);
  const historiaViva = await prisma.movement.count({ where: { recurrenceRuleId: ruleId } });
  check("sus movimientos siguen en la base", historiaViva, 1);

  /* ────────────────────────────────────────────────────────────────────────
   * 4 · Borrar la categoría que usa una regla
   * ──────────────────────────────────────────────────────────────────────── */
  section("4 · Borrar la categoría que usa una regla");

  const borrarCategoria = await api(`/api/categories?id=${categoryId}`, { method: "DELETE" });
  console.log(`      (respuesta de DELETE categoría: ${borrarCategoria.status} ${JSON.stringify(borrarCategoria.body)})`);
  checkTrue(
    "la categoría NO se borró (bloqueado)",
    (await prisma.category.findUnique({ where: { id: categoryId } })) !== null,
  );
  check("el status esperado es 409 (conflicto de dominio, no 500)", borrarCategoria.status, 409);
  checkTrue(
    "y el mensaje explica la causa (menciona la regla o la recurrencia)",
    typeof borrarCategoria.body?.error === "string" &&
      /regla|recurren/i.test(borrarCategoria.body.error),
    JSON.stringify(borrarCategoria.body),
  );

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
