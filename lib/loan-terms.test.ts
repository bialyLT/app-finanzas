/**
 * Tests de la derivación de la tasa (lo que la persona SÍ sabe).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA FILOSOFÍA (la misma de `money.test.ts` y `loans.test.ts`)
 * ─────────────────────────────────────────────────────────────────────────────
 * Primero el CASO CONOCIDO, con las cuentas escritas en el test: el préstamo
 * del §3.2 (500.000 a TNA 60% en 12 cuotas, i = 5% mensual) da una cuota de
 * 56.412,71. El inverso tiene que devolver 60% — y el cronograma tiene que
 * ser IDÉNTICO al que sale de la tasa.
 *
 * Después los BORDES: la cuota insuficiente (no hay solución y el mensaje lo
 * dice), la tasa 0 (un préstamo sin interés es un caso real, no un error), el
 * total que no puede ser menor que el capital, y el cronograma que cierra en
 * 0 EXACTO con la tasa derivada.
 *
 * Y el centro de todo: el número que la persona escribe es el número que la
 * app cobra. Si la cuota que se deriva no es la que se pidió, el modo "por
 * cuota" sería una mentira.
 */

import { describe, expect, it } from "vitest";
import { sum } from "./money";
import {
  LoanTermsError,
  minimumLoanPayment,
  resolveLoanTerms,
} from "./loan-terms";

const P = "500000";
const N = 12;

describe("La cuota derivada (modo PAYMENT)", () => {
  it("el caso conocido: 500.000 en 12 cuotas a 60% dan 56.412,71", () => {
    const terms = resolveLoanTerms({
      system: "FRENCH",
      principal: P,
      installmentCount: N,
      mode: "RATE",
      tnaPercent: "60",
    });
    expect(terms.payment.toFixed(2)).toBe("56412.71");
  });

  it("el inverso devuelve 60% y el MISMO cronograma", () => {
    const porTasa = resolveLoanTerms({
      system: "FRENCH",
      principal: P,
      installmentCount: N,
      mode: "RATE",
      tnaPercent: "60",
    });
    const porCuota = resolveLoanTerms({
      system: "FRENCH",
      principal: P,
      installmentCount: N,
      mode: "PAYMENT",
      payment: "56412.71",
    });

    expect(porCuota.tnaPercent.toFixed(4)).toBe("60.0000");
    expect(porCuota.exact).toBe(true);
    expect(porCuota.payment.toFixed(2)).toBe("56412.71");

    // El cronograma COMPLETO tiene que ser el mismo: pagos, intereses,
    // capitales y saldos. Si sólo cuadrara la cuota, la app cobraría una
    // cosa y mostraría otra.
    expect(
      porCuota.schedule.map((i) => [
        i.payment.toFixed(2),
        i.interest.toFixed(2),
        i.principal.toFixed(2),
        i.remainingBalance.toFixed(2),
      ]),
    ).toEqual(
      porTasa.schedule.map((i) => [
        i.payment.toFixed(2),
        i.interest.toFixed(2),
        i.principal.toFixed(2),
        i.remainingBalance.toFixed(2),
      ]),
    );
  });

  it("la cuota mínima es el capital repartido (tasa 0)", () => {
    expect(minimumLoanPayment(P, N).toFixed(2)).toBe("41666.67");
  });

  it("una cuota por debajo de la mínima NO tiene solución: lo dice", () => {
    expect(() =>
      resolveLoanTerms({
        system: "FRENCH",
        principal: P,
        installmentCount: N,
        mode: "PAYMENT",
        payment: "40000",
      }),
    ).toThrowError(LoanTermsError);

    try {
      resolveLoanTerms({
        system: "FRENCH",
        principal: P,
        installmentCount: N,
        mode: "PAYMENT",
        payment: "40000",
      });
      throw new Error("debería haber fallado");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("no alcanza para cubrir el capital");
      // El mensaje trae la cuota mínima: es lo que la persona necesita.
      expect(message).toContain("41666.67");
    }
  });

  it("la cuota mínima EXACTA es un préstamo sin interés (tasa 0)", () => {
    const terms = resolveLoanTerms({
      system: "FRENCH",
      principal: P,
      installmentCount: N,
      mode: "PAYMENT",
      payment: "41666.67",
    });
    expect(terms.tnaPercent.toFixed(4)).toBe("0.0000");
    expect(terms.exact).toBe(true);
    expect(terms.totalInterest.toFixed(2)).toBe("0.00");
  });

  it("una cuota de cero o negativa es un error, no una tasa", () => {
    for (const payment of ["0", "-1000"]) {
      expect(() =>
        resolveLoanTerms({
          system: "FRENCH",
          principal: P,
          installmentCount: N,
          mode: "PAYMENT",
          payment,
        }),
      ).toThrowError(/mayor a cero/);
    }
  });

  it("el cronograma derivado cierra en 0 EXACTO", () => {
    const terms = resolveLoanTerms({
      system: "FRENCH",
      principal: P,
      installmentCount: N,
      mode: "PAYMENT",
      payment: "60000",
    });
    expect(terms.schedule.at(-1)?.remainingBalance.toFixed(2)).toBe("0.00");
    expect(sum(terms.schedule.map((i) => i.principal)).toFixed(2)).toBe(
      "500000.00",
    );
  });
});

describe("El total (modo TOTAL)", () => {
  it("el total manda: de él sale la cuota y la tasa", () => {
    const porTasa = resolveLoanTerms({
      system: "FRENCH",
      principal: P,
      installmentCount: N,
      mode: "RATE",
      tnaPercent: "60",
    });

    const porTotal = resolveLoanTerms({
      system: "FRENCH",
      principal: P,
      installmentCount: N,
      mode: "TOTAL",
      total: porTasa.totalPaid.toFixed(2),
    });

    expect(porTotal.tnaPercent.toFixed(4)).toBe("60.0000");
    expect(porTotal.totalPaid.toFixed(2)).toBe(porTasa.totalPaid.toFixed(2));
    expect(porTotal.payment.toFixed(2)).toBe("56412.71");
  });

  it("un total menor que el capital es un error con palabras", () => {
    expect(() =>
      resolveLoanTerms({
        system: "FRENCH",
        principal: P,
        installmentCount: N,
        mode: "TOTAL",
        total: "100000",
      }),
    ).toThrowError(/no puede ser menor que el capital/);
  });

  it("un total de cero o negativo es un error", () => {
    expect(() =>
      resolveLoanTerms({
        system: "FRENCH",
        principal: P,
        installmentCount: N,
        mode: "TOTAL",
        total: "0",
      }),
    ).toThrowError(/mayor a cero/);
  });
});

describe("Los otros sistemas", () => {
  it("alemán: la primera cuota es la que se deriva", () => {
    const porTasa = resolveLoanTerms({
      system: "GERMAN",
      principal: P,
      installmentCount: N,
      mode: "RATE",
      tnaPercent: "60",
    });
    const porCuota = resolveLoanTerms({
      system: "GERMAN",
      principal: P,
      installmentCount: N,
      mode: "PAYMENT",
      payment: porTasa.payment.toFixed(2),
    });
    expect(porCuota.tnaPercent.toFixed(4)).toBe("60.0000");
    expect(porCuota.payment.toFixed(2)).toBe(porTasa.payment.toFixed(2));
  });

  it("americano: la cuota ES el interés (directo, sin bisección)", () => {
    const terms = resolveLoanTerms({
      system: "AMERICAN",
      principal: P,
      installmentCount: N,
      mode: "PAYMENT",
      payment: "25000",
    });
    // 25.000 = 500.000 × 5% mensual → 60% anual.
    expect(terms.tnaPercent.toFixed(4)).toBe("60.0000");
    expect(terms.schedule.at(-1)?.principal.toFixed(2)).toBe("500000.00");
  });

  it("solo interés: la cuota es el interés del mes", () => {
    const terms = resolveLoanTerms({
      system: "INTEREST_ONLY",
      principal: P,
      installmentCount: N,
      mode: "PAYMENT",
      payment: "25000",
    });
    expect(terms.tnaPercent.toFixed(4)).toBe("60.0000");
    expect(terms.totalPrincipal.toFixed(2)).toBe("0.00");
  });

  it("el importado no tiene tasa que derivar", () => {
    expect(() =>
      resolveLoanTerms({
        system: "IMPORTED",
        principal: P,
        installmentCount: N,
        mode: "PAYMENT",
        payment: "50000",
      }),
    ).toThrowError(/sistema importado/);
  });
});
