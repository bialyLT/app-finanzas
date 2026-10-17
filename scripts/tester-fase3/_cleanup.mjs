#!/usr/bin/env node
/** Limpieza puntual de restos de sondas de diagnóstico (`T_TESTER_*`). */
import { PrismaClient, cleanupTag } from "./helpers.mjs";

const prisma = new PrismaClient();
for (const tag of ["T_TESTER_DBG_", "T_TESTER_DBG2_", "T_TESTER_PB_", "T_TESTER_01_", "T_TESTER_02_", "T_TESTER_03_", "T_TESTER_04_", "T_TESTER_05_", "T_TESTER_06_", "T_TESTER_07_"]) {
  await cleanupTag(prisma, tag);
}
const rules = await prisma.recurrenceRule.findMany({ select: { title: true } });
const accs = await prisma.account.findMany({ select: { name: true } });
const occ = await prisma.recurrenceOccurrence.count();
const movsConRegla = await prisma.movement.count({ where: { recurrenceRuleId: { not: null } } });
console.log("reglas que quedan:", JSON.stringify(rules));
console.log("cuentas que quedan:", JSON.stringify(accs));
console.log("ocurrencias:", occ, "· movimientos con regla:", movsConRegla);
await prisma.$disconnect();
