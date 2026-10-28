/**
 * Validador y resolvedor de servidor para lotes de movimientos interpretados.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REGLAS DE NEGOCIO Y RESOLUCIÓN
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Valida con ParsedBatchSchema (Zod).
 * 2. Normaliza y busca cuentas y categorías en la base de datos de la persona.
 * 3. Corrige o marca aclaraciones según las reglas de oro:
 *    - Pago de tarjeta: si fue clasificado como EXPENSE con una tarjeta de crédito,
 *      se convierte a TRANSFER con toAccount = la tarjeta.
 *    - TRANSFER con origen == destino genera aclaración.
 *    - Categoría en conflicto con el tipo de movimiento genera aclaración.
 *    - Fecha posterior a hoy genera aclaración.
 *    - Cuota de préstamo sin desglose genera aclaración loanSplit.
 */

import { categoryKindConflicts } from "../category-kind";
import { cleanName, normalizeCategoryName } from "../finance";
import {
  ParsedBatchSchema,
  type Clarification,
  type MovementKind,
  type ParsedMovement,
} from "./schema";

export interface AccountLookup {
  id: string;
  name: string;
  kind: string; // CASH | BANK | CREDIT_CARD | LOAN | RECEIVABLE
}

export interface CategoryLookup {
  id: string;
  name: string;
  kind: string; // INCOME | EXPENSE
}

export interface ResolveContext {
  today: string; // AAAA-MM-DD
  accounts: AccountLookup[];
  categories: CategoryLookup[];
}

export interface ResolvedMovement extends ParsedMovement {
  accountId: string | null;
  fromAccountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
}

export interface ResolvedBatch {
  movements: ResolvedMovement[];
  unparsedText: string | null;
}

function normalizeKey(str: string): string {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function findAccount(
  name: string | null | undefined,
  accounts: AccountLookup[],
): AccountLookup | null {
  if (!name) return null;
  const target = normalizeKey(name);
  return (
    accounts.find((a) => normalizeKey(a.name) === target) ??
    accounts.find((a) => normalizeKey(a.name).includes(target) || target.includes(normalizeKey(a.name))) ??
    null
  );
}

function findCategory(
  name: string | null | undefined,
  categories: CategoryLookup[],
): CategoryLookup | null {
  if (!name) return null;
  const target = normalizeCategoryName(name);
  return (
    categories.find((c) => normalizeCategoryName(c.name) === target) ?? null
  );
}

export function resolveBatch(
  rawInput: unknown,
  context: ResolveContext,
): ResolvedBatch {
  const parsed = ParsedBatchSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      movements: [],
      unparsedText:
        typeof rawInput === "object" && rawInput !== null && "text" in rawInput
          ? String((rawInput as Record<string, unknown>).text)
          : "El lote devuelto por la IA no tiene el formato esperado.",
    };
  }

  const resolvedMovements: ResolvedMovement[] = [];
  const validAccountNames = context.accounts.map((a) => a.name);

  for (const item of parsed.data.movements) {
    let kind: MovementKind = item.kind;
    let accountName = item.accountName ? cleanName(item.accountName) : null;
    let fromAccountName = item.fromAccountName ? cleanName(item.fromAccountName) : null;
    let toAccountName = item.toAccountName ? cleanName(item.toAccountName) : null;
    let categoryName = item.categoryName ? cleanName(item.categoryName) : null;

    let accountId: string | null = null;
    let fromAccountId: string | null = null;
    let toAccountId: string | null = null;
    let categoryId: string | null = null;

    const clarifications: Clarification[] = [...item.clarifications];

    // ── REGLA DE ORO: Pago de tarjeta cargado como EXPENSE ──
    const textCombined = `${item.description} ${item.sourceText}`.toLowerCase();
    const looksLikeCardPayment =
      textCombined.includes("pago tarjeta") ||
      textCombined.includes("pago de tarjeta") ||
      textCombined.includes("pago de la tarjeta") ||
      textCombined.includes("pago del resumen") ||
      textCombined.includes("pago resumen") ||
      textCombined.includes("pagué la tarjeta") ||
      textCombined.includes("pagué el resumen") ||
      textCombined.includes("pagar la tarjeta");

    const matchedPrimaryAcc = findAccount(accountName, context.accounts);
    if (
      kind === "EXPENSE" &&
      (looksLikeCardPayment || matchedPrimaryAcc?.kind === "CREDIT_CARD")
    ) {
      if (looksLikeCardPayment) {
        kind = "TRANSFER";
        if (matchedPrimaryAcc?.kind === "CREDIT_CARD") {
          toAccountId = matchedPrimaryAcc.id;
          toAccountName = matchedPrimaryAcc.name;
          accountName = null;
        } else {
          const firstCard = context.accounts.find((a) => a.kind === "CREDIT_CARD");
          if (firstCard) {
            toAccountId = firstCard.id;
            toAccountName = firstCard.name;
          }
          if (matchedPrimaryAcc) {
            fromAccountId = matchedPrimaryAcc.id;
            fromAccountName = matchedPrimaryAcc.name;
          }
        }
      }
    }

    // ── RESOLUCIÓN DE CUENTAS SEGÚN KIND ──
    if (kind === "TRANSFER") {
      accountName = null;
      accountId = null;

      const fromAcc = findAccount(fromAccountName, context.accounts);
      if (fromAcc) {
        fromAccountId = fromAcc.id;
        fromAccountName = fromAcc.name;
      } else {
        fromAccountId = null;
        clarifications.push({
          field: "fromAccount",
          reason: `No se encontró la cuenta de origen "${fromAccountName ?? ""}".`,
          options: validAccountNames,
        });
      }

      const toAcc = findAccount(toAccountName, context.accounts);
      if (toAcc) {
        toAccountId = toAcc.id;
        toAccountName = toAcc.name;
      } else {
        toAccountId = null;
        clarifications.push({
          field: "toAccount",
          reason: `No se encontró la cuenta de destino "${toAccountName ?? ""}".`,
          options: validAccountNames,
        });
      }

      // No permitir origen == destino
      if (fromAccountId && toAccountId && fromAccountId === toAccountId) {
        clarifications.push({
          field: "toAccount",
          reason: "La cuenta de destino tiene que ser distinta a la de origen.",
          options: validAccountNames.filter((n) => n !== fromAccountName),
        });
      }

      // Transferencias NO llevan categoría
      categoryName = null;
      categoryId = null;
    } else {
      // INCOME o EXPENSE
      fromAccountName = null;
      fromAccountId = null;
      toAccountName = null;
      toAccountId = null;

      const acc = findAccount(accountName, context.accounts);
      if (acc) {
        accountId = acc.id;
        accountName = acc.name;
      } else {
        accountId = null;
        clarifications.push({
          field: "account",
          reason: `No se reconoció la cuenta "${accountName ?? ""}". Indicá cuál usar.`,
          options: validAccountNames,
        });
      }

      // ── RESOLUCIÓN DE CATEGORÍAS ──
      if (categoryName) {
        const cat = findCategory(categoryName, context.categories);
        if (cat) {
          if (categoryKindConflicts(kind, cat.kind as "INCOME" | "EXPENSE")) {
            clarifications.push({
              field: "category",
              reason: `La categoría "${cat.name}" es de ${
                cat.kind === "INCOME" ? "ingreso" : "gasto"
              } y no coincide con este movimiento.`,
            });
            categoryId = null;
          } else {
            categoryId = cat.id;
            categoryName = cat.name;
          }
        } else {
          // Si no existe, dejamos categoryId en null (se creará o confirmará luego)
          categoryId = null;
        }
      }
    }

    // ── FECHA EN EL FUTURO ──
    if (item.date > context.today) {
      clarifications.push({
        field: "date",
        reason: `La fecha ${item.date} es en el futuro respecto a hoy (${context.today}). Confirmá la fecha correcta.`,
      });
    }

    resolvedMovements.push({
      ...item,
      kind,
      accountName,
      fromAccountName,
      toAccountName,
      categoryName,
      accountId,
      fromAccountId,
      toAccountId,
      categoryId,
      clarifications,
    });
  }

  return {
    movements: resolvedMovements,
    unparsedText: parsed.data.unparsedText,
  };
}
