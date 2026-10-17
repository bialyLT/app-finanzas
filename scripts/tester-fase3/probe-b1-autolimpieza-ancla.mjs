#!/usr/bin/env node
/**
 * Sonda del fix B1, camino 2: UNA FRECUENCIA SIN ANCLA LIMPIA EL ANCLA SOLA.
 *
 * El fix de B1 tiene dos caminos: `dayOfMonth: null`/"" explícito limpia el
 * ancla, y —cuando la frecuencia resultante no admite ancla (DAILY/WEEKLY) y no
 * vino ninguna nueva— el ancla heredada se limpia sola (la forma la define
 * `freq`, criterio D8). El script 04 §1 cubre el primero; esta sonda cubre el
 * segundo y su contracara: un ancla EXPLÍCITA junto a una frecuencia que no la
 * admite sigue siendo un 400 (la hostilidad explícita no se relajó).
 *
 * Corre desde la raíz del repo: node scripts/tester-fase3/probe-b1-autolimpieza-ancla.mjs
 */

import {
  api,
  PrismaClient,
  check,
  checkTrue,
  cleanupTag,
  login,
  section,
  summary,
} from "./helpers.mjs";

const TAG = "T_TESTER_PB_b1_";
const prisma = new PrismaClient();

async function main() {
  await login();

  const account = await prisma.account.findFirst({ select: { id: true } });
  if (!account) throw new Error("No hay ninguna cuenta para colgar las reglas.");

  const ruleBody = (title, extra = {}) => ({
    title,
    kind: "EXPENSE",
    amount: "1000",
    accountId: account.id,
    categoryName: "Comida",
    freq: "MONTHLY",
    startDate: "2026-11-01",
    dayOfMonth: 1,
    ...extra,
  });

  section("1 · PATCH a DAILY sin mandar el ancla: se limpia sola");

  const regla = await api("/api/recurrence/rules", {
    method: "POST",
    body: JSON.stringify(ruleBody(`${TAG}auto`)),
  });
  check("la regla nace MONTHLY con ancla 1 (201)", regla.status, 201);
  check("ancla inicial", regla.body?.dayOfMonth, 1);

  const patchSinAncla = await api("/api/recurrence/rules", {
    method: "PATCH",
    body: JSON.stringify({ id: regla.body?.id, freq: "DAILY" }),
  });
  check("PATCH freq DAILY sin dayOfMonth → 200", patchSinAncla.status, 200);
  check("la frecuencia quedó en DAILY", patchSinAncla.body?.freq, "DAILY");
  check("el ancla heredada se limpió sola (null)", patchSinAncla.body?.dayOfMonth, null);

  const enBase = await prisma.recurrenceRule.findUnique({
    where: { id: regla.body?.id },
    select: { freq: true, dayOfMonth: true },
  });
  checkTrue(
    "y en la base también (DAILY, dayOfMonth null)",
    enBase?.freq === "DAILY" && enBase?.dayOfMonth === null,
    JSON.stringify(enBase),
  );

  section("2 · Un ancla EXPLÍCITA en una frecuencia sin ancla sigue rechazada");

  const conAncla = await api("/api/recurrence/rules", {
    method: "POST",
    body: JSON.stringify(ruleBody(`${TAG}hostil`)),
  });
  check("segunda regla MONTHLY con ancla (201)", conAncla.status, 201);

  const patchHostil = await api("/api/recurrence/rules", {
    method: "PATCH",
    body: JSON.stringify({ id: conAncla.body?.id, freq: "DAILY", dayOfMonth: 15 }),
  });
  check("PATCH DAILY + dayOfMonth 15 explícito → 400", patchHostil.status, 400);
  checkTrue(
    "y lo explica en castellano",
    typeof patchHostil.body?.error === "string" &&
      patchHostil.body.error.includes("mensuales o anuales"),
    JSON.stringify(patchHostil.body),
  );

  const intacta = await prisma.recurrenceRule.findUnique({
    where: { id: conAncla.body?.id },
    select: { freq: true, dayOfMonth: true },
  });
  checkTrue(
    "la regla hostil quedó INTACTA (MONTHLY, ancla 1): el rechazo no escribió nada",
    intacta?.freq === "MONTHLY" && intacta?.dayOfMonth === 1,
    JSON.stringify(intacta),
  );

  section("3 · `dayOfMonth: \"\"` también limpia el ancla (sin cambiar la frecuencia)");

  const patchVacio = await api("/api/recurrence/rules", {
    method: "PATCH",
    body: JSON.stringify({ id: conAncla.body?.id, dayOfMonth: "" }),
  });
  check("PATCH dayOfMonth vacío → 200", patchVacio.status, 200);
  check("la regla sigue MONTHLY", patchVacio.body?.freq, "MONTHLY");
  check("y el ancla quedó en null", patchVacio.body?.dayOfMonth, null);

  section("Limpieza");
  await cleanupTag(prisma, TAG);
  check(
    "quedan 0 reglas de prueba",
    await prisma.recurrenceRule.count({ where: { title: { startsWith: TAG } } }),
    0,
  );
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
