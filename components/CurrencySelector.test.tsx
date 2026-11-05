import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CurrencySelector } from "./CurrencySelector";

/**
 * El selector de moneda, renderizado sin DOM (`react-dom/server`, como las
 * primitivas de `ui/`). Lo que importa acá es la regla de producto:
 *
 *   · con una sola moneda habilitada NO existe control —no hay nada que
 *     elegir—;
 *   · con dos, sólo se ofrecen las habilitadas, nunca el enum completo.
 *
 * La interacción (persistir la elección, escuchar el modal) vive en las
 * funciones puras de `lib/currency-preference.ts`, que sí se pueden probar de
 * punta a punta sin jsdom.
 */
function render(enabled: ("ARS" | "USD")[], value: "ARS" | "USD" = enabled[0]) {
  return renderToStaticMarkup(
    <CurrencySelector
      enabledCurrencies={enabled}
      value={value}
      onChange={() => {}}
    />,
  );
}

describe("CurrencySelector", () => {
  it("con una sola moneda habilitada no se muestra", () => {
    expect(render(["ARS"])).toBe("");
    expect(render(["USD"])).toBe("");
  });

  it("con dos monedas muestra el control y las dos opciones", () => {
    const html = render(["ARS", "USD"], "ARS");

    expect(html).toContain("<select");
    expect(html).toContain("Pesos (ARS)");
    expect(html).toContain("Dólares (USD)");
    expect(html).toContain('aria-label="Moneda de trabajo"');
  });
});
