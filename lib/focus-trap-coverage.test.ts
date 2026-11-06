import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * El candado de ADOPCIÓN del trap.
 *
 * Los tests de `use-focus-trap.test.ts` prueban la lógica; este archivo impide
 * que un diálogo custom vuelva a declararse modal sin atrapar el foco (que es
 * justo el bug que la fase corrige). Corre en Node leyendo el código: el
 * comportamiento real se mide en el navegador, modal por modal.
 */
const RAIZ = resolve(import.meta.dirname, "..");

const DIALOGOS = [
  "AccountForm",
  "CardConfigForm",
  "CardPlanForm",
  "CommandPalette",
  "CsvImportModal",
  "CurrencySettingsModal",
  "LoanForm",
  "TransactionForm",
];

function leerComponente(nombre: string): string {
  return readFileSync(resolve(RAIZ, "components", nombre + ".tsx"), "utf8");
}

/** Un comentario puede nombrar `confirm()` sin llamarlo: se descarta. */
function sinComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("todos los diálogos custom usan el trap compartido", () => {
  for (const nombre of DIALOGOS) {
    it(nombre + " importa y ejecuta useFocusTrap", () => {
      const texto = leerComponente(nombre);
      expect(texto).toContain('from "@/lib/use-focus-trap"');
      expect(texto).toMatch(/useFocusTrap\s*[<(]/);
      // El ref tiene que viajar al contenedor que declara el diálogo: sin
      // `ref={...}` el hook no tiene a quién atrapar.
      expect(texto).toMatch(/ref=\{\w+\}/);
    });

    it(nombre + " sigue declarando el diálogo modal", () => {
      const texto = leerComponente(nombre);
      expect(texto).toContain('role="dialog"');
      expect(texto).toContain('aria-modal="true"');
    });
  }
});

describe("BudgetsSection confirma en la UI, no con el diálogo nativo", () => {
  const texto = leerComponente("BudgetsSection");

  it("no llama a window.confirm / confirm()", () => {
    expect(sinComentarios(texto)).not.toMatch(/\bconfirm\s*\(/);
  });

  it("usa la máquina de estados de dos pasos", () => {
    expect(texto).toContain('from "@/lib/budget-delete"');
    expect(texto).toContain("requestBudgetDeletion(");
    expect(texto).toContain("cancelBudgetDeletion(");
    expect(texto).toContain("isBudgetDeletionConfirmed(");
  });
});
