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
 *    - Moneda nula se completa desde la cuenta; una moneda no habilitada, una
 *      distinta de la cuenta o una transferencia entre monedas genera
 *      aclaración currency (la voz no puede expresar el segundo monto).
 */

import type { Currency } from "@prisma/client";
import { categoryKindConflicts } from "../category-kind";
import { cleanName, normalizeCategoryName } from "../finance";
import { currencyNoun, isCurrency } from "../currency";
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
  currency: Currency;
}

export interface CategoryLookup {
  id: string;
  name: string;
  kind: string; // INCOME | EXPENSE
}

export interface ResolveContext {
  today: string; // AAAA-MM-DD
  /** Monedas habilitadas en la app; una fuera de esta lista pide aclaración. */
  currencies: string[];
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

/**
 * El nombre de una moneda para un mensaje, tolerando un código desconocido.
 *
 * El LLM puede devolver "EUR": no hay que romper el lote (perdería el
 * movimiento) ni inventar una traducción. Para un código conocido se usa el
 * nombre llano; para el resto, el código tal cual.
 */
function currencyName(code: string): string {
  return isCurrency(code) ? currencyNoun(code) : code;
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
    let currency: string | null = item.currency;

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

    // ── MONEDAS ──
    // La cuenta que define la unidad del `amount`: en una transferencia es la
    // de origen (el monto es lo que SALE); en INCOME/EXPENSE, la única.
    const sourceAccount =
      kind === "TRANSFER"
        ? context.accounts.find((a) => a.id === fromAccountId) ?? null
        : context.accounts.find((a) => a.id === accountId) ?? null;
    const targetAccount =
      kind === "TRANSFER" && toAccountId
        ? context.accounts.find((a) => a.id === toAccountId) ?? null
        : null;

    // Una sola aclaración de moneda por movimiento: si el modelo ya marcó una,
    // se respeta; si dos reglas aplican a la vez (p. ej. moneda no habilitada y
    // distinta de la cuenta), la primera —la más accionable— gana.
    const clarifyCurrency = (reason: string, options?: string[]) => {
      const existing = clarifications.find((c) => c.field === "currency");
      if (existing) {
        // Si el modelo ya marcó la moneda pero no ofreció opciones, las
        // habilitadas son la respuesta accionable: se completan sin pisar su
        // motivo.
        if (options && !existing.options?.length) existing.options = options;
        return;
      }
      clarifications.push(
        options
          ? { field: "currency", reason, options }
          : { field: "currency", reason },
      );
    };

    // 1. Sin moneda declarada: la unidad la define la cuenta resuelta. Un
    //    movimiento no puede quedar en una unidad desconocida si hay cuenta.
    if (currency === null && sourceAccount) {
      currency = sourceAccount.currency;
    }

    // 2. Moneda fuera de las habilitadas: ofrecer la lista cerrada. Es la más
    //    accionable, así que va primero (y `clarifyCurrency` dedupe).
    if (currency !== null && !context.currencies.includes(currency)) {
      const habilitadas = context.currencies;
      clarifyCurrency(
        habilitadas.length > 0
          ? `La moneda "${currencyName(currency)}" no está habilitada en la app. Monedas habilitadas: ${habilitadas.join(", ")}.`
          : `La moneda "${currencyName(currency)}" no está habilitada en la app y no hay monedas configuradas.`,
        habilitadas.length > 0 ? [...habilitadas] : undefined,
      );
    }

    // 3. Transferencia entre monedas distintas: la voz no puede expresar el
    //    segundo monto (D7 del diseño), así que se carga a mano. Va ANTES de
    //    "distinta de la cuenta": cuando el modelo declara la moneda de
    //    destino, la acción que importa es cargar el segundo monto a mano, no
    //    confirmar la cuenta.
    if (
      kind === "TRANSFER" &&
      sourceAccount &&
      targetAccount &&
      sourceAccount.currency !== targetAccount.currency
    ) {
      clarifyCurrency(
        `Es una transferencia entre ${currencyNoun(sourceAccount.currency)} y ${currencyNoun(targetAccount.currency)}: la carga por voz no puede expresar cuánto llega a la cuenta de destino. Cargala a mano.`,
      );
    }

    // 4. La cuenta resolvió a otra unidad: no se cambia la cuenta sola.
    if (
      currency !== null &&
      sourceAccount &&
      currency !== sourceAccount.currency
    ) {
      clarifyCurrency(
        `La cuenta "${sourceAccount.name}" está en ${currencyNoun(sourceAccount.currency)} y el movimiento quedó en ${currencyName(currency)}. Confirmá la cuenta o la moneda.`,
      );
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
      currency,
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
