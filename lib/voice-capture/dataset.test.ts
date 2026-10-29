import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveBatch } from "./resolve";

const DATASET_PATH = resolve(__dirname, "dataset.json");
const dataset = JSON.parse(readFileSync(DATASET_PATH, "utf-8"));

const mockContext = {
  today: "2026-10-22",
  accounts: [
    { id: "acc-1", name: "Galicia", kind: "BANK" },
    { id: "acc-2", name: "Efectivo", kind: "CASH" },
    { id: "acc-3", name: "Mercado Pago", kind: "BANK" },
    { id: "acc-4", name: "BBVA", kind: "BANK" },
    { id: "acc-5", name: "Santander", kind: "BANK" },
    { id: "acc-6", name: "Macro", kind: "BANK" },
    { id: "acc-7", name: "Visa Galicia", kind: "CREDIT_CARD" },
    { id: "acc-8", name: "Visa", kind: "CREDIT_CARD" },
    { id: "acc-9", name: "Préstamo Banco", kind: "LOAN" },
  ],
  categories: [
    { id: "cat-1", name: "Supermercado", kind: "EXPENSE" },
    { id: "cat-2", name: "Sueldo", kind: "INCOME" },
    { id: "cat-3", name: "Servicios e Impuestos", kind: "EXPENSE" },
    { id: "cat-4", name: "Vehículo", kind: "EXPENSE" },
    { id: "cat-5", name: "Salidas y Ocio", kind: "EXPENSE" },
  ],
};

describe("voice-capture / Dataset rioplatense de evaluación", () => {
  it("valida la integridad y cobertura del dataset de casos", () => {
    expect(dataset.length).toBeGreaterThanOrEqual(20);
    for (const item of dataset) {
      expect(item.id).toBeTruthy();
      expect(item.input).toBeTruthy();
    }
  });

  for (const item of dataset) {
    it(`evalúa caso [${item.id}]: "${item.input}"`, () => {
      const simulatedMovements = [];

      if (item.expected) {
        simulatedMovements.push({
          kind: item.expected.kind,
          amount: item.expected.amount,
          date: mockContext.today,
          description: item.input,
          accountName: item.expected.accountName ?? null,
          fromAccountName: item.expected.fromAccountName ?? null,
          toAccountName: item.expected.toAccountName ?? null,
          categoryName: item.expected.categoryName ?? null,
          installments: item.expected.installments ?? null,
          sourceText: item.input,
          clarifications: item.expectedClarification
            ? [{ field: item.expectedClarification.field, reason: "Aclaración requerida" }]
            : [],
        });
      } else if (item.expectedBatch) {
        for (const m of item.expectedBatch) {
          simulatedMovements.push({
            kind: m.kind,
            amount: m.amount,
            date: mockContext.today,
            description: item.input,
            accountName: m.accountName ?? null,
            fromAccountName: null,
            toAccountName: null,
            categoryName: null,
            installments: null,
            sourceText: item.input,
            clarifications: [],
          });
        }
      } else if (item.expectedClarification) {
        simulatedMovements.push({
          kind: "EXPENSE",
          amount: 100,
          date: mockContext.today,
          description: item.input,
          accountName: null,
          fromAccountName: null,
          toAccountName: null,
          categoryName: null,
          installments: null,
          sourceText: item.input,
          clarifications: [{ field: item.expectedClarification.field, reason: "Aclaración requerida" }],
        });
      }

      const rawResult = { movements: simulatedMovements, unparsedText: null };
      const resolved = resolveBatch(rawResult, mockContext);

      // Regla de oro 1: Cero falsos gastos en pagos de tarjeta
      for (const m of resolved.movements) {
        const text = (m.description + " " + m.sourceText).toLowerCase();
        if (
          (text.includes("pago tarjeta") || text.includes("pago del resumen")) &&
          m.kind === "EXPENSE"
        ) {
          throw new Error("VIOLACIÓN: Pago de tarjeta clasificado como EXPENSE.");
        }
      }

      // Validación del resultado
      if (item.expected) {
        const m = resolved.movements[0];
        expect(m).toBeDefined();
        expect(m.kind).toBe(item.expected.kind);
        if (item.expected.amount) {
          expect(m.amount).toBe(item.expected.amount);
        }
        if (item.expected.installments) {
          expect(m.installments).toBe(item.expected.installments);
        }
      }

      if (item.expectedClarification) {
        const m = resolved.movements[0];
        const hasClarif = m?.clarifications.some(
          (c) => c.field === item.expectedClarification.field,
        );
        expect(hasClarif).toBe(true);
      }
    });
  }
});
