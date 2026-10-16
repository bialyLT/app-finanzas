/**
 * Tests de `formatLiability` — la etiqueta de las cuentas de deuda.
 *
 * La regla que se verifica es una SOLA y es la razón de existir del helper:
 * la deuda se dice con la palabra del lado que corresponde. El caso que lo
 * motivó es el saldo a favor (se pagó más de lo que se debía): interpolar el
 * signo crudo producía "debe −$ 50.000,00", una frase que se contradice a sí
 * misma.
 */

import { describe, expect, it } from "vitest";
import { formatLiability } from "./format";

describe("formatLiability", () => {
  it("una deuda pendiente se dice con 'debe'", () => {
    const label = formatLiability("50000.00");
    expect(label).toContain("debe");
    expect(label).toContain("50.000,00");
  });

  it("un saldo a favor se dice con 'a favor' y sin el signo", () => {
    const label = formatLiability("-50000.00");
    expect(label).toContain("a favor");
    expect(label).not.toContain("debe");
    // El monto se muestra en positivo: "a favor $ 50.000,00". Un guion acá
    // sería el bug de vuelta.
    expect(label).not.toContain("-");
    expect(label).toContain("50.000,00");
  });

  it("el cero es deuda nula, no un saldo a favor", () => {
    const label = formatLiability("0.00");
    expect(label).toContain("debe");
    expect(label).toContain("0,00");
  });

  it("un centavo a favor también se dice", () => {
    const label = formatLiability("-0.01");
    expect(label).toContain("a favor");
    expect(label).toContain("0,01");
  });
});
