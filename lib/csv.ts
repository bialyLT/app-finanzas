/**
 * Parser y validación de forma del CSV de importación (Fase 7 ronda 2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTO NO TOCA LA BASE
 * ─────────────────────────────────────────────────────────────────────────────
 * Acá sólo se responde una pregunta: ¿esta fila, tal como está escrita, se
 * puede interpretar? Si la fecha existe, si el monto es un decimal positivo,
 * si el tipo es uno de los tres y si la forma de la fila (destino/categoría)
 * corresponde al tipo.
 *
 * Resolver nombres contra cuentas y categorías, detectar duplicados y escribir
 * es responsabilidad de `lib/csv-import.ts`. Esa división permite probar el
 * parser con strings y sin PostgreSQL, que es donde están los casos raros
 * (BOM, CRLF, comillas, saltos de línea adentro de un campo).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FORMATO SOPORTADO (documentado también en docs/import-csv.md)
 * ─────────────────────────────────────────────────────────────────────────────
 *   · Separador: coma.
 *   · Codificación: UTF-8. Se tolera BOM al principio.
 *   · Fin de línea: LF o CRLF, también mezclados.
 *   · Comillas dobles para encerrar campos con coma, comilla o salto de línea.
 *     Una comilla adentro se escapa duplicándola (`""`).
 *   · Encabezados obligatorios: fecha, tipo, monto, cuenta.
 *   · Encabezados opcionales: cuenta_destino, categoria, descripcion.
 *   · Los alias (importe, date, rubro, etc.) están en `CSV_FIELD_ALIASES`.
 *
 * Los nombres de cuenta y categoría se comparan sin mayúsculas ni acentos, con
 * la misma normalización que usa el resto de la app (`normalizeCategoryName`).
 */

import { isCalendarDate } from "./dates";
import { cleanName, normalizeCategoryName } from "./finance";
import { parseMoneyInput, type Money } from "./money";

/**
 * Tope de tamaño del texto CSV.
 *
 * 256 KB es holgadamente más de 500 filas reales y mantiene el preview barato:
 * el archivo viaja entero en el body y se parsea en memoria. El límite se mide
 * en BYTES UTF-8, no en caracteres, porque es lo que ocupa la petición.
 */
export const CSV_MAX_BYTES = 256 * 1024;

/** Tope de filas de datos (sin contar el encabezado). */
export const CSV_MAX_ROWS = 500;

/** Largo máximo de la descripción, igual que en los movimientos. */
export const CSV_DESCRIPTION_MAX = 200;

/** Largo máximo del nombre de categoría, igual que en favoritos. */
export const CSV_CATEGORY_MAX = 40;

/** Los tres tipos que acepta el CSV. */
export type CsvKind = "INCOME" | "EXPENSE" | "TRANSFER";

/** Las columnas canónicas del formato. */
export type CsvField =
  | "date"
  | "kind"
  | "amount"
  | "account"
  | "toAccount"
  | "category"
  | "description";

/**
 * Error de formato del archivo completo: encabezado ausente, columna
 * duplicada, comillas sin cerrar, NUL, demasiadas filas.
 *
 * No es un error de fila. Una fila inválida se devuelve en el preview para que
 * la persona vea exactamente cuál es; un archivo que no se puede ni parsear no
 * tiene filas que mostrar.
 */
export class CsvError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "CsvError";
    this.status = status;
  }
}

export interface CsvRecord {
  /** Línea física donde EMPIEZA el registro (1 = encabezado). */
  line: number;
  cells: string[];
}

export interface CsvDataRow {
  line: number;
  /** Valores por columna canónica. Las columnas ausentes quedan en "". */
  values: Record<CsvField, string>;
  /**
   * Error de forma del registro (más columnas que el encabezado, por ejemplo).
   * Un error acá invalida la fila, pero no el archivo.
   */
  shapeError: string | null;
}

export interface CsvTable {
  /** Encabezados tal como vinieron, para mostrarlos en el preview. */
  headers: string[];
  rows: CsvDataRow[];
}

/** Resultado de interpretar una fila, antes de resolver nombres contra la base. */
export interface ParsedCsvRow {
  line: number;
  empty: boolean;
  kind: CsvKind | null;
  /** Fecha normalizada `YYYY-MM-DD`, o `null` si no se pudo interpretar. */
  date: string | null;
  /** Monto normalizado `1234.56`, o `null` si no se pudo interpretar. */
  amount: string | null;
  accountName: string;
  toAccountName: string;
  categoryName: string;
  description: string;
  errors: string[];
}

/**
 * Alias de encabezado. La clave se normaliza quitando acentos, mayúsculas,
 * espacios, guiones y guiones bajos: "Cuenta Destino", "cuenta_destino" y
 * "CUENTA-DESTINO" son la misma columna.
 */
const CSV_FIELD_ALIASES: Record<CsvField, readonly string[]> = {
  date: ["fecha", "date", "dia", "fechamovimiento"],
  kind: ["tipo", "type", "clase", "movimiento", "tipomovimiento"],
  amount: ["monto", "importe", "amount", "valor"],
  account: ["cuenta", "account", "cuentaorigen", "origen", "fromaccount"],
  toAccount: [
    "cuentadestino",
    "destino",
    "toaccount",
    "cuentadedestino",
    "hacia",
  ],
  category: ["categoria", "category", "rubro", "etiqueta"],
  description: ["descripcion", "description", "detalle", "nota", "concepto", "comentario"],
};

const FIELD_BY_ALIAS = new Map<string, CsvField>();
for (const [field, aliases] of Object.entries(CSV_FIELD_ALIASES) as [
  CsvField,
  readonly string[],
][]) {
  for (const alias of aliases) {
    FIELD_BY_ALIAS.set(headerKey(alias), field);
  }
}

function headerKey(value: string): string {
  return normalizeCategoryName(value).replace(/[^a-z0-9]+/g, "");
}

/**
 * Parser de registros.
 *
 * Es una máquina de estados y no un `split(",")` por una razón concreta: una
 * descripción puede ser "Súper, verdulería" y entonces la coma NO separa
 * campos. Sin comillas, ese CSV es ambiguo y no hay forma de adivinarlo.
 *
 * Reglas:
 *   · Una comilla sólo abre un campo al principio del campo.
 *   · Después de cerrar comillas se toleran espacios; cualquier otro carácter
 *     es un error (CSV mal formado).
 *   · Una comilla suelta adentro de un campo sin comillas es un error, no un
 *     carácter literal: aceptarla escondería un archivo corrupto.
 *   · Los saltos de línea adentro de comillas se conservan como `\n`.
 */
function parseRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];

  let field = "";
  let cells: string[] = [];
  let inQuotes = false;
  let quoteClosed = false;
  let fieldStarted = false;

  let line = 1;
  let recordLine = 1;
  let index = 0;

  const pushField = () => {
    cells.push(field);
    field = "";
    fieldStarted = false;
    quoteClosed = false;
  };

  const pushRecord = () => {
    cells.push(field);
    field = "";
    // Una línea totalmente vacía (`\n\n`) no es una fila: se ignora. Una línea
    // con comas (`;;` en otro formato, `,,,` acá) sí es una fila vacía y se
    // informa como EMPTY en el preview.
    if (!(cells.length === 1 && cells[0] === "")) {
      records.push({ line: recordLine, cells });
    }
    cells = [];
    fieldStarted = false;
    quoteClosed = false;
  };

  while (index < text.length) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        quoteClosed = true;
        index += 1;
        continue;
      }

      if (char === "\r") {
        if (text[index + 1] === "\n") index += 1;
        field += "\n";
        line += 1;
        index += 1;
        continue;
      }
      if (char === "\n") {
        field += "\n";
        line += 1;
        index += 1;
        continue;
      }

      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      if (!fieldStarted) {
        inQuotes = true;
        fieldStarted = true;
        index += 1;
        continue;
      }
      throw new CsvError(
        `La fila ${line} tiene comillas mal ubicadas. Para escribir una comilla adentro de un campo entre comillas, duplicala ("").`,
      );
    }

    if (char === ",") {
      pushField();
      index += 1;
      continue;
    }

    if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      pushRecord();
      line += 1;
      recordLine = line;
      index += 1;
      continue;
    }

    if (quoteClosed) {
      // Espacios después de la comilla de cierre: se toleran. Cualquier otra
      // cosa sería texto pegado a un campo cerrado, que ningún CSV válido
      // produce.
      if (char === " " || char === "\t") {
        index += 1;
        continue;
      }
      throw new CsvError(
        `La fila ${line} tiene texto después de una comilla de cierre.`,
      );
    }

    field += char;
    fieldStarted = true;
    index += 1;
  }

  if (inQuotes) {
    throw new CsvError(`La fila ${recordLine} tiene comillas sin cerrar.`);
  }

  if (fieldStarted || field !== "" || cells.length > 0) {
    cells.push(field);
    if (!(cells.length === 1 && cells[0] === "")) {
      records.push({ line: recordLine, cells });
    }
  }

  return records;
}

/** Cuenta los bytes UTF-8 de un texto (el tope se mide así, no en caracteres). */
export function csvByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Parsea el archivo completo: BOM, encabezados, alias y filas.
 *
 * Los errores de ACÁ son del archivo, no de una fila. Que falte la columna
 * `monto` no se puede reportar "en la fila 7": no hay forma de interpretar
 * ninguna fila.
 */
export function parseCsv(text: string): CsvTable {
  if (typeof text !== "string") {
    throw new CsvError("El contenido del CSV tiene que ser texto.");
  }
  if (text.includes("\u0000")) {
    // Un NUL no es un carácter de texto: suele ser el síntoma de un archivo
    // binario renombrado a .csv o de una codificación rota. Se rechaza antes de
    // intentar parsear para no guardar datos con bytes invisibles.
    throw new CsvError("El CSV contiene bytes NUL. Guardalo como texto UTF-8 y volvé a intentar.");
  }
  if (csvByteLength(text) > CSV_MAX_BYTES) {
    throw new CsvError(
      `El CSV supera el máximo de ${Math.floor(CSV_MAX_BYTES / 1024)} KB.`,
      413,
    );
  }

  const withoutBom = text.replace(/^\uFEFF/, "");
  const records = parseRecords(withoutBom);

  // Tolerar líneas vacías antes del encabezado: pegar desde una planilla suele
  // arrastrar un salto inicial. No se toleran columnas basura antes.
  const headerIndex = records.findIndex((record) =>
    record.cells.some((cell) => cell.trim() !== ""),
  );
  if (headerIndex === -1) {
    throw new CsvError("El CSV está vacío: falta la fila de encabezados.");
  }

  const headerRecord = records[headerIndex];
  const headers = headerRecord.cells.map((header) => header.trim());
  if (headers.every((header) => header === "")) {
    throw new CsvError("La primera fila del CSV tiene que ser el encabezado.");
  }

  const fieldByIndex: (CsvField | null)[] = [];
  const seen = new Map<CsvField, string>();

  for (const header of headers) {
    const field = header === "" ? null : FIELD_BY_ALIAS.get(headerKey(header)) ?? null;

    if (field === null) {
      fieldByIndex.push(null);
      continue;
    }
    if (seen.has(field)) {
      throw new CsvError(
        `El CSV tiene más de una columna para “${seen.get(field)}”. Dejá una sola.`,
      );
    }
    seen.set(field, header);
    fieldByIndex.push(field);
  }

  const required: { field: CsvField; label: string }[] = [
    { field: "date", label: "fecha" },
    { field: "kind", label: "tipo" },
    { field: "amount", label: "monto" },
    { field: "account", label: "cuenta" },
  ];
  const missing = required.filter(({ field }) => !seen.has(field));
  if (missing.length > 0) {
    throw new CsvError(
      `Al CSV le falta${missing.length === 1 ? " la columna" : "n las columnas"} ${missing
        .map(({ label }) => `“${label}”`)
        .join(", ")}. El encabezado mínimo es: fecha, tipo, monto, cuenta.`,
    );
  }
  const dataRecords = records.slice(headerIndex + 1);
  if (dataRecords.length > CSV_MAX_ROWS) {
    throw new CsvError(
      `El CSV tiene ${dataRecords.length} filas y el máximo es ${CSV_MAX_ROWS}. Partilo en archivos más chicos.`,
      422,
    );
  }

  const rows: CsvDataRow[] = dataRecords.map((record) => {
    const values: Record<CsvField, string> = {
      date: "",
      kind: "",
      amount: "",
      account: "",
      toAccount: "",
      category: "",
      description: "",
    };

    let shapeError: string | null = null;

    for (let column = 0; column < record.cells.length; column += 1) {
      const field = fieldByIndex[column] ?? null;
      const value = record.cells[column] ?? "";

      if (field) {
        values[field] = value;
      } else if (column >= fieldByIndex.length && value.trim() !== "") {
        // Una columna DE MÁS (no existe ni siquiera un encabezado para ella)
        // con contenido es un archivo desalineado: la fila se marca inválida
        // en vez de adivinar a qué campo pertenece. Las columnas desconocidas
        // que sí tienen encabezado se ignoran a propósito.
        shapeError = `La fila ${record.line} tiene más columnas con datos que el encabezado.`;
      }
    }

    return { line: record.line, values, shapeError };
  });

  return { headers, rows };
}

/** Interpreta una fecha del CSV. Acepta `YYYY-MM-DD` y `DD/MM/YYYY`. */
export function parseCsvDate(raw: string): {
  date: string | null;
  error: string | null;
} {
  const value = raw.trim();
  if (value === "") return { date: null, error: "Falta la fecha." };

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) {
    const normalized = `${iso[1]}-${iso[2]}-${iso[3]}`;
    return isCalendarDate(normalized)
      ? { date: normalized, error: null }
      : {
          date: null,
          error: `La fecha “${value}” no existe en el calendario.`,
        };
  }

  const local = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (local) {
    const day = local[1].padStart(2, "0");
    const month = local[2].padStart(2, "0");
    const normalized = `${local[3]}-${month}-${day}`;
    return isCalendarDate(normalized)
      ? { date: normalized, error: null }
      : {
          date: null,
          error: `La fecha “${value}” no existe en el calendario.`,
        };
  }

  return {
    date: null,
    error: `La fecha “${value}” no se entiende. Usá AAAA-MM-DD o DD/MM/AAAA.`,
  };
}

/** Interpreta el tipo. Acepta los valores del enum y sus nombres en castellano. */
export function parseCsvKind(raw: string): CsvKind | null {
  switch (normalizeCategoryName(raw)) {
    case "income":
    case "ingreso":
    case "ingresos":
    case "entrada":
      return "INCOME";
    case "expense":
    case "gasto":
    case "gastos":
    case "salida":
    case "egreso":
      return "EXPENSE";
    case "transfer":
    case "transferencia":
    case "transferencias":
    case "transfe":
      return "TRANSFER";
    default:
      return null;
  }
}

/**
 * Interpreta el monto con la misma regla local que el formulario (coma decimal,
 * punto de miles o punto decimal), pero con controles EXTRA de CSV:
 *
 *   · no se aceptan letras ni notación científica (`1e5` no es un monto);
 *   · el signo negativo se rechaza antes de parsear;
 *   · se exigen como máximo dos decimales (la columna es Decimal(18,2));
 *   · se rechaza el rango que no entra en Decimal(18,2) antes de Postgres.
 */
export function parseCsvAmount(raw: string): {
  amount: Money | null;
  text: string | null;
  error: string | null;
} {
  const value = raw.trim();
  if (value === "") {
    return { amount: null, text: null, error: "Falta el monto." };
  }

  // Sólo dígitos, separadores, espacios y el símbolo de peso. Cualquier letra
  // (incluida la `e` de notación científica) hace que el monto no sea un monto.
  if (!/^[\d.,\s$+-]+$/.test(value)) {
    return {
      amount: null,
      text: null,
      error: `El monto “${value}” no es un número positivo. Escribilo como 1234,56.`,
    };
  }
  if (value.includes("-") || value.includes("+")) {
    return {
      amount: null,
      text: null,
      error: "El monto tiene que ser mayor a cero: el signo lo da el tipo de movimiento.",
    };
  }

  const parsed = parseMoneyInput(value);
  if (!parsed) {
    return {
      amount: null,
      text: null,
      error: `El monto “${value}” no se entiende. Escribilo como 1234,56.`,
    };
  }
  if (parsed.lessThanOrEqualTo(0)) {
    return {
      amount: null,
      text: null,
      error: "El monto tiene que ser mayor a cero.",
    };
  }
  if (parsed.decimalPlaces() > 2) {
    return {
      amount: null,
      text: null,
      error: `El monto “${value}” tiene más de dos decimales.`,
    };
  }
  if (parsed.greaterThanOrEqualTo("10000000000000000")) {
    return {
      amount: null,
      text: null,
      error: "El monto es demasiado grande para la base.",
    };
  }

  return { amount: parsed, text: parsed.toFixed(2), error: null };
}

/**
 * Interpreta una fila. No resuelve cuentas ni categorías: sólo valida que los
 * datos tengan la forma correcta y que destino/categoría correspondan al tipo.
 *
 * Se acumulan TODOS los errores de la fila (no se corta en el primero) para que
 * la persona pueda corregir el archivo de una vez y no de a un error por
 * intento.
 */
export function parseCsvRow(row: CsvDataRow): ParsedCsvRow {
  const errors: string[] = [];
  if (row.shapeError) errors.push(row.shapeError);

  const values = row.values;
  const accountName = cleanName(values.account);
  const toAccountName = cleanName(values.toAccount);
  const categoryName = cleanName(values.category);
  const description = cleanName(values.description);

  const empty =
    accountName === "" &&
    toAccountName === "" &&
    categoryName === "" &&
    description === "" &&
    values.date.trim() === "" &&
    values.kind.trim() === "" &&
    values.amount.trim() === "";

  if (empty) {
    return {
      line: row.line,
      empty: true,
      kind: null,
      date: null,
      amount: null,
      accountName: "",
      toAccountName: "",
      categoryName: "",
      description: "",
      errors: [],
    };
  }

  const dateResult = parseCsvDate(values.date);
  if (dateResult.error) errors.push(dateResult.error);

  const kind = parseCsvKind(values.kind);
  if (kind === null) {
    errors.push(
      `El tipo “${values.kind.trim()}” no se entiende. Usá ingreso, gasto o transferencia.`,
    );
  }

  const amountResult = parseCsvAmount(values.amount);
  if (amountResult.error) errors.push(amountResult.error);

  if (!accountName) errors.push("Falta la cuenta.");

  if (description.length > CSV_DESCRIPTION_MAX) {
    errors.push(
      `La descripción de la fila ${row.line} supera los ${CSV_DESCRIPTION_MAX} caracteres.`,
    );
  }
  if (categoryName.length > CSV_CATEGORY_MAX) {
    errors.push(
      `La categoría “${categoryName}” supera los ${CSV_CATEGORY_MAX} caracteres.`,
    );
  }

  if (kind === "TRANSFER") {
    if (!toAccountName) {
      errors.push("Una transferencia necesita cuenta_destino.");
    } else if (
      normalizeCategoryName(toAccountName) === normalizeCategoryName(accountName)
    ) {
      errors.push("La cuenta de destino tiene que ser distinta a la de origen.");
    }
    if (categoryName) {
      errors.push("Una transferencia no lleva categoría: no es un gasto ni un ingreso.");
    }
  } else if (kind === "INCOME" || kind === "EXPENSE") {
    if (toAccountName) {
      errors.push(
        kind === "INCOME"
          ? "Un ingreso no lleva cuenta_destino: la plata entra a la cuenta indicada."
          : "Un gasto no lleva cuenta_destino: la plata sale de la cuenta indicada.",
      );
    }
  }

  return {
    line: row.line,
    empty: false,
    kind,
    date: dateResult.date,
    amount: amountResult.text,
    accountName,
    toAccountName,
    categoryName,
    description,
    errors,
  };
}
