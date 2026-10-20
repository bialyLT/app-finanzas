#!/usr/bin/env node
/**
 * 09-residuos · ¿la ronda dejó algo en la base?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * La base es parte del producto: los flows y el smoke asertan contra el seed
 * canónico. Si una batería (mía o de la auditoría) deja una fila, la corrida
 * siguiente falla por un motivo equivocado.
 *
 * Este script cuenta, con Prisma DIRECTO, todo lo que se haya creado con los
 * prefijos de la ronda:
 *   · `__AUDIT_`  — la tarjeta descartable de la auditoría;
 *   · `T_RESPONDE_LARGO` — el ingreso del monto enorme de la batería 07;
 *   · `T_TESTER_F9*` — cualquier otra cosa que se haya creado.
 *
 * No es una batería de UI: no abre Chrome (corre en un segundo) y se puede
 * correr en cualquier momento.
 */

import { check, section, counters } from "../tester-fase7/helpers.mjs";
import { PrismaClient } from "@prisma/client";

const PREFIJOS = ["__AUDIT_", "T_RESPONDE_LARGO", "T_TESTER_F9", "T_ZONA9"];
/** Montos que usaron las baterías de la ronda (no están en el seed). */
const MONTOS_PRUEBA = ["4321.99", "987.65"];

const prisma = new PrismaClient();
let ok = false;
try {
  section("Cuentas");
  const cuentas = await prisma.account.findMany({
    where: { OR: PREFIJOS.map((p) => ({ name: { startsWith: p } })) },
    select: { id: true, name: true, kind: true },
  });
  check("no quedan cuentas de la ronda", cuentas.length, 0);
  for (const c of cuentas) console.log(`  · ${c.name} (${c.id}, ${c.kind})`);

  section("Movimientos");
  const movimientos = await prisma.movement.findMany({
    where: {
      OR: [
        ...PREFIJOS.map((p) => ({ description: { startsWith: p } })),
        { amount: { in: MONTOS_PRUEBA } },
      ],
    },
    select: { id: true, description: true, amount: true, date: true },
  });
  check("no quedan movimientos de la ronda", movimientos.length, 0);
  for (const m of movimientos) {
    console.log(
      `  · ${m.description || "(sin nota)"} ${m.amount} ${m.date.toISOString().slice(0, 10)} (${m.id})`,
    );
  }

  section("Categorías");
  const categorias = await prisma.category.findMany({
    where: { OR: PREFIJOS.map((p) => ({ name: { startsWith: p } })) },
    select: { id: true, name: true },
  });
  check("no quedan categorías de la ronda", categorias.length, 0);
  for (const c of categorias) console.log(`  · ${c.name} (${c.id})`);

  section("Plantillas (favoritos)");
  const plantillas = await prisma.favoriteTemplate.findMany({
    where: { OR: PREFIJOS.map((p) => ({ name: { startsWith: p } })) },
    select: { id: true, name: true },
  });
  check("no quedan plantillas de la ronda", plantillas.length, 0);
  for (const p of plantillas) console.log(`  · ${p.name} (${p.id})`);

  section("Reglas de recurrencia");
  const reglas = await prisma.recurrenceRule.findMany({
    where: { OR: PREFIJOS.map((p) => ({ title: { startsWith: p } })) },
    select: { id: true, title: true },
  });
  check("no quedan reglas de recurrencia de la ronda", reglas.length, 0);
  for (const r of reglas) console.log(`  · ${r.title} (${r.id})`);

  const { passed, failed } = counters;
  ok = failed === 0;
  console.log(`\n──────── ${passed} ok · ${failed} fallas ────────`);
} catch (error) {
  console.error(`\nFalló el chequeo: ${error.message ?? error}`);
  ok = false;
} finally {
  await prisma.$disconnect();
}

console.log(`RESULT ok=${counters.passed} fail=${counters.failed}`);
process.exit(ok ? 0 : 1);
