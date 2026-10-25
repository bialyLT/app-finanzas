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
 * ─────────────────────────────────────────────────────────────────────────────
 * ESTOS NÚMEROS SON MEDIDAS, NO OPINIONES (Archivo, 2026-10-22)
 * El avance de cada glifo se midió en el navegador con el motor de texto
 * real, con cuerpo de 100 px y `font-variant-numeric: tabular-nums`. La
 * medición está en `docs/design-system.md` §3.3 y la reproduce
 * `node scripts/medir-fuente.mjs`.
 *
 * La tabla vive ACÁ (no se importa de `lib/format.ts`) a propósito: si el
 * modelo cambia sus constantes, este test tiene que fallar — importar las
 * constantes del modelo haría que el test se mueva junto con el bug.
 *
 * Con cifras tabulares el ancho de un monto es la SUMA de sus glifos: el «0»,
 * el «1» y el «8» miden lo mismo. Con Geist (la fuente de la F0a) los dígitos
 * eran proporcionales (0,6931 vs 0,4491 em) y el ancho dependía de qué
 * dígitos tuviera el monto.
 */
const ARCHIVO_800 = {
  digito: 0.627031,
  separador: 0.318125,
  simbolo: 0.579063,
  espacio: 0.189063,
  signo: 0.649063,
  guion: 0.333125,
};

const ARCHIVO_700 = {
  digito: 0.598125,
  separador: 0.307031,
  simbolo: 0.556094,
  espacio: 0.196094,
  signo: 0.641094,
  guion: 0.333125,
};

/** El ancho de un monto en `em`, glifo por glifo (la misma composición que el modelo). */
function anchoEm(
  texto: string,
  tabla: typeof ARCHIVO_700,
): number {
  let em = 0;
  for (const caracter of texto) {
    if (caracter >= "0" && caracter <= "9") em += tabla.digito;
    else if (caracter === "." || caracter === ",") em += tabla.separador;
    else if (caracter === "$") em += tabla.simbolo;
    else if (caracter === " " || caracter === "\u00a0") em += tabla.espacio;
    else if (caracter === "+" || caracter === "−") em += tabla.signo;
    else if (caracter === "-") em += tabla.guion;
    else em += tabla.digito;
  }
  return em;
}

describe("factorMonto", () => {
  /** El ancho de la caja del monto a 940 px (la tarjeta de cuatro columnas). */
  const CAJA_A_940 = 195;

  it("un monto de todos los días NO cambia de cuerpo de letra", () => {
    // "$ 800.000,00": 12 caracteres.
    const k = Number(factorMonto("$ 800.000,00"));
    // El tope que impone la regla es `min(1,5rem, 100cqw × k)`: si el
    // segundo término da MÁS que 1,5 rem (24 px, el paso `xl` de la escala),
    // el cuerpo sigue siendo el de siempre y la tarjeta se ve igual.
    expect(k * CAJA_A_940).toBeGreaterThan(24);
  });

  it("un monto largo entra en la caja de su tarjeta", () => {
    // "$ 1.234.567.890,12": 18 caracteres · 9,5650 em medidos.
    const texto = "$ 1.234.567.890,12";
    const k = Number(factorMonto(texto));
    const cuerpo = k * CAJA_A_940; // px
    expect(cuerpo).toBeLessThan(24);
    // El texto, con el ancho REAL de la fuente, tiene que caber.
    expect(anchoEm(texto, ARCHIVO_800) * cuerpo).toBeLessThanOrEqual(CAJA_A_940);
  });

  it("el modelo cubre el ancho medido con ~5 % de margen (ni de menos ni de más)", () => {
    // `1 / k` es el ancho que el modelo le asigna al monto, en em. Tiene que
    // cubrir el ancho real (si no, el número se sale de su caja) y no pasarse
    // del margen (si no, se achica de más y se ve chico al pedo).
    for (const texto of [
      "$ 000.000,00",
      "$ 800.000,00",
      "+$ 800.000,00",
      "$ 100.000,00",
      "$ 1.234.567.890,12",
      "−$ 9.999.999,99",
    ]) {
      const k = Number(factorMonto(texto));
      const margen = 1 / k / anchoEm(texto, ARCHIVO_800);
      expect(margen).toBeGreaterThanOrEqual(1.04);
      expect(margen).toBeLessThanOrEqual(1.06);
    }
  });

  it("con cifras tabulares, el ancho NO depende de qué dígitos tenga el monto", () => {
    // Tres montos de la MISMA forma (8 dígitos, 2 separadores): con Archivo
    // tabular miden exactamente lo mismo, así que el modelo les da el mismo
    // factor. Con Geist esto era falso («$ 111.111,11» era más angosto que
    // «$ 800.000,00») y por eso el modelo necesitaba un avance por forma.
    expect(factorMonto("$ 111.111,11")).toBe(factorMonto("$ 800.000,00"));
    expect(factorMonto("$ 999.999,99")).toBe(factorMonto("$ 800.000,00"));
    expect(factorMonto("+$ 123.456,78")).toBe(factorMonto("+$ 800.000,00"));
  });

  it("un monto CON signo entra en la caja (el «+» y la «−» son más anchos)", () => {
    const texto = "+$ 800.000,00";
    const k = Number(factorMonto(texto));
    // El tope de 24 px manda: el monto de todos los días no se achica.
    expect(k * CAJA_A_940).toBeGreaterThan(24);
    expect(anchoEm(texto, ARCHIVO_800) * 24).toBeLessThanOrEqual(CAJA_A_940);
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
    // "$ 100.000,00": 12 caracteres · 6,1512 em medidos en peso 700.
    const texto = "$ 100.000,00";
    const k = Number(factorMontoFicha(texto));
    const cuerpo = k * CAJA_A_320; // px
    expect(cuerpo).toBeLessThanOrEqual(14);
    // El texto, con el avance real medido, tiene que caber en la caja: es lo
    // que evita el número partido.
    expect(anchoEm(texto, ARCHIVO_700) * cuerpo).toBeLessThanOrEqual(
      CAJA_A_320,
    );
  });

  it("un monto CON signo (más ancho) también entra", () => {
    // "+$ 310.000,00": los mismos 8 dígitos más el signo.
    const texto = "+$ 310.000,00";
    const k = Number(factorMontoFicha(texto));
    const cuerpo = k * CAJA_A_320;
    expect(anchoEm(texto, ARCHIVO_700) * cuerpo).toBeLessThanOrEqual(
      CAJA_A_320,
    );
  });

  it("el ancho del modelo cubre la medida de la ficha (peso 700, tabular)", () => {
    for (const texto of [
      "$ 000.000,00",
      "$ 800.000,00",
      "$ 100.000,00",
      "+$ 310.000,00",
      "−$ 1.234.567,89",
    ]) {
      const k = Number(factorMontoFicha(texto));
      const margen = 1 / k / anchoEm(texto, ARCHIVO_700);
      expect(margen).toBeGreaterThanOrEqual(1.04);
      expect(margen).toBeLessThanOrEqual(1.06);
    }
  });

  it("las fichas usan la tabla del peso 700, no la del 800", () => {
    // Si la ficha usara la tabla del 800 (dígito 0,627031) el cuerpo saldría
    // un 4,8 % más chico: el monto de todos los días se vería más chico
    // aunque entre. El factor de la ficha es, con los mismos caracteres,
    // MAYOR que el de una tarjeta grande.
    expect(Number(factorMontoFicha("$ 100.000,00"))).toBeGreaterThan(
      Number(factorMonto("$ 100.000,00")),
    );
  });

  it("en una ficha ancha el cuerpo NO cambia (el caso común se ve igual)", () => {
    // A 480 px la ficha entra de sobra: el tope de 0,875 rem (14 px) manda
    // y el monto se ve igual que siempre.
    const texto = "$ 100.000,00";
    const k = Number(factorMontoFicha(texto));
    expect(k * 117).toBeGreaterThan(14);
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
