/**
 * El tipo de una categoría y el tipo de un movimiento tienen que ser el mismo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ VIVE EN UN MÓDULO PROPIO Y NO EN CADA CAPA
 *
 * La regla cruza tres capas (la API, el generador y el formulario) y las tres
 * tienen que decir LO MISMO: si la API dice "usá una categoría de Ingreso" y el
 * formulario dice "cambiale el tipo a la regla", la persona recibe dos
 * consignas distintas para el mismo error y no sabe a cuál obeyecer.
 *
 * Por eso el mensaje se arma ACÁ, en un solo lugar, y cada capa lo usa:
 *
 *   · la API (POST /api/transactions, POST /api/recurrence/rules) responde 400
 *     con este texto;
 *   · el generador (lib/recurring.ts) no postea el movimiento imposible y
 *     reporta por qué;
 *   · el formulario de recurrencia avisa antes de que llegue al servidor.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ LA CATEGORÍA NO SE "ARREGLA" SOLA
 *
 * Podría parecer que la solución es cambiar el tipo de la categoría para que
 * coincida con el movimiento. NO: una categoría en uso ya clasifica
 * movimientos, y cambiarle el tipo dejaría a todos esos movimientos
 * contradiciéndola. El tipo de una categoría en uso es inmutable — y eso lo
 * hace cumplir la base (trigger `category_kind_immutable_check`).
 *
 * Lo que SÍ se puede es lo que esta app propone: usar otra categoría, o
 * derivar el tipo del movimiento del tipo de la categoría (que es lo que hace
 * el formulario de recurrencia con un botón).
 */

/** Los tres tipos de movimiento, con el nombre que ve la persona. */
export const MOVEMENT_KIND_LABEL: Record<
  "INCOME" | "EXPENSE" | "TRANSFER",
  string
> = {
  INCOME: "Ingreso",
  EXPENSE: "Gasto",
  TRANSFER: "Transferencia",
};

/** Los dos tipos de categoría, con el nombre que ve la persona. */
export const CATEGORY_KIND_LABEL: Record<"INCOME" | "EXPENSE", string> = {
  INCOME: "Ingreso",
  EXPENSE: "Gasto",
};

/**
 * ¿El tipo del movimiento contradice el de la categoría?
 *
 * Una TRANSFERENCIA no se categoriza (no es ni un ingreso ni un gasto), así
 * que nunca contradice: la pregunta no tiene sentido para ella.
 */
export function categoryKindConflicts(
  kind: "INCOME" | "EXPENSE" | "TRANSFER",
  categoryKind: "INCOME" | "EXPENSE",
): boolean {
  if (kind === "TRANSFER") return false;
  return kind !== categoryKind;
}

/**
 * El mensaje para la persona, con lo que pidió y por qué se rechaza.
 *
 * Dice QUÉ se pidió (el tipo del movimiento), QUÉ se encontró (el tipo de la
 * categoría) y QUÉ hacer (usar otra categoría o derivar el tipo). Un mensaje
 * que sólo dice "error" obliga a leer el código.
 */
export function categoryKindMessage(
  categoryName: string,
  kind: "INCOME" | "EXPENSE" | "TRANSFER",
  categoryKind: "INCOME" | "EXPENSE",
): string {
  const nombre = categoryName.trim() || "la categoría";
  return (
    `La categoría «${nombre}» es de tipo ${CATEGORY_KIND_LABEL[categoryKind]} ` +
    `y no puede clasificar un ${MOVEMENT_KIND_LABEL[kind].toLowerCase()}. ` +
    `Usá una categoría de tipo ${MOVEMENT_KIND_LABEL[kind]} o creá una nueva con otro nombre.`
  );
}

/**
 * El mismo aviso, pero para una REGLA de recurrencia.
 *
 * La diferencia no es de forma: una regla es la PROMESA de un movimiento, así
 * que el remedy es distinto. En un movimiento se cambia la categoría; en una
 * regla se puede cambiar el TIPO de la regla (que es lo que ofrece el
 * formulario), y eso es lo que el mensaje tiene que ofrecer también.
 */
export function ruleCategoryKindMessage(
  categoryName: string,
  kind: "INCOME" | "EXPENSE" | "TRANSFER",
  categoryKind: "INCOME" | "EXPENSE",
): string {
  const nombre = categoryName.trim() || "la categoría";
  return (
    `La categoría «${nombre}» es de tipo ${CATEGORY_KIND_LABEL[categoryKind]} ` +
    `y la regla es de tipo ${MOVEMENT_KIND_LABEL[kind]}: no puede postear un ` +
    `movimiento de ese tipo. Usá una categoría de tipo ${MOVEMENT_KIND_LABEL[kind]}, ` +
    `creá una nueva con otro nombre o cambiá el tipo de la regla.`
  );
}

/**
 * El error de dominio, con su status HTTP.
 *
 * Es una clase (y no un `{ ok, error }`) porque estas operaciones escriben en
 * una transacción: cuando algo no corresponde hay que CORTAR la transacción
 * para que no quede nada a medias. Mismo criterio que `RecurrenceError`.
 */
export class CategoryKindError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CategoryKindError";
  }
}
