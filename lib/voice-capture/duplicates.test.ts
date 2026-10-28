import { describe, expect, it } from "vitest";
import { findPossibleDuplicates, type ExistingMovementRecord } from "./duplicates";
import type { ResolvedMovement } from "./resolve";

describe("voice-capture / duplicates detection", () => {
  const existing: ExistingMovementRecord[] = [
    {
      id: "mov-1",
      kind: "EXPENSE",
      amount: "4500.00",
      date: "2026-10-22",
      description: "Supermercado Coto",
      accountId: "acc-1",
    },
    {
      id: "mov-2",
      kind: "INCOME",
      amount: "150000.00",
      date: "2026-10-20",
      description: "Sueldo",
      accountId: "acc-1",
    },
  ];

  it("detecta posible duplicado con misma fecha, cuenta y monto idéntico", () => {
    const candidate: ResolvedMovement = {
      kind: "EXPENSE",
      amount: 4500,
      date: "2026-10-22",
      description: "Coto",
      accountName: "Galicia",
      fromAccountName: null,
      toAccountName: null,
      categoryName: "Supermercado",
      accountId: "acc-1",
      fromAccountId: null,
      toAccountId: null,
      categoryId: null,
      installments: null,
      sourceText: "gasté 4500 en Coto",
      clarifications: [],
    };

    const dup = findPossibleDuplicates(candidate, existing);
    expect(dup).not.toBeNull();
    expect(dup?.id).toBe("mov-1");
    expect(dup?.reason).toContain("4.500");
  });

  it("no alerta duplicado si la fecha o la cuenta difieren", () => {
    const candidateDiffAccount: ResolvedMovement = {
      kind: "EXPENSE",
      amount: 4500,
      date: "2026-10-22",
      description: "Coto",
      accountName: "Efectivo",
      fromAccountName: null,
      toAccountName: null,
      categoryName: null,
      accountId: "acc-2", // cuenta distinta
      fromAccountId: null,
      toAccountId: null,
      categoryId: null,
      installments: null,
      sourceText: "gasté 4500 en efectivo",
      clarifications: [],
    };

    expect(findPossibleDuplicates(candidateDiffAccount, existing)).toBeNull();
  });
});
