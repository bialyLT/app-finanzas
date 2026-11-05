import { describe, expect, it } from "vitest";
import { resolveBatch, type ResolveContext } from "./resolve";

describe("voice-capture / resolveBatch", () => {
  const context: ResolveContext = {
    today: "2026-10-22",
    currencies: ["ARS", "USD"],
    accounts: [
      { id: "acc-1", name: "Banco Galicia", kind: "BANK", currency: "ARS" },
      { id: "acc-2", name: "Efectivo", kind: "CASH", currency: "ARS" },
      { id: "acc-3", name: "Visa Galicia", kind: "CREDIT_CARD", currency: "ARS" },
      { id: "acc-4", name: "Préstamo Personal", kind: "LOAN", currency: "ARS" },
      { id: "acc-5", name: "Caja Dólares", kind: "CASH", currency: "USD" },
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

  // ── MONEDAS (F4.5) ──

  it("completa una moneda nula con la de la cuenta resuelta", () => {
    const rawBatch = {
      movements: [
        {
          kind: "EXPENSE",
          amount: 100,
          date: "2026-10-22",
          description: "Curso online",
          categoryName: null,
          accountName: "Caja Dólares",
          fromAccountName: null,
          toAccountName: null,
          installments: null,
          currency: null,
          sourceText: "gasté 100 en el curso, pagué con la caja de dólares",
          clarifications: [],
        },
      ],
      unparsedText: null,
    };

    const resolved = resolveBatch(rawBatch, context);
    const m = resolved.movements[0];
    expect(m.currency).toBe("USD");
    expect(m.accountId).toBe("acc-5");
    expect(m.clarifications.find((c) => c.field === "currency")).toBeUndefined();
  });

  it("pide aclaración si la moneda no está habilitada", () => {
    const restricted: ResolveContext = { ...context, currencies: ["ARS"] };
    const rawBatch = {
      movements: [
        {
          kind: "EXPENSE",
          amount: 100,
          date: "2026-10-22",
          description: "Curso online",
          categoryName: null,
          accountName: "Caja Dólares",
          fromAccountName: null,
          toAccountName: null,
          installments: null,
          currency: "USD",
          sourceText: "gasté 100 dólares en un curso online",
          clarifications: [],
        },
      ],
      unparsedText: null,
    };

    const resolved = resolveBatch(rawBatch, restricted);
    const m = resolved.movements[0];
    const clarif = m.clarifications.find((c) => c.field === "currency");
    expect(clarif).toBeDefined();
    expect(clarif?.options).toEqual(["ARS"]);
    expect(clarif?.reason).toContain("no está habilitada");
    // El movimiento sigue existiendo para que la persona lo corrija.
    expect(m.amount).toBe(100);
  });

  it("pide aclaración si la moneda difiere de la cuenta que matcheó el nombre", () => {
    const rawBatch = {
      movements: [
        {
          kind: "EXPENSE",
          amount: 5000,
          date: "2026-10-22",
          description: "Cena",
          categoryName: null,
          accountName: "Banco Galicia",
          fromAccountName: null,
          toAccountName: null,
          installments: null,
          currency: "USD",
          sourceText: "gasté 5000 dólares con la Galicia",
          clarifications: [],
        },
      ],
      unparsedText: null,
    };

    const resolved = resolveBatch(rawBatch, context);
    const m = resolved.movements[0];
    const clarif = m.clarifications.find((c) => c.field === "currency");
    expect(clarif).toBeDefined();
    expect(clarif?.reason).toContain("Banco Galicia");
    // La cuenta NO se cambia sola: sigue siendo la que matcheó el nombre.
    expect(m.accountId).toBe("acc-1");
  });

  it("pide aclaración en una transferencia entre monedas distintas", () => {
    const rawBatch = {
      movements: [
        {
          kind: "TRANSFER",
          amount: 100000,
          date: "2026-10-22",
          description: "Compra de dólares",
          categoryName: null,
          accountName: null,
          fromAccountName: "Banco Galicia",
          toAccountName: "Caja Dólares",
          installments: null,
          currency: null,
          sourceText: "pasé 100 lucas de Galicia a la caja de dólares",
          clarifications: [],
        },
      ],
      unparsedText: null,
    };

    const resolved = resolveBatch(rawBatch, context);
    const m = resolved.movements[0];
    const currencyClarifications = m.clarifications.filter(
      (c) => c.field === "currency",
    );
    expect(currencyClarifications).toHaveLength(1);
    expect(currencyClarifications[0]?.reason).toContain("a mano");
    expect(m.fromAccountId).toBe("acc-1");
    expect(m.toAccountId).toBe("acc-5");
  });

  it("trata una moneda desconocida como aclaración, sin romper el lote", () => {
    const rawBatch = {
      movements: [
        {
          kind: "EXPENSE",
          amount: 200,
          date: "2026-10-22",
          description: "Compra en el exterior",
          categoryName: null,
          accountName: "Banco Galicia",
          fromAccountName: null,
          toAccountName: null,
          installments: null,
          currency: "EUR",
          sourceText: "gasté 200 euros con la Galicia",
          clarifications: [],
        },
      ],
      unparsedText: null,
    };

    const resolved = resolveBatch(rawBatch, context);
    const m = resolved.movements[0];
    const currencyClarifications = m.clarifications.filter(
      (c) => c.field === "currency",
    );
    expect(currencyClarifications).toHaveLength(1);
    expect(currencyClarifications[0]?.options).toEqual(["ARS", "USD"]);
  });

  it("completa las opciones de una aclaración currency que ya trajo el modelo", () => {
    const restricted: ResolveContext = { ...context, currencies: ["ARS"] };
    const rawBatch = {
      movements: [
        {
          kind: "EXPENSE",
          amount: 100,
          date: "2026-10-22",
          description: "Curso online",
          categoryName: null,
          accountName: null,
          fromAccountName: null,
          toAccountName: null,
          installments: null,
          currency: "USD",
          sourceText: "gasté 100 dólares en un curso online",
          clarifications: [
            { field: "currency", reason: "La app no opera en dólares." },
          ],
        },
      ],
      unparsedText: null,
    };

    const resolved = resolveBatch(rawBatch, restricted);
    const clarif = resolved.movements[0].clarifications.find(
      (c) => c.field === "currency",
    );
    expect(clarif?.options).toEqual(["ARS"]);
    expect(clarif?.reason).toBe("La app no opera en dólares.");
  });

  it("rechaza un tipo hostil en currency sin lanzar (lote no parseable)", () => {
    const rawBatch = {
      movements: [
        {
          kind: "EXPENSE",
          amount: 200,
          date: "2026-10-22",
          description: "Hostil",
          categoryName: null,
          accountName: "Banco Galicia",
          fromAccountName: null,
          toAccountName: null,
          installments: null,
          currency: 123,
          sourceText: "200 con la Galicia",
          clarifications: [],
        },
      ],
      unparsedText: null,
    };

    const resolved = resolveBatch(rawBatch, context);
    expect(resolved.movements).toHaveLength(0);
    expect(resolved.unparsedText).not.toBeNull();
  });

  it("prioriza la transferencia cruzada sobre 'distinta de la cuenta'", () => {
    // El modelo declara la moneda de DESTINO: aplican las dos reglas. La
    // acción que importa es cargar el segundo monto a mano, no confirmar la
    // cuenta (prioridad del brief: cruzada > distinta).
    const rawBatch = {
      movements: [
        {
          kind: "TRANSFER",
          amount: 100000,
          date: "2026-10-22",
          description: "Compra de dólares",
          categoryName: null,
          accountName: null,
          fromAccountName: "Banco Galicia",
          toAccountName: "Caja Dólares",
          installments: null,
          currency: "USD",
          sourceText: "pasé 100 lucas de Galicia a la caja de dólares",
          clarifications: [],
        },
      ],
      unparsedText: null,
    };

    const resolved = resolveBatch(rawBatch, context);
    const currencyClarifications = resolved.movements[0]!.clarifications.filter(
      (c) => c.field === "currency",
    );
    expect(currencyClarifications).toHaveLength(1);
    expect(currencyClarifications[0]?.reason).toContain("a mano");
  });

  it("no ofrece options vacías si no hay monedas habilitadas", () => {
    const sinMonedas: ResolveContext = { ...context, currencies: [] };
    const rawBatch = {
      movements: [
        {
          kind: "EXPENSE",
          amount: 100,
          date: "2026-10-22",
          description: "Curso online",
          categoryName: null,
          accountName: "Banco Galicia",
          fromAccountName: null,
          toAccountName: null,
          installments: null,
          currency: "USD",
          sourceText: "gasté 100 dólares en un curso online",
          clarifications: [],
        },
      ],
      unparsedText: null,
    };

    const clarif = resolveBatch(rawBatch, sinMonedas).movements[0]!.clarifications.find(
      (c) => c.field === "currency",
    );
    expect(clarif).toBeDefined();
    expect(clarif?.options).toBeUndefined();
    expect(clarif?.reason).toContain("no hay monedas configuradas");
  });
});
