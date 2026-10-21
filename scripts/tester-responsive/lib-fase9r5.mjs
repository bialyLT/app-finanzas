#!/usr/bin/env node
/**
 * lib-fase9r5.mjs — el escenario y las sondas de la ronda 9 r5 («la banderita de
 * la cuenta»).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL ESCENARIO (por qué julio de 2026)
 *
 * El brief de la ronda trae los números de la persona: una cuenta «Efectivo» con
 * 7.000 de saldo inicial, un ingreso de 325.000 y dos gastos (325.000 y 6.400).
 * Con la banderita encendida, los ingresos del mes dan 332.000, el ahorro +600 y
 * el patrimonio no se mueve.
 *
 * Esos números NO se pueden medir en `finanzas_dev` (la base de la persona es
 * intocable) y tampoco en octubre de `finanzas_test`, porque octubre viene
 * sembrado con el smoke (sueldo de 800.000, gastos, la cuota del préstamo) y los
 * números del mes quedarían mezclados con el seed.
 *
 * Julio de 2026 está VACÍO en el seed (verificado: los movimientos del seed son
 * del 30/09, de octubre y de enero de 2027), así que el escenario se puede
 * reproducir con números EXACTOS: los mismos 325.000 / 325.000 / 6.400 y el
 * mismo 7.000 declarado. Si la fórmula de la plata declarada está bien, los
 * números de esta batería tienen que ser los de la tabla del dev.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAS RIENDAS
 *
 * Todo lo de esta biblioteca corre contra `finanzas_test` y la instancia de
 * pruebas. Las riendas están en `lib-fase9r3.mjs` (misma base, puerto ≠ 3000) y
 * se revalidan en cada batería: una batería que puede escribir en la base de la
 * persona no es una batería, es un riesgo.
 */

import { clienteDePruebas, verificarDestino, api, post, patch, login } from "./lib-fase9r3.mjs";
import { check, checkTrue, checkIncluye, section } from "../tester-fase7/helpers.mjs";

export { check, checkTrue, checkIncluye, section, api, post, patch, login };
export { correrBateria, sql } from "./lib-fase9r3.mjs";

/** La espera corta y acotada de las sondas. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** El prefijo de TODO lo que esta ronda crea (para borrar por id). */
export const TAG = "T9R5";

/** El mes del escenario: vacío en el seed (ver arriba). */
export const MES = "2026-07";
export const DESDE = "2026-07-01";
export const HASTA = "2026-07-31";

/** El saldo inicial de la cuenta del escenario (el 7.000 de la persona). */
export const SALDO = "7000";
/** Lo que la persona declaró: el 7.000 cuenta como ingreso de SU mes. */
export const DECLARADO = "7000.00";

/**
 * Crea el escenario completo (cuenta + categorías + movimientos) SIN la
 * banderita. Devuelve los ids para poder limpiar por id y para medir.
 */
export async function crearEscenario() {
  const cuenta = await post("/api/accounts", {
    name: `${TAG} Efectivo`,
    kind: "CASH",
    openingBalance: SALDO,
  });
  if (cuenta.status !== 201) {
    throw new Error(`No se pudo crear la cuenta del escenario: ${cuenta.status} ${cuenta.rawText}`);
  }
  const id = cuenta.body.id;

  const ingreso = await post("/api/categories", { name: `${TAG} Sueldo`, kind: "INCOME" });
  const alquiler = await post("/api/categories", { name: `${TAG} Alquiler`, kind: "EXPENSE" });
  const kiosco = await post("/api/categories", { name: `${TAG} Kiosco`, kind: "EXPENSE" });

  const movimientos = [];
  const crear = async (body) => {
    const r = await post("/api/transactions", body);
    if (r.status !== 201) {
      throw new Error(`No se pudo crear el movimiento: ${r.status} ${r.rawText}`);
    }
    movimientos.push(r.body.id);
    return r.body;
  };

  await crear({
    kind: "INCOME",
    amount: "325000",
    date: "2026-07-19",
    accountId: id,
    categoryName: `${TAG} Sueldo`,
    description: `${TAG} Sueldo de julio`,
  });
  await crear({
    kind: "EXPENSE",
    amount: "325000",
    date: "2026-07-20",
    accountId: id,
    categoryName: `${TAG} Alquiler`,
    description: `${TAG} Alquiler de julio`,
  });
  await crear({
    kind: "EXPENSE",
    amount: "6400",
    date: "2026-07-20",
    accountId: id,
    categoryName: `${TAG} Kiosco`,
    description: `${TAG} Kiosco de julio`,
  });

  return {
    cuentaId: id,
    categorias: {
      ingreso: ingreso.body?.id,
      alquiler: alquiler.body?.id,
      kiosco: kiosco.body?.id,
    },
    movimientos,
  };
}

/** Enciende (o apaga) la banderita de la cuenta del escenario. */
export function banderita(cuentaId, mes) {
  return patch("/api/accounts", { id: cuentaId, openingIncomeMonth: mes });
}

/** Los totales del panel para el mes del escenario. */
export function totalesDelPanel() {
  return api(`/api/transactions?from=${DESDE}&to=${HASTA}`);
}

/** La reconciliación del mes del escenario. */
export function conciliacion(asOf) {
  return api(`/api/reconciliation?month=${MES}${asOf ? `&asOf=${asOf}` : ""}`);
}

/** El reporte de deudas (DTI) del mes del escenario. */
export function deudas(asOf) {
  return api(`/api/debts?month=${MES}${asOf ? `&asOf=${asOf}` : ""}`);
}

/** El reporte de /analisis del mes del escenario. */
export function reporte(params = "") {
  return api(`/api/reports?from=${DESDE}&to=${HASTA}${params}`);
}

/** El patrimonio (net worth) de HOY. */
export function patrimonio() {
  return api("/api/accounts");
}

/**
 * Borra el escenario POR ID (nunca un `deleteMany` sin filtro).
 *
 * El orden importa por los FK: los movimientos primero (la cuenta tiene
 * `Restrict`), después las categorías, después la cuenta.
 */
export async function limpiarEscenario(prisma, ids) {
  if (!ids) return;
  const movimientoIds = ids.movimientos ?? [];
  if (movimientoIds.length > 0) {
    await prisma.movement.deleteMany({ where: { id: { in: movimientoIds } } });
  }
  if (ids.cuentaId) {
    await prisma.account.deleteMany({ where: { id: ids.cuentaId } });
  }
  await prisma.category.deleteMany({
    where: { name: { startsWith: `${TAG} ` } },
  });
}

/**
 * Borra por prefijo lo que haya quedado de una corrida anterior (por si una
 * batería se cortó a mitad de camino). Sólo toca filas con el prefijo de la
 * ronda: la base del seed queda intacta.
 */
export async function limpiarPorPrefijo(prisma) {
  const cuentas = await prisma.account.findMany({
    where: { name: { startsWith: `${TAG} ` } },
    select: { id: true },
  });
  const ids = cuentas.map((c) => c.id);
  if (ids.length > 0) {
    await prisma.statement.deleteMany({ where: { accountId: { in: ids } } });
    await prisma.cardPlan.deleteMany({ where: { accountId: { in: ids } } });
    await prisma.installment.deleteMany({ where: { accountId: { in: ids } } });
    await prisma.movement.deleteMany({
      where: { OR: [{ accountId: { in: ids } }, { toAccountId: { in: ids } }] },
    });
    await prisma.account.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.movement.deleteMany({ where: { description: { startsWith: `${TAG} ` } } });
  await prisma.category.deleteMany({ where: { name: { startsWith: `${TAG} ` } } });
}

/**
 * Limpia y ADEMÁS comprueba que no quedó nada.
 *
 * El residuo es un bug de la batería (no del producto): una cuenta que la
 * batería dejó viva cambia los números del mes que se está midiendo y hace
 * que el reporte diga «el producto calcula mal» cuando lo que pasó es que la
 * batería no limpió. Por eso el residuo se verifica, no se supone.
 */
export async function limpiarYVerificar(prisma) {
  await limpiarPorPrefijo(prisma);
  const cuentas = await prisma.account.count({ where: { name: { startsWith: `${TAG} ` } } });
  const categorias = await prisma.category.count({ where: { name: { startsWith: `${TAG} ` } } });
  const movimientos = await prisma.movement.count({
    where: { description: { startsWith: `${TAG} ` } },
  });
  check(`no quedan cuentas de la ronda (residuo)`, cuentas, 0);
  check(`no quedan categorías de la ronda (residuo)`, categorias, 0);
  check(`no quedan movimientos de la ronda (residuo)`, movimientos, 0);
}

export { clienteDePruebas, verificarDestino };
