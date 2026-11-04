/**
 * Servicio transaccional para el guardado atómico de lotes de movimientos
 * interpretados por voz o texto (Fase 3).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REGLAS DE INTEGRIDAD Y CONSISTENCIA
 * ─────────────────────────────────────────────────────────────────────────────
 * - Todo o nada: se ejecuta dentro de prisma.$transaction.
 * - Si un movimiento incluye `installments >= 2`, se delega a `createCardPlan`
 *   (o se crea el CardPlan correspondiente garantizando el desglose de cuotas).
 * - TRANSFER requiere fromAccountId y toAccountId distintos, y no tiene categoría.
 * - Fechas estrictas en formato calendario (AAAA-MM-DD).
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { isCalendarDate, calendarToDb } from "../dates";
import { currencyNoun } from "../currency";
import { money, parseMoneyInput, type Money } from "../money";
import { createCardPlan } from "../card-service";

export interface BatchSaveMovementInput {
  kind: "INCOME" | "EXPENSE" | "TRANSFER";
  amount: number;
  /**
   * Sólo en una TRANSFER entre cuentas de DISTINTA moneda: cuánto LLEGA a la
   * cuenta de destino, en la moneda de destino (Fase 4.3). Obligatorio si las
   * monedas difieren y prohibido si son iguales — la misma bicondicional que
   * hace cumplir el trigger `movement_currency_shape_check`.
   *
   * Viaja como `number | string` porque el motor de voz arma números y un
   * cliente escrito a mano puede mandar texto decimal; los dos se normalizan
   * con el mismo `parseMoneyInput`.
   */
  toAmount?: number | string | null;
  date: string; // AAAA-MM-DD
  description?: string | null;
  accountId?: string | null;
  fromAccountId?: string | null;
  toAccountId?: string | null;
  categoryId?: string | null;
  installments?: number | null;
}

/** `true` sólo si el ítem trae un monto de destino con valor. */
function hasToAmount(item: BatchSaveMovementInput): boolean {
  return (
    item.toAmount !== undefined && item.toAmount !== null && item.toAmount !== ""
  );
}

/**
 * Interpreta el monto de destino. `null` si no se entiende o no es un monto.
 *
 * Un `number` se fija con `toFixed(2)` ANTES de parsear (`NaN`/`Infinity`
 * terminan en "NaN"/"Infinity", que `parseMoneyInput` rechaza): el error binario
 * de un `number` no llega nunca a la base.
 */
function parseToAmount(value: number | string): Money | null {
  return parseMoneyInput(
    typeof value === "number" ? value.toFixed(2) : value,
  );
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateBatchSaveInput(
  items: BatchSaveMovementInput[],
): ValidationResult {
  const errors: string[] = [];

  if (!Array.isArray(items) || items.length === 0) {
    return {
      valid: false,
      errors: ["El lote de movimientos no puede estar vacío."],
    };
  }

  items.forEach((item, index) => {
    const idx = index + 1;

    // El cuerpo viene de un cliente: un `null`, un string o un array en la
    // lista reventaba con un TypeError de JS ("cannot read properties of
    // null") convertido en 400 con texto en inglés. Un ítem que no es un
    // objeto es un rechazo de forma, con su número.
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      errors.push(
        `Movimiento #${idx}: no es un objeto con los datos del movimiento.`,
      );
      return;
    }

    if (!["INCOME", "EXPENSE", "TRANSFER"].includes(item.kind)) {
      errors.push(`Movimiento #${idx}: tipo de movimiento inválido (${item.kind}).`);
    }

    if (typeof item.amount !== "number" || isNaN(item.amount) || item.amount <= 0) {
      errors.push(`Movimiento #${idx}: el monto tiene que ser mayor a cero.`);
    }

    if (!isCalendarDate(item.date)) {
      errors.push(`Movimiento #${idx}: la fecha "${item.date}" no es válida (AAAA-MM-DD).`);
    }

    if (item.kind === "TRANSFER") {
      if (!item.fromAccountId) {
        errors.push(`Movimiento #${idx}: la transferencia requiere una cuenta de origen.`);
      }
      if (!item.toAccountId) {
        errors.push(`Movimiento #${idx}: la transferencia requiere una cuenta de destino.`);
      }
      if (item.fromAccountId && item.toAccountId && item.fromAccountId === item.toAccountId) {
        errors.push(`Movimiento #${idx}: la cuenta de origen y destino deben ser distintas.`);
      }
      // La forma del monto de destino. Si las monedas difieren (o no) lo dice
      // la base, en `assertCurrencyShape`: acá sólo se valida que un monto de
      // destino presente sea un monto positivo de verdad.
      if (hasToAmount(item)) {
        const parsed = parseToAmount(item.toAmount as number | string);
        if (parsed === null) {
          errors.push(`Movimiento #${idx}: el monto de destino no se entiende como un monto.`);
        } else if (parsed.lessThanOrEqualTo(0)) {
          errors.push(`Movimiento #${idx}: el monto de destino tiene que ser mayor a cero.`);
        }
      }
    } else {
      if (!item.accountId) {
        errors.push(`Movimiento #${idx}: se requiere indicar la cuenta.`);
      }
      // Un ingreso o un gasto no tienen segunda punta: aceptar el campo sería
      // guardar un número que nadie lee.
      if (hasToAmount(item)) {
        errors.push(
          `Movimiento #${idx}: el monto de destino sólo existe en una transferencia entre cuentas.`,
        );
      }
    }

    if (item.installments !== undefined && item.installments !== null) {
      if (!Number.isInteger(item.installments) || item.installments < 2) {
        errors.push(`Movimiento #${idx}: el número de cuotas debe ser un entero mayor o igual a 2.`);
      }
    }
  });

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * La bicondicional del monto de destino, para todo el lote.
 *
 * Es async y no parte de `validateBatchSaveInput` porque necesita leer
 * `Account`: la regla depende de la moneda de cada cuenta y no se puede decidir
 * con el cuerpo de la petición. Se llama DENTRO de la transacción, antes de
 * escribir la primera fila: si un ítem está mal, no se guarda ninguno.
 */
async function assertCurrencyShape(
  tx: Prisma.TransactionClient,
  items: BatchSaveMovementInput[],
): Promise<void> {
  const transfers = items
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item }) =>
        item.kind === "TRANSFER" && item.fromAccountId && item.toAccountId,
    );

  if (transfers.length === 0) return;

  const ids = [
    ...new Set(
      transfers.flatMap(({ item }) => [item.fromAccountId!, item.toAccountId!]),
    ),
  ];
  const accounts = await tx.account.findMany({
    where: { id: { in: ids } },
    select: { id: true, currency: true },
  });
  const byId = new Map(accounts.map((account) => [account.id, account]));

  for (const { item, index } of transfers) {
    const idx = index + 1;
    const from = byId.get(item.fromAccountId!);
    const to = byId.get(item.toAccountId!);

    if (!from || !to) {
      throw new Error(
        `Movimiento #${idx}: la cuenta de origen o la de destino no existe.`,
      );
    }

    const bringsToAmount = hasToAmount(item);

    if (from.currency !== to.currency && !bringsToAmount) {
      throw new Error(
        `Movimiento #${idx}: la cuenta de origen está en ${currencyNoun(from.currency)} y la de destino en ${currencyNoun(to.currency)}: hace falta indicar cuánto llega a la cuenta de destino.`,
      );
    }
    if (from.currency === to.currency && bringsToAmount) {
      throw new Error(
        `Movimiento #${idx}: las dos cuentas están en ${currencyNoun(from.currency)}: el monto de destino no corresponde.`,
      );
    }
  }
}

export async function saveMovementBatch(
  prisma: PrismaClient,
  items: BatchSaveMovementInput[],
): Promise<{ count: number }> {
  const validation = validateBatchSaveInput(items);
  if (!validation.valid) {
    throw new Error(validation.errors.join(" "));
  }

  await prisma.$transaction(async (tx) => {
    // Antes de escribir: la forma por moneda del lote completo.
    await assertCurrencyShape(tx, items);

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      const amountDec = money(String(item.amount)).toFixed(2);
      const desc = (item.description ?? "").trim().slice(0, 200);

      // Caso A: Compra en cuotas con tarjeta de crédito
      if (
        item.kind === "EXPENSE" &&
        item.installments &&
        item.installments >= 2 &&
        item.accountId
      ) {
        // Obtenemos la categoría si existe
        let categoryName: string | null = null;
        if (item.categoryId) {
          const cat = await tx.category.findUnique({
            where: { id: item.categoryId },
            select: { name: true },
          });
          if (cat) categoryName = cat.name;
        }

        // Delegamos a createCardPlan
        await createCardPlan(
          tx as unknown as PrismaClient,
          {
            cardId: item.accountId,
            label: desc || "Compra en cuotas",
            totalAmount: amountDec,
            installments: item.installments,
            purchaseDate: item.date,
            categoryName,
          },
          { today: item.date },
        );
        continue;
      }

      // Caso B: Transferencia entre cuentas
      if (item.kind === "TRANSFER") {
        // La forma ya se validó arriba; acá sólo se normaliza a string decimal.
        // `assertCurrencyShape` garantiza que un `toAmount` presente es el de
        // una transferencia entre monedas distintas.
        const parsedToAmount = hasToAmount(item)
          ? parseToAmount(item.toAmount as number | string)
          : null;
        if (hasToAmount(item) && parsedToAmount === null) {
          // Inalcanzable después de `validateBatchSaveInput`; si algún día deja
          // de serlo, mejor un error que un monto de destino inventado.
          throw new Error(
            `Movimiento #${index + 1}: el monto de destino no es válido.`,
          );
        }

        await tx.movement.create({
          data: {
            kind: "TRANSFER",
            amount: amountDec,
            toAmount: parsedToAmount ? parsedToAmount.toFixed(2) : null,
            date: calendarToDb(item.date),
            description: desc,
            accountId: item.fromAccountId!,
            toAccountId: item.toAccountId!,
            categoryId: null,
          },
        });
        continue;
      }

      // Caso C: Ingreso o Gasto simple
      await tx.movement.create({
        data: {
          kind: item.kind,
          amount: amountDec,
          date: calendarToDb(item.date),
          description: desc,
          accountId: item.accountId!,
          categoryId: item.categoryId ?? null,
        },
      });
    }
  });

  return { count: items.length };
}
