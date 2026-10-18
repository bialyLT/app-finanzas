import { describe, expect, it } from "vitest";
import { installmentState, loanStatus, type InstallmentStateInput } from "./loan-ui";

/**
 * Las etiquetas de estado de la pantalla de préstamos.
 *
 * Son lógica de presentación con bordes finos (cobertura por prefijo + fecha
 * de calendario + cuotas sin amortización), así que viven acá con su test:
 * repetirlas en el JSX las dejaría sin candado.
 */

const TODAY = "2026-11-30";

function installment(
  input: Partial<InstallmentStateInput> = {},
): InstallmentStateInput {
  return {
    covered: false,
    dueDate: "2026-11-15",
    principal: "312.29",
    ...input,
  };
}

describe("installmentState: el estado de una cuota del cronograma", () => {
  it("cubierta y con la fecha ya caída es Pagada", () => {
    expect(
      installmentState(installment({ covered: true, dueDate: "2026-10-15" }), "FRENCH", TODAY),
    ).toBe("Pagada");
  });

  it("cubierta ANTES de la fecha es Cubierta (pagada por adelantado)", () => {
    expect(
      installmentState(installment({ covered: true, dueDate: "2026-12-15" }), "FRENCH", TODAY),
    ).toBe("Cubierta");
  });

  it("cubierta el DÍA del vencimiento es Pagada: vence hoy no es adelanto", () => {
    expect(
      installmentState(installment({ covered: true, dueDate: TODAY }), "FRENCH", TODAY),
    ).toBe("Pagada");
  });

  it("impaga con la fecha pasada es Vencida", () => {
    expect(
      installmentState(installment({ dueDate: "2026-11-15" }), "FRENCH", TODAY),
    ).toBe("Vencida");
  });

  it("impaga que vence HOY es Pendiente: vence hoy, todavía no venció", () => {
    expect(installmentState(installment({ dueDate: TODAY }), "FRENCH", TODAY)).toBe(
      "Pendiente",
    );
  });

  it("impaga con fecha futura es Pendiente", () => {
    expect(
      installmentState(installment({ dueDate: "2026-12-15" }), "FRENCH", TODAY),
    ).toBe("Pendiente");
  });

  it("en un americano, la cuota de capital 0 impaga es Solo interés (nunca Vencida)", () => {
    const interestOnly = installment({
      dueDate: "2026-10-15",
      principal: "0.00",
    });
    expect(installmentState(interestOnly, "AMERICAN", TODAY)).toBe("Solo interés");
  });

  it("en un americano, el cierre (capital > 0) sí puede vencer y se cubre como cualquier cuota", () => {
    const closing = installment({ dueDate: "2026-11-15", principal: "500000.00" });
    expect(installmentState(closing, "AMERICAN", TODAY)).toBe("Vencida");
    expect(installmentState({ ...closing, covered: true }, "AMERICAN", TODAY)).toBe(
      "Pagada",
    );
  });

  it("en un rotativo toda cuota es Solo interés mientras no esté cubierta", () => {
    const row = installment({ dueDate: "2026-10-15", principal: "0.00" });
    expect(installmentState(row, "INTEREST_ONLY", TODAY)).toBe("Solo interés");
    expect(installmentState({ ...row, covered: true }, "INTEREST_ONLY", TODAY)).toBe(
      "Pagada",
    );
  });

  it("un capital 0 en un sistema que amortiza no inventa 'Solo interés'", () => {
    const row = installment({ dueDate: "2026-11-15", principal: "0.00" });
    expect(installmentState(row, "FRENCH", TODAY)).toBe("Vencida");
  });
});

describe("loanStatus: la píldora de estado de la tarjeta de un préstamo", () => {
  it("sin cronograma lo dice tal cual", () => {
    expect(loanStatus({ plan: null, nextInstallment: null }, TODAY)).toBe(
      "Sin cronograma",
    );
  });

  it("con todas las cuotas cubiertas está Cubierto", () => {
    expect(
      loanStatus(
        { plan: { remainingCount: 0 }, nextInstallment: null },
        TODAY,
      ),
    ).toBe("Cubierto");
  });

  it("con la próxima cuota vencida está Vencida", () => {
    expect(
      loanStatus(
        {
          plan: { remainingCount: 11 },
          nextInstallment: { dueDate: "2026-11-15" },
        },
        TODAY,
      ),
    ).toBe("Vencida");
  });

  it("con la próxima cuota al día (o al borde de hoy) está Al día", () => {
    expect(
      loanStatus(
        {
          plan: { remainingCount: 11 },
          nextInstallment: { dueDate: TODAY },
        },
        TODAY,
      ),
    ).toBe("Al día");
    expect(
      loanStatus(
        {
          plan: { remainingCount: 11 },
          nextInstallment: { dueDate: "2026-12-15" },
        },
        TODAY,
      ),
    ).toBe("Al día");
  });

  it("un rotativo sin cuotas por ruta no inventa un vencimiento", () => {
    expect(
      loanStatus({ plan: { remainingCount: 6 }, nextInstallment: null }, TODAY),
    ).toBe("Al día");
  });
});
