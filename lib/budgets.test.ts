import { describe, it, expect } from "vitest";
import { calculateBudgetStatus, parseBudgetMonth } from "./budgets";

describe("lib/budgets", () => {
  describe("calculateBudgetStatus", () => {
    it("clasifica como 'ok' cuando el consumo está por debajo del 80%", () => {
      const res = calculateBudgetStatus(100000, 50000);
      expect(res.status).toBe("ok");
      expect(res.percentage).toBe(50);
      expect(res.remaining).toBe(50000);
    });

    it("clasifica como 'warning' cuando el consumo está entre 80% y 100%", () => {
      const res = calculateBudgetStatus(100000, 85000);
      expect(res.status).toBe("warning");
      expect(res.percentage).toBe(85);
      expect(res.remaining).toBe(15000);

      const exacto80 = calculateBudgetStatus(100000, 80000);
      expect(exacto80.status).toBe("warning");
      expect(exacto80.percentage).toBe(80);
    });

    it("clasifica como 'exceeded' cuando el consumo supera el 100% y da remanente negativo", () => {
      const res = calculateBudgetStatus(100000, 120000);
      expect(res.status).toBe("exceeded");
      expect(res.percentage).toBe(120);
      expect(res.remaining).toBe(-20000);
    });

    it("maneja caso borde de presupuesto 0", () => {
      const res = calculateBudgetStatus(0, 5000);
      expect(res.remaining).toBe(-5000);
      expect(res.percentage).toBe(0);
      expect(res.status).toBe("ok");
    });
  });

  describe("parseBudgetMonth", () => {
    it("convierte 'YYYY-MM' al primer día del mes UTC", () => {
      const d = parseBudgetMonth("2026-10");
      expect(d.toISOString().startsWith("2026-10-01")).toBe(true);
    });

    it("falla si el mes es inválido", () => {
      expect(() => parseBudgetMonth("invalido")).toThrow();
      expect(() => parseBudgetMonth("2026-13")).toThrow();
    });
  });
});
