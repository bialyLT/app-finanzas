/**
 * Tests unitarios de la banderita: «esta plata cuenta como ingreso de este mes».
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ SE PRUEBA Y POR QUÉ ESTAS REGLAS SON PURAS
 *
 * Las tres reglas de la banderita (sólo cuentas de dinero, sólo saldo positivo,
 * sólo en el mes declarado) están escritas UNA vez, en `lib/declared-income.ts`,
 * y la base las custodia con un CHECK. Estos tests son el candado de la lógica:
 * si alguien cambia una regla sin cambiar la base (o al revés), uno de los dos
 * lados se cae y estos tests lo dicen.
 *
 * La aritmética en DECIMAL (no float) y los errores con mensaje: una regla que
 * no se puede explicar no sirve de nada en la interfaz.
 */

import { describe, expect, it } from "vitest";
import {
  canDeclareIncome,
  declaredIncomeWhere,
  incomeMonthToDto,
  parseIncomeMonth,
} from "./declared-income";
import { money } from "./money";

describe("el mes de la declaración", () => {
  it("apagado: no mandar la banderita es lo mismo que mandarla vacía", () => {
    expect(parseIncomeMonth(undefined)).toEqual({ ok: true, month: null });
    expect(parseIncomeMonth(null)).toEqual({ ok: true, month: null });
    expect(parseIncomeMonth("")).toEqual({ ok: true, month: null });
  });

  it("acepta el mes y lo deja como AAAA-MM", () => {
    expect(parseIncomeMonth("2026-10")).toEqual({ ok: true, month: "2026-10" });
  });

  it("un día del mes se reduce a SU mes (la persona declara un mes, no un día)", () => {
    expect(parseIncomeMonth("2026-10-01")).toEqual({ ok: true, month: "2026-10" });
    expect(parseIncomeMonth("2026-10-15")).toEqual({ ok: true, month: "2026-10" });
  });

  it("rechaza lo que no es un mes, con un mensaje (nunca un 500)", () => {
    const casos = ["2026-13", "2026-00", "basura", "10/2026", "2026-1", "2026-02-30"];
    for (const caso of casos) {
      const resultado = parseIncomeMonth(caso);
      expect(resultado.ok, `${caso} debería rechazarse`).toBe(false);
      if (!resultado.ok) {
        expect(resultado.error.length).toBeGreaterThan(10);
      }
    }
  });

  it("un cuerpo hostil (número, array, objeto) no se convierte en un mes", () => {
    for (const caso of [42, true, ["2026-10"], { month: "2026-10" }]) {
      const resultado = parseIncomeMonth(caso);
      expect(resultado.ok, `${JSON.stringify(caso)} debería rechazarse`).toBe(false);
    }
  });
});

describe("quién puede declarar su saldo como ingreso", () => {
  it("efectivo y banco con plata: sí", () => {
    expect(canDeclareIncome("CASH", money("7000")).ok).toBe(true);
    expect(canDeclareIncome("BANK", money("0.01")).ok).toBe(true);
  });

  it("una tarjeta o un préstamo NO: su saldo es una deuda, no plata que entró", () => {
    for (const kind of ["CREDIT_CARD", "LOAN", "RECEIVABLE"]) {
      const resultado = canDeclareIncome(kind, money("500000"));
      expect(resultado.ok, `${kind} no debería poder declarar`).toBe(false);
      if (!resultado.ok) {
        expect(resultado.error).toMatch(/efectivo o banco/);
      }
    }
  });

  it("un saldo en cero o NEGATIVO no es ingreso: es un pasivo", () => {
    for (const saldo of ["0", "0.00", "-1", "-500000"]) {
      const resultado = canDeclareIncome("CASH", money(saldo));
      expect(resultado.ok, `${saldo} no debería poder declarar`).toBe(false);
      if (!resultado.ok) {
        expect(resultado.error).toMatch(/mayor a cero/);
      }
    }
  });
});

describe("el DTO del mes", () => {
  it("la base guarda el primer día del mes; el DTO habla de meses", () => {
    expect(incomeMonthToDto(new Date("2026-10-01T00:00:00.000Z"))).toBe("2026-10");
    expect(incomeMonthToDto("2026-10-01")).toBe("2026-10");
    expect(incomeMonthToDto("2026-10")).toBe("2026-10");
  });

  it("sin banderita: null (y null es el comportamiento de siempre)", () => {
    expect(incomeMonthToDto(null)).toBeNull();
    expect(incomeMonthToDto(undefined)).toBeNull();
  });
});

describe("el filtro de la consulta", () => {
  it("mira el mes, el tipo de cuenta y que el saldo sea positivo", () => {
    const where = declaredIncomeWhere({ from: "2026-10-01", to: "2026-10-31" });

    expect(where.kind).toEqual({ in: ["CASH", "BANK"] });
    expect(where.openingBalance).toEqual({ gt: 0 });
    expect(where.openingIncomeMonth).toBeDefined();
  });

  it("sin límites de fechas el rango cubre todo (y sigue exigiendo los meses)", () => {
    const where = declaredIncomeWhere({ from: null, to: null });
    expect(where.openingIncomeMonth).toBeDefined();
    expect(where.kind).toEqual({ in: ["CASH", "BANK"] });
  });
});
