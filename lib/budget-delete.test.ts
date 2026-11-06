import { describe, expect, it } from "vitest";
import {
  cancelBudgetDeletion,
  isBudgetDeletionConfirmed,
  requestBudgetDeletion,
} from "@/lib/budget-delete";

/**
 * El borrado de presupuestos en DOS PASOS, sin `window.confirm()`.
 *
 * El primer toque apunta a un id; recién el botón de confirmación dispara el
 * DELETE, y sólo si el id pendiente es el mismo. Cancelar o pedir otro borrado
 * descarta el pendiente anterior.
 */

describe("confirmación de borrado de presupuestos", () => {
  it("el primer toque deja un borrado pendiente", () => {
    expect(requestBudgetDeletion("budget-1")).toBe("budget-1");
  });

  it("un toque en otro presupuesto reemplaza al pendiente", () => {
    const pending = requestBudgetDeletion("budget-1");
    expect(requestBudgetDeletion("budget-2")).toBe("budget-2");
    expect(isBudgetDeletionConfirmed(pending, "budget-2")).toBe(false);
  });

  it("confirmar sólo vale para el presupuesto pendiente", () => {
    const pending = requestBudgetDeletion("budget-1");
    expect(isBudgetDeletionConfirmed(pending, "budget-1")).toBe(true);
    expect(isBudgetDeletionConfirmed(pending, "budget-2")).toBe(false);
  });

  it("cancelar descarta el pendiente", () => {
    const pending = cancelBudgetDeletion();
    expect(pending).toBeNull();
    expect(isBudgetDeletionConfirmed(pending, "budget-1")).toBe(false);
  });

  it("un id vacío no deja un borrado a medias", () => {
    expect(requestBudgetDeletion("")).toBeNull();
    expect(requestBudgetDeletion("   ")).toBeNull();
    expect(isBudgetDeletionConfirmed(null, "")).toBe(false);
  });
});
