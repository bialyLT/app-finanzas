/**
 * Tests del motor de recurrencia.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTOS TESTS SON LOS MÁS BARATOS Y LOS MÁS IMPORTANTES DE LA FASE 3
 * ─────────────────────────────────────────────────────────────────────────────
 * Todo el resto de la recurrencia (el generador, la bandeja, la API) confía en
 * que estas fechas son correctas. Un error acá no se ve: produce una fecha que
 * "parece bien" —el 28 de febrero es un día perfectamente creíble— y el
 * vencimiento se corre sin que nadie lo note hasta que la cuenta llega tarde.
 *
 * Cada caso está calculado a mano contra un calendario. Y ninguno toca el reloj
 * de la máquina: el motor no lee la hora, así que el mismo test da el mismo
 * resultado un 15 de junio que un 29 de febrero.
 */

import { describe, expect, it } from "vitest";
import {
  nextOccurrence,
  occurrenceAt,
  occurrencesBetween,
  projectedOccurrences,
  type RecurrenceSpec,
} from "./recurrence";

/** Arma una regla con los valores por defecto más comunes del test. */
function spec(overrides: Partial<RecurrenceSpec> = {}): RecurrenceSpec {
  return {
    freq: "MONTHLY",
    interval: 1,
    startDate: "2026-01-01",
    endDate: null,
    count: null,
    dayOfMonth: null,
    ...overrides,
  };
}

/** Las próximas `n` fechas de una regla, desde su inicio. */
function nextDates(rule: RecurrenceSpec, n: number): string[] {
  return projectedOccurrences(rule, { after: null, limit: n });
}

describe("occurrenceAt — aritmética del calendario", () => {
  it("DAILY avanza días", () => {
    const rule = spec({ freq: "DAILY", startDate: "2026-10-15" });
    expect(occurrenceAt(rule, 0)).toBe("2026-10-15");
    expect(occurrenceAt(rule, 16)).toBe("2026-10-31");
    // Cruza el fin de mes sin nada especial: son días.
    expect(occurrenceAt(rule, 17)).toBe("2026-11-01");
  });

  it("DAILY con interval 10 salta de a diez días", () => {
    const rule = spec({ freq: "DAILY", interval: 10, startDate: "2026-01-01" });
    expect(nextDates(rule, 4)).toEqual([
      "2026-01-01",
      "2026-01-11",
      "2026-01-21",
      "2026-01-31",
    ]);
  });

  it("WEEKLY avanza semanas (7 días por interval)", () => {
    const rule = spec({ freq: "WEEKLY", startDate: "2026-10-15" });
    expect(nextDates(rule, 3)).toEqual(["2026-10-15", "2026-10-22", "2026-10-29"]);
  });

  it("WEEKLY con interval 2 = cada 15 días", () => {
    const rule = spec({ freq: "WEEKLY", interval: 2, startDate: "2026-10-15" });
    expect(nextDates(rule, 3)).toEqual(["2026-10-15", "2026-10-29", "2026-11-12"]);
  });

  it("MONTHLY cae el mismo día de cada mes", () => {
    const rule = spec({ freq: "MONTHLY", startDate: "2026-01-10" });
    expect(nextDates(rule, 3)).toEqual(["2026-01-10", "2026-02-10", "2026-03-10"]);
  });

  it("MONTHLY con interval 2 saltea meses", () => {
    const rule = spec({ freq: "MONTHLY", interval: 2, startDate: "2026-01-10" });
    expect(nextDates(rule, 4)).toEqual([
      "2026-01-10",
      "2026-03-10",
      "2026-05-10",
      "2026-07-10",
    ]);
  });

  it("MONTHLY cruza el fin de año", () => {
    const rule = spec({ freq: "MONTHLY", startDate: "2026-11-20" });
    expect(nextDates(rule, 3)).toEqual(["2026-11-20", "2026-12-20", "2027-01-20"]);
  });

  it("YEARLY cae el mismo mes y día, año tras año", () => {
    const rule = spec({ freq: "YEARLY", startDate: "2026-07-09" });
    expect(nextDates(rule, 3)).toEqual(["2026-07-09", "2027-07-09", "2028-07-09"]);
  });
});

describe("el clamp de fin de mes, con el ancla correcta", () => {
  it("ancla 31: feb 28, y en marzo VUELVE al 31", () => {
    const rule = spec({ freq: "MONTHLY", startDate: "2026-01-31", dayOfMonth: 31 });
    expect(nextDates(rule, 7)).toEqual([
      "2026-01-31",
      "2026-02-28", // no hay 31
      "2026-03-31", // vuelve al ancla — NO sigue en 28
      "2026-04-30",
      "2026-05-31",
      "2026-06-30",
      "2026-07-31",
    ]);
  });

  it("ancla 31: el año siguiente vuelve a empezar en 31", () => {
    const rule = spec({ freq: "MONTHLY", startDate: "2026-01-31", dayOfMonth: 31 });
    // Doce meses después de arrancar: otra vez el 31 de enero.
    expect(occurrenceAt(rule, 12)).toBe("2027-01-31");
    expect(occurrenceAt(rule, 13)).toBe("2027-02-28");
  });

  it("ancla 31 en año bisiesto: feb 29", () => {
    const rule = spec({ freq: "MONTHLY", startDate: "2028-01-31", dayOfMonth: 31 });
    expect(nextDates(rule, 4)).toEqual(["2028-01-31", "2028-02-29", "2028-03-31", "2028-04-30"]);
  });

  it("ancla 30: febrero queda en 28/29 y marzo vuelve al 30", () => {
    const rule = spec({ freq: "MONTHLY", startDate: "2026-01-30", dayOfMonth: 30 });
    expect(nextDates(rule, 4)).toEqual(["2026-01-30", "2026-02-28", "2026-03-30", "2026-04-30"]);
  });

  it("ancla 29: solo el bisiesto la tiene exacta", () => {
    const rule = spec({ freq: "MONTHLY", startDate: "2028-01-29", dayOfMonth: 29 });
    expect(nextDates(rule, 3)).toEqual(["2028-01-29", "2028-02-29", "2028-03-29"]);
  });

  it("YEARLY con ancla 29 de febrero: se corre y VUELVE en el bisiesto", () => {
    const rule = spec({ freq: "YEARLY", startDate: "2028-02-29" });
    expect(nextDates(rule, 5)).toEqual([
      "2028-02-29", // bisiesto
      "2029-02-28",
      "2030-02-28",
      "2031-02-28",
      "2032-02-29", // vuelve el 29
    ]);
  });
});

describe("el ancla y el arranque", () => {
  it("sin dayOfMonth, el ancla es el día de startDate", () => {
    const rule = spec({ freq: "MONTHLY", startDate: "2026-05-31" });
    expect(nextDates(rule, 3)).toEqual(["2026-05-31", "2026-06-30", "2026-07-31"]);
  });

  it("con dayOfMonth anterior a startDate, la primera ocurrencia es la del mes siguiente", () => {
    // La regla empieza el 17 de octubre pero vence el 1: el 1 de octubre ya
    // pasó, así que la primera ocurrencia es el 1 de noviembre.
    const rule = spec({ freq: "MONTHLY", startDate: "2026-10-17", dayOfMonth: 1 });
    expect(nextDates(rule, 3)).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"]);
  });

  it("con dayOfMonth posterior a startDate, la primera ocurrencia es del mismo mes", () => {
    const rule = spec({ freq: "MONTHLY", startDate: "2026-10-17", dayOfMonth: 31 });
    expect(nextDates(rule, 2)).toEqual(["2026-10-31", "2026-11-30"]);
  });

  it("con dayOfMonth igual a startDate, la primera ocurrencia es startDate", () => {
    const rule = spec({ freq: "MONTHLY", startDate: "2026-10-01", dayOfMonth: 1 });
    expect(nextDates(rule, 2)).toEqual(["2026-10-01", "2026-11-01"]);
  });

  it("ninguna ocurrencia cae antes de startDate (barrido de frecuencias)", () => {
    for (const freq of ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const) {
      for (const dayOfMonth of [null, 1, 15, 28, 31]) {
        for (const interval of [1, 2, 3]) {
          const rule = spec({
            freq,
            interval,
            dayOfMonth: freq === "MONTHLY" || freq === "YEARLY" ? dayOfMonth : null,
            startDate: "2026-10-17",
          });
          for (const date of projectedOccurrences(rule, { after: null, limit: 24 })) {
            expect(date >= "2026-10-17").toBe(true);
          }
        }
      }
    }
  });

  it("la secuencia es estrictamente creciente (barrido de frecuencias)", () => {
    for (const freq of ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const) {
      for (const interval of [1, 2, 5]) {
        const rule = spec({
          freq,
          interval,
          dayOfMonth: freq === "MONTHLY" || freq === "YEARLY" ? 31 : null,
          startDate: "2026-01-31",
        });
        const dates = projectedOccurrences(rule, { after: null, limit: 40 });
        for (let i = 1; i < dates.length; i += 1) {
          expect(dates[i] > dates[i - 1]).toBe(true);
        }
      }
    }
  });
});

describe("endDate y count", () => {
  it("endDate inclusive: la ocurrencia del último día entra", () => {
    const rule = spec({
      freq: "MONTHLY",
      startDate: "2026-01-10",
      endDate: "2026-03-10",
    });
    expect(nextDates(rule, 10)).toEqual(["2026-01-10", "2026-02-10", "2026-03-10"]);
  });

  it("endDate corta la lista un día antes", () => {
    const rule = spec({
      freq: "MONTHLY",
      startDate: "2026-01-10",
      endDate: "2026-03-09",
    });
    expect(nextDates(rule, 10)).toEqual(["2026-01-10", "2026-02-10"]);
  });

  it("count limita la cantidad de ocurrencias", () => {
    const rule = spec({ freq: "MONTHLY", startDate: "2026-01-10", count: 3 });
    expect(nextDates(rule, 10)).toEqual(["2026-01-10", "2026-02-10", "2026-03-10"]);
    // El índice fuera del count no existe, ni siquiera "por más que se pida".
    expect(occurrenceAt(rule, 3)).toBeNull();
  });

  it("count 1 = una sola ocurrencia", () => {
    const rule = spec({ freq: "YEARLY", startDate: "2026-01-01", count: 1 });
    expect(nextDates(rule, 5)).toEqual(["2026-01-01"]);
    expect(nextOccurrence(rule, { after: "2026-01-01" })).toBeNull();
  });

  it("endDate y count juntos: gana el que corta antes", () => {
    const rule = spec({
      freq: "MONTHLY",
      startDate: "2026-01-10",
      endDate: "2026-05-10",
      count: 2,
    });
    expect(nextDates(rule, 10)).toEqual(["2026-01-10", "2026-02-10"]);
  });
});

describe("nextOccurrence", () => {
  const rule = spec({ freq: "MONTHLY", startDate: "2026-01-31", dayOfMonth: 31 });

  it("desde null devuelve la primera", () => {
    expect(nextOccurrence(rule, { after: null })).toBe("2026-01-31");
  });

  it("es ESTRICTAMENTE posterior: parada justo en una ocurrencia devuelve la siguiente", () => {
    expect(nextOccurrence(rule, { after: "2026-02-28" })).toBe("2026-03-31");
  });

  it("desde un día cualquiera del medio", () => {
    expect(nextOccurrence(rule, { after: "2026-02-15" })).toBe("2026-02-28");
  });

  it("desde antes de startDate devuelve la primera", () => {
    expect(nextOccurrence(rule, { after: "2025-12-31" })).toBe("2026-01-31");
  });

  it("después del final devuelve null", () => {
    const capped = spec({
      freq: "MONTHLY",
      startDate: "2026-01-10",
      endDate: "2026-03-10",
    });
    expect(nextOccurrence(capped, { after: "2026-03-10" })).toBeNull();
  });

  it("con count agotado devuelve null", () => {
    const capped = spec({ freq: "DAILY", startDate: "2026-01-01", count: 2 });
    expect(nextOccurrence(capped, { after: "2026-01-02" })).toBeNull();
  });

  it("una regla diaria encuentra la fecha en una búsqueda larga sin colgarse", () => {
    // 20 años de ocurrencias diarias: la búsqueda binaria no recorre ninguna.
    const daily = spec({ freq: "DAILY", startDate: "2020-01-01" });
    expect(nextOccurrence(daily, { after: "2040-01-01" })).toBe("2040-01-02");
  });

  it("el borde del año 9999: la última ocurrencia sigue siendo una fecha de 4 dígitos", () => {
    // La regresión que este caso protege: una cota de búsqueda "grande" hacía
    // que la última ocurrencia cayera en el año 10359, y ahí la comparación de
    // strings `YYYY-MM-DD` da al revés (`"10359-…" < "2026-…"`) y la búsqueda
    // concluía que no había más fechas. El síntoma era un generador que, con el
    // "hoy" en cualquier fecha, decía que la regla ya no tenía ocurrencias.
    const monthly = spec({ freq: "MONTHLY", startDate: "2026-01-31", dayOfMonth: 31 });
    expect(nextOccurrence(monthly, { after: "9999-11-30" })).toBe("9999-12-31");
    expect(nextOccurrence(monthly, { after: "9999-12-31" })).toBeNull();
  });
});

describe("occurrencesBetween — la consulta del generador", () => {
  it("devuelve las ocurrencias de (after, through]", () => {
    const rule = spec({ freq: "MONTHLY", startDate: "2026-01-10" });
    expect(occurrencesBetween(rule, { after: null, through: "2026-03-10", limit: 50 })).toEqual([
      "2026-01-10",
      "2026-02-10",
      "2026-03-10",
    ]);
  });

  it("con after en una ocurrencia, no la repite", () => {
    const rule = spec({ freq: "MONTHLY", startDate: "2026-01-10" });
    expect(occurrencesBetween(rule, { after: "2026-01-10", through: "2026-03-10", limit: 50 })).toEqual([
      "2026-02-10",
      "2026-03-10",
    ]);
  });

  it("correr el generador dos veces con el mismo estado no devuelve nada la segunda", () => {
    const rule = spec({ freq: "MONTHLY", startDate: "2026-01-10" });
    const first = occurrencesBetween(rule, { after: null, through: "2026-03-10", limit: 50 });
    const last = first[first.length - 1];
    const second = occurrencesBetween(rule, { after: last, through: "2026-03-10", limit: 50 });
    expect(second).toEqual([]);
  });

  it("respeta el límite de la corrida", () => {
    const rule = spec({ freq: "DAILY", startDate: "2026-01-01" });
    const dates = occurrencesBetween(rule, { after: null, through: "2026-12-31", limit: 3 });
    expect(dates).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
  });

  it("sin fechas vencidas devuelve vacío", () => {
    const rule = spec({ freq: "MONTHLY", startDate: "2026-06-01", dayOfMonth: 1 });
    expect(occurrencesBetween(rule, { after: null, through: "2026-05-31", limit: 50 })).toEqual([]);
  });
});

describe("validaciones que fallan ruidosamente", () => {
  it("interval 0 no es una regla: es un bucle infinito", () => {
    expect(() => occurrenceAt(spec({ interval: 0 }), 0)).toThrow(RangeError);
  });

  it("un índice negativo es un error de programación", () => {
    expect(() => occurrenceAt(spec(), -1)).toThrow(RangeError);
  });

  it("un límite no positivo es un error de programación", () => {
    expect(() => occurrencesBetween(spec(), { after: null, through: "2026-12-31", limit: 0 })).toThrow(
      RangeError,
    );
  });
});
