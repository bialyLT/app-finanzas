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
import { factorMonto, factorMontoFicha, formatLiability, montoLargo } from "./format";

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

/**
 * Tests de la tipografía del monto (`factorMonto` y `montoLargo`).
 *
 * La regla que se verifica es UNA: el monto tiene que entrar en su tarjeta.
 * El corte de las cuatro columnas (940 px) está calculado para 13 caracteres;
 * con más, el número no entra y empuja al documento (scroll horizontal).
 *
 * El avance medio de un carácter de un monto en negrita es de 0,576 em
 * (medido en el navegador: 248 px / 18 caracteres / 24 px de cuerpo).
 */
describe("factorMonto", () => {
  /** El ancho de la caja del monto a 940 px (la tarjeta de cuatro columnas). */
  const CAJA_A_940 = 195;

  it("un monto de todos los días NO cambia de cuerpo de letra", () => {
    // "$ 800.000,00": 12 caracteres.
    const k = Number(factorMonto("$ 800.000,00"));
    // El tope que impone la regla es `min(1,5rem, 100cqw × k)`: si el
    // segundo término da MÁS que 1,5 rem (24 px), el cuerpo sigue siendo el
    // de siempre y la tarjeta se ve igual.
    expect(k * CAJA_A_940).toBeGreaterThan(24);
  });

  it("un monto largo entra en la caja de su tarjeta", () => {
    // "$ 1.234.567.890,12": 18 caracteres.
    const texto = "$ 1.234.567.890,12";
    const k = Number(factorMonto(texto));
    const cuerpo = k * CAJA_A_940; // px
    expect(cuerpo).toBeLessThan(24);
    // El texto, medido con el avance medio real, tiene que caber.
    const ancho = 0.576 * [...texto].length * cuerpo;
    expect(ancho).toBeLessThanOrEqual(CAJA_A_940);
  });

  it("el factor es monótono: más caracteres, cuerpo más chico", () => {
    expect(Number(factorMonto("$ 1.234.567.890,12"))).toBeLessThan(
      Number(factorMonto("$ 800.000,00")),
    );
  });

  it("un texto vacío no rompe nada", () => {
    expect(Number(factorMonto(""))).toBeGreaterThan(0);
  });
});

describe("factorMontoFicha", () => {
  /**
   * La caja de una ficha (la del mes del patrimonio o la de la
   * reconciliación) a 320 px: la grilla de 3 columnas deja 64 px de
   * contenido.
   */
  const CAJA_A_320 = 64;

  it("el monto de todos los días entra en la caja de su ficha", () => {
    // "$ 100.000,00": 12 caracteres, 82 px medidos con cuerpo de 14.
    const texto = "$ 100.000,00";
    const k = Number(factorMontoFicha(texto));
    const cuerpo = k * CAJA_A_320; // px
    expect(cuerpo).toBeLessThanOrEqual(14);
    // El texto, con el avance real medido (0,488 em por carácter), tiene que
    // caber en la caja: es lo que evita el número partido.
    const ancho = 0.488 * [...texto].length * cuerpo;
    expect(ancho).toBeLessThanOrEqual(CAJA_A_320);
  });

  it("un monto CON signo (más ancho) también entra", () => {
    // "+$ 310.000,00": los mismos 12 caracteres más el signo, que es más
    // ancho (medido: 90 px con cuerpo de 14).
    const texto = "+$ 310.000,00";
    const k = Number(factorMontoFicha(texto));
    const cuerpo = k * CAJA_A_320;
    const ancho = (0.488 * [...texto].length + 0.571) * cuerpo;
    expect(ancho).toBeLessThanOrEqual(CAJA_A_320);
  });

  it("en una ficha ancha el cuerpo NO cambia (el caso común se ve igual)", () => {
    // A 480 px la ficha entra de sobra: el tope de 0,875 rem (14 px) manda
    // y el monto se ve igual que siempre.
    const texto = "$ 100.000,00";
    const k = Number(factorMontoFicha(texto));
    expect(k * 117).toBeGreaterThan(14);
  });

  it("el factor de la ficha es mayor que el de las tarjetas grandes", () => {
    // El de las tarjetas grandes usa un avance de 0,6 (un margen
    // conservador); el de las fichas usa el avance REAL, así que el monto
    // de una ficha se achica MENOS (y se ve más grande).
    expect(Number(factorMontoFicha("$ 100.000,00"))).toBeGreaterThan(
      Number(factorMonto("$ 100.000,00")),
    );
  });

  it("un texto vacío no rompe nada", () => {
    expect(Number(factorMontoFicha(""))).toBeGreaterThan(0);
  });
});

describe("montoLargo", () => {

  it("un monto de 13 caracteres no es largo", () => {
    expect(montoLargo("+$ 800.000,00")).toBe(false);
  });

  it("un monto de 14 caracteres sí lo es", () => {
    expect(montoLargo("$ 1.234.567.890,1")).toBe(true);
  });

  it("el límite es configurable", () => {
    expect(montoLargo("$ 800.000,00", 8)).toBe(true);
    expect(montoLargo("$ 800.000,00", 20)).toBe(false);
  });
});
