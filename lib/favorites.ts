/**
 * Plantillas / favoritos de la carga rápida (Fase 7 ronda 2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ ES (Y QUÉ NO ES)
 * ─────────────────────────────────────────────────────────────────────────────
 * Es un formulario guardado: nombre, tipo, monto opcional, cuenta, categoría,
 * descripción y destino. NO es un movimiento ni una regla de recurrencia: no
 * tiene fecha, no toca totales y no lo materializa el generador.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ NO HAY EDICIÓN
 * ─────────────────────────────────────────────────────────────────────────────
 * Editar una plantilla usada no cambia el pasado (no hay historia que reescribir).
 * Borrar + recrear cubre el caso completo con una sola ruta menos y sin un PATCH
 * que tenga que decidir qué hacer con `lastUsedAt`. El nombre normalizado único
 * hace que recrear con el mismo nombre sea un reemplazo explícito.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import type { Db } from "./balance";
import { canReceiveIncome, cleanName, normalizeCategoryName } from "./finance";
import type { FavoriteDTO } from "./finance";
import { money, parseMoneyInput, type Money } from "./money";
import { toAccountDTO, toCategoryDTO } from "./queries";

/** Tope de plantillas. Más que esto es un catálogo, no una ayuda de carga. */
export const FAVORITES_MAX = 24;

/** Largo máximo del nombre visible. */
export const FAVORITE_NAME_MAX = 40;

function favoriteInclude() {
  return {
    account: true,
    toAccount: true,
    category: true,
  } as const satisfies Prisma.FavoriteTemplateInclude;
}

type FavoriteRow = Prisma.FavoriteTemplateGetPayload<{
  include: ReturnType<typeof favoriteInclude>;
}>;

/** Convierte una fila de Prisma al DTO que consume el cliente. */
export function toFavoriteDTO(favorite: FavoriteRow): FavoriteDTO {
  return {
    id: favorite.id,
    name: favorite.name,
    kind: favorite.kind,
    amount: favorite.amount === null ? null : favorite.amount.toFixed(2),
    description: favorite.description,
    category: favorite.category ? toCategoryDTO(favorite.category) : null,
    account: toAccountDTO(favorite.account),
    toAccount: favorite.toAccount ? toAccountDTO(favorite.toAccount) : null,
    lastUsedAt: favorite.lastUsedAt ? favorite.lastUsedAt.toISOString() : null,
  };
}

/** Error de dominio con el status HTTP que le corresponde. */
export class FavoriteError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "FavoriteError";
    this.status = status;
  }
}

/** Lo que la API acepta para crear una plantilla (todos los campos crudos). */
export interface FavoriteInput {
  name: string;
  kind: "INCOME" | "EXPENSE" | "TRANSFER";
  amount: string | null;
  description: string;
  categoryName: string | null;
  accountId: string;
  toAccountId: string | null;
}

/**
 * Valida la forma de la entrada, sin tocar la base.
 *
 * Las referencias (cuenta/categoría) se validan en `createFavorite`, que es
 * donde se puede consultar si existen y si están archivadas.
 */
export function parseFavoriteInput(
  body: Record<string, unknown>,
): FavoriteInput {
  const kind = body.kind;
  if (kind !== "INCOME" && kind !== "EXPENSE" && kind !== "TRANSFER") {
    throw new FavoriteError("El tipo de la plantilla es inválido.");
  }

  const name = cleanName(typeof body.name === "string" ? body.name : "");
  if (!name) throw new FavoriteError("La plantilla necesita un nombre.");
  if (name.length > FAVORITE_NAME_MAX) {
    throw new FavoriteError(
      `El nombre de la plantilla no puede superar los ${FAVORITE_NAME_MAX} caracteres.`,
    );
  }

  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  if (description.length > 200) {
    throw new FavoriteError("La nota de la plantilla no puede superar los 200 caracteres.");
  }

  let amount: Money | null = null;
  const rawAmount =
    typeof body.amount === "number"
      ? body.amount.toFixed(2)
      : typeof body.amount === "string"
        ? body.amount.trim()
        : "";
  if (rawAmount !== "") {
    const parsed = parseMoneyInput(rawAmount);
    if (!parsed) {
      throw new FavoriteError(
        "El monto de la plantilla no se entiende. Dejalo vacío o escribí 1234,56.",
      );
    }
    if (parsed.lessThanOrEqualTo(0)) {
      throw new FavoriteError("El monto de la plantilla tiene que ser mayor a cero.");
    }
    if (parsed.decimalPlaces() > 2) {
      throw new FavoriteError("El monto de la plantilla admite como máximo dos decimales.");
    }
    // Decimal(18,2): 16 dígitos enteros. Se rechaza antes de que Postgres
    // devuelva un overflow que la ruta tendría que traducir.
    if (parsed.greaterThanOrEqualTo("10000000000000000")) {
      throw new FavoriteError("El monto de la plantilla es demasiado grande.");
    }
    amount = parsed;
  }

  const rawCategory =
    typeof body.categoryName === "string" ? cleanName(body.categoryName) : "";
  if (rawCategory.length > 40) {
    throw new FavoriteError("El nombre de la categoría no puede superar los 40 caracteres.");
  }
  if (kind === "TRANSFER" && rawCategory !== "") {
    throw new FavoriteError(
      "Una transferencia entre cuentas propias no lleva categoría: no es un gasto ni un ingreso.",
    );
  }

  const accountId = typeof body.accountId === "string" ? body.accountId : "";
  if (!accountId) throw new FavoriteError("Falta indicar la cuenta de la plantilla.");

  const toAccountId =
    typeof body.toAccountId === "string" ? body.toAccountId : "";
  if (kind === "TRANSFER") {
    if (!toAccountId) {
      throw new FavoriteError("Una plantilla de transferencia necesita una cuenta de destino.");
    }
    if (toAccountId === accountId) {
      throw new FavoriteError("La cuenta de destino tiene que ser distinta a la de origen.");
    }
  } else if (toAccountId) {
    throw new FavoriteError(
      kind === "INCOME"
        ? "Un ingreso no lleva cuenta de destino."
        : "Un gasto no lleva cuenta de destino.",
    );
  }

  return {
    name,
    kind,
    amount: amount ? amount.toFixed(2) : null,
    description,
    categoryName: rawCategory || null,
    accountId,
    toAccountId: toAccountId || null,
  };
}

/** Lista las plantillas: último usado primero, después las más nuevas. */
export async function listFavorites(db: Db): Promise<FavoriteDTO[]> {
  const favorites = await db.favoriteTemplate.findMany({
    include: favoriteInclude(),
    orderBy: [
      { lastUsedAt: { sort: "desc", nulls: "last" } },
      { createdAt: "desc" },
    ],
  });
  return favorites.map(toFavoriteDTO);
}

/**
 * Crea una plantilla validando las referencias contra la base.
 *
 * Reglas:
 *   · Cuenta existente y NO archivada. Una plantilla que apunta a una cuenta
 *     archivada no se puede usar (el formulario no la ofrece).
 *   · INCOME sólo a cuentas que pueden recibirlo (CASH/BANK).
 *   · TRANSFER: destino existente, no archivado y distinto.
 *   · Categoría opcional: si el nombre existe se reutiliza; si no, se crea con
 *     el tipo de la plantilla. Guardar un favorito no puede dejar la categoría
 *     "a medio crear" para el día que se use.
 *   · Tope de 24. Se chequea antes de insertar; el índice único es el candado
 *     del nombre, no del conteo.
 */
export async function createFavorite(
  db: PrismaClient,
  input: FavoriteInput,
): Promise<FavoriteDTO> {
  const [count, account, toAccount] = await Promise.all([
    db.favoriteTemplate.count(),
    db.account.findUnique({ where: { id: input.accountId } }),
    input.toAccountId
      ? db.account.findUnique({ where: { id: input.toAccountId } })
      : Promise.resolve(null),
  ]);

  if (count >= FAVORITES_MAX) {
    throw new FavoriteError(
      `Ya tenés ${FAVORITES_MAX} plantillas. Borrá una para guardar otra.`,
      409,
    );
  }
  if (!account) throw new FavoriteError("La cuenta de la plantilla no existe.");
  if (account.archived) {
    throw new FavoriteError("La cuenta de la plantilla está archivada. Elegí otra.");
  }
  if (input.kind === "INCOME" && !canReceiveIncome(account.kind)) {
    throw new FavoriteError(
      "Un ingreso no puede entrar a una cuenta de deuda o a un préstamo a cobrar. Elegí una cuenta de dinero.",
    );
  }
  if (input.kind === "TRANSFER") {
    if (!toAccount) {
      throw new FavoriteError("La cuenta de destino de la plantilla no existe.");
    }
    if (toAccount.archived) {
      throw new FavoriteError("La cuenta de destino está archivada. Elegí otra.");
    }
    if (toAccount.id === account.id) {
      throw new FavoriteError("La cuenta de destino tiene que ser distinta a la de origen.");
    }
  }

  const normalizedName = normalizeCategoryName(input.name);

  return db.$transaction(async (tx) => {
    let categoryId: string | null = null;

    if (input.categoryName) {
      const normalizedCategory = normalizeCategoryName(input.categoryName);
      const existing = await tx.category.findUnique({
        where: { normalizedName: normalizedCategory },
      });

      if (existing) {
        const expected = input.kind === "INCOME" ? "INCOME" : "EXPENSE";
        if (existing.kind !== expected) {
          throw new FavoriteError(
            `La categoría “${existing.name}” es de ${existing.kind === "INCOME" ? "ingreso" : "gasto"}. Elegí una del tipo de la plantilla.`,
          );
        }
        categoryId = existing.id;
      } else {
        const created = await tx.category.create({
          data: {
            name: input.categoryName,
            normalizedName: normalizedCategory,
            kind: input.kind === "INCOME" ? "INCOME" : "EXPENSE",
          },
        });
        categoryId = created.id;
      }
    }

    const favorite = await tx.favoriteTemplate.create({
      data: {
        name: input.name,
        normalizedName,
        kind: input.kind,
        // `money` acepta string; null significa "sin monto" y no se convierte.
        amount: input.amount === null ? null : money(input.amount),
        description: input.description,
        categoryId,
        accountId: input.accountId,
        toAccountId: input.kind === "TRANSFER" ? input.toAccountId : null,
      },
      include: favoriteInclude(),
    });

    return toFavoriteDTO(favorite);
  });
}

/** Borra una plantilla. No toca ningún movimiento: no hay historia que borrar. */
export async function deleteFavorite(db: Db, id: string): Promise<void> {
  try {
    await db.favoriteTemplate.delete({ where: { id } });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "P2025"
    ) {
      throw new FavoriteError("Esa plantilla no existe.", 404);
    }
    throw error;
  }
}

/**
 * Marca la plantilla como usada cuando un movimiento se guarda con ella.
 *
 * Best-effort por diseño: la plantilla pudo borrarse en otra pestaña y eso no
 * puede impedir que el movimiento se guarde. `updateMany` no falla si el id ya
 * no existe.
 */
export async function touchFavorite(db: Db, id: string): Promise<void> {
  await db.favoriteTemplate.updateMany({
    where: { id },
    data: { lastUsedAt: new Date() },
  });
}
