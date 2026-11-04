import { describe, expect, it } from "vitest";
import {
  evaluateCase,
  formatReport,
  namesMatch,
  summarize,
  thresholdViolations,
  THRESHOLDS,
  type CaseOutcome,
  type DatasetCase,
} from "./eval-metrics";
import type { ResolveContext, ResolvedBatch, ResolvedMovement } from "./resolve";

const context: ResolveContext = {
  today: "2026-10-22",
  accounts: [
    { id: "acc-galicia", name: "Galicia", kind: "BANK" },
    { id: "acc-visa-galicia", name: "Visa Galicia", kind: "CREDIT_CARD" },
    { id: "acc-efectivo", name: "Efectivo", kind: "CASH" },
  ],
  categories: [{ id: "cat-super", name: "Supermercado", kind: "EXPENSE" }],
};

function movement(overrides: Partial<ResolvedMovement> = {}): ResolvedMovement {
  return {
    kind: "EXPENSE",
    amount: 1000,
    date: "2026-10-22",
    description: "",
    categoryName: null,
    accountName: null,
    fromAccountName: null,
    toAccountName: null,
    installments: null,
    sourceText: "",
    clarifications: [],
    accountId: null,
    fromAccountId: null,
    toAccountId: null,
    categoryId: null,
    ...overrides,
  };
}

function batch(movements: ResolvedMovement[]): ResolvedBatch {
  return { movements, unparsedText: null };
}

describe("voice-capture / eval-metrics · comparación de nombres", () => {
  it("ignora tildes y mayúsculas", () => {
    expect(namesMatch("Préstamo Banco", "prestamo banco")).toBe(true);
  });

  it("acepta que la persona diga 'tarjeta Galicia' y la cuenta sea 'Visa Galicia'", () => {
    expect(namesMatch("tarjeta Galicia", "Visa Galicia")).toBe(true);
  });

  it("no confunde cuentas sin tokens en común", () => {
    expect(namesMatch("Galicia", "Efectivo")).toBe(false);
  });

  it("devuelve false cuando no hubo cuenta resuelta", () => {
    expect(namesMatch("Galicia", null)).toBe(false);
  });
});

describe("voice-capture / eval-metrics · evaluación de un caso", () => {
  it("marca todas las dimensiones cuando el resultado es correcto", () => {
    const item: DatasetCase = {
      id: "ok",
      input: "gasté 20 lucas en el súper con Galicia",
      expected: {
        kind: "EXPENSE",
        amount: 20000,
        accountName: "Galicia",
        categoryName: "Supermercado",
      },
    };

    const outcome = evaluateCase(
      item,
      batch([
        movement({
          amount: 20000,
          accountId: "acc-galicia",
          categoryId: "cat-super",
        }),
      ]),
      context,
    );

    expect(outcome.kind).toBe(true);
    expect(outcome.amount).toBe(true);
    expect(outcome.account).toBe(true);
    expect(outcome.category).toBe(true);
    expect(outcome.cardRuleViolations).toBe(0);
  });

  it("detecta un monto mal interpretado", () => {
    const item: DatasetCase = {
      id: "monto",
      input: "20 lucas",
      expected: { kind: "EXPENSE", amount: 20000 },
    };

    const outcome = evaluateCase(item, batch([movement({ amount: 2000 })]), context);

    expect(outcome.amount).toBe(false);
  });

  it("cuenta como violación un pago de tarjeta devuelto como EXPENSE", () => {
    const item: DatasetCase = {
      id: "tarjeta",
      input: "pagué el resumen de la Visa",
      expected: {
        kind: "TRANSFER",
        amount: 120000,
        fromAccountName: "Galicia",
        toAccountName: "Visa Galicia",
        neverKind: "EXPENSE",
      },
    };

    const outcome = evaluateCase(
      item,
      batch([movement({ kind: "EXPENSE", amount: 120000 })]),
      context,
    );

    expect(outcome.kind).toBe(false);
    expect(outcome.cardRuleViolations).toBe(1);
  });

  it("empareja lotes aunque el orden venga invertido", () => {
    const item: DatasetCase = {
      id: "multi",
      input: "12 lucas con Galicia y 5 lucas en efectivo",
      expectedBatch: [
        { kind: "EXPENSE", amount: 12000, accountName: "Galicia" },
        { kind: "EXPENSE", amount: 5000, accountName: "Efectivo" },
      ],
    };

    const outcome = evaluateCase(
      item,
      batch([
        movement({ amount: 5000, accountId: "acc-efectivo" }),
        movement({ amount: 12000, accountId: "acc-galicia" }),
      ]),
      context,
    );

    expect(outcome.amount).toBe(true);
    expect(outcome.account).toBe(true);
  });

  it("valida fechas relativas contra el día de hoy del contexto", () => {
    const item: DatasetCase = {
      id: "ayer",
      input: "ayer gasté 8 lucas",
      expected: { kind: "EXPENSE", amount: 8000, relativeDayOffset: -1 },
    };

    expect(
      evaluateCase(item, batch([movement({ amount: 8000, date: "2026-10-21" })]), context)
        .date,
    ).toBe(true);

    expect(
      evaluateCase(item, batch([movement({ amount: 8000, date: "2026-10-22" })]), context)
        .date,
    ).toBe(false);
  });

  it("exige la aclaración esperada", () => {
    const item: DatasetCase = {
      id: "dolares",
      input: "gasté 100 dólares",
      expectedClarification: { field: "currency" },
    };

    const sinAclaracion = evaluateCase(item, batch([movement()]), context);
    const conAclaracion = evaluateCase(
      item,
      batch([
        movement({
          clarifications: [{ field: "currency", reason: "Moneda no habilitada" }],
        }),
      ]),
      context,
    );

    expect(sinAclaracion.clarification).toBe(false);
    expect(conAclaracion.clarification).toBe(true);
  });

  it("no aplica dimensiones que el caso no declara", () => {
    const item: DatasetCase = { id: "minimo", input: "algo", expected: { kind: "EXPENSE" } };

    const outcome = evaluateCase(item, batch([movement()]), context);

    expect(outcome.amount).toBeNull();
    expect(outcome.account).toBeNull();
    expect(outcome.category).toBeNull();
    expect(outcome.clarification).toBeNull();
  });

  it("marca el caso como error si el proveedor falló", () => {
    const item: DatasetCase = { id: "caido", input: "x", expected: { kind: "EXPENSE" } };

    const outcome = evaluateCase(item, batch([]), context, "timeout");

    expect(outcome.error).toBe("timeout");
    expect(outcome.kind).toBe(false);
  });
});

describe("voice-capture / eval-metrics · resumen y umbrales", () => {
  const passing = (id: string): CaseOutcome => ({
    id,
    kind: true,
    amount: true,
    account: null,
    category: null,
    installments: null,
    date: null,
    clarification: null,
    cardRuleViolations: 0,
    error: null,
  });

  it("calcula tasas sólo sobre las dimensiones aplicables", () => {
    const summary = summarize([passing("a"), passing("b")]);

    expect(summary.kind.rate).toBe(1);
    expect(summary.account.rate).toBeNull();
    expect(summary.cases).toBe(2);
  });

  it("no reporta violaciones cuando todo está por encima del umbral", () => {
    expect(thresholdViolations(summarize([passing("a"), passing("b")]))).toEqual([]);
  });

  it("falla si la precisión de tipo baja del 95%", () => {
    const outcomes: CaseOutcome[] = [];

    for (let index = 0; index < 20; index++) {
      outcomes.push({ ...passing(`caso-${index}`), kind: index < 18 });
    }

    const violations = thresholdViolations(summarize(outcomes));

    expect(summaryRate(outcomes)).toBeLessThan(THRESHOLDS.kind);
    expect(violations.some((violation) => violation.includes("Tipo de movimiento"))).toBe(
      true,
    );
  });

  it("falla si la precisión de monto baja del 95%", () => {
    const outcomes = Array.from({ length: 20 }, (_, index) => ({
      ...passing(`caso-${index}`),
      amount: index < 18,
    }));

    expect(
      thresholdViolations(summarize(outcomes)).some((violation) =>
        violation.includes("Monto"),
      ),
    ).toBe(true);
  });

  it("falla con una sola violación de la regla de tarjetas", () => {
    const outcomes = [
      passing("a"),
      { ...passing("b"), cardRuleViolations: 1 },
    ];

    const violations = thresholdViolations(summarize(outcomes));

    expect(violations.some((violation) => violation.includes("Regla de oro"))).toBe(true);
  });

  it("el reporte incluye el detalle por caso y el resumen", () => {
    const outcomes = [passing("exp-01")];
    const report = formatReport(outcomes, summarize(outcomes));

    expect(report).toContain("exp-01");
    expect(report).toContain("Tipo de movimiento");
  });
});

function summaryRate(outcomes: CaseOutcome[]): number {
  const summary = summarize(outcomes);

  return summary.kind.rate ?? 0;
}
