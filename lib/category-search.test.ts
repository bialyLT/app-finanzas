/**
 * Tests de la búsqueda de categorías de la carga rápida.
 *
 * Lo que se verifica acá es lo que el usuario VE al escribir: qué categorías
 * aparecen, en qué orden, y con qué aviso ("se usa la existente" / "se crea
 * una nueva"). Son las tres decisiones que, de otro modo, sólo se podrían
 * comprobar a ojo abriendo el navegador.
 */

import { describe, expect, it } from "vitest";
import { findCategoryByName, searchCategories } from "./category-search";
import type { CategoryDTO, CategoryKindDTO } from "./finance";

/** Una categoría de prueba; los campos que no importan acá usan defaults. */
function cat(
  name: string,
  lastUsedAt: string | null = null,
  kind: CategoryKindDTO = "EXPENSE",
): CategoryDTO {
  return { id: `id-${name}`, name, kind, lastUsedAt };
}

const names = (categories: CategoryDTO[]) => categories.map((c) => c.name);

describe("searchCategories · qué matchea (fuzzy)", () => {
  it("ignora mayúsculas, acentos y espacios de más", () => {
    const categories = [cat("Café"), cat("Transporte")];

    // Las tres formas de escribir "cafe" encuentran "Café": la comparación es
    // por nombre normalizado, la misma que usa el servidor para deduplicar.
    expect(names(searchCategories(categories, "cafe"))).toEqual(["Café"]);
    expect(names(searchCategories(categories, "CAFE"))).toEqual(["Café"]);
    expect(names(searchCategories(categories, "  CAFÉ  "))).toEqual(["Café"]);
  });

  it("matchea el nombre normalizado aunque la categoría tenga la tilde", () => {
    const categories = [cat("Educación")];
    // La tilde va en la CATEGORÍA y la query no la lleva: tiene que matchear.
    expect(names(searchCategories(categories, "educacion"))).toEqual([
      "Educación",
    ]);
  });

  it("sin coincidencias devuelve la lista vacía", () => {
    expect(searchCategories([cat("Comida")], "zzz")).toEqual([]);
  });
});

describe("searchCategories · el orden (prefijo → palabra → subcadena)", () => {
  it("lo que empieza con la query va antes que el resto, aunque el resto sea más reciente", () => {
    // "Consulado" fue la última usada (la recencia más fuerte), pero su match
    // es sólo una subcadena: primero van los matches por prefijo y por palabra.
    const categories = [
      cat("Consulado", "2026-10-17"),
      cat("Pago sueldo", "2026-10-16"),
      cat("Sueldo", "2026-09-01"),
    ];

    expect(names(searchCategories(categories, "su"))).toEqual([
      "Sueldo", // prefijo
      "Pago sueldo", // una palabra empieza con "su"
      "Consulado", // recién ahí, subcadena
    ]);
  });

  it("dentro del mismo score manda la recencia: la usada más nueva primero", () => {
    const categories = [
      cat("Café chico", "2026-09-01"),
      cat("Cafe grande", "2026-10-15"),
    ];

    expect(names(searchCategories(categories, "cafe"))).toEqual([
      "Cafe grande",
      "Café chico",
    ]);
  });

  it("una categoría nunca usada (`lastUsedAt: null`) va después de una usada", () => {
    const categories = [cat("Cena", null), cat("Cemento", "2026-01-01")];

    expect(names(searchCategories(categories, "ce"))).toEqual([
      "Cemento",
      "Cena",
    ]);
  });

  it("con recencia empatada desempata por nombre, para que el orden no cambie entre recargas", () => {
    const categories = [cat("Torta"), cat("Taller"), cat("Té")];

    expect(names(searchCategories(categories, "t"))).toEqual([
      "Taller",
      "Té",
      "Torta",
    ]);
  });
});

describe("searchCategories · sin query (recents primero)", () => {
  it("devuelve las últimas usadas y deja las nunca usadas al final", () => {
    const categories = [
      cat("Alquiler", "2026-10-01"),
      cat("Comida", "2026-10-15"),
      cat("Nueva", null),
      cat("Transporte", "2026-09-20"),
    ];

    expect(names(searchCategories(categories, ""))).toEqual([
      "Comida",
      "Alquiler",
      "Transporte",
      "Nueva",
    ]);
  });

  it("con la query en blanco se comporta igual que vacía", () => {
    const categories = [cat("Vieja", "2026-01-01"), cat("Nueva", "2026-10-01")];
    expect(names(searchCategories(categories, "   "))).toEqual([
      "Nueva",
      "Vieja",
    ]);
  });
});

describe("searchCategories · el tope de sugerencias", () => {
  it("corta en el límite (por defecto 6)", () => {
    const categories = Array.from({ length: 9 }, (_, i) =>
      cat(`Comida ${i}`),
    );

    const result = searchCategories(categories, "comida");
    expect(result).toHaveLength(6);
  });

  it("acepta un límite explícito", () => {
    const categories = Array.from({ length: 9 }, (_, i) =>
      cat(`Comida ${i}`),
    );

    expect(searchCategories(categories, "comida", 3)).toHaveLength(3);
  });
});

describe("findCategoryByName · el aviso de existente o nueva", () => {
  it("encuentra la categoría con el nombre normalizado", () => {
    const existing = cat("Café");
    expect(findCategoryByName([cat("Comida"), existing], "cafe")).toBe(existing);
  });

  it("no inventa coincidencias con nombres vacíos o espacios", () => {
    expect(findCategoryByName([cat("Comida")], "")).toBeNull();
    expect(findCategoryByName([cat("Comida")], "   ")).toBeNull();
  });

  it("devuelve null si no existe ninguna con ese nombre", () => {
    expect(findCategoryByName([cat("Comida")], "Kiosco")).toBeNull();
  });
});
