import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * El candado de los estados vacíos (F3b).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ UN TEST DE TEXTO Y NO DE RENDER
 * Las vistas son `"use client"` con fetch propio: renderizarlas vacías exigiría
 * un DOM y un servidor. Lo que esta fase promete es más simple y verificable en
 * el código: que los SIETE estados vacíos que estaban duplicados usen la MISMA
 * primitiva (`EmptyState`) y que sus textos sigan siendo los del producto (los
 * flows de Maestro los buscan por texto). Si alguien vuelve a copiar el markup
 * ad-hoc, el `title=` desaparece del `<EmptyState>` y este test falla.
 */
const RAIZ = resolve(import.meta.dirname, "..");

/** Vista → textos que tienen que vivir dentro de `title=` de `EmptyState`. */
const ESTADOS_VACIOS: Record<string, string[]> = {
  "app/page.tsx": [
    "Sin movimientos este mes",
    "Sin movimientos con esos filtros",
  ],
  "app/analisis/page.tsx": [
    "No hay gastos con esos filtros",
    "No hay gastos en este período",
  ],
  "components/BudgetsSection.tsx": [
    "No hay presupuestos fijados para este mes",
    "Todavía no hay categorías de gasto",
  ],
  "app/tarjetas/page.tsx": [
    "No hay tarjetas de crédito cargadas",
    "Todavía no hay resúmenes emitidos",
    "Sin compras en cuotas",
    "Sin cuotas comprometidas todavía",
  ],
  "app/prestamos/page.tsx": [
    "No tenés préstamos que debas cargados",
    "No tenés préstamos que te deban cargados",
  ],
  "app/recurrencia/page.tsx": [
    "No hay nada pendiente",
    "No hay reglas todavía",
  ],
};

describe("EmptyState es la única forma de decir «no hay nada»", () => {
  for (const [archivo, titulos] of Object.entries(ESTADOS_VACIOS)) {
    it(`${archivo} usa la primitiva y conserva sus textos`, () => {
      const texto = readFileSync(resolve(RAIZ, archivo), "utf8");

      // La importación y el uso de la primitiva.
      expect(texto).toContain('from "@/components/ui/empty-state"');
      expect(texto).toContain("<EmptyState");

      for (const titulo of titulos) {
        // El texto tiene que ser el `title` de un `EmptyState`: si quedó el
        // markup ad-hoc, no hay `title="..."` (y el flujo lo busca igual).
        expect(texto, `${archivo}: falta el estado vacío «${titulo}»`).toContain(
          `title="${titulo}"`,
        );
      }
    });
  }

  it("la primitiva expone un data-slot estable y no usa emoji", () => {
    const primitiva = readFileSync(
      resolve(RAIZ, "components/ui/empty-state.tsx"),
      "utf8",
    );
    expect(primitiva).toContain('data-slot="empty-state"');
    // `aria-hidden` en el icono: el título ya dice qué es.
    expect(primitiva).toContain("aria-hidden");
    // Cero emoji en el código fuente de la primitiva.
    expect(/\p{Extended_Pictographic}/u.test(primitiva)).toBe(false);
  });
});
