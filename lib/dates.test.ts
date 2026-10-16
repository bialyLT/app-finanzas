/**
 * Tests de fechas-calendario.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ESTOS TESTS NO DEPENDEN DE LA ZONA HORARIA
 * ─────────────────────────────────────────────────────────────────────────────
 * Es a propósito. La forma fácil de escribir estos tests sería fijar
 * `TZ=America/Buenos_Aires` y comparar contra resultados esperados. Pero eso
 * esconde el problema real: el bug original sólo aparecía con offset negativo,
 * así que los tests habrían pasado en un servidor en UTC y fallado en la
 * máquina de un usuario argentino. Esa es exactamente la peor combinación.
 *
 * En cambio, se verifica la PROPIEDAD que tiene que cumplirse en cualquier
 * zona horaria: que la fecha que sale sea la misma que la que entró. Si el
 * código usa `toISOString()` o `new Date("YYYY-MM-DD")`, un offset negativo lo
 * rompe y estos tests lo detectan. En UTC pasarían igual, pero la propiedad
 * seguiría siendo la correcta.
 *
 * Los `it` que documentan el bug viejo comparan contra el comportamiento roto
 * de `new Date("YYYY-MM-DD")` para dejar constancia de POR QUÉ existe el módulo.
 */

import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  bucketIndex,
  calendarToDb,
  calendarToLocalDate,
  clampDayOfMonth,
  dbToCalendar,
  endOfMonth,
  endOfYear,
  formatPeriodLabel,
  isCalendarDate,
  lastDayOfMonth,
  periodRange,
  shiftPeriod,
  startOfMonth,
  startOfWeek,
  startOfYear,
  toCalendarString,
  todayCalendar,
} from "./dates";

describe("B1 · el día no se corre al leer una fecha calendario", () => {
  it("calendarToLocalDate conserva el día (el bug lo mostraba como 14)", () => {
    // EL BUG ORIGINAL: la app guardaba la fecha con new Date("2026-10-15"),
    // que JS interpreta como UTC midnight. Con offset −3, el día LOCAL era 14,
    // así que la interfaz mostraba "14 oct" para un gasto del 15.
    const date = calendarToLocalDate("2026-10-15");
    expect(date.getDate()).toBe(15);
    expect(date.getMonth()).toBe(9); // octubre es el mes 9 (0-based)
    expect(date.getFullYear()).toBe(2026);
  });

  it("el modo roto queda documentado: new Date('YYYY-MM-DD') se parsea como UTC", () => {
    // No es código de la app: es la demostración de por qué las dos reglas de
    // oro de lib/dates.ts existen. Si esto algún día deja de fallar, la
    // especificación de JavaScript cambió y hay que revisar el módulo.
    const naive = new Date("2026-10-15");
    expect(naive.getUTCDate()).toBe(15);

    // Con offset negativo el día local es 14. En una máquina en UTC coincidiría,
    // y por eso este bug vivió tanto tiempo sin que nadie lo notara.
    if (new Date().getTimezoneOffset() > 0) {
      expect(naive.getDate()).toBe(14);
    }
  });

  it("la ida y vuelta string → Date → string es exacta", () => {
    for (const value of ["2026-01-01", "2026-10-15", "2026-12-31", "2024-02-29"]) {
      expect(toCalendarString(calendarToLocalDate(value))).toBe(value);
    }
  });

  it("rechaza fechas que no existen en el calendario", () => {
    // JS desborda silenciosamente: new Date(2026, 1, 31) da el 3 de marzo.
    // Una app de finanzas no puede aceptar "31 de febrero".
    expect(() => calendarToLocalDate("2026-02-31")).toThrow(RangeError);
    expect(() => calendarToLocalDate("2026-13-01")).toThrow(RangeError);
    expect(() => calendarToLocalDate("2026-00-10")).toThrow(RangeError);
    expect(() => calendarToLocalDate("15/10/2026")).toThrow(RangeError);
    expect(() => calendarToLocalDate("2026-10-15T00:00:00Z")).toThrow(RangeError);
  });

  it("isCalendarDate distingue fechas válidas de inválidas", () => {
    expect(isCalendarDate("2026-10-15")).toBe(true);
    expect(isCalendarDate("2024-02-29")).toBe(true);
    expect(isCalendarDate("2026-02-31")).toBe(false);
    expect(isCalendarDate("2026-2-5")).toBe(false);
    expect(isCalendarDate("")).toBe(false);
    expect(isCalendarDate(null)).toBe(false);
    expect(isCalendarDate(20261015)).toBe(false);
  });
});

describe("B2 · el borde con la base de datos no corre el día", () => {
  it("dbToCalendar lee un Date UTC-medianoche como el mismo día", () => {
    // Prisma devuelve @db.Date como un Date anclado a medianoche UTC.
    // Leerlo con getDate() (local) daría 14. Por eso se usa getUTCDate().
    const fromDb = new Date("2026-10-15T00:00:00.000Z");
    expect(dbToCalendar(fromDb)).toBe("2026-10-15");
  });

  it("calendarToDb ancla a medianoche UTC", () => {
    const dbValue = calendarToDb("2026-10-15");
    expect(dbValue.toISOString()).toBe("2026-10-15T00:00:00.000Z");
  });

  it("la ida y vuelta por la base es exacta", () => {
    for (const value of ["2026-01-01", "2026-06-15", "2026-12-31", "2024-02-29"]) {
      expect(dbToCalendar(calendarToDb(value))).toBe(value);
    }
  });

  it("el día 1 y el último del mes sobreviven el viaje a la base", () => {
    // Los extremos son donde el bug se veía: el 1 de noviembre caía en octubre.
    expect(dbToCalendar(calendarToDb("2026-11-01"))).toBe("2026-11-01");
    expect(dbToCalendar(calendarToDb("2026-11-30"))).toBe("2026-11-30");
  });
});

describe("B3 · los límites del mes son los del calendario", () => {
  it("octubre va del 1 al 31 y no se come noviembre", () => {
    const range = periodRange("month", "2026-10-15");
    expect(range).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });

  it("el 1 de noviembre pertenece a NOVIEMBRE, no a octubre", () => {
    // EL BUG ORIGINAL: el rango de octubre se construía con
    // new Date("2026-10-01T00:00:00") .. new Date("2026-10-31T23:59:59") en
    // hora local, o sea [01/10 03:00Z .. 01/11 02:59:59Z]. Como el 1 de
    // noviembre a las 00:00Z caía DENTRO de esa ventana, todo gasto del
    // 1 de noviembre se contaba en el balance de octubre.
    const november = periodRange("month", "2026-11-01");
    expect(november.from).toBe("2026-11-01");

    const october = periodRange("month", "2026-10-15");
    expect(november.from > october.to).toBe(true);
  });

  it("febrero termina el 28 o el 29 según el año", () => {
    expect(lastDayOfMonth(2026, 2)).toBe(28);
    expect(lastDayOfMonth(2024, 2)).toBe(29);
    expect(lastDayOfMonth(2000, 2)).toBe(29); // divisible por 400 → bisiesto
    expect(lastDayOfMonth(1900, 2)).toBe(28); // divisible por 100 pero no por 400
    expect(lastDayOfMonth(2026, 4)).toBe(30);
    expect(lastDayOfMonth(2026, 12)).toBe(31);
  });

  it("el rango del año cubre el año entero", () => {
    const range = periodRange("year", "2026-06-15");
    expect(range).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });

  it("la semana arranca el lunes y termina el domingo", () => {
    // 15 de octubre de 2026 es jueves. Su semana va del lunes 12 al domingo 18.
    expect(periodRange("week", "2026-10-15")).toEqual({
      from: "2026-10-12",
      to: "2026-10-18",
    });
  });

  it("startOfWeek funciona con domingo (getDay() devuelve 0 y es la trampa clásica)", () => {
    // 18 de octubre de 2026 es domingo. Con la fórmula ingenua `getDay() - 1`
    // daría −1 y rompería. La corrección es (getDay() + 6) % 7.
    expect(startOfWeek("2026-10-18")).toBe("2026-10-12");
    expect(startOfWeek("2026-10-12")).toBe("2026-10-12"); // el lunes es su propio inicio
  });

  it("startOfMonth y endOfMonth son consistentes con periodRange", () => {
    expect(startOfMonth("2026-10-15")).toBe("2026-10-01");
    expect(endOfMonth("2026-10-15")).toBe("2026-10-31");
    expect(startOfYear("2026-10-15")).toBe("2026-01-01");
    expect(endOfYear("2026-10-15")).toBe("2026-12-31");
  });
});

describe("bucketIndex · los gráficos ubican cada día en la barra correcta", () => {
  it("el 1 de noviembre cae en el bucket 0 de noviembre, no en el de octubre", () => {
    // EL BUG ORIGINAL: se calculaba con getDate() sobre un instante UTC.
    // new Date("2026-11-01T00:00:00Z").getDate() daba 31 (por el offset −3),
    // así que el gasto de noviembre aterrizaba en el día 31 del gráfico de
    // octubre — una barra que debería estar vacía.
    const november = periodRange("month", "2026-11-01");
    expect(bucketIndex("month", november, "2026-11-01")).toBe(0);
    expect(bucketIndex("month", november, "2026-11-30")).toBe(29);
  });

  it("en modo mes, el bucket es el día menos 1", () => {
    const range = periodRange("month", "2026-10-15");
    expect(bucketIndex("month", range, "2026-10-01")).toBe(0);
    expect(bucketIndex("month", range, "2026-10-15")).toBe(14);
    expect(bucketIndex("month", range, "2026-10-31")).toBe(30);
  });

  it("en modo año, el bucket es el mes", () => {
    const range = periodRange("year", "2026-06-15");
    expect(bucketIndex("year", range, "2026-01-15")).toBe(0);
    expect(bucketIndex("year", range, "2026-10-15")).toBe(9);
    expect(bucketIndex("year", range, "2026-12-31")).toBe(11);
  });

  it("devuelve null si la fecha está fuera del rango", () => {
    const range = periodRange("month", "2026-10-15");
    expect(bucketIndex("month", range, "2026-09-30")).toBeNull();
    expect(bucketIndex("month", range, "2026-11-01")).toBeNull();
  });

  it("en modo semana, el lunes es 0 y el domingo es 6", () => {
    const range = periodRange("week", "2026-10-15");
    expect(bucketIndex("week", range, "2026-10-12")).toBe(0);
    expect(bucketIndex("week", range, "2026-10-18")).toBe(6);
  });
});

describe("Aritmética de calendario", () => {
  it("addDays cruza fin de mes y fin de año", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("addMonths clampea el día a fin de mes", () => {
    // El 31 de enero más un mes es el 28 de febrero, NO el 3 de marzo.
    // Sin el clamp, JS desborda al mes siguiente y una cuota mensual
    // "del 31" se cobraría en marzo.
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(addMonths("2026-03-31", 1)).toBe("2026-04-30");
    expect(addMonths("2026-10-15", 1)).toBe("2026-11-15");
    expect(addMonths("2026-01-15", 12)).toBe("2027-01-15");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
  });

  it("clampDayOfMonth mantiene el día dentro del mes", () => {
    expect(clampDayOfMonth(2026, 2, 31)).toBe(28);
    expect(clampDayOfMonth(2024, 2, 31)).toBe(29);
    expect(clampDayOfMonth(2026, 4, 31)).toBe(30);
    expect(clampDayOfMonth(2026, 10, 15)).toBe(15);
    expect(clampDayOfMonth(2026, 10, 0)).toBe(1); // nunca por debajo de 1
  });

  it("shiftPeriod mueve el ancla sin romper el calendario", () => {
    expect(shiftPeriod("month", "2026-10-15", 1)).toBe("2026-11-01");
    expect(shiftPeriod("month", "2026-10-15", -1)).toBe("2026-09-01");
    expect(shiftPeriod("week", "2026-10-15", 1)).toBe("2026-10-22");
    expect(shiftPeriod("year", "2026-10-15", 1)).toBe("2027-10-15");
  });

  it("todayCalendar devuelve una fecha válida de hoy", () => {
    const today = todayCalendar();
    expect(isCalendarDate(today)).toBe(true);
    const parsed = calendarToLocalDate(today);
    expect(parsed.getFullYear()).toBe(new Date().getFullYear());
  });
});

describe("Presentación", () => {
  it("la etiqueta del mes se lee en minúscula, como en español", () => {
    const range = periodRange("month", "2026-10-15");
    const label = formatPeriodLabel("month", range);

    // El bug de presentación: Intl devolvía "octubre de 2026" pero la app
    // mostraba "Octubre De 2026" porque el CSS aplicaba text-transform
    // capitalize a cada palabra. Acá se verifica el string de origen, que es
    // el que debe estar en minúscula.
    expect(label).toContain("octubre");
    expect(label).toContain("2026");
    expect(label).not.toContain("Octubre");
  });

  it("la etiqueta del año es sólo el año", () => {
    expect(formatPeriodLabel("year", periodRange("year", "2026-06-15"))).toBe("2026");
  });
});
