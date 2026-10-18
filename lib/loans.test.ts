/**
 * Tests de las reglas puras de los préstamos.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA FILOSOFÍA (la misma de `money.test.ts`)
 * ─────────────────────────────────────────────────────────────────────────────
 * Primero los INVARIANTES: todo cronograma que cierra a 0 suma exactamente el
 * capital, todas las cuotas son positivas, el saldo nunca se va de rango. Se
 * prueban para cada sistema porque son la garantía de que "el préstamo termina
 * de pagarse" sin importar la fórmula.
 *
 * Después, al menos UN EJEMPLO CALCULADO A MANO por sistema (§3.2: 500.000 a
 * TNA 60% en 12 cuotas, i = 5% mensual), con las cuentas escritas en el test.
 * Un invariante sólo no alcanza: una fórmula que devolviera cuotas todas de
 * cero también "cierra" si el capital es cero — el ejemplo ancla los números a
 * la realidad.
 */

import { describe, expect, it } from "vitest";
import { money, sum } from "./money";
import {
  AMORTIZATION_SYSTEMS,
  americanSchedule,
  closesToZero,
  dueDateSeries,
  germanSchedule,
  importedSchedule,
  interestOnlySchedule,
  isAmortizationSystem,
  loanCommitments,
  loanDirectionOf,
  loanProgressFor,
  loanScheduleFor,
  loanSummaryFor,
  materializeSchedule,
  systemOf,
  type AmortizationSystem,
} from "./loans";

/** El préstamo del §3.2: 500.000 a TNA 60% en 12 cuotas → i = 5% mensual. */
const P = "500000";
const TNA = "60";
const N = 12;

const total = (values: readonly { toFixed(dp: number): string }[]) =>
  sum(values.map((value) => money(value.toFixed(2))));

describe("Dirección y sistema", () => {
  it("el kind gobierna la dirección: LOAN es I_OWE y RECEIVABLE es OWED_TO_ME", () => {
    expect(loanDirectionOf("LOAN")).toBe("I_OWE");
    expect(loanDirectionOf("RECEIVABLE")).toBe("OWED_TO_ME");
  });

  it("un sistema nulo (dato legado) se lee como francés", () => {
    expect(systemOf(null)).toBe("FRENCH");
    expect(systemOf(undefined)).toBe("FRENCH");
    expect(systemOf("GERMAN")).toBe("GERMAN");
  });

  it("sólo INTEREST_ONLY no cierra a cero", () => {
    for (const system of AMORTIZATION_SYSTEMS) {
      expect(closesToZero(system)).toBe(system !== "INTEREST_ONLY");
    }
  });

  it("valida el nombre del sistema", () => {
    expect(isAmortizationSystem("GERMAN")).toBe(true);
    expect(isAmortizationSystem("german")).toBe(false);
    expect(isAmortizationSystem(42)).toBe(false);
  });
});

describe("Serie de vencimientos (clamp contra el ancla)", () => {
  it("una primera cuota el 31 de enero da 28 de febrero y 31 de marzo", () => {
    expect(dueDateSeries("2026-01-31", 3)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
    ]);
  });

  it("clampea febrero bisiesto a 29", () => {
    expect(dueDateSeries("2028-01-31", 2)).toEqual(["2028-01-31", "2028-02-29"]);
  });

  it("rechaza una cantidad de cuotas que no es un entero positivo", () => {
    expect(() => dueDateSeries("2026-01-01", 0)).toThrow();
    expect(() => dueDateSeries("2026-01-01", 1.5)).toThrow();
  });
});

describe("Invariantes de todos los sistemas calculados", () => {
  it("cada cuota es positiva, el saldo nunca sube y los que cierran terminan en 0", () => {
    const inputs: { system: AmortizationSystem; schedule: ReturnType<typeof germanSchedule> }[] = [
      { system: "FRENCH", schedule: loanScheduleFor({ system: "FRENCH", principal: P, tnaPercent: TNA, installmentCount: N }) },
      { system: "GERMAN", schedule: germanSchedule(P, TNA, N) },
      { system: "AMERICAN", schedule: americanSchedule(P, TNA, N) },
      { system: "INTEREST_ONLY", schedule: interestOnlySchedule(P, TNA, N) },
    ];

    for (const { system, schedule } of inputs) {
      expect(schedule).toHaveLength(N);

      for (const installment of schedule) {
        expect(installment.payment.greaterThan(0)).toBe(true);
        expect(installment.interest.greaterThanOrEqualTo(0)).toBe(true);
        expect(installment.principal.greaterThanOrEqualTo(0)).toBe(true);
        // payment = interés + capital, exacto (es el CHECK de la base).
        expect(installment.payment.equals(installment.interest.plus(installment.principal))).toBe(true);
        // El saldo nunca es negativo.
        expect(installment.remainingBalance.greaterThanOrEqualTo(0)).toBe(true);
      }

      // El saldo nunca sube. En el rotativo es constante por contrato; en el
      // americano también hasta la última cuota, donde cae todo el capital.
      for (let index = 1; index < schedule.length; index += 1) {
        const previous = schedule[index - 1].remainingBalance;
        const current = schedule[index].remainingBalance;
        if (system === "FRENCH" || system === "GERMAN") {
          expect(current.lessThan(previous)).toBe(true);
        } else {
          expect(current.lessThanOrEqualTo(previous)).toBe(true);
        }
      }

      if (closesToZero(system)) {
        expect(schedule[schedule.length - 1].remainingBalance.isZero()).toBe(true);
        expect(total(schedule.map((i) => i.principal)).equals(money(P))).toBe(true);
      } else {
        // La excepción documentada: el saldo queda en el capital original.
        expect(schedule[schedule.length - 1].remainingBalance.equals(money(P))).toBe(true);
        expect(total(schedule.map((i) => i.principal)).isZero()).toBe(true);
      }
    }
  });
});

describe("Sistema FRENCH (delega en lib/money.ts)", () => {
  it("reproduce los números del §3.2: cuota 1 = 25.000,00 + 31.412,71", () => {
    const schedule = loanScheduleFor({
      system: "FRENCH",
      principal: P,
      tnaPercent: TNA,
      installmentCount: N,
    });

    expect(schedule[0].payment.toFixed(2)).toBe("56412.71");
    expect(schedule[0].interest.toFixed(2)).toBe("25000.00");
    expect(schedule[0].principal.toFixed(2)).toBe("31412.71");
    expect(schedule[0].remainingBalance.toFixed(2)).toBe("468587.29");
    expect(total(schedule.map((i) => i.interest)).toFixed(2)).toBe("176952.44");
  });
});

describe("Sistema GERMAN (capital constante, calculado a mano)", () => {
  it("la cuota 1 es 41.666,66 de capital + 25.000,00 de interés", () => {
    const schedule = germanSchedule(P, TNA, N);

    // 500.000 ÷ 12 = 41.666,666… → base truncada al centavo: 41.666,66.
    expect(schedule[0].principal.toFixed(2)).toBe("41666.66");
    expect(schedule[0].interest.toFixed(2)).toBe("25000.00");
    expect(schedule[0].payment.toFixed(2)).toBe("66666.66");
    expect(schedule[0].remainingBalance.toFixed(2)).toBe("458333.34");

    // La última absorbe el resto del reparto: 500.000 − 41.666,66 × 11.
    expect(schedule[11].principal.toFixed(2)).toBe("41666.74");
    // El interés de la última corre sobre el saldo final: 41.666,74 × 5% = 2.083,337 → 2.083,34.
    expect(schedule[11].interest.toFixed(2)).toBe("2083.34");
    expect(schedule[11].payment.toFixed(2)).toBe("43750.08");
    expect(schedule[11].remainingBalance.toFixed(2)).toBe("0.00");

    // Todas las cuotas de capital son iguales salvo la última.
    for (let index = 0; index < N - 1; index += 1) {
      expect(schedule[index].principal.toFixed(2)).toBe("41666.66");
    }
  });

  it("con tasa 0 el capital constante sigue cerrando a 0", () => {
    const schedule = germanSchedule("120", "0", 3);
    expect(schedule.map((i) => i.payment.toFixed(2))).toEqual([
      "40.00",
      "40.00",
      "40.00",
    ]);
    expect(schedule[2].remainingBalance.isZero()).toBe(true);
  });
});

describe("Sistema AMERICAN (interés periódico + capital al vencimiento)", () => {
  it("las 11 primeras cuotas son sólo interés y la última es interés + 500.000", () => {
    const schedule = americanSchedule(P, TNA, N);

    for (let index = 0; index < N - 1; index += 1) {
      expect(schedule[index].payment.toFixed(2)).toBe("25000.00");
      expect(schedule[index].principal.isZero()).toBe(true);
      expect(schedule[index].remainingBalance.toFixed(2)).toBe("500000.00");
    }

    expect(schedule[11].payment.toFixed(2)).toBe("525000.00");
    expect(schedule[11].interest.toFixed(2)).toBe("25000.00");
    expect(schedule[11].principal.toFixed(2)).toBe("500000.00");
    expect(schedule[11].remainingBalance.toFixed(2)).toBe("0.00");
  });

  it("rechaza tasa 0 con más de una cuota (cuotas de interés de $0,00)", () => {
    expect(() => americanSchedule(P, "0", 12)).toThrow(/tasa mayor a cero/);
    // Con UNA cuota no hay cuotas intermedias: la única cuota es capital + interés.
    const one = americanSchedule(P, "0", 1);
    expect(one[0].payment.toFixed(2)).toBe("500000.00");
  });
});

describe("Sistema INTEREST_ONLY (rotativo)", () => {
  it("todas las cuotas son 25.000,00 de interés y el saldo nunca baja", () => {
    const schedule = interestOnlySchedule(P, TNA, N);
    for (const installment of schedule) {
      expect(installment.payment.toFixed(2)).toBe("25000.00");
      expect(installment.principal.isZero()).toBe(true);
      expect(installment.remainingBalance.toFixed(2)).toBe("500000.00");
    }
  });

  it("rechaza tasa 0: sería un préstamo gratis para siempre", () => {
    expect(() => interestOnlySchedule(P, "0", N)).toThrow(/tasa mayor a cero/);
  });
});

describe("Sistema IMPORTED (el cronograma lo dicta el banco)", () => {
  const items = [
    { dueDate: "2026-11-15", payment: "20000.00", interest: "5000.00" },
    { dueDate: "2026-12-15", payment: "20000.00", interest: "3333.33" },
    { dueDate: "2027-01-15", payment: "15000.00", interest: "1666.67" },
  ];

  it("materializa tal cual: no recalcula ni la cuota ni la composición", () => {
    const schedule = importedSchedule(items, "45000");

    expect(schedule.map((i) => i.payment.toFixed(2))).toEqual([
      "20000.00",
      "20000.00",
      "15000.00",
    ]);
    expect(schedule.map((i) => i.principal.toFixed(2))).toEqual([
      "15000.00",
      "16666.67",
      "13333.33",
    ]);
    expect(schedule.map((i) => i.remainingBalance.toFixed(2))).toEqual([
      "30000.00",
      "13333.33",
      "0.00",
    ]);
  });

  it("exige fechas estrictamente crecientes", () => {
    const decreasing = [
      { dueDate: "2026-11-15", payment: "100", interest: "0" },
      { dueDate: "2026-11-15", payment: "100", interest: "0" },
    ];
    expect(() => importedSchedule(decreasing, "200")).toThrow(/estrictamente crecientes/);
  });

  it("un pago que no cubre su propio interés describe una quita disfrazada", () => {
    const bad = [{ dueDate: "2026-11-15", payment: "100", interest: "150" }];
    expect(() => importedSchedule(bad, "200")).toThrow(/no cubre ni su propio interés/);
  });

  it("rechaza un capital que supera el saldo que queda", () => {
    const bad = [
      { dueDate: "2026-11-15", payment: "200", interest: "0" },
      { dueDate: "2026-12-15", payment: "200", interest: "0" },
    ];
    expect(() => importedSchedule(bad, "300")).toThrow(/supera el saldo que queda/);
  });

  it("exige que Σ capital sea EXACTAMENTE el principal", () => {
    // De MENOS: el cronograma no alcanza a devolver el préstamo.
    const short = [
      { dueDate: "2026-11-15", payment: "100", interest: "0" },
      { dueDate: "2026-12-15", payment: "100", interest: "0" },
    ];
    expect(() => importedSchedule(short, "250")).toThrow(/no coincide con el monto/);

    // De MÁS: el recorrido de saldos lo detecta antes (devolvería más capital
    // que el préstamo en algún paso), que es un error más explicable.
    const long = [
      { dueDate: "2026-11-15", payment: "100", interest: "0" },
      { dueDate: "2026-12-15", payment: "150", interest: "0" },
    ];
    expect(() => importedSchedule(long, "200")).toThrow(/supera el saldo que queda/);
  });

  it("rechaza fechas y montos hostiles", () => {
    expect(() =>
      importedSchedule([{ dueDate: "2026-02-31", payment: "100", interest: "0" }], "100"),
    ).toThrow(/no es una fecha válida/);
    expect(() =>
      importedSchedule([{ dueDate: "2026-11-15", payment: "0", interest: "0" }], "100"),
    ).toThrow(/mayor a cero/);
    expect(() =>
      importedSchedule([{ dueDate: "2026-11-15", payment: "100", interest: "-1" }], "100"),
    ).toThrow(/no puede ser negativo/);
    expect(() => importedSchedule([], "100")).toThrow(/al menos una cuota/);
  });
});

describe("loanScheduleFor (el despachador común)", () => {
  it("FRENCH es exactamente el cronograma del §3.2 ya verificado", () => {
    const schedule = loanScheduleFor({
      system: "FRENCH",
      principal: P,
      tnaPercent: TNA,
      installmentCount: N,
    });
    expect(schedule[0].payment.toFixed(2)).toBe("56412.71");
  });

  it("corta con un mensaje claro cuando el préstamo es demasiado chico", () => {
    // $0,02 en 3 cuotas al 0%: la fórmula redondea la cuota a $0,01 y la última
    // quedaría en $0,00 — imposible en la base.
    expect(() =>
      loanScheduleFor({ system: "FRENCH", principal: "0.02", tnaPercent: "0", installmentCount: 3 }),
    ).toThrow(/demasiado chico/);
  });

  it("pide la tasa en los sistemas calculados y el cronograma en el importado", () => {
    expect(() =>
      loanScheduleFor({ system: "AMERICAN", principal: P, tnaPercent: null, installmentCount: N }),
    ).toThrow(/necesita la tasa/);
    expect(() =>
      loanScheduleFor({ system: "IMPORTED", principal: P, tnaPercent: null, installmentCount: N }),
    ).toThrow(/necesita el cronograma/);
  });
});

describe("materializeSchedule", () => {
  it("pega las fechas en orden", () => {
    const schedule = loanScheduleFor({
      system: "FRENCH",
      principal: P,
      tnaPercent: TNA,
      installmentCount: 3,
    });
    const rows = materializeSchedule(schedule, ["2026-11-15", "2026-12-15", "2027-01-15"]);
    expect(rows.map((row) => row.dueDate)).toEqual([
      "2026-11-15",
      "2026-12-15",
      "2027-01-15",
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[2].remainingBalance.isZero()).toBe(true);
  });

  it("rechaza cronogramas y fechas de largos distintos (error interno)", () => {
    const schedule = germanSchedule("100", "0", 2);
    expect(() => materializeSchedule(schedule, ["2026-11-15"])).toThrow(/no coinciden/);
  });
});

describe("loanSummaryFor", () => {
  it("el francés coincide con loanSummary de lib/money.ts", () => {
    const summary = loanSummaryFor({
      system: "FRENCH",
      principal: P,
      tnaPercent: TNA,
      installmentCount: N,
    });
    expect(summary.payment.toFixed(2)).toBe("56412.71");
    expect(summary.totalInterest.toFixed(2)).toBe("176952.44");
    // Σ cuotas = capital + interés: 500.000 + 176.952,44.
    expect(summary.totalPaid.toFixed(2)).toBe("676952.44");
    expect(summary.interestSharePercent.toFixed(2)).toBe("26.14");
  });

  it("el americano declara la cuota 1 como el interés del período", () => {
    const summary = loanSummaryFor({
      system: "AMERICAN",
      principal: P,
      tnaPercent: TNA,
      installmentCount: N,
    });
    expect(summary.payment.toFixed(2)).toBe("25000.00");
    expect(summary.totalInterest.toFixed(2)).toBe("300000.00");
  });

  it("el alemán paga menos interés total que el francés: amortiza capital más rápido al principio", () => {
    const german = loanSummaryFor({
      system: "GERMAN",
      principal: P,
      tnaPercent: TNA,
      installmentCount: N,
    });
    // Capital constante: el saldo baja más rápido que en el francés, así que el
    // interés total es MENOR. El número exacto se verifica acá una vez.
    expect(german.totalInterest.toFixed(2)).toBe("162500.03");
  });
});

describe("loanProgressFor", () => {
  it("en un préstamo que cierra, delega en las definiciones bloqueadas de la Fase 6", () => {
    const schedule = loanScheduleFor({
      system: "FRENCH",
      principal: P,
      tnaPercent: TNA,
      installmentCount: N,
    });
    const progress = loanProgressFor(
      { system: "FRENCH", principal: P, tnaPercent: TNA, installmentCount: N },
      schedule,
      "31412.71",
    );
    expect(progress.installmentsCovered).toBe(1);
    expect(progress.remainingCount).toBe(11);
    expect(progress.interestPaid?.toFixed(2)).toBe("25000.00");
    expect(progress.progressPercent.toFixed(2)).toBe("6.28");
  });

  it("en un rotativo, 0 cuotas cubiertas mientras haya capital vivo", () => {
    const schedule = interestOnlySchedule(P, TNA, N);
    const input = {
      system: "INTEREST_ONLY" as const,
      principal: P,
      tnaPercent: TNA,
      installmentCount: N,
    };

    const open = loanProgressFor(input, schedule, "300000");
    expect(open.installmentsCovered).toBe(0);
    expect(open.remainingCount).toBe(N);
    expect(open.interestPaid).toBeNull();
    expect(open.progressPercent.toFixed(2)).toBe("60.00");

    const closed = loanProgressFor(input, schedule, "500000");
    expect(closed.installmentsCovered).toBe(N);
    expect(closed.remainingCount).toBe(0);
  });

  it("en un americano, la cobertura es todo-o-nada del capital (el cierre)", () => {
    // Las 11 primeras cuotas son de sólo interés: con el caminador de capital
    // darían "cubiertas" gratis (su acumulado es 0) y su interés inflaría
    // `interestPaid` sin que nadie lo haya pagado. La lectura honesta: 0
    // cubiertas hasta que el capital entero amorticó (el cierre o cancelar).
    const schedule = americanSchedule(P, TNA, N);
    const input = {
      system: "AMERICAN" as const,
      principal: P,
      tnaPercent: TNA,
      installmentCount: N,
    };

    const fresh = loanProgressFor(input, schedule, "0");
    expect(fresh.installmentsCovered).toBe(0);
    expect(fresh.remainingCount).toBe(N);
    expect(fresh.interestPaid).toBeNull();
    expect(fresh.progressPercent.toFixed(2)).toBe("0.00");

    // Una amortización parcial a mano mueve el porcentaje, no la cobertura.
    const half = loanProgressFor(input, schedule, "250000");
    expect(half.installmentsCovered).toBe(0);
    expect(half.progressPercent.toFixed(2)).toBe("50.00");

    const closed = loanProgressFor(input, schedule, "500000");
    expect(closed.installmentsCovered).toBe(N);
    expect(closed.remainingCount).toBe(0);
    expect(closed.interestPaid).toBeNull();
    expect(closed.progressPercent.toFixed(2)).toBe("100.00");
  });
});

describe("loanCommitments", () => {
  const make = (dueDate: string, payment: string, covered = false) => ({
    dueDate,
    payment,
    covered,
  });

  it("agrupa por mes, separa lo vencido y excluye lo cubierto", () => {
    const commitments = loanCommitments(
      [
        make("2026-09-15", "100.00"), // vencida (antes de octubre)
        make("2026-10-15", "200.00"),
        make("2026-11-15", "300.00"),
        make("2026-11-20", "400.00"),
        make("2028-01-15", "999.00"), // fuera de la ventana de 12 meses
      ],
      "2026-10-01",
      12,
      { countOverdue: true },
    );

    // Una cuota cubierta no compromete nada: ya se pagó.
    const withCovered = loanCommitments(
      [make("2026-11-15", "300.00", true)],
      "2026-10-01",
      12,
    );
    expect(withCovered.months.every((month) => month.amount.isZero())).toBe(true);

    expect(commitments.months[0]).toMatchObject({ year: 2026, month: 10 });
    expect(commitments.months[0].amount.toFixed(2)).toBe("200.00");
    expect(commitments.months[1].amount.toFixed(2)).toBe("700.00");
    expect(commitments.months[0].amount.toFixed(2)).toBe("200.00");

    expect(commitments.overdue.toFixed(2)).toBe("100.00");
    expect(commitments.overdueCount).toBe(1);
    // El total de la ventana NO incluye lo vencido: no se cuenta doble.
    expect(commitments.total.toFixed(2)).toBe("900.00");
  });

  it("el cruce de año no descuadra los buckets", () => {
    const commitments = loanCommitments(
      [make("2026-12-15", "100.00"), make("2027-01-15", "200.00")],
      "2026-10-01",
      12,
    );
    expect(commitments.months[2]).toMatchObject({ year: 2026, month: 12 });
    expect(commitments.months[3]).toMatchObject({ year: 2027, month: 1 });
    expect(commitments.months[3].amount.toFixed(2)).toBe("200.00");
  });

  it("en un rotativo (countOverdue: false) lo vencido no acumula", () => {
    const commitments = loanCommitments(
      [make("2026-09-15", "100.00"), make("2026-10-15", "200.00")],
      "2026-10-01",
      12,
      { countOverdue: false },
    );
    expect(commitments.overdue.toFixed(2)).toBe("0.00");
    expect(commitments.overdueCount).toBe(0);
    expect(commitments.months[0].amount.toFixed(2)).toBe("200.00");
  });

  it("rechaza una ventana sin meses", () => {
    expect(() => loanCommitments([], "2026-10-01", 0)).toThrow(/al menos un mes/);
  });
});
