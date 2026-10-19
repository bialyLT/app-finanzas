/**
 * Importación de CSV: resolución contra la base, preview y commit (Fase 7 r2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAS TRES RESPONSABILIDADES
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. PREVIEW: interpretar el texto (`lib/csv.ts`) y resolver cada nombre
 *      contra las cuentas y categorías reales. Devuelve filas VÁLIDAS,
 *      INVÁLIDAS, DUPLICADAS y VACÍAS, con totales de las importables.
 *   2. COMMIT: recalcular el preview DENTRO de la transacción, compararlo con
 *      el que vio la persona, crear categorías y movimientos, y leer de vuelta
 *      lo insertado para conciliar al centavo. Cualquier diferencia hace
 *      rollback: no queda media importación.
 *   3. DUPLICADOS: se avisan y se omiten. Nunca se saltean en silencio.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ SE RECALCULA EN EL COMMIT
 * ─────────────────────────────────────────────────────────────────────────────
 * Entre el preview y el "Importar" pueden pasar cosas: otra pestaña cargó el
 * mismo movimiento, se archivó una cuenta, se creó una categoría con otro tipo.
 * Importar el preview viejo a ciegas escribiría datos que ya no corresponden al
 * estado real. Si el recálculo no coincide con lo mostrado, se devuelve 409 y
 * se pide revisar de nuevo; no se importa "lo que se pueda".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ ES UN DUPLICADO (y el costo de la definición)
 * ─────────────────────────────────────────────────────────────────────────────
 * Misma clave completa: tipo, fecha, monto, cuenta, destino, categoría y
 * descripción normalizada (sin acentos ni mayúsculas). Es deliberadamente
 * conservador: dos cafés idénticos el mismo día con la misma descripción se
 * marcan como duplicados y se omite el segundo. Se prefiere avisar de más a
 * duplicar historia en silencio; la persona puede cambiar la descripción para
 * distinguirlos. La regla está documentada en docs/import-csv.md.
 */

import type { PrismaClient } from "@prisma/client";
import type { Db } from "./balance";
import {
  CSV_MAX_ROWS,
  parseCsv,
  parseCsvRow,
  type CsvKind,
} from "./csv";
import { calendarToDb, dbToCalendar } from "./dates";
import { normalizeDescription } from "./description-suggestions";
import {
  canReceiveIncome,
  normalizeCategoryName,
  type AccountKindDTO,
  type CsvImportResultDTO,
  type CsvPreviewDTO,
  type CsvRowPreviewDTO,
} from "./finance";
import { money, parseMoneyInput, type Money } from "./money";

/** Error de la importación con el status HTTP que le corresponde. */
export class CsvImportError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "CsvImportError";
    this.status = status;
  }
}

/** Totales y cantidad que el cliente vio en el preview. */
export interface CsvExpected {
  count: number;
  income: string;
  expenses: string;
  transfers: string;
}

interface AccountLike {
  id: string;
  name: string;
  kind: AccountKindDTO;
  archived: boolean;
}

interface CategoryLike {
  id: string;
  name: string;
  kind: "INCOME" | "EXPENSE";
  normalizedName: string;
}

interface AccountIndex {
  byNormalized: Map<string, AccountLike>;
  ambiguous: Set<string>;
}

function indexAccounts(accounts: readonly AccountLike[]): AccountIndex {
  const byNormalized = new Map<string, AccountLike>();
  const ambiguous = new Set<string>();

  for (const account of accounts) {
    const key = normalizeCategoryName(account.name);
    if (byNormalized.has(key)) {
      // `Account.name` es único en la base, pero único SENSIBLE A MAYÚSCULAS:
      // "Banco" y "banco" pueden coexistir. Si el CSV dice "BANCO", no hay
      // forma honesta de elegir una: la fila se invalida.
      ambiguous.add(key);
    } else {
      byNormalized.set(key, account);
    }
  }

  return { byNormalized, ambiguous };
}

function resolveAccount(
  rawName: string,
  index: AccountIndex,
): { account: AccountLike | null; error: string | null } {
  const key = normalizeCategoryName(rawName);
  if (index.ambiguous.has(key)) {
    return {
      account: null,
      error: `Hay más de una cuenta que coincide con “${rawName}”. Renombrá una para poder importar.`,
    };
  }

  const account = index.byNormalized.get(key);
  if (!account) {
    return { account: null, error: `La cuenta “${rawName}” no existe.` };
  }
  if (account.archived) {
    return {
      account: null,
      error: `La cuenta “${rawName}” está archivada. Desarchivala o cambiá la fila.`,
    };
  }

  return { account, error: null };
}

/** Una fila que pasó todas las validaciones y se va a insertar. */
interface ValidRow {
  line: number;
  kind: CsvKind;
  date: string;
  amount: string;
  accountId: string;
  toAccountId: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryKey: string;
  description: string;
}

interface PlannedCategory {
  name: string;
  normalizedName: string;
  kind: "INCOME" | "EXPENSE";
}

interface CsvEntry {
  dto: CsvRowPreviewDTO;
  candidate: ValidRow | null;
  planned: PlannedCategory | null;
}

export interface CsvAnalysis {
  preview: CsvPreviewDTO;
  valid: ValidRow[];
  plannedCategories: PlannedCategory[];
}

function categoryKey(
  categoryId: string | null,
  categoryName: string | null,
): string {
  if (categoryId) return `id:${categoryId}`;
  if (categoryName) return `new:${normalizeCategoryName(categoryName)}`;
  return "none";
}

function duplicateKey(input: {
  kind: string;
  date: string;
  amount: string;
  accountId: string;
  toAccountId: string | null;
  categoryKey: string;
  description: string;
}): string {
  return [
    input.kind,
    input.date,
    input.amount,
    input.accountId,
    input.toAccountId ?? "",
    input.categoryKey,
    normalizeDescription(input.description),
  ].join("|");
}

/**
 * Interpreta y clasifica el CSV. No escribe nada.
 *
 * El orden de los veredictos es importante:
 *   EMPTY      → no hay nada que validar.
 *   INVALID    → cualquier error de forma, cuenta, categoría o tipo.
 *   DUPLICATE  → la fila es válida, pero ya existe (en la base o antes en el
 *                mismo archivo). Se omite.
 *   VALID      → se importa.
 *
 * Una fila inválida NUNCA se marca duplicada: el mensaje útil es el error.
 */
export async function analyzeCsv(db: Db, text: string): Promise<CsvAnalysis> {
  const table = parseCsv(text);

  const [accounts, categories] = await Promise.all([
    db.account.findMany({
      select: { id: true, name: true, kind: true, archived: true },
    }),
    db.category.findMany({
      select: { id: true, name: true, kind: true, normalizedName: true },
    }),
  ]);

  const accountIndex = indexAccounts(accounts);
  const categoriesByNormalized = new Map<string, CategoryLike>(
    categories.map((category) => [category.normalizedName, category]),
  );

  /** Categorías planificadas por filas que pasaron el resto de la validación. */
  const plannedByNormalized = new Map<string, PlannedCategory>();

  const entries: CsvEntry[] = [];

  for (const sourceRow of table.rows) {
    const parsed = parseCsvRow(sourceRow);

    if (parsed.empty) {
      entries.push({
        dto: {
          line: parsed.line,
          status: "EMPTY",
          errors: [],
          kind: null,
          date: null,
          amount: null,
          account: "",
          toAccount: "",
          category: "",
          description: "",
        },
        candidate: null,
        planned: null,
      });
      continue;
    }

    const errors = [...parsed.errors];

    // ── Cuentas ────────────────────────────────────────────────────────────
    let accountId: string | null = null;
    if (parsed.accountName) {
      const resolved = resolveAccount(parsed.accountName, accountIndex);
      if (resolved.error) {
        errors.push(resolved.error);
      } else if (resolved.account) {
        accountId = resolved.account.id;
        if (parsed.kind === "INCOME" && !canReceiveIncome(resolved.account.kind)) {
          errors.push(
            `Un ingreso no puede entrar a la cuenta “${parsed.accountName}”. Elegí una cuenta de dinero.`,
          );
        }
      }
    }

    let toAccountId: string | null = null;
    if (parsed.kind === "TRANSFER" && parsed.toAccountName) {
      const resolved = resolveAccount(parsed.toAccountName, accountIndex);
      if (resolved.error) {
        errors.push(resolved.error);
      } else if (resolved.account) {
        toAccountId = resolved.account.id;
        if (toAccountId === accountId) {
          errors.push("La cuenta de destino tiene que ser distinta a la de origen.");
        }
      }
    }

    if (
      errors.length === 0 &&
      (!parsed.kind || !parsed.date || !parsed.amount || !accountId)
    ) {
      errors.push("La fila está incompleta.");
    }

    // ── Categoría: existente, planificada o inválida ───────────────────────
    //
    // Sólo se planifica una categoría cuando la fila ya pasó todo lo demás.
    // Si no, una fila con la cuenta mal escrita podría "reservar" un nombre de
    // categoría y hacer fallar otra fila que sí es válida.
    let categoryId: string | null = null;
    let planned: PlannedCategory | null = null;

    if (
      errors.length === 0 &&
      parsed.categoryName &&
      (parsed.kind === "INCOME" || parsed.kind === "EXPENSE")
    ) {
      const normalized = normalizeCategoryName(parsed.categoryName);
      const existing = categoriesByNormalized.get(normalized);

      if (existing) {
        if (existing.kind !== parsed.kind) {
          errors.push(
            `La categoría “${existing.name}” es de ${existing.kind === "INCOME" ? "ingreso" : "gasto"} y la fila es de ${parsed.kind === "INCOME" ? "ingreso" : "gasto"}.`,
          );
        } else {
          categoryId = existing.id;
        }
      } else {
        const alreadyPlanned = plannedByNormalized.get(normalized);
        if (alreadyPlanned && alreadyPlanned.kind !== parsed.kind) {
          // `Category.normalizedName` es único en TODA la tabla: el mismo
          // nombre no puede ser ingreso y gasto a la vez. El archivo tiene
          // que desambiguar antes de importar.
          errors.push(
            `La categoría “${parsed.categoryName}” ya aparece como ${alreadyPlanned.kind === "INCOME" ? "ingreso" : "gasto"} en otra fila. Usá nombres distintos para ingreso y gasto.`,
          );
        } else {
          planned = alreadyPlanned ?? {
            name: parsed.categoryName,
            normalizedName: normalized,
            kind: parsed.kind,
          };
        }
      }
    }

    const kind = parsed.kind;
    const date = parsed.date;
    const amount = parsed.amount;

    if (
      errors.length > 0 ||
      !kind ||
      !date ||
      !amount ||
      !accountId
    ) {
      entries.push({
        dto: {
          line: parsed.line,
          status: "INVALID",
          errors,
          kind,
          date,
          amount,
          account: parsed.accountName,
          toAccount: parsed.toAccountName,
          category: parsed.categoryName,
          description: parsed.description,
        },
        candidate: null,
        planned: null,
      });
      continue;
    }

    if (planned && !plannedByNormalized.has(planned.normalizedName)) {
      plannedByNormalized.set(planned.normalizedName, planned);
    }

    const candidate: ValidRow = {
      line: parsed.line,
      kind,
      date,
      amount,
      accountId,
      toAccountId: kind === "TRANSFER" ? toAccountId : null,
      categoryId,
      categoryName: categoryId ? null : parsed.categoryName || null,
      categoryKey: categoryKey(categoryId, parsed.categoryName || null),
      description: parsed.description,
    };

    entries.push({
      dto: {
        line: parsed.line,
        status: "VALID",
        errors: [],
        kind,
        date,
        amount,
        account: parsed.accountName,
        toAccount: parsed.toAccountName,
        category: parsed.categoryName,
        description: parsed.description,
      },
      candidate,
      planned,
    });
  }

  const pendingRows = entries.filter(
    (entry): entry is CsvEntry & { candidate: ValidRow } =>
      entry.candidate !== null,
  );

  // ── Duplicados: contra la base y contra el mismo archivo ────────────────
  //
  // Se consultan SÓLO las fechas del archivo, no todo el histórico. Con 500
  // filas como máximo son 500 fechas; la consulta queda acotada por día y no
  // por tamaño de la base.
  const dates = [...new Set(pendingRows.map((row) => row.candidate.date))];
  const existingMovements =
    dates.length === 0
      ? []
      : await db.movement.findMany({
          where: { date: { in: dates.map(calendarToDb) } },
          select: {
            kind: true,
            amount: true,
            date: true,
            description: true,
            accountId: true,
            toAccountId: true,
            categoryId: true,
          },
        });

  const existingKeys = new Set(
    existingMovements.map((movement) =>
      duplicateKey({
        kind: movement.kind,
        // `dbToCalendar` y NO `toISOString()`: la columna es una fecha de
        // calendario y convertirla a UTC puede devolver el día anterior.
        date: dbToCalendar(movement.date),
        amount: movement.amount.toFixed(2),
        accountId: movement.accountId,
        toAccountId: movement.toAccountId,
        categoryKey: categoryKey(movement.categoryId, null),
        description: movement.description,
      }),
    ),
  );

  const seenInFile = new Set<string>();
  const valid: ValidRow[] = [];
  const usedCategories = new Set<string>();

  for (const pending of pendingRows) {
    const key = duplicateKey(pending.candidate);
    if (existingKeys.has(key) || seenInFile.has(key)) {
      pending.dto.status = "DUPLICATE";
      continue;
    }

    seenInFile.add(key);
    pending.dto.status = "VALID";
    valid.push(pending.candidate);
    if (pending.planned) usedCategories.add(pending.planned.normalizedName);
  }

  // Sólo se crean categorías que alguna fila VÁLIDA va a usar. Una categoría
  // planificada por una fila que terminó duplicada no debe nacer de un archivo
  // que no la importó.
  const plannedCategories = [...plannedByNormalized.values()].filter((category) =>
    usedCategories.has(category.normalizedName),
  );

  const rows = entries.map((entry) => entry.dto);

  const totals = {
    income: money("0"),
    expenses: money("0"),
    transfers: money("0"),
  };
  for (const row of valid) {
    const amount = money(row.amount);
    if (row.kind === "INCOME") totals.income = totals.income.plus(amount);
    else if (row.kind === "EXPENSE") totals.expenses = totals.expenses.plus(amount);
    else totals.transfers = totals.transfers.plus(amount);
  }

  const preview: CsvPreviewDTO = {
    headers: table.headers,
    totalRows: rows.length,
    importableRows: valid.length,
    invalidRows: rows.filter((row) => row.status === "INVALID").length,
    duplicateRows: rows.filter((row) => row.status === "DUPLICATE").length,
    emptyRows: rows.filter((row) => row.status === "EMPTY").length,
    totals: {
      income: totals.income.toFixed(2),
      expenses: totals.expenses.toFixed(2),
      transfers: totals.transfers.toFixed(2),
      count: valid.length,
    },
    rows,
    categoriesToCreate: plannedCategories.map((category) => ({
      name: category.name,
      kind: category.kind,
    })),
  };

  return { preview, valid, plannedCategories };
}

/** Preview sin la maquinaria interna: lo que consume la ruta. */
export async function buildCsvPreview(
  db: Db,
  text: string,
): Promise<CsvPreviewDTO> {
  return (await analyzeCsv(db, text)).preview;
}

/** Valida el resumen que el cliente vio en el preview. */
export function parseCsvExpected(value: unknown): CsvExpected {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CsvImportError(
      "Falta el resumen del preview. Volvé a previsualizar el archivo.",
    );
  }

  const record = value as Record<string, unknown>;
  const count = record.count;
  if (
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    count < 0 ||
    count > CSV_MAX_ROWS
  ) {
    throw new CsvImportError("La cantidad del preview no es válida.");
  }

  const normalize = (field: "income" | "expenses" | "transfers"): string => {
    const raw = record[field];
    if (typeof raw !== "string") {
      throw new CsvImportError("Los totales del preview no son válidos.");
    }
    const parsed = parseMoneyInput(raw);
    if (!parsed || parsed.isNegative()) {
      throw new CsvImportError("Los totales del preview no son válidos.");
    }
    return parsed.toFixed(2);
  };

  return {
    count,
    income: normalize("income"),
    expenses: normalize("expenses"),
    transfers: normalize("transfers"),
  };
}

function sameTotals(a: CsvPreviewDTO["totals"], b: CsvPreviewDTO["totals"]): boolean {
  return (
    a.count === b.count &&
    money(a.income).equals(b.income) &&
    money(a.expenses).equals(b.expenses) &&
    money(a.transfers).equals(b.transfers)
  );
}

function sameStatuses(a: CsvPreviewDTO, b: CsvPreviewDTO): boolean {
  if (a.rows.length !== b.rows.length) return false;
  for (let index = 0; index < a.rows.length; index += 1) {
    if (a.rows[index].line !== b.rows[index].line) return false;
    if (a.rows[index].status !== b.rows[index].status) return false;
  }
  return true;
}

function assertExpectedMatches(
  preview: CsvPreviewDTO,
  expected: CsvExpected,
): void {
  const expectedTotals = {
    income: money(expected.income).toFixed(2),
    expenses: money(expected.expenses).toFixed(2),
    transfers: money(expected.transfers).toFixed(2),
    count: expected.count,
  };

  if (!sameTotals(preview.totals, expectedTotals)) {
    throw new CsvImportError(
      "La vista previa no coincide con el archivo actual. Volvé a previsualizar antes de importar.",
      409,
    );
  }
}

/**
 * Importa el CSV completo o nada.
 *
 * Flujo:
 *   1. Recalcular el preview con el texto recibido.
 *   2. Rechazar si hay filas inválidas (422) o si no queda nada por importar.
 *   3. Comparar con el resumen que vio la persona (409 si cambió).
 *   4. Abrir UNA transacción, recalcular otra vez, crear categorías y filas.
 *   5. Leer de vuelta los movimientos insertados y conciliar cantidad y totales
 *      por tipo contra el preview. Cualquier diferencia → rollback + 409.
 */
export async function importCsv(
  db: PrismaClient,
  text: string,
  expected: CsvExpected,
): Promise<CsvImportResultDTO> {
  const initial = await analyzeCsv(db, text);
  const preview = initial.preview;

  if (preview.totalRows === 0) {
    throw new CsvImportError("El CSV no tiene filas de datos.", 422);
  }

  if (preview.invalidRows > 0) {
    const examples = preview.rows
      .filter((row) => row.status === "INVALID")
      .slice(0, 3)
      .map((row) => `fila ${row.line}: ${row.errors[0] ?? "error"}`);
    throw new CsvImportError(
      `Hay ${preview.invalidRows} fila${preview.invalidRows === 1 ? "" : "s"} con errores. No se importó nada. Corregí el archivo y volvé a intentar. ${examples.join(" · ")}`,
      422,
    );
  }

  if (preview.importableRows === 0) {
    throw new CsvImportError(
      "No hay filas nuevas para importar: todas son duplicadas o vacías. Si querés reimportarlas, cambiá algún dato que las distinga.",
      422,
    );
  }

  assertExpectedMatches(preview, expected);

  return db.$transaction(async (tx) => {
    // ── Serialización entre pestañas ───────────────────────────────────────
    //
    // El recálculo de abajo no alcanza por sí solo: dos commits simultáneos
    // del mismo archivo (doble click, dos pestañas, reintentos del navegador)
    // pueden intercalar "recalcular" e "insertar". Con READ COMMITTED cada
    // transacción NO ve lo que la otra todavía no confirmó, así que las DOS
    // verían el archivo como importable y las filas entrarían duplicadas.
    //
    // `pg_advisory_xact_lock` serializa las importaciones: el segundo pedido
    // espera a que termine el primero y, al recalcular, ya ve las filas recién
    // insertadas como duplicadas (409) en vez de insertarlas de nuevo. El lock
    // se libera solo al cerrar la transacción (commit o rollback), así que no
    // puede quedar colgado ni sobrevivir a un error.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(73672101::bigint)`;

    // Recalcular DENTRO de la transacción: si otra pestaña cambió algo entre
    // el preview y este momento, el estado ya no es el que la persona aprobó.
    const current = await analyzeCsv(tx, text);

    if (
      current.preview.importableRows !== preview.importableRows ||
      current.preview.invalidRows !== preview.invalidRows ||
      current.preview.duplicateRows !== preview.duplicateRows ||
      !sameTotals(current.preview.totals, preview.totals) ||
      !sameStatuses(current.preview, preview)
    ) {
      throw new CsvImportError(
        "Los datos cambiaron entre la vista previa y la importación. Volvé a revisar el archivo.",
        409,
      );
    }

    // ── Categorías: resolver-o-crear, como el formulario ──────────────────
    const categoryIdByNormalized = new Map<string, string>();
    for (const planned of current.plannedCategories) {
      const category = await tx.category.upsert({
        where: { normalizedName: planned.normalizedName },
        update: {},
        create: {
          name: planned.name,
          normalizedName: planned.normalizedName,
          kind: planned.kind,
        },
      });

      // Si otra pestaña creó la categoría con el tipo contrario justo entre el
      // recálculo y este upsert, no se puede usar: mejor rollback que guardar
      // un gasto con una categoría de ingreso.
      if (category.kind !== planned.kind) {
        throw new CsvImportError(
          `La categoría “${planned.name}” cambió de tipo mientras se importaba. No se guardó nada.`,
          409,
        );
      }
      categoryIdByNormalized.set(planned.normalizedName, category.id);
    }

    // ── Inserción ─────────────────────────────────────────────────────────
    const insertedIds: string[] = [];

    for (const row of current.valid) {
      const categoryId = row.categoryId
        ? row.categoryId
        : row.categoryName
          ? categoryIdByNormalized.get(normalizeCategoryName(row.categoryName)) ?? null
          : null;

      if (row.categoryName && !categoryId) {
        throw new CsvImportError(
          `No se pudo resolver la categoría “${row.categoryName}” de la fila ${row.line}. No se guardó nada.`,
          409,
        );
      }

      const created = await tx.movement.create({
        data: {
          kind: row.kind,
          amount: row.amount,
          date: calendarToDb(row.date),
          description: row.description,
          accountId: row.accountId,
          toAccountId: row.toAccountId,
          categoryId,
        },
        select: { id: true },
      });
      insertedIds.push(created.id);
    }

    if (insertedIds.length !== current.preview.importableRows) {
      throw new CsvImportError(
        "La cantidad importada no coincide con la vista previa. No se guardó nada.",
        409,
      );
    }

    // ── Conciliación: leer de la BASE lo que se acaba de escribir ─────────
    //
    // No se suman los datos en memoria: se leen los movimientos insertados y
    // se agrupan por tipo. Así la comparación es contra lo que Postgres
    // realmente tiene, no contra lo que el código cree que mandó.
    const grouped = await tx.movement.groupBy({
      by: ["kind"],
      where: { id: { in: insertedIds } },
      _sum: { amount: true },
      _count: { _all: true },
    });

    const insertedTotals = {
      income: money("0"),
      expenses: money("0"),
      transfers: money("0"),
      count: 0,
    };
    for (const group of grouped) {
      const sum = group._sum.amount ? money(group._sum.amount) : money("0");
      insertedTotals.count += group._count._all;
      if (group.kind === "INCOME") insertedTotals.income = sum;
      else if (group.kind === "EXPENSE") insertedTotals.expenses = sum;
      else insertedTotals.transfers = sum;
    }

    if (
      insertedTotals.count !== current.preview.totals.count ||
      !sameTotals(
        {
          income: insertedTotals.income.toFixed(2),
          expenses: insertedTotals.expenses.toFixed(2),
          transfers: insertedTotals.transfers.toFixed(2),
          count: insertedTotals.count,
        },
        current.preview.totals,
      )
    ) {
      throw new CsvImportError(
        "La importación no cerró al centavo contra la vista previa. No se guardó nada.",
        409,
      );
    }

    return {
      imported: insertedTotals.count,
      skippedDuplicates: current.preview.duplicateRows,
      totals: {
        income: insertedTotals.income.toFixed(2),
        expenses: insertedTotals.expenses.toFixed(2),
        transfers: insertedTotals.transfers.toFixed(2),
        count: insertedTotals.count,
      },
      categoriesCreated: current.preview.categoriesToCreate,
    } satisfies CsvImportResultDTO;
  });
}
