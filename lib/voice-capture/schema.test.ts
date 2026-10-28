import { describe, expect, it } from "vitest";
import {
  ClarificationSchema,
  MovementKind,
  ParsedBatchSchema,
  ParsedMovementSchema,
} from "./schema";

describe("voice-capture / schema", () => {
  it("valida tipos de movimiento permitidos (INCOME, EXPENSE, TRANSFER)", () => {
    expect(MovementKind.safeParse("INCOME").success).toBe(true);
    expect(MovementKind.safeParse("EXPENSE").success).toBe(true);
    expect(MovementKind.safeParse("TRANSFER").success).toBe(true);
    expect(MovementKind.safeParse("DEBT").success).toBe(false);
    expect(MovementKind.safeParse("").success).toBe(false);
  });

  it("valida una aclaración bien formada", () => {
    const valid = {
      field: "account",
      reason: "No se especificó la cuenta origen",
      options: ["Galicia", "Efectivo"],
    };
    const res = ClarificationSchema.safeParse(valid);
    expect(res.success).toBe(true);
  });

  it("rechaza una aclaración con campo inválido o razón vacía", () => {
    const invalidField = {
      field: "non_existent_field",
      reason: "Falta dato",
    };
    expect(ClarificationSchema.safeParse(invalidField).success).toBe(false);

    const emptyReason = {
      field: "amount",
      reason: "",
    };
    expect(ClarificationSchema.safeParse(emptyReason).success).toBe(false);
  });

  it("valida un movimiento parseado completo (gasto)", () => {
    const validExpense = {
      kind: "EXPENSE",
      amount: 4500,
      date: "2026-10-22",
      description: "Supermercado Coto",
      categoryName: "Supermercado",
      accountName: "Galicia",
      fromAccountName: null,
      toAccountName: null,
      installments: null,
      sourceText: "gasté 4500 en el súper con la Galicia",
      clarifications: [],
    };

    const res = ParsedMovementSchema.safeParse(validExpense);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.kind).toBe("EXPENSE");
      expect(res.data.amount).toBe(4500);
      expect(res.data.accountName).toBe("Galicia");
    }
  });

  it("valida un movimiento en cuotas con tarjeta", () => {
    const cardInstallments = {
      kind: "EXPENSE",
      amount: 120000,
      date: "2026-10-22",
      description: "Zapatillas",
      categoryName: "Ropa",
      accountName: "Visa Galicia",
      fromAccountName: null,
      toAccountName: null,
      installments: 3,
      sourceText: "compré unas zapatillas en 3 cuotas con la Visa",
      clarifications: [],
    };

    const res = ParsedMovementSchema.safeParse(cardInstallments);
    expect(res.success).toBe(true);
  });

  it("valida una transferencia entre cuentas", () => {
    const transfer = {
      kind: "TRANSFER",
      amount: 50000,
      date: "2026-10-22",
      description: "Transferencia propia",
      categoryName: null,
      accountName: null,
      fromAccountName: "Galicia",
      toAccountName: "Mercado Pago",
      installments: null,
      sourceText: "me pasé 50 lucas de Galicia a Mercado Pago",
      clarifications: [],
    };

    const res = ParsedMovementSchema.safeParse(transfer);
    expect(res.success).toBe(true);
  });

  it("rechaza fechas con formato inválido o montos negativos/cero", () => {
    const invalidDate = {
      kind: "EXPENSE",
      amount: 100,
      date: "22/10/2026", // no es AAAA-MM-DD
      description: "Test",
      categoryName: null,
      accountName: "Efectivo",
      fromAccountName: null,
      toAccountName: null,
      installments: null,
      sourceText: "100 en efectivo",
      clarifications: [],
    };
    expect(ParsedMovementSchema.safeParse(invalidDate).success).toBe(false);

    const negativeAmount = {
      ...invalidDate,
      date: "2026-10-22",
      amount: -50,
    };
    expect(ParsedMovementSchema.safeParse(negativeAmount).success).toBe(false);

    const zeroAmount = {
      ...invalidDate,
      date: "2026-10-22",
      amount: 0,
    };
    expect(ParsedMovementSchema.safeParse(zeroAmount).success).toBe(false);
  });

  it("valida un ParsedBatch con múltiples movimientos y unparsedText", () => {
    const batch = {
      movements: [
        {
          kind: "EXPENSE",
          amount: 1200,
          date: "2026-10-22",
          description: "Nafta",
          categoryName: "Auto",
          accountName: "Efectivo",
          fromAccountName: null,
          toAccountName: null,
          installments: null,
          sourceText: "1200 de nafta en efectivo",
          clarifications: [],
        },
      ],
      unparsedText: "y después no me acuerdo qué más compré",
    };

    const res = ParsedBatchSchema.safeParse(batch);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.movements).toHaveLength(1);
      expect(res.data.unparsedText).toBe("y después no me acuerdo qué más compré");
    }
  });
});
