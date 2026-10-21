/**
 * Tests del invariante "la categoría tiene que ser del mismo tipo que el
 * movimiento".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTE MÓDULO TIENE SU PROPIO ARCHIVO DE TESTS
 *
 * El mensaje es la parte que la persona lee, y se arma en UN solo lugar para
 * que la API, el generador y el formulario digan lo mismo. Si mañana se
 * cambia la redacción, el test avisa: no es un detalle, es el contrato entre
 * las tres capas.
 *
 * La otra mitad del invariante (que la BASE lo haga cumplir) vive en
 * `lib/db.integration.test.ts`, que intenta guardar el dato imposible de
 * verdad.
 */

import { describe, expect, it } from "vitest";
import {
  CATEGORY_KIND_LABEL,
  MOVEMENT_KIND_LABEL,
  CategoryKindError,
  categoryKindConflicts,
  categoryKindMessage,
} from "./category-kind";

describe("categoryKindConflicts · cuándo hay contradicción", () => {
  it("un ingreso con una categoría de ingreso es válido", () => {
    expect(categoryKindConflicts("INCOME", "INCOME")).toBe(false);
  });

  it("un gasto con una categoría de gasto es válido", () => {
    expect(categoryKindConflicts("EXPENSE", "EXPENSE")).toBe(false);
  });

  it("un ingreso con una categoría de GASTO es la contradicción", () => {
    expect(categoryKindConflicts("INCOME", "EXPENSE")).toBe(true);
  });

  it("y al revés también", () => {
    expect(categoryKindConflicts("EXPENSE", "INCOME")).toBe(true);
  });

  it("una transferencia nunca contradice: no se categoriza", () => {
    expect(categoryKindConflicts("TRANSFER", "INCOME")).toBe(false);
    expect(categoryKindConflicts("TRANSFER", "EXPENSE")).toBe(false);
  });
});

describe("categoryKindMessage · lo que lee la persona", () => {
  it("dice qué se pidió, qué se encontró y qué hacer", () => {
    const mensaje = categoryKindMessage("Alquiler", "INCOME", "EXPENSE");

    expect(mensaje).toContain("Alquiler");
    expect(mensaje).toContain("Gasto");
    expect(mensaje).toContain("Ingreso");
    expect(mensaje).toContain("Usá una categoría de tipo Ingreso");
  });

  it("el tipo del movimiento va en minúscula dentro de la frase", () => {
    // "un Ingreso" no se escribe así: la palabra va en minúscula cuando
    // acompaña al sustantivo ("un ingreso"), y con mayúscula cuando ES el
    // nombre del tipo ("una categoría de tipo Ingreso").
    const mensaje = categoryKindMessage("Alquiler", "INCOME", "EXPENSE");

    expect(mensaje).toContain("un ingreso");
    expect(mensaje).not.toContain("un Ingreso");
  });

  it("usa el nombre de la categoría como lo tiene la base", () => {
    expect(categoryKindMessage("Kiosco", "EXPENSE", "INCOME")).toContain(
      "«Kiosco»",
    );
  });

  it("no rompe con una categoría sin nombre", () => {
    expect(categoryKindMessage("   ", "INCOME", "EXPENSE")).toContain(
      "la categoría",
    );
  });
});

describe("las etiquetas", () => {
  it("son las que la persona ve", () => {
    expect(CATEGORY_KIND_LABEL.INCOME).toBe("Ingreso");
    expect(CATEGORY_KIND_LABEL.EXPENSE).toBe("Gasto");
    expect(MOVEMENT_KIND_LABEL.TRANSFER).toBe("Transferencia");
  });
});

describe("CategoryKindError", () => {
  it("corta la transacción y lleva el status", () => {
    const error = new CategoryKindError(400, "No se puede");

    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(400);
    expect(error.message).toBe("No se puede");
    expect(error.name).toBe("CategoryKindError");
  });
});
