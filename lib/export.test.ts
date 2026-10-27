import { describe, expect, it } from "vitest";
import { escapeCsvField, exportMovementsToCsv } from "./export";
import type { MovementDTO } from "./finance";

describe("exportMovementsToCsv", () => {
  it("escapa campos especiales correctamente", () => {
    expect(escapeCsvField("simple")).toBe("simple");
    expect(escapeCsvField("con, coma")).toBe('"con, coma"');
    expect(escapeCsvField('con "comillas"')).toBe('"con ""comillas"""');
    expect(escapeCsvField("con\nsalto")).toBe('"con\nsalto"');
    expect(escapeCsvField(null)).toBe("");
  });

  it("genera un CSV compatible con el formato estándar", () => {
    const movements: MovementDTO[] = [
      {
        id: "mov-1",
        date: "2026-10-01",
        kind: "EXPENSE",
        amount: "1500.50",
        description: "Supermercado, pan y leche",
        account: {
          id: "acc-1",
          name: "Efectivo",
          kind: "CASH",
          archived: false,
          openingBalance: "0.00",
          openingIncomeMonth: null,
          closingDay: null,
          dueDay: null,
          creditLimit: null,
          amortizationSystem: null,
        },
        toAccount: null,
        category: { id: "cat-1", name: "Comida", kind: "EXPENSE", lastUsedAt: "2026-10-01T12:00:00Z" },
        recurrenceRuleId: null,
      },
      {
        id: "mov-2",
        date: "2026-10-02",
        kind: "TRANSFER",
        amount: "5000.00",
        description: "",
        account: {
          id: "acc-1",
          name: "Efectivo",
          kind: "CASH",
          archived: false,
          openingBalance: "0.00",
          openingIncomeMonth: null,
          closingDay: null,
          dueDay: null,
          creditLimit: null,
          amortizationSystem: null,
        },
        toAccount: {
          id: "acc-2",
          name: "Banco Galicia",
          kind: "BANK",
          archived: false,
          openingBalance: "0.00",
          openingIncomeMonth: null,
          closingDay: null,
          dueDay: null,
          creditLimit: null,
          amortizationSystem: null,
        },
        category: null,
        recurrenceRuleId: null,
      },
    ];

    const csv = exportMovementsToCsv(movements);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("fecha,tipo,monto,cuenta,cuenta_destino,categoria,descripcion");
    expect(lines[1]).toBe('2026-10-01,EXPENSE,1500.50,Efectivo,,Comida,"Supermercado, pan y leche"');
    expect(lines[2]).toBe("2026-10-02,TRANSFER,5000.00,Efectivo,Banco Galicia,,");
  });
});
