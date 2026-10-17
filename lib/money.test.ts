/**
 * Tests de aritmética de dinero y préstamos.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA FILOSOFÍA DE ESTOS TESTS
 * ─────────────────────────────────────────────────────────────────────────────
 * Se verifican INVARIANTES, no números mágicos.
 *
 * Comparar contra "56412.99" dice que el cálculo no cambió; no dice que sea
 * correcto. En cambio "la suma de las amortizaciones de capital es exactamente
 * el principal" es una propiedad que TIENE que cumplirse siempre: si falla,
 * estás cobrando de más o de menos, sin importar la fórmula que uses.
 *
 * Los invariantes se cumplen en cualquier implementación correcta y se rompen
 * en cualquier implementación con un error de redondeo. Eso es un buen test.
 */

import { describe, expect, it } from "vitest";
import {
  add,
  amortizationSchedule,
  formatMoney,
  formatPercent,
  installmentPayment,
  installmentsCoveredBy,
  isNegative,
  isZero,
  loanProgress,
  loanSummary,
  max,
  min,
  money,
  monthlyRateFromTna,
  monthlyShare,
  parseMoneyInput,
  round,
  subtract,
  sum,
} from "./money";

/** Tolerancia para comparar porcentajes. */
const EPSILON = 0.05;

const toNumber = (value: { toNumber(): number }) => value.toNumber();

describe("Aritmética decimal exacta", () => {
  it("0,1 + 0,2 es exactamente 0,3 (con Float NO lo es)", () => {
    // Esta es la razón de existir del módulo.
    //   0.1 + 0.2 === 0.3        → false
    //   0.1 + 0.2                → 0.30000000000000004
    // Acumulado en cientos de movimientos, el saldo deja de cerrar.
    expect((0.1 + 0.2) === 0.3).toBe(false); // el bug, documentado
    expect(add(money("0.1"), money("0.2")).equals(money("0.3"))).toBe(true);
  });

  it("sumar muchos centavos no acumula error", () => {
    // Diez mil veces 0,01 tienen que dar exactamente 100.
    // Con Float el resultado se desvía.
    const items = Array.from({ length: 10_000 }, () => money("0.01"));
    expect(sum(items).equals(money("100"))).toBe(true);
  });

  it("la resta de importes iguales da cero exacto", () => {
    const total = sum([money("1234.56"), money("7890.12"), money("0.01")]);
    expect(isZero(subtract(total, total))).toBe(true);
  });

  it("sum de una lista vacía es cero, no null", () => {
    expect(isZero(sum([]))).toBe(true);
  });

  it("redondea con half-even para no sesgar los totales", () => {
    // Half-up empujaría siempre hacia arriba y acumularía un sesgo medible.
    expect(round(money("0.125")).toFixed(2)).toBe("0.12");
    expect(round(money("0.135")).toFixed(2)).toBe("0.14");
    expect(round(money("2.5")).toFixed(2)).toBe("2.50");
  });

  it("monthlyShare reparte un gasto anual en 12 (half-even, 2 decimales)", () => {
    // El caso del ROADMAP §5.3 #9: la expensa anual de 240.000 son 20.000 al
    // mes, exacto.
    expect(monthlyShare(money("240000")).toFixed(2)).toBe("20000.00");
    // 250.000 / 12 = 20.833,333… → se corta en 20.833,33 (no es un empate).
    expect(monthlyShare(money("250000")).toFixed(2)).toBe("20833.33");
    // Empates EXACTOS, uno por lado del half-even:
    //   1.000,14 / 12 = 83,345 → queda 83,34 (el 4 es par)
    //   1.000,26 / 12 = 83,355 → sube a 83,36 (el 5 impar va al par)
    // Si el redondeo fuera half-up, el primero subiría a 83,35 y el sesgo
    // volvería por la puerta de atrás.
    expect(monthlyShare(money("1000.14")).toFixed(2)).toBe("83.34");
    expect(monthlyShare(money("1000.26")).toFixed(2)).toBe("83.36");
  });

  it("detecta negativos y cero correctamente", () => {
    expect(isNegative(money("-1"))).toBe(true);
    expect(isNegative(money("0"))).toBe(false); // cero no es negativo
    expect(isNegative(money("1"))).toBe(false);
  });

  it("max y min comparan como números, no como strings", () => {
    // "9" > "10" es true al comparar como texto. Con Decimal no pasa.
    expect(max(money("9"), money("10")).toFixed(0)).toBe("10");
    expect(min(money("9"), money("10")).toFixed(0)).toBe("9");
  });
});

describe("parseMoneyInput · lo que la gente realmente escribe", () => {
  it("interpreta el formato argentino (punto de miles, coma decimal)", () => {
    expect(parseMoneyInput("1.234,56")?.toFixed(2)).toBe("1234.56");
    expect(parseMoneyInput("800.000")?.toFixed(2)).toBe("800000.00");
    expect(parseMoneyInput("1.234.567,89")?.toFixed(2)).toBe("1234567.89");
  });

  it("interpreta el formato internacional (coma de miles, punto decimal)", () => {
    expect(parseMoneyInput("1,234.56")?.toFixed(2)).toBe("1234.56");
    expect(parseMoneyInput("1,234,567.89")?.toFixed(2)).toBe("1234567.89");
  });

  it("con un solo punto y 3 decimales asume separador de miles (convención local)", () => {
    // "1.500" en Argentina son mil quinientos. La ambigüedad es real, y se
    // resuelve por la convención del usuario, no por la del navegador.
    expect(parseMoneyInput("1.500")?.toFixed(2)).toBe("1500.00");
    expect(parseMoneyInput("2.000")?.toFixed(2)).toBe("2000.00");
  });

  it("con un solo punto y otros decimales lo toma como decimal", () => {
    expect(parseMoneyInput("1.5")?.toFixed(2)).toBe("1.50");
    expect(parseMoneyInput("10.25")?.toFixed(2)).toBe("10.25");
    expect(parseMoneyInput("1234.567")?.toFixed(2)).toBe("1234.57");
  });

  it("ignora símbolos de moneda, espacios y letras", () => {
    expect(parseMoneyInput("$ 800.000,50")?.toFixed(2)).toBe("800000.50");
    expect(parseMoneyInput(" 1.234,56 ")?.toFixed(2)).toBe("1234.56");
    expect(parseMoneyInput("ARS 500")?.toFixed(2)).toBe("500.00");
  });

  it("acepta negativos", () => {
    expect(parseMoneyInput("-1.234,56")?.toFixed(2)).toBe("-1234.56");
  });

  it("devuelve null (nunca NaN) cuando no puede interpretar", () => {
    // NaN se propaga en silencio por toda la app y aparece como "NaN" en la
    // interfaz recién al final. null obliga a decidir qué hacer.
    expect(parseMoneyInput("")).toBeNull();
    expect(parseMoneyInput("   ")).toBeNull();
    expect(parseMoneyInput("abc")).toBeNull();
    expect(parseMoneyInput("$")).toBeNull();
    expect(parseMoneyInput(",")).toBeNull();
    expect(parseMoneyInput(".")).toBeNull();
    expect(parseMoneyInput("-")).toBeNull();
  });
});

describe("Formato", () => {
  it("formatea en pesos con separador de miles", () => {
    const formatted = formatMoney("800000.5");
    // Se verifica el número; el símbolo exacto varía según la versión de ICU.
    expect(formatted).toContain("800.000,50");
  });

  it("siempre muestra dos decimales", () => {
    expect(formatMoney("1500")).toContain("500,00");
  });

  it("formatea porcentajes al estilo local", () => {
    const formatted = formatPercent("21.88");
    expect(formatted).toContain("21,88");
    expect(formatted).toContain("%");
  });
});

describe("Préstamos · tasa mensual", () => {
  it("convierte TNA a tasa mensual dividiendo por 12", () => {
    // La TNA es NOMINAL: se divide por 12. Si se usara la conversión de tasa
    // efectiva ((1+tna)^(1/12)-1) las cuotas no coincidirían NUNCA con el
    // resumen del banco, que liquida dividiendo por 12.
    expect(monthlyRateFromTna("60").toFixed(6)).toBe("0.050000");
    expect(monthlyRateFromTna("36").toFixed(6)).toBe("0.030000");
    expect(monthlyRateFromTna("0").toFixed(6)).toBe("0.000000");
  });
});

describe("Préstamos · cuota y plan de pagos", () => {
  const PRINCIPAL = "500000";
  const TNA = "60";
  const CUOTAS = 12;

  it("calcula una cuota fija razonable", () => {
    // Verificado contra la fórmula del sistema francés: ≈ 56.413.
    const cuota = installmentPayment(PRINCIPAL, TNA, CUOTAS);
    expect(toNumber(cuota)).toBeGreaterThan(56_400);
    expect(toNumber(cuota)).toBeLessThan(56_430);
  });

  it("sin interés, la cuota es el capital repartido", () => {
    expect(installmentPayment("1200", "0", 12).toFixed(2)).toBe("100.00");
  });

  it("LA INVARIANTE CLAVE: la suma del capital amortizado es exactamente el préstamo", () => {
    // Si esto falla, el préstamo nunca termina de pagarse: siempre queda un
    // saldo residual por errores de redondeo acumulados.
    const schedule = amortizationSchedule(PRINCIPAL, TNA, CUOTAS);
    const totalPrincipal = sum(schedule.map((c) => c.principal));
    expect(totalPrincipal.equals(money(PRINCIPAL))).toBe(true);
  });

  it("LA INVARIANTE CLAVE: el saldo final es cero exacto", () => {
    const schedule = amortizationSchedule(PRINCIPAL, TNA, CUOTAS);
    const last = schedule[schedule.length - 1];
    expect(isZero(last.remainingBalance)).toBe(true);
  });

  it("cada cuota es exactamente interés más capital", () => {
    const schedule = amortizationSchedule(PRINCIPAL, TNA, CUOTAS);
    for (const cuota of schedule) {
      expect(cuota.payment.equals(add(cuota.interest, cuota.principal))).toBe(true);
    }
  });

  it("el total pagado es exactamente capital más intereses", () => {
    const schedule = amortizationSchedule(PRINCIPAL, TNA, CUOTAS);
    const totalPaid = sum(schedule.map((c) => c.payment));
    const totalInterest = sum(schedule.map((c) => c.interest));
    const totalPrincipal = sum(schedule.map((c) => c.principal));
    expect(totalPaid.equals(add(totalInterest, totalPrincipal))).toBe(true);
  });

  it("el primer interés es el capital por la tasa mensual", () => {
    // 500.000 × 5% = 25.000. Es el costo real del primer mes.
    const schedule = amortizationSchedule(PRINCIPAL, TNA, CUOTAS);
    expect(schedule[0].interest.toFixed(2)).toBe("25000.00");
  });

  it("el interés baja y el capital sube en cada cuota", () => {
    // La composición es lo único que cambia en un préstamo de cuota fija.
    // Al principio casi todo es interés; al final, casi todo capital.
    const schedule = amortizationSchedule(PRINCIPAL, TNA, CUOTAS);

    for (let i = 1; i < schedule.length; i += 1) {
      expect(schedule[i].interest.lessThan(schedule[i - 1].interest)).toBe(true);
      expect(schedule[i].principal.greaterThan(schedule[i - 1].principal)).toBe(true);
    }
  });

  it("el saldo baja en cada cuota y termina en cero", () => {
    const schedule = amortizationSchedule(PRINCIPAL, TNA, CUOTAS);
    expect(schedule[0].remainingBalance.lessThan(PRINCIPAL)).toBe(true);
    for (let i = 1; i < schedule.length; i += 1) {
      expect(schedule[i].remainingBalance.lessThan(schedule[i - 1].remainingBalance)).toBe(true);
    }
    expect(isZero(schedule[schedule.length - 1].remainingBalance)).toBe(true);
  });

  it("genera exactamente la cantidad de cuotas pedidas", () => {
    for (const count of [1, 6, 12, 24, 60]) {
      expect(amortizationSchedule(PRINCIPAL, TNA, count)).toHaveLength(count);
    }
  });

  it("rechaza cantidades de cuotas inválidas", () => {
    expect(() => amortizationSchedule(PRINCIPAL, TNA, 0)).toThrow();
    expect(() => amortizationSchedule(PRINCIPAL, TNA, -1)).toThrow();
  });

  it("un préstamo sin interés no genera costo", () => {
    const summary = loanSummary("120000", "0", 12);
    expect(isZero(summary.totalInterest)).toBe(true);
    expect(isZero(summary.totalCost)).toBe(true);
    expect(summary.totalPaid.equals(money("120000"))).toBe(true);
  });
});

describe("loanSummary · el costo real de un préstamo", () => {
  it("de cada 100 pesos pagados, sólo ~26 son del banco", () => {
    // Este es el número que la app anterior no podía calcular: de los
    // ≈676.000 que vas a pagar, 500.000 son recuperar tu propia deuda y
    // ≈177.000 son plata que se queda el banco.
    const summary = loanSummary("500000", "60", 12);

    expect(toNumber(summary.interestSharePercent)).toBeGreaterThan(26.0 - EPSILON);
    expect(toNumber(summary.interestSharePercent)).toBeLessThan(26.3 + EPSILON);

    // El total pagado ronda los 676.000.
    expect(toNumber(summary.totalPaid)).toBeGreaterThan(676_900);
    expect(toNumber(summary.totalPaid)).toBeLessThan(677_000);
  });

  it("el costo real es sólo el interés, no la cuota entera", () => {
    const summary = loanSummary("500000", "60", 12);
    expect(summary.totalCost.equals(summary.totalInterest)).toBe(true);
    // El capital devuelto NO es un costo: es bajar la deuda.
    expect(summary.totalPrincipal.equals(money("500000"))).toBe(true);
  });

  it("más cuotas con la misma tasa cuestan MÁS, no menos", () => {
    // Cambiar de 12 a 24 cuotas baja la cuota mensual y por eso parece
    // conveniente. No lo es: casi duplica el costo total.
    const short = loanSummary("500000", "60", 12);
    const long = loanSummary("500000", "60", 24);

    expect(toNumber(long.totalInterest)).toBeGreaterThan(toNumber(short.totalInterest));
    expect(toNumber(long.payment)).toBeLessThan(toNumber(short.payment));
  });
});

describe("EL CASO QUE JUSTIFICA TODO EL REDISEÑO", () => {
  /**
   * Sueldo 800.000 · Gastos 600.000 · Préstamo 500.000 a TNA 60% en 12 cuotas.
   *
   * Los dos modelos dan tasas de ahorro RADICALMENTE distintas, y la diferencia
   * no es un detalle de redondeo: es la diferencia entre creerte rico y serlo.
   */
  const SALARY = "800000";
  const EXPENSES = "600000";
  const LOAN = "500000";
  const TNA = "60";
  const CUOTAS = 12;

  it("el modelo viejo reportaba un ahorro del ~49%, y era mentira", () => {
    // Cobrar un préstamo NO es un ingreso (te endeudaste, no ganaste plata) y
    // la cuota entera NO es un gasto (la mayor parte devuelve deuda).
    // El modelo viejo no podía distinguirlo: sólo tenía INCOME y EXPENSE.
    const loan = loanSummary(LOAN, TNA, CUOTAS);

    const naiveIncome = add(money(SALARY), money(LOAN));
    const naiveExpenses = add(money(EXPENSES), loan.payment);
    const naiveRate = toNumber(
      naiveIncome.minus(naiveExpenses).dividedBy(naiveIncome).times(100),
    );

    expect(naiveRate).toBeGreaterThan(49);
    expect(naiveRate).toBeLessThan(50);
  });

  it("el modelo nuevo reporta un ahorro del ~22%, que es el real", () => {
    // Ingreso real: sólo el sueldo.
    // Gasto real: los gastos + el INTERÉS del período (el resto de la cuota
    // es amortización de capital: baja la deuda, no se pierde).
    const loan = loanSummary(LOAN, TNA, CUOTAS);
    const firstMonthInterest = loan.schedule[0].interest;

    const trueRate = toNumber(
      money(SALARY)
        .minus(money(EXPENSES))
        .minus(firstMonthInterest)
        .dividedBy(money(SALARY))
        .times(100),
    );

    expect(trueRate).toBeGreaterThan(21);
    expect(trueRate).toBeLessThan(24);
  });

  it("la diferencia entre los dos números supera los 20 puntos", () => {
    const loan = loanSummary(LOAN, TNA, CUOTAS);

    const naiveIncome = add(money(SALARY), money(LOAN));
    const naiveRate = naiveIncome
      .minus(add(money(EXPENSES), loan.payment))
      .dividedBy(naiveIncome)
      .times(100);

    const trueRate = money(SALARY)
      .minus(money(EXPENSES))
      .minus(loan.schedule[0].interest)
      .dividedBy(money(SALARY))
      .times(100);

    // Este es el tamaño del autoengaño que la app anterior producía.
    expect(toNumber(naiveRate.minus(trueRate))).toBeGreaterThan(20);
  });
});

describe("installmentsCoveredBy · cuántas cuotas cubre el capital pagado", () => {
  // Los números del cronograma del §3.2 (500.000 al 60% en 12 cuotas), con las
  // amortizaciones acumuladas calculadas A MANO:
  //   cuota 1: 31.412,71 → acumulado 31.412,71
  //   cuota 2: 32.983,35 → acumulado 64.396,06
  //   cuota 11: …        → acumulado 446.273,69
  //   cuota 12: …        → acumulado 500.000,00 exactos (la invariante)
  const schedule = amortizationSchedule("500000", "60", 12);

  it("sin capital pagado, ninguna cuota", () => {
    expect(installmentsCoveredBy(schedule, "0")).toBe(0);
  });

  it("un centavo menos que la amortización de la cuota 1 NO la cubre", () => {
    // El pago parcial no "casi" cuenta: hasta que no se cubre la amortización
    // completa de la próxima cuota, esa cuota no está pagada. Es lo que hace el
    // banco, y evita decir "vas por la cuota 2" debiendo la 1.
    expect(installmentsCoveredBy(schedule, "31412.70")).toBe(0);
    expect(installmentsCoveredBy(schedule, "31412.71")).toBe(1);
  });

  it("las amortizaciones se acumulan cuota por cuota", () => {
    expect(installmentsCoveredBy(schedule, "64396.06")).toBe(2);
    expect(installmentsCoveredBy(schedule, "446273.69")).toBe(11);
    expect(installmentsCoveredBy(schedule, "500000")).toBe(12);
  });

  it("pagar más que el préstamo no cubre cuotas de más", () => {
    // Un cronograma tiene 12 cuotas: ni con 600.000 hay una cuota 13.
    expect(installmentsCoveredBy(schedule, "600000")).toBe(12);
  });

  it("un pago de 40.000 cubre la cuota 1 y nada más", () => {
    expect(installmentsCoveredBy(schedule, "40000")).toBe(1);
  });

  it("un cronograma vacío no cubre nada", () => {
    expect(installmentsCoveredBy([], "1000")).toBe(0);
  });
});

describe("loanProgress · capital, interés y cuotas restantes", () => {
  const schedule = amortizationSchedule("500000", "60", 12);

  it("sin pagos: todo en cero y 12 cuotas restantes", () => {
    const progress = loanProgress(schedule, "0");
    expect(progress.capitalPaid.toFixed(2)).toBe("0.00");
    expect(progress.installmentsCovered).toBe(0);
    expect(progress.interestPaid.toFixed(2)).toBe("0.00");
    expect(progress.remainingCount).toBe(12);
    expect(progress.progressPercent.toFixed(2)).toBe("0.00");
  });

  it("con la cuota 1 pagada: el interés pagado es SOLO el de esa cuota", () => {
    // 25.000,00: el costo real del primer mes. El resto de la cuota baja deuda.
    const progress = loanProgress(schedule, "31412.71");
    expect(progress.capitalPaid.toFixed(2)).toBe("31412.71");
    expect(progress.installmentsCovered).toBe(1);
    expect(progress.interestPaid.toFixed(2)).toBe("25000.00");
    expect(progress.remainingCount).toBe(11);
    // 31.412,71 / 500.000 = 6,282542% → 6,28.
    expect(progress.progressPercent.toFixed(2)).toBe("6.28");
  });

  it("con dos cuotas pagadas el interés se acumula", () => {
    const progress = loanProgress(schedule, "64396.06");
    expect(progress.installmentsCovered).toBe(2);
    // 25.000,00 + 23.429,36.
    expect(progress.interestPaid.toFixed(2)).toBe("48429.36");
    expect(progress.remainingCount).toBe(10);
    expect(progress.progressPercent.toFixed(2)).toBe("12.88");
  });

  it("el capital se clampa al principal y el progreso nunca supera 100%", () => {
    const progress = loanProgress(schedule, "600000");
    expect(progress.principal.toFixed(2)).toBe("500000.00");
    expect(progress.capitalPaid.toFixed(2)).toBe("500000.00");
    expect(progress.installmentsCovered).toBe(12);
    // El interés total del préstamo: lo único que pagaste de más.
    expect(progress.interestPaid.toFixed(2)).toBe("176952.44");
    expect(progress.remainingCount).toBe(0);
    expect(progress.progressPercent.toFixed(2)).toBe("100.00");
  });

  it("un pago parcial de 40.000 deja 11 cuotas pendientes y 8,00% de progreso", () => {
    const progress = loanProgress(schedule, "40000");
    expect(progress.capitalPaid.toFixed(2)).toBe("40000.00");
    expect(progress.installmentsCovered).toBe(1);
    expect(progress.interestPaid.toFixed(2)).toBe("25000.00");
    expect(progress.remainingCount).toBe(11);
    expect(progress.progressPercent.toFixed(2)).toBe("8.00");
  });

  it("un principal de cero devuelve 0% y no NaN", () => {
    // Caso defensivo: la base prohíbe un préstamo sin parámetros, pero una
    // división por cero viajando como "NaN" por la interfaz sería peor.
    const progress = loanProgress(amortizationSchedule("0", "60", 12), "100");
    expect(progress.progressPercent.toFixed(2)).toBe("0.00");
    expect(progress.capitalPaid.toFixed(2)).toBe("0.00");
  });

  it("LA INVARIANTE: el progreso queda siempre entre 0 y 100 y las cuotas suman 12", () => {
    for (const paid of ["0", "1", "31412.71", "250000", "499999.99", "999999"]) {
      const progress = loanProgress(schedule, paid);
      expect(progress.capitalPaid.greaterThanOrEqualTo(0)).toBe(true);
      expect(progress.capitalPaid.lessThanOrEqualTo(progress.principal)).toBe(true);
      expect(progress.progressPercent.greaterThanOrEqualTo(0)).toBe(true);
      expect(progress.progressPercent.lessThanOrEqualTo(100)).toBe(true);
      expect(progress.installmentsCovered + progress.remainingCount).toBe(12);
    }
  });
});
