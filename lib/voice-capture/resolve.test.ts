import { describe, expect, it } from "vitest";
import { resolveBatch, type ResolveContext } from "./resolve";

describe("voice-capture / resolveBatch", () => {
  const context: ResolveContext = {
    today: "2026-10-22",
    accounts: [
      { id: "acc-1", name: "Banco Galicia", kind: "BANK" },
      { id: "acc-2", name: "Efectivo", kind: "CASH" },
      { id: "acc-3", name: "Visa Galicia", kind: "CREDIT_CARD" },
      { id: "acc-4", name: "Préstamo Personal", kind: "LOAN" },
    ],
    categories: [
      { id: "cat-1", name: "Supermercado", kind: "EXPENSE" },
      { id: "cat-2", name: "Sueldo", kind: "INCOME" },
    ],
  };

  it("resuelve cuentas y categorías existentes por comparación insensible a mayúsculas/espacios", () => {
    const rawBatch = {
      movements: [
        {
          kind: "EXPENSE",
          amount: 4500,
          date: "2026-10-22",
          description: "Supermercado",
          categoryName: "supermercado  ",
          accountName: "  banco galicia ",
          fromAccountName: null,
          toAccountName: null,
          installments: null,
          sourceText: "gasté 4500 en el súper con Galicia",
          clarifications: [],
        },
      ],
      unparsedText: null,
    };

    const resolved = resolveBatch(rawBatch, context);
    expect(resolved.movements).toHaveLength(1);
    const m = resolved.movements[0];
    expect(m.accountId).toBe("acc-1");
    expect(m.accountName).toBe("Banco Galicia");
    expect(m.categoryId).toBe("cat-1");
    expect(m.categoryName).toBe("Supermercado");
    expect(m.clarifications).toHaveLength(0);
  });

  it("agrega aclaración si la cuenta no coincide con ninguna existente", () => {
    const rawBatch = {
      movements: [
        {
          kind: "EXPENSE",
          amount: 1500,
          date: "2026-10-22",
          description: "Kiosco",
          categoryName: null,
          accountName: "Banco Santander", // no existe en context
          fromAccountName: null,
          toAccountName: null,
          installments: null,
          sourceText: "1500 con Santander",
          clarifications: [],
        },
      ],
      unparsedText: null,
    };

    const resolved = resolveBatch(rawBatch, context);
    const m = resolved.movements[0];
    expect(m.accountId).toBeNull();
    const clarif = m.clarifications.find((c) => c.field === "account");
    expect(clarif).toBeDefined();
    expect(clarif?.options).toEqual(
      expect.arrayContaining(["Banco Galicia", "Efectivo", "Visa Galicia"]),
    );
  });

  it("convierte un gasto con destino pago de tarjeta a TRANSFER o genera aclaración", () => {
    const rawBatch = {
      movements: [
        {
          kind: "EXPENSE",
          amount: 80000,
          date: "2026-10-22",
          description: "Pago de la tarjeta Visa",
          categoryName: null,
          accountName: "Visa Galicia",
          fromAccountName: null,
          toAccountName: null,
          installments: null,
          sourceText: "pagué 80 lucas de la tarjeta con el Galicia",
          clarifications: [],
        },
      ],
      unparsedText: null,
    };

    const resolved = resolveBatch(rawBatch, context);
    const m = resolved.movements[0];
    // Debe convertirse a TRANSFER o exigir aclaración de origen/destino
    expect(m.kind).toBe("TRANSFER");
    expect(m.toAccountId).toBe("acc-3"); // Visa Galicia
  });

  it("agrega aclaración si en un TRANSFER origen y destino son iguales", () => {
    const rawBatch = {
      movements: [
        {
          kind: "TRANSFER",
          amount: 10000,
          date: "2026-10-22",
          description: "Transferencia",
          categoryName: null,
          accountName: null,
          fromAccountName: "Banco Galicia",
          toAccountName: "Banco Galicia",
          installments: null,
          sourceText: "transferí de Galicia a Galicia",
          clarifications: [],
        },
      ],
      unparsedText: null,
    };

    const resolved = resolveBatch(rawBatch, context);
    const m = resolved.movements[0];
    const clarif = m.clarifications.find(
      (c) => c.field === "toAccount" || c.field === "fromAccount",
    );
    expect(clarif).toBeDefined();
    expect(clarif?.reason).toContain("distinta");
  });

  it("agrega aclaración si la categoría entra en conflicto con el tipo de movimiento", () => {
    const rawBatch = {
      movements: [
        {
          kind: "INCOME",
          amount: 50000,
          date: "2026-10-22",
          description: "Freelance",
          categoryName: "Supermercado", // Supermercado es EXPENSE!
          accountName: "Banco Galicia",
          fromAccountName: null,
          toAccountName: null,
          installments: null,
          sourceText: "50 mil de sueldo en Galicia",
          clarifications: [],
        },
      ],
      unparsedText: null,
    };

    const resolved = resolveBatch(rawBatch, context);
    const m = resolved.movements[0];
    expect(m.categoryId).toBeNull();
    const clarif = m.clarifications.find((c) => c.field === "category");
    expect(clarif).toBeDefined();
  });

  it("agrega aclaración si la fecha es en el futuro", () => {
    const rawBatch = {
      movements: [
        {
          kind: "EXPENSE",
          amount: 3000,
          date: "2026-12-31", // futuro respecto a 2026-10-22
          description: "Cena",
          categoryName: null,
          accountName: "Efectivo",
          fromAccountName: null,
          toAccountName: null,
          installments: null,
          sourceText: "3000 en efectivo para fin de año",
          clarifications: [],
        },
      ],
      unparsedText: null,
    };

    const resolved = resolveBatch(rawBatch, context);
    const m = resolved.movements[0];
    const clarif = m.clarifications.find((c) => c.field === "date");
    expect(clarif).toBeDefined();
    expect(clarif?.reason).toContain("futuro");
  });
});
