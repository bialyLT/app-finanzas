/**
 * Métricas de la evaluación del motor de interpretación (Fase 6 · T6.2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTO NO VIVE DENTRO DEL RUNNER
 * ─────────────────────────────────────────────────────────────────────────────
 * El runner en vivo necesita una API key y hace 20 llamadas de red: es lento y
 * no determinista. La parte que decide si un resultado está bien o mal, en
 * cambio, es lógica pura y tiene que poder testearse siempre, incluso sin red.
 *
 * Separarlas permite dos cosas:
 *   1. Que los umbrales del plan se validen en cada `npm test`.
 *   2. Que un cambio en el dataset o en las reglas de comparación no se pueda
 *      romper sin que un test lo note.
 *
 * El runner en vivo sólo aporta los resultados; acá se los juzga.
 */

import type { ResolveContext, ResolvedBatch, ResolvedMovement } from "./resolve";

/** Un movimiento esperado dentro de un caso del dataset. */
export interface ExpectedMovement {
  kind?: string;
  amount?: number;
  accountName?: string;
  fromAccountName?: string;
  toAccountName?: string;
  categoryName?: string;
  installments?: number;
  /** Días respecto de "hoy": -1 = ayer, -2 = anteayer. */
  relativeDayOffset?: number;
  /** Tipo que el motor NUNCA debe devolver en este caso (regla de oro). */
  neverKind?: string;
}

/** Un caso del dataset de evaluación. */
export interface DatasetCase {
  id: string;
  input: string;
  expected?: ExpectedMovement;
  expectedBatch?: ExpectedMovement[];
  expectedClarification?: { field: string };
}

/** Resultado de un caso, dimensión por dimensión. `null` = no aplica. */
export interface CaseOutcome {
  id: string;
  kind: boolean | null;
  amount: boolean | null;
  account: boolean | null;
  category: boolean | null;
  installments: boolean | null;
  date: boolean | null;
  clarification: boolean | null;
  /** Cantidad de movimientos que devolvieron un `neverKind` prohibido. */
  cardRuleViolations: number;
  error: string | null;
}

export interface DimensionSummary {
  applicable: number;
  correct: number;
  /** `null` cuando la dimensión no aplica en ningún caso del dataset. */
  rate: number | null;
}

export interface EvalSummary {
  cases: number;
  errors: number;
  kind: DimensionSummary;
  amount: DimensionSummary;
  account: DimensionSummary;
  category: DimensionSummary;
  installments: DimensionSummary;
  date: DimensionSummary;
  clarification: DimensionSummary;
  cardRuleViolations: number;
}

/**
 * Umbrales mínimos del plan (T6.3).
 *
 * `cardRuleViolations: 0` no es negociable: un pago de resumen cargado como
 * gasto duplica el gasto real de la persona. Es el error más caro del sistema.
 */
export const THRESHOLDS = {
  kind: 0.95,
  amount: 0.95,
  cardRuleViolations: 0,
} as const;

/** Palabras que no distinguen una cuenta de otra. */
const GENERIC_WORDS = new Set([
  "tarjeta",
  "cuenta",
  "de",
  "del",
  "la",
  "el",
  "los",
  "las",
]);

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function tokens(value: string): string[] {
  return normalize(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !GENERIC_WORDS.has(token));
}

/**
 * Compara nombres de cuenta o categoría con tolerancia a lo que no distingue:
 * tildes, mayúsculas y palabras genéricas ("tarjeta Galicia" ~ "Visa Galicia").
 */
export function namesMatch(
  expected: string,
  actual: string | null | undefined,
): boolean {
  if (!actual) return false;

  const a = normalize(expected);
  const b = normalize(actual);

  if (a === b || a.includes(b) || b.includes(a)) return true;

  const expectedTokens = new Set(tokens(expected));

  return tokens(actual).some((token) => expectedTokens.has(token));
}

function cents(value: number): number {
  return Math.round(value * 100);
}

function sameAmount(expected: number, actual: number | null): boolean {
  return actual !== null && cents(expected) === cents(actual);
}

function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));

  return date.toISOString().slice(0, 10);
}

interface MatchedPair {
  expected: ExpectedMovement;
  actual: ResolvedMovement | null;
}

/**
 * Empareja esperados con obtenidos. Con varios movimientos en una frase el
 * orden no está garantizado, así que se busca por tipo y monto antes de caer
 * al primero libre.
 */
function matchPairs(
  expected: ExpectedMovement[],
  actual: ResolvedMovement[],
): MatchedPair[] {
  const used = new Set<number>();

  const take = (predicate: (movement: ResolvedMovement) => boolean) => {
    const index = actual.findIndex(
      (movement, position) => !used.has(position) && predicate(movement),
    );

    if (index === -1) return null;

    used.add(index);

    return actual[index];
  };

  return expected.map((item) => {
    const exact =
      item.kind !== undefined || item.amount !== undefined
        ? take(
            (movement) =>
              (item.kind === undefined || movement.kind === item.kind) &&
              (item.amount === undefined || sameAmount(item.amount, movement.amount)),
          )
        : null;

    return { expected: item, actual: exact ?? take(() => true) };
  });
}

function accountNameOf(
  id: string | null,
  context: ResolveContext,
): string | null {
  if (!id) return null;

  return context.accounts.find((account) => account.id === id)?.name ?? null;
}

function categoryNameOf(
  id: string | null,
  context: ResolveContext,
): string | null {
  if (!id) return null;

  return context.categories.find((category) => category.id === id)?.name ?? null;
}

/** Evalúa un caso completo contra su resultado resuelto. */
export function evaluateCase(
  item: DatasetCase,
  resolved: ResolvedBatch,
  context: ResolveContext,
  error: string | null = null,
): CaseOutcome {
  const movements = resolved.movements;

  const expectedList: ExpectedMovement[] = item.expectedBatch ?? [
    item.expected ?? {},
  ];

  const pairs = matchPairs(expectedList, movements);

  let cardRuleViolations = 0;

  for (const expected of expectedList) {
    if (!expected.neverKind) continue;

    cardRuleViolations += movements.filter(
      (movement) => movement.kind === expected.neverKind,
    ).length;
  }

  const results = {
    kind: [] as boolean[],
    amount: [] as boolean[],
    account: [] as boolean[],
    category: [] as boolean[],
    installments: [] as boolean[],
    date: [] as boolean[],
  };

  for (const { expected, actual } of pairs) {
    if (expected.kind !== undefined) {
      results.kind.push(actual?.kind === expected.kind);
    }

    if (expected.amount !== undefined) {
      results.amount.push(sameAmount(expected.amount, actual?.amount ?? null));
    }

    const accountChecks: boolean[] = [];

    if (expected.accountName !== undefined) {
      accountChecks.push(
        namesMatch(expected.accountName, accountNameOf(actual?.accountId ?? null, context)),
      );
    }

    if (expected.fromAccountName !== undefined) {
      accountChecks.push(
        namesMatch(
          expected.fromAccountName,
          accountNameOf(actual?.fromAccountId ?? null, context),
        ),
      );
    }

    if (expected.toAccountName !== undefined) {
      accountChecks.push(
        namesMatch(
          expected.toAccountName,
          accountNameOf(actual?.toAccountId ?? null, context),
        ),
      );
    }

    if (accountChecks.length > 0) {
      results.account.push(accountChecks.every(Boolean));
    }

    if (expected.categoryName !== undefined) {
      results.category.push(
        namesMatch(
          expected.categoryName,
          categoryNameOf(actual?.categoryId ?? null, context),
        ),
      );
    }

    if (expected.installments !== undefined) {
      results.installments.push(actual?.installments === expected.installments);
    }

    if (expected.relativeDayOffset !== undefined) {
      results.date.push(
        actual?.date === addDays(context.today, expected.relativeDayOffset),
      );
    }
  }

  const collapse = (values: boolean[]): boolean | null =>
    values.length === 0 ? null : values.every(Boolean);

  let clarification: boolean | null = null;

  if (item.expectedClarification) {
    const field = item.expectedClarification.field;

    clarification = movements.some((movement) =>
      movement.clarifications.some((entry) => entry.field === field),
    );
  }

  return {
    id: item.id,
    kind: collapse(results.kind),
    amount: collapse(results.amount),
    account: collapse(results.account),
    category: collapse(results.category),
    installments: collapse(results.installments),
    date: collapse(results.date),
    clarification,
    cardRuleViolations,
    error,
  };
}

function summarizeDimension(values: Array<boolean | null>): DimensionSummary {
  const applicable = values.filter((value): value is boolean => value !== null);
  const correct = applicable.filter(Boolean).length;

  return {
    applicable: applicable.length,
    correct,
    rate: applicable.length === 0 ? null : correct / applicable.length,
  };
}

/** Agrega los resultados de todos los casos. */
export function summarize(outcomes: CaseOutcome[]): EvalSummary {
  return {
    cases: outcomes.length,
    errors: outcomes.filter((outcome) => outcome.error !== null).length,
    kind: summarizeDimension(outcomes.map((outcome) => outcome.kind)),
    amount: summarizeDimension(outcomes.map((outcome) => outcome.amount)),
    account: summarizeDimension(outcomes.map((outcome) => outcome.account)),
    category: summarizeDimension(outcomes.map((outcome) => outcome.category)),
    installments: summarizeDimension(
      outcomes.map((outcome) => outcome.installments),
    ),
    date: summarizeDimension(outcomes.map((outcome) => outcome.date)),
    clarification: summarizeDimension(
      outcomes.map((outcome) => outcome.clarification),
    ),
    cardRuleViolations: outcomes.reduce(
      (total, outcome) => total + outcome.cardRuleViolations,
      0,
    ),
  };
}

function formatRate(dimension: DimensionSummary): string {
  if (dimension.rate === null) return "n/a";

  const percent = (dimension.rate * 100).toFixed(1);

  return `${percent}% (${dimension.correct}/${dimension.applicable})`;
}

/**
 * Devuelve la lista de umbrales incumplidos. Lista vacía = gate en verde.
 */
export function thresholdViolations(summary: EvalSummary): string[] {
  const violations: string[] = [];

  if (summary.kind.rate !== null && summary.kind.rate < THRESHOLDS.kind) {
    violations.push(
      `Tipo de movimiento: ${formatRate(summary.kind)} < ${THRESHOLDS.kind * 100}%`,
    );
  }

  if (summary.amount.rate !== null && summary.amount.rate < THRESHOLDS.amount) {
    violations.push(
      `Monto: ${formatRate(summary.amount)} < ${THRESHOLDS.amount * 100}%`,
    );
  }

  if (summary.cardRuleViolations > THRESHOLDS.cardRuleViolations) {
    violations.push(
      `Regla de oro de tarjetas: ${summary.cardRuleViolations} movimiento(s) con un tipo prohibido (debe ser 0)`,
    );
  }

  return violations;
}

const MARK = (value: boolean | null): string =>
  value === null ? "·" : value ? "ok" : "FALLA";

/** Reporte legible por caso y por dimensión. */
export function formatReport(
  outcomes: CaseOutcome[],
  summary: EvalSummary,
): string {
  const lines: string[] = [""];

  lines.push("caso            tipo   monto  cuenta categ. cuotas fecha  aclar. tarjeta");

  for (const outcome of outcomes) {
    lines.push(
      [
        outcome.id.padEnd(15),
        MARK(outcome.kind).padEnd(6),
        MARK(outcome.amount).padEnd(6),
        MARK(outcome.account).padEnd(6),
        MARK(outcome.category).padEnd(6),
        MARK(outcome.installments).padEnd(6),
        MARK(outcome.date).padEnd(6),
        MARK(outcome.clarification).padEnd(6),
        outcome.cardRuleViolations > 0 ? `VIOLÓ(${outcome.cardRuleViolations})` : "·",
      ].join(" "),
    );

    if (outcome.error) {
      lines.push(`  error: ${outcome.error}`);
    }
  }

  lines.push("");
  lines.push(`Casos: ${summary.cases} · errores del proveedor: ${summary.errors}`);
  lines.push(`Tipo de movimiento: ${formatRate(summary.kind)}`);
  lines.push(`Monto:              ${formatRate(summary.amount)}`);
  lines.push(`Cuenta:             ${formatRate(summary.account)}`);
  lines.push(`Categoría:          ${formatRate(summary.category)}`);
  lines.push(`Cuotas:             ${formatRate(summary.installments)}`);
  lines.push(`Fecha:              ${formatRate(summary.date)}`);
  lines.push(`Aclaraciones:       ${formatRate(summary.clarification)}`);
  lines.push(`Violaciones de regla de tarjetas: ${summary.cardRuleViolations}`);
  lines.push("");

  return lines.join("\n");
}
