import { describe, expect, it } from "vitest";
import {
  filterPaletteItems,
  isPaletteShortcut,
  movePaletteIndex,
  normalizePaletteText,
  type PaletteItem,
} from "./command-palette";

const ITEMS: PaletteItem[] = [
  { id: "expense", label: "Nuevo gasto", hint: "Gasto", group: "Acciones" },
  { id: "income", label: "Nuevo ingreso", hint: "Ingreso", group: "Acciones" },
  {
    id: "transfer",
    label: "Nueva transferencia",
    hint: "Transferencia",
    group: "Acciones",
  },
  { id: "analysis", label: "Ir a Análisis", group: "Pantallas" },
  {
    id: "fav-cafe",
    label: "Café con leche",
    hint: "Gasto · Banco",
    group: "Plantillas",
    keywords: "comida cafeteria",
  },
  {
    id: "fav-archived",
    label: "Alquiler viejo",
    hint: "Gasto · Cuenta archivada",
    group: "Plantillas",
    disabled: true,
  },
];

describe("normalizePaletteText", () => {
  it("ignora acentos, mayúsculas y espacios de más", () => {
    expect(normalizePaletteText("  CAFÉ   con Leche ")).toBe("cafe con leche");
  });
});

describe("filterPaletteItems", () => {
  it("sin búsqueda conserva el orden y respeta el límite", () => {
    expect(filterPaletteItems(ITEMS, "", 3).map((item) => item.id)).toEqual([
      "expense",
      "income",
      "transfer",
    ]);
  });

  it("prioriza prefijo de label sobre coincidencia en keywords", () => {
    expect(filterPaletteItems(ITEMS, "caf").map((item) => item.id)).toEqual([
      "fav-cafe",
    ]);
    expect(filterPaletteItems(ITEMS, "gas").map((item) => item.id)[0]).toBe(
      "expense",
    );
  });

  it("encuentra por palabra interna y por acentos", () => {
    expect(filterPaletteItems(ITEMS, "análisis").map((item) => item.id)).toEqual([
      "analysis",
    ]);
    expect(filterPaletteItems(ITEMS, "leche").map((item) => item.id)).toEqual([
      "fav-cafe",
    ]);
  });

  it("encuentra por keywords aunque el label no coincida", () => {
    expect(filterPaletteItems(ITEMS, "cafeteria").map((item) => item.id)).toEqual([
      "fav-cafe",
    ]);
  });

  it("incluye elementos deshabilitados para poder explicarlos", () => {
    const result = filterPaletteItems(ITEMS, "alquiler");
    expect(result).toHaveLength(1);
    expect(result[0].disabled).toBe(true);
  });

  it("devuelve vacío si nada coincide", () => {
    expect(filterPaletteItems(ITEMS, "zzzz")).toEqual([]);
  });
});

describe("movePaletteIndex", () => {
  it("baja y sube con wrap-around", () => {
    expect(movePaletteIndex(0, 1, 3)).toBe(1);
    expect(movePaletteIndex(2, 1, 3)).toBe(0);
    expect(movePaletteIndex(0, -1, 3)).toBe(2);
  });

  it("con lista vacía devuelve -1", () => {
    expect(movePaletteIndex(0, 1, 0)).toBe(-1);
  });

  it("sin selección, baja al primero y sube al último", () => {
    expect(movePaletteIndex(-1, 1, 3)).toBe(0);
    expect(movePaletteIndex(-1, -1, 3)).toBe(2);
  });
});

describe("isPaletteShortcut", () => {
  const base = {
    key: "k",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
  };

  it("acepta Ctrl+K y Cmd+K", () => {
    expect(isPaletteShortcut({ ...base, ctrlKey: true })).toBe(true);
    expect(isPaletteShortcut({ ...base, metaKey: true, key: "K" })).toBe(true);
  });

  it("no dispara escribiendo k sola ni con otros modificadores", () => {
    expect(isPaletteShortcut(base)).toBe(false);
    expect(isPaletteShortcut({ ...base, ctrlKey: true, altKey: true })).toBe(false);
    expect(isPaletteShortcut({ ...base, ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isPaletteShortcut({ ...base, ctrlKey: true, key: "j" })).toBe(false);
  });

  it("no dispara durante la composición de un IME", () => {
    expect(
      isPaletteShortcut({ ...base, ctrlKey: true, isComposing: true }),
    ).toBe(false);
  });
});
