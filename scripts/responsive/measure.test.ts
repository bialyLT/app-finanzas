import { describe, expect, it } from "vitest";
import {
  INVISIBLE_HELPERS,
  measureExpression,
  deadTapsExpression,
} from "./measure.mjs";

/**
 * El auditor tiene que IGNORAR lo que no se puede ver ni tocar.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTOS TESTS EXISTEN
 * La auditoría contaba un `<select>` FANTASMA: Radix monta un espejo nativo
 * oculto (`aria-hidden="true"`, 1×1, recortado con `clip: rect(0, 0, 0, 0)`)
 * sólo para el envío de formularios. La regla de los 44 px lo inflaba a 44×44
 * y el auditor reportaba un target chico / tap muerto de un elemento que NO
 * está en pantalla ni recibe toques (medido por el tester: 0/25 puntos con
 * `elementFromPoint`).
 *
 * El criterio, entonces, no es «mide todo» sino «mide lo que el dedo puede
 * alcanzar». Un elemento invisible no puede ser un target chico (no hay target)
 * ni un tap muerto (no hay tap que dé).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CÓMO SE PRUEBA SIN NAVEGADOR
 * `INVISIBLE_HELPERS` es la MISMA fuente que corre dentro de Chrome (los dos
 * caminos —targets y taps— la inyectan, para que no puedan divergir). Acá se
 * evalúa contra un DOM mínimo: si la lógica de recorte/ocultamiento se
 * equivoca, estos tests se ponen rojos sin abrir un Chrome.
 */

type FakeElement = {
  nodeType: number;
  tagName: string;
  parentElement: FakeElement | null;
  attrs: Record<string, string>;
  style: Record<string, string>;
  rect: { width: number; height: number };
  getAttribute(name: string): string | null;
  closest(selector: string): FakeElement | null;
  getBoundingClientRect(): {
    width: number;
    height: number;
    top: number;
    left: number;
    right: number;
    bottom: number;
  };
};

function makeEl(options: {
  tag?: string;
  attrs?: Record<string, string>;
  style?: Record<string, string>;
  width?: number;
  height?: number;
  parent?: FakeElement | null;
} = {}): FakeElement {
  const node: FakeElement = {
    nodeType: 1,
    tagName: (options.tag ?? "button").toUpperCase(),
    parentElement: options.parent ?? null,
    attrs: options.attrs ?? {},
    style: options.style ?? {},
    rect: { width: options.width ?? 44, height: options.height ?? 44 },
    getAttribute(name: string) {
      return name in node.attrs ? node.attrs[name] : null;
    },
    closest(selector: string) {
      // Sólo lo que usan los helpers: `[aria-hidden="true"]` y `[hidden]`.
      let actual: FakeElement | null = node;
      while (actual) {
        if (selector === '[aria-hidden="true"]' && actual.attrs["aria-hidden"] === "true") {
          return actual;
        }
        if (selector === "[hidden]" && actual.attrs.hidden !== undefined) {
          return actual;
        }
        actual = actual.parentElement;
      }
      return null;
    },
    getBoundingClientRect() {
      return {
        width: node.rect.width,
        height: node.rect.height,
        top: 0,
        left: 0,
        right: node.rect.width,
        bottom: node.rect.height,
      };
    },
  };
  return node;
}

/** Corre `invisibleReason` sobre un elemento falso y devuelve su veredicto. */
function razon(el: FakeElement): string | null {
  const getComputedStyle = (node: FakeElement) => ({
    display: "block",
    visibility: "visible",
    clip: "auto",
    clipPath: "none",
    ...node.style,
  });
  const fn = new Function(
    "el",
    "getComputedStyle",
    `${INVISIBLE_HELPERS}
    return invisibleReason(el);`,
  );
  return fn(el, getComputedStyle) as string | null;
}

describe("invisibleReason — lo que no se ve ni se toca", () => {
  it("un control visible y medible NO se excluye", () => {
    expect(razon(makeEl({ width: 44, height: 44 }))).toBeNull();
  });

  it("excluye el espejo oculto de Radix: aria-hidden en el propio elemento", () => {
    const espejo = makeEl({
      tag: "select",
      attrs: { "aria-hidden": "true" },
      width: 1,
      height: 1,
      style: { clip: "rect(0px, 0px, 0px, 0px)" },
    });
    expect(razon(espejo)).toBe("aria-hidden");
  });

  it("excluye un control dentro de un contenedor aria-hidden", () => {
    const contenedor = makeEl({ tag: "div", attrs: { "aria-hidden": "true" } });
    const boton = makeEl({ width: 30, height: 30, parent: contenedor });
    expect(razon(boton)).toBe("aria-hidden");
  });

  it("excluye el atributo `hidden`", () => {
    const panel = makeEl({ tag: "div", attrs: { hidden: "" } });
    expect(razon(makeEl({ width: 30, height: 30, parent: panel }))).toBe("hidden");
    expect(razon(makeEl({ attrs: { hidden: "" } }))).toBe("hidden");
  });

  it("excluye `display: none`", () => {
    expect(razon(makeEl({ style: { display: "none" } }))).toBe("display-none");
  });

  it("excluye `visibility: hidden` (también en un ancestro)", () => {
    expect(razon(makeEl({ style: { visibility: "hidden" } }))).toBe("visibility-hidden");
    const padre = makeEl({ tag: "div", style: { visibility: "hidden" } });
    expect(razon(makeEl({ width: 30, height: 30, parent: padre }))).toBe(
      "visibility-hidden",
    );
  });

  it("excluye tamaño 0", () => {
    expect(razon(makeEl({ width: 0, height: 0 }))).toBe("sin-area");
    expect(razon(makeEl({ width: 30, height: 0 }))).toBe("sin-area");
  });

  it("excluye lo recortado sin área con `clip`", () => {
    expect(razon(makeEl({ style: { clip: "rect(0px, 0px, 0px, 0px)" } }))).toBe("clip");
    // Un recorte CON área no oculta nada: el control mide lo que se ve.
    expect(razon(makeEl({ style: { clip: "rect(0px, 44px, 44px, 0px)" } }))).toBeNull();
  });

  it("excluye lo recortado sin área con `clip-path`", () => {
    expect(razon(makeEl({ style: { clipPath: "inset(50%)" } }))).toBe("clip-path");
    expect(razon(makeEl({ style: { clipPath: "circle(0px)" } }))).toBe("clip-path");
    expect(razon(makeEl({ style: { clipPath: "inset(0px)" } }))).toBeNull();
  });

  it("un control CHICO pero visible NO se oculta: 1×1 sin recorte es un bug real", () => {
    expect(razon(makeEl({ width: 1, height: 1 }))).toBeNull();
  });
});

describe("las dos comprobaciones usan la MISMA definición", () => {
  it("la medición de targets inyecta el filtro y lo aplica antes de contar", () => {
    const expr = measureExpression({ deviceWidth: 320, scopeSelector: null, minTarget: 44 });
    expect(expr).toContain("invisibleReason(el)");
    // No basta con definirla: tiene que cortar el circuito ANTES del push.
    const antesDelPush = expr.slice(
      expr.indexOf("if (invisibleReason(el))") >= 0
        ? expr.indexOf("if (invisibleReason(el))")
        : expr.indexOf("const invisible = invisibleReason(el)"),
      expr.indexOf("out.smallTargets.push"),
    );
    expect(antesDelPush.length).toBeGreaterThan(0);
    expect(antesDelPush).toContain("continue");
  });

  it("la prueba de taps muertos inyecta el mismo filtro", () => {
    const expr = deadTapsExpression({ scopeSelector: null });
    expect(expr).toContain("invisibleReason(el)");
    expect(expr).toContain(INVISIBLE_HELPERS.trim().slice(0, 40));
  });
});
