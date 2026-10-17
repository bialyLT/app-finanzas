#!/usr/bin/env node
/**
 * Probe — ¿qué error devuelve Prisma al borrar una categoría que usa una regla?
 *
 * Es un diagnóstico (no una aserción): imprime clase, código, meta y texto del
 * error para saber QUÉ se puede mapear a una respuesta decente en la ruta de
 * categorías. Deja la base como estaba.
 */

import { PrismaClient } from "@prisma/client";

try {
  process.loadEnvFile();
} catch {}

const prisma = new PrismaClient();

const acc = await prisma.account.create({ data: { name: "T_TESTER_PB_Acc", kind: "BANK" } });
const cat = await prisma.category.upsert({
  where: { normalizedName: "t_tester_pb" },
  update: {},
  create: { name: "T_TESTER_PB", normalizedName: "t_tester_pb", kind: "EXPENSE" },
});
const rule = await prisma.recurrenceRule.create({
  data: {
    title: "T_TESTER_PB_regla",
    kind: "EXPENSE",
    amount: "10",
    accountId: acc.id,
    categoryId: cat.id,
    freq: "MONTHLY",
    dayOfMonth: 1,
    startDate: new Date(Date.UTC(2026, 7, 1)),
  },
});

try {
  await prisma.category.delete({ where: { id: cat.id } });
  console.log("DELETE categoría: NO falló (inesperado)");
} catch (error) {
  console.log("clase:", error.constructor.name);
  console.log("code:", error.code);
  console.log("meta:", JSON.stringify(error.meta));
  console.log("message:", String(error.message).slice(0, 500));
}

await prisma.recurrenceRule.delete({ where: { id: rule.id } });
await prisma.category.delete({ where: { id: cat.id } }).catch(() => {});
await prisma.account.delete({ where: { id: acc.id } }).catch(() => {});
await prisma.$disconnect();
