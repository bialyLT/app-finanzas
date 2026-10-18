/**
 * Reglas puras de las tarjetas de crédito (Fase 5).
 *
 * Todos los tests de fechas usan fechas FIJAS: el módulo recibe "hoy" como
 * parámetro justamente para que el resultado no dependa del día en que se corra
 * la suite. Los bordes que importan —el 31 en meses cortos, la compra EN el día
 * de cierre, el cruce diciembre/enero— se prueban acá, una vez, sin base de
 * datos.
 */

import { describe, expect, it } from "vitest";
import { sum } from "./money";
import {
  addMonthsToPeriod,
  cardPeriodLabel,
  closingDateOf,
  commitmentsFromItems,
  comparePeriods,
  dueDateOf,
  installmentAmounts,
  isInPeriodWindow,
  isPeriodClosed,
  lastClosedPeriod,
  minimumPayment,
  nextPeriod,
  periodKey,
  periodWindow,
  STATEMENT_MINIMUM_PERCENT,
  statementPeriodOf,
  utilizationPercent,
  type StatementPeriod,
} from "./cards";

const period = (year: number, month: number): StatementPeriod => ({ year, month });
const cents = (values: { toFixed(dp: number): string }[]) =>
  values.map((value) => value.toFixed(2));

describe("Períodos de resumen · aritmética de meses", () => {
  it("suma meses cruzando el año", () => {
    expect(addMonthsToPeriod(period(2026, 12), 1)).toEqual(period(2027, 1));
    expect(addMonthsToPeriod(period(2026, 1), -1)).toEqual(period(2025, 12));
    expect(addMonthsToPeriod(period(2026, 10), 12)).toEqual(period(2027, 10));
    expect(addMonthsToPeriod(period(2026, 10), 0)).toEqual(period(2026, 10));
    expect(addMonthsToPeriod(period(2026, 10), 27)).toEqual(period(2029, 1));
  });

  it("nextPeriod avanza de a uno", () => {
    expect(nextPeriod(period(2026, 12))).toEqual(period(2027, 1));
    expect(nextPeriod(period(2026, 10))).toEqual(period(2026, 11));
  });

  it("compara y etiqueta períodos", () => {
    expect(comparePeriods(period(2026, 10), period(2026, 11))).toBeLessThan(0);
    expect(comparePeriods(period(2026, 12), period(2027, 1))).toBeLessThan(0);
    expect(comparePeriods(period(2026, 10), period(2026, 10))).toBe(0);
    expect(comparePeriods(period(2027, 1), period(2026, 12))).toBeGreaterThan(0);

    expect(periodKey(period(2026, 1))).toBe("2026-01");
    expect(periodKey(period(2026, 12))).toBe("2026-12");
  });
});

describe("closingDateOf · el día de cierre se clampea a fin de mes", () => {
  it("usa el día tal cual cuando existe", () => {
    expect(closingDateOf(period(2026, 10), 25)).toBe("2026-10-25");
    expect(closingDateOf(period(2026, 10), 1)).toBe("2026-10-01");
  });

  it("clampea el 31 a los meses cortos", () => {
    expect(closingDateOf(period(2026, 4), 31)).toBe("2026-04-30");
    expect(closingDateOf(period(2026, 6), 31)).toBe("2026-06-30");
    expect(closingDateOf(period(2026, 2), 31)).toBe("2026-02-28");
  });

  it("respeta el 29 de febrero de un año bisiesto", () => {
    expect(closingDateOf(period(2028, 2), 31)).toBe("2028-02-29");
  });
});

describe("statementPeriodOf · en qué resumen cae una compra", () => {
  it("antes del cierre cae en el mes en curso", () => {
    expect(statementPeriodOf("2026-10-24", 25)).toEqual(period(2026, 10));
  });

  it("EN el día de cierre cae en ESE resumen (regla inclusiva)", () => {
    expect(statementPeriodOf("2026-10-25", 25)).toEqual(period(2026, 10));
  });

  it("un día después del cierre cae en el resumen siguiente", () => {
    expect(statementPeriodOf("2026-10-26", 25)).toEqual(period(2026, 11));
  });

  it("con cierre 1, el día 1 entra y el día 2 no", () => {
    expect(statementPeriodOf("2026-10-01", 1)).toEqual(period(2026, 10));
    expect(statementPeriodOf("2026-10-02", 1)).toEqual(period(2026, 11));
  });

  it("con cierre 31 el último día de un mes corto entra a ese mes", () => {
    expect(statementPeriodOf("2026-04-30", 31)).toEqual(period(2026, 4));
    expect(statementPeriodOf("2026-02-28", 31)).toEqual(period(2026, 2));
    expect(statementPeriodOf("2026-05-01", 31)).toEqual(period(2026, 5));
  });

  it("cruza diciembre/enero sin confundir el mes de compras con el de cierre", () => {
    // Compra del 28 de diciembre con cierre el 25: no entra al resumen de
    // diciembre (ya cerró), entra al de enero.
    expect(statementPeriodOf("2026-12-28", 25)).toEqual(period(2027, 1));
    // Compra del 20 de diciembre: sí entra al resumen que cierra en diciembre.
    expect(statementPeriodOf("2026-12-20", 25)).toEqual(period(2026, 12));
  });
});

describe("dueDateOf · el vencimiento es el primer dueDay después del cierre", () => {
  it("cierre 25, vence 5 → vence el 5 del mes siguiente", () => {
    expect(dueDateOf(period(2026, 10), 25, 5)).toBe("2026-11-05");
  });

  it("cierre 5, vence 20 → vence el 20 del mismo mes", () => {
    expect(dueDateOf(period(2026, 10), 5, 20)).toBe("2026-10-20");
  });

  it("cierre y vencimiento el mismo día → vence el mes siguiente", () => {
    expect(dueDateOf(period(2026, 10), 25, 25)).toBe("2026-11-25");
  });

  it("cruza el año", () => {
    expect(dueDateOf(period(2026, 12), 25, 5)).toBe("2027-01-05");
    expect(dueDateOf(period(2027, 1), 25, 5)).toBe("2027-02-05");
  });

  it("clampea el vencimiento a fin de mes", () => {
    // Cierra el 28/2 (31 clampeado) y vence el 31 clampeado a febrero: el 28 no
    // es estrictamente posterior al cierre, así que vence el 31 de marzo.
    expect(dueDateOf(period(2026, 2), 31, 31)).toBe("2026-03-31");
    // Cierra el 25/2 y vence el 31: febrero no tiene 31 → 28, que sí es después.
    expect(dueDateOf(period(2026, 2), 25, 31)).toBe("2026-02-28");
  });
});

describe("periodWindow · la ventana de fechas que factura un resumen", () => {
  it("es (cierre anterior, cierre]", () => {
    const window = periodWindow(period(2026, 10), 25);
    expect(window.after).toBe("2026-09-25");
    expect(window.through).toBe("2026-10-25");
  });

  it("incluye el día de cierre y excluye el cierre anterior", () => {
    expect(isInPeriodWindow("2026-09-25", period(2026, 10), 25)).toBe(false);
    expect(isInPeriodWindow("2026-09-26", period(2026, 10), 25)).toBe(true);
    expect(isInPeriodWindow("2026-10-25", period(2026, 10), 25)).toBe(true);
    expect(isInPeriodWindow("2026-10-26", period(2026, 10), 25)).toBe(false);
  });

  it("cruza el año: el resumen de enero empieza después del cierre de diciembre", () => {
    const window = periodWindow(period(2027, 1), 25);
    expect(window.after).toBe("2026-12-25");
    expect(window.through).toBe("2027-01-25");
  });
});

describe("lastClosedPeriod · qué períodos ya se pueden emitir", () => {
  it("el período en curso no cerró", () => {
    expect(lastClosedPeriod("2026-10-17", 25)).toEqual(period(2026, 9));
  });

  it("el día de cierre, el período cierra HOY", () => {
    expect(lastClosedPeriod("2026-10-25", 25)).toEqual(period(2026, 10));
  });

  it("después del cierre, el último cerrado es el del mes", () => {
    expect(lastClosedPeriod("2026-10-26", 25)).toEqual(period(2026, 10));
    expect(lastClosedPeriod("2026-11-01", 25)).toEqual(period(2026, 10));
  });

  it("isPeriodClosed coincide con lastClosedPeriod", () => {
    expect(isPeriodClosed(period(2026, 10), "2026-10-24", 25)).toBe(false);
    expect(isPeriodClosed(period(2026, 10), "2026-10-25", 25)).toBe(true);
    expect(isPeriodClosed(period(2026, 11), "2026-10-25", 25)).toBe(false);
  });
});

describe("installmentAmounts · repartir el total sin perder centavos", () => {
  it("reparte parejo cuando la división es exacta", () => {
    const values = installmentAmounts("120000", 12);
    expect(values).toHaveLength(12);
    expect(cents(values)).toEqual(Array(12).fill("10000.00"));
  });

  it("la última absorbe el redondeo y la suma da EXACTO el total", () => {
    const values = installmentAmounts("100000", 3);
    expect(cents(values)).toEqual(["33333.33", "33333.33", "33333.34"]);
    expect(sum(values).toFixed(2)).toBe("100000.00");
  });

  it("la última nunca es menor que las demás", () => {
    const values = installmentAmounts("100001", 7);
    const base = values[0];
    for (const value of values) {
      expect(value.greaterThanOrEqualTo(base)).toBe(true);
    }
    expect(sum(values).toFixed(2)).toBe("100001.00");
  });

  it("con el mínimo de un centavo por cuota, todas son positivas", () => {
    const values = installmentAmounts("0.04", 4);
    expect(cents(values)).toEqual(["0.01", "0.01", "0.01", "0.01"]);
  });

  it("rechaza un total que no alcanza para cuotas de un centavo", () => {
    expect(() => installmentAmounts("0.03", 4)).toThrow(/un centavo/);
  });

  it("rechaza montos y cantidades inválidas", () => {
    expect(() => installmentAmounts("0", 3)).toThrow(/mayor a cero/);
    expect(() => installmentAmounts("-10", 3)).toThrow(/mayor a cero/);
    expect(() => installmentAmounts("100", 0)).toThrow(/entero/);
    expect(() => installmentAmounts("100", 1.5)).toThrow(/entero/);
  });
});

describe("minimumPayment · 5% hacia arriba, nunca más que el total", () => {
  it("usa el porcentaje documentado", () => {
    expect(STATEMENT_MINIMUM_PERCENT).toBe(5);
    expect(minimumPayment("120000").toFixed(2)).toBe("6000.00");
    expect(minimumPayment("19.99").toFixed(2)).toBe("1.00");
  });

  it("redondea HACIA ARRIBA al centavo", () => {
    expect(minimumPayment("100.10").toFixed(2)).toBe("5.01");
    expect(minimumPayment("100.00").toFixed(2)).toBe("5.00");
  });

  it("nunca supera el total", () => {
    expect(minimumPayment("0.03").toFixed(2)).toBe("0.01");
    expect(minimumPayment("0.01").toFixed(2)).toBe("0.01");
  });

  it("sin deuda el mínimo es cero", () => {
    expect(minimumPayment("0").toFixed(2)).toBe("0.00");
    expect(minimumPayment("-5").toFixed(2)).toBe("0.00");
  });
});

describe("utilizationPercent · deuda sobre límite", () => {
  it("calcula el porcentaje", () => {
    expect(utilizationPercent("50000", "100000")?.toFixed(2)).toBe("50.00");
    expect(utilizationPercent("120000", "600000")?.toFixed(2)).toBe("20.00");
    expect(utilizationPercent("300000", "150000")?.toFixed(2)).toBe("200.00");
  });

  it("sin límite no se sabe: null, nunca 0", () => {
    expect(utilizationPercent("50000", null)).toBeNull();
    expect(utilizationPercent("50000", "0")).toBeNull();
  });

  it("una tarjeta a favor usa 0% del límite", () => {
    expect(utilizationPercent("0", "100000")?.toFixed(2)).toBe("0.00");
    expect(utilizationPercent("-5000", "100000")?.toFixed(2)).toBe("0.00");
  });
});

describe("commitmentsFromItems · cuotas comprometidas de los próximos meses", () => {
  const items = Array.from({ length: 12 }, (_, index) => {
    const current = addMonthsToPeriod(period(2026, 10), index);
    return {
      periodYear: current.year,
      periodMonth: current.month,
      amount: "10000",
    };
  });

  it("los próximos 6 y 12 meses", () => {
    const commitments = commitmentsFromItems(items, period(2026, 10), 12);
    expect(commitments.months).toHaveLength(12);
    expect(commitments.months[0]).toMatchObject({ year: 2026, month: 10 });
    expect(commitments.months[11]).toMatchObject({ year: 2027, month: 9 });
    expect(commitments.total.toFixed(2)).toBe("120000.00");
    expect(
      sum(commitments.months.slice(0, 6).map((month) => month.amount)).toFixed(2),
    ).toBe("60000.00");
  });

  it("una cuota de un resumen ya pagado no se compromete de nuevo", () => {
    const commitments = commitmentsFromItems(
      items,
      period(2026, 10),
      12,
      new Set(["2026-10"]),
    );
    expect(commitments.total.toFixed(2)).toBe("110000.00");
  });

  it("ignora las cuotas fuera de la ventana", () => {
    const commitments = commitmentsFromItems(
      items,
      period(2026, 11),
      6,
      new Set(),
    );
    // Nov..Abr: 6 cuotas. Octubre (ya facturado) queda afuera.
    expect(commitments.months.map((month) => month.month)).toEqual([11, 12, 1, 2, 3, 4]);
    expect(commitments.total.toFixed(2)).toBe("60000.00");
  });

  it("suma varias cuotas del mismo período (dos planes)", () => {
    const commitments = commitmentsFromItems(
      [
        { periodYear: 2026, periodMonth: 11, amount: "10000" },
        { periodYear: 2026, periodMonth: 11, amount: "5000" },
      ],
      period(2026, 11),
      6,
    );
    expect(commitments.months[0].amount.toFixed(2)).toBe("15000.00");
    expect(commitments.total.toFixed(2)).toBe("15000.00");
  });
});

describe("cardPeriodLabel", () => {
  it("muestra el mes y el año en castellano", () => {
    const label = cardPeriodLabel(period(2026, 10));
    expect(label).toContain("2026");
    expect(label.toLowerCase()).toContain("octubre");
  });
});
