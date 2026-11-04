import { describe, expect, it } from "vitest";
import { validateBatchSaveInput, type BatchSaveMovementInput } from "./batch-service";

describe("voice-capture / batch-service - validateBatchSaveInput", () => {
  it("valida y acepta movimientos correctos", () => {
    const inputs: BatchSaveMovementInput[] = [
      {
        kind: "EXPENSE",
        amount: 4500,
        date: "2026-10-22",
        description: "Supermercado",
        accountId: "acc-1",
        categoryId: "cat-1",
      },
      {
        kind: "INCOME",
        amount: 150000,
        date: "2026-10-22",
        description: "Sueldo",
        accountId: "acc-1",
        categoryId: "cat-2",
      },
      {
        kind: "TRANSFER",
        amount: 20000,
        date: "2026-10-22",
        description: "Ahorro",
        fromAccountId: "acc-1",
        toAccountId: "acc-2",
      },
    ];

    const result = validateBatchSaveInput(inputs);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rechaza si falta la cuenta o el monto es menor o igual a cero", () => {
    const invalidInputs: BatchSaveMovementInput[] = [
      {
        kind: "EXPENSE",
        amount: 0,
        date: "2026-10-22",
        description: "Café",
        accountId: "acc-1",
      },
      {
        kind: "EXPENSE",
        amount: 500,
        date: "2026-10-22",
        description: "Facturas",
        accountId: null, // falta cuenta
      },
    ];

    const result = validateBatchSaveInput(invalidInputs);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("rechaza TRANSFER con cuentas iguales o faltantes", () => {
    const invalidTransfers: BatchSaveMovementInput[] = [
      {
        kind: "TRANSFER",
        amount: 1000,
        date: "2026-10-22",
        fromAccountId: "acc-1",
        toAccountId: "acc-1", // iguales
      },
      {
        kind: "TRANSFER",
        amount: 1000,
        date: "2026-10-22",
        fromAccountId: "acc-1",
        toAccountId: null, // falta destino
      },
    ];

    const result = validateBatchSaveInput(invalidTransfers);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("rechaza compras en cuotas con cuotas inválidas", () => {
    const invalidPlan: BatchSaveMovementInput[] = [
      {
        kind: "EXPENSE",
        amount: 60000,
        date: "2026-10-22",
        accountId: "card-1",
        installments: 1, // menor a 2 no es plan de cuotas
      },
    ];

    const result = validateBatchSaveInput(invalidPlan);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("cuotas");
  });

  it("acepta el monto de destino en una transferencia cuando es un monto positivo", () => {
    const result = validateBatchSaveInput([
      {
        kind: "TRANSFER",
        amount: 120000,
        toAmount: 100,
        date: "2026-10-22",
        fromAccountId: "acc-ars",
        toAccountId: "acc-usd",
      },
      {
        kind: "TRANSFER",
        amount: 120000,
        toAmount: "100,50",
        date: "2026-10-22",
        fromAccountId: "acc-ars",
        toAccountId: "acc-usd",
      },
    ]);

    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("rechaza un monto de destino que no es un monto positivo", () => {
    for (const toAmount of [0, -1, "abc", NaN, Infinity]) {
      const result = validateBatchSaveInput([
        {
          kind: "TRANSFER",
          amount: 120000,
          toAmount,
          date: "2026-10-22",
          fromAccountId: "acc-ars",
          toAccountId: "acc-usd",
        },
      ]);

      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/monto de destino/i);
    }
  });

  it("rechaza el monto de destino en un ingreso o un gasto", () => {
    for (const kind of ["INCOME", "EXPENSE"] as const) {
      const result = validateBatchSaveInput([
        {
          kind,
          amount: 1000,
          toAmount: 5,
          date: "2026-10-22",
          accountId: "acc-1",
        },
      ]);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/sólo existe en una transferencia/i);
    }
  });
});
