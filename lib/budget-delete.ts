/**
 * El borrado de un presupuesto se confirma EN LA UI, en dos pasos.
 *
 * `window.confirm()` no existe para el driver web (bloquea el hilo y el paso
 * siguiente muere con un error que no lo menciona), así que el primer toque
 * sólo deja el borrado PENDIENTE y el segundo botón lo ejecuta. Este módulo es
 * la máquina de estados mínima: quién está pendiente y si el pedido de
 * confirmación corresponde a ese presupuesto.
 */

export type PendingBudgetDeletion = string | null;

/** Primer paso: apuntar a un presupuesto (sin borrar nada todavía). */
export function requestBudgetDeletion(id: string): PendingBudgetDeletion {
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  return trimmed === "" ? null : trimmed;
}

/** Segundo paso cancelado (o el diálogo se cerró). */
export function cancelBudgetDeletion(): PendingBudgetDeletion {
  return null;
}

/**
 * ¿El pedido de confirmación es para el presupuesto que está pendiente?
 *
 * Evita ejecutar un DELETE con un id que ya no es el que la persona está
 * mirando (otro toque en la lista, un cambio de mes, un doble submit).
 */
export function isBudgetDeletionConfirmed(
  pending: PendingBudgetDeletion,
  id: string,
): boolean {
  if (typeof pending !== "string" || typeof id !== "string") return false;
  return pending !== "" && pending === id.trim();
}
