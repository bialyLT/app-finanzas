import { describe, expect, it } from "vitest";
import {
  filterFocusable,
  isFocusable,
  nextFocusIndex,
  type FocusCandidate,
} from "@/lib/use-focus-trap";

/**
 * El candado del trap de foco (accesibilidad).
 *
 * Sólo cubre la LÓGICA: qué es enfocable y a qué índice se mueve el `Tab`.
 * Que el foco ciclado aterrice de verdad en cada diálogo se mide en el
 * navegador (el trap toca el documento y este proyecto testea en Node).
 */

function candidate(overrides: Partial<FocusCandidate> = {}): FocusCandidate {
  return { tabIndex: 0, ...overrides };
}

describe("isFocusable", () => {
  it("acepta un control normal", () => {
    expect(isFocusable(candidate())).toBe(true);
  });

  it("rechaza oculto, deshabilitado, tabindex -1 e invisible", () => {
    expect(isFocusable(candidate({ hidden: true }))).toBe(false);
    expect(isFocusable(candidate({ disabled: true }))).toBe(false);
    expect(isFocusable(candidate({ tabIndex: -1 }))).toBe(false);
    expect(isFocusable(candidate({ visible: false }))).toBe(false);
  });

  it("un elemento sin dato de visibilidad cuenta como visible", () => {
    // El hook sólo marca `visible: false` cuando el navegador lo confirma:
    // un descriptor parcial no puede sacar del ciclo a un control real.
    expect(isFocusable(candidate({ visible: undefined }))).toBe(true);
  });
});

describe("filterFocusable", () => {
  it("conserva el orden del documento y descarta sólo lo no enfocable", () => {
    const first = candidate();
    const hidden = candidate({ hidden: true });
    const disabled = candidate({ disabled: true });
    const second = candidate({ tabIndex: 0 });
    const negative = candidate({ tabIndex: -1 });
    const third = candidate({ tabIndex: 0 });

    expect(
      filterFocusable([first, hidden, disabled, second, negative, third]),
    ).toEqual([first, second, third]);
  });

  it("una lista sin enfocables queda vacía (el trap conserva el foco)", () => {
    expect(
      filterFocusable([candidate({ hidden: true }), candidate({ tabIndex: -1 })]),
    ).toEqual([]);
  });
});

describe("nextFocusIndex", () => {
  it("avanza dentro de la lista", () => {
    expect(nextFocusIndex(0, 4, false)).toBe(1);
    expect(nextFocusIndex(2, 4, false)).toBe(3);
  });

  it("retrocede con Shift", () => {
    expect(nextFocusIndex(3, 4, true)).toBe(2);
    expect(nextFocusIndex(1, 4, true)).toBe(0);
  });

  it("envuelve en los dos extremos", () => {
    expect(nextFocusIndex(3, 4, false)).toBe(0);
    expect(nextFocusIndex(0, 4, true)).toBe(3);
  });

  it("con un solo enfocable se queda en él", () => {
    expect(nextFocusIndex(0, 1, false)).toBe(0);
    expect(nextFocusIndex(0, 1, true)).toBe(0);
  });

  it("si el foco no está en la lista entra por el extremo que corresponde", () => {
    expect(nextFocusIndex(-1, 3, false)).toBe(0);
    expect(nextFocusIndex(-1, 3, true)).toBe(2);
  });

  it("un índice fuera de rango se trata como foco fuera de la lista", () => {
    expect(nextFocusIndex(9, 3, false)).toBe(0);
    expect(nextFocusIndex(9, 3, true)).toBe(2);
  });

  it("sin enfocables devuelve -1", () => {
    expect(nextFocusIndex(0, 0, false)).toBe(-1);
    expect(nextFocusIndex(-1, 0, true)).toBe(-1);
  });
});
