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

import type { PrismaClient } from "@prisma/client";
import { isCalendarDate, calendarToDb } from "../dates";
import { money } from "../money";
import { createCardPlan } from "../card-service";

export interface BatchSaveMovementInput {
  kind: "INCOME" | "EXPENSE" | "TRANSFER";
  amount: number;
  date: string; // AAAA-MM-DD
  description?: string | null;
  accountId?: string | null;
  fromAccountId?: string | null;
  toAccountId?: string | null;
  categoryId?: string | null;
  installments?: number | null;
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
    } else {
      if (!item.accountId) {
        errors.push(`Movimiento #${idx}: se requiere indicar la cuenta.`);
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

export async function saveMovementBatch(
  prisma: PrismaClient,
  items: BatchSaveMovementInput[],
): Promise<{ count: number }> {
  const validation = validateBatchSaveInput(items);
  if (!validation.valid) {
    throw new Error(validation.errors.join(" "));
  }

  await prisma.$transaction(async (tx) => {
    for (const item of items) {
      const amountDec = money(item.amount).toFixed(2);
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
            totalAmount: item.amount,
            installments: item.installments,
            purchaseDate: item.date as any,
            categoryName,
          },
          { today: item.date as any },
        );
        continue;
      }

      // Caso B: Transferencia entre cuentas
      if (item.kind === "TRANSFER") {
        await tx.movement.create({
          data: {
            kind: "TRANSFER",
            amount: amountDec,
            date: calendarToDb(item.date as any),
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
          date: calendarToDb(item.date as any),
          description: desc,
          accountId: item.accountId!,
          categoryId: item.categoryId ?? null,
        },
      });
    }
  });

  return { count: items.length };
}
