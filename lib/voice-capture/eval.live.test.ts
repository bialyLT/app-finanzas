import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateCase,
  formatReport,
  summarize,
  thresholdViolations,
  type CaseOutcome,
  type DatasetCase,
} from "./eval-metrics";
import { GeminiProvider } from "./provider";
import { resolveBatch, type ResolveContext } from "./resolve";

/**
 * Runner de evaluación en vivo (Fase 6 · T6.2 y T6.3).
 *
 * Corre el dataset rioplatense contra el proveedor real, pasando por el mismo
 * `buildPrompt` y el mismo `resolveBatch` que usa la aplicación. No reimplementa
 * nada: si el prompt cambia, la evaluación cambia con él.
 *
 * Se saltea solo cuando no hay API key o cuando no se pidió explícitamente
 * (`npm run eval:parse`). Así `npm test` nunca hace llamadas de red.
 */

const dataset = JSON.parse(
  readFileSync(resolve(__dirname, "dataset.json"), "utf-8"),
) as DatasetCase[];

const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Argentina/Cordoba",
}).format(new Date());

const context: ResolveContext = {
  today,
  currencies: ["ARS"],
  accounts: [
    { id: "acc-1", name: "Galicia", kind: "BANK", currency: "ARS" },
    { id: "acc-2", name: "Efectivo", kind: "CASH", currency: "ARS" },
    { id: "acc-3", name: "Mercado Pago", kind: "BANK", currency: "ARS" },
    { id: "acc-4", name: "BBVA", kind: "BANK", currency: "ARS" },
    { id: "acc-5", name: "Santander", kind: "BANK", currency: "ARS" },
    { id: "acc-6", name: "Macro", kind: "BANK", currency: "ARS" },
    { id: "acc-7", name: "Visa Galicia", kind: "CREDIT_CARD", currency: "ARS" },
    { id: "acc-8", name: "Visa", kind: "CREDIT_CARD", currency: "ARS" },
    { id: "acc-9", name: "Prestamo Banco", kind: "LOAN", currency: "ARS" },
    { id: "acc-10", name: "Banco", kind: "BANK", currency: "ARS" },
  ],
  categories: [
    { id: "cat-1", name: "Supermercado", kind: "EXPENSE" },
    { id: "cat-2", name: "Sueldo", kind: "INCOME" },
    { id: "cat-3", name: "Servicios e Impuestos", kind: "EXPENSE" },
    { id: "cat-4", name: "Vehiculo", kind: "EXPENSE" },
    { id: "cat-5", name: "Salidas y Ocio", kind: "EXPENSE" },
  ],
};

const enabled =
  process.env.EVAL_LIVE === "1" && Boolean(process.env.GEMINI_API_KEY?.trim());

describe.skipIf(!enabled)("voice-capture / evaluación en vivo del motor", () => {
  it(
    "cumple los umbrales del plan contra el dataset rioplatense",
    async () => {
      const provider = new GeminiProvider();
      const outcomes: CaseOutcome[] = [];

      for (const item of dataset) {
        try {
          const raw = await provider.parseMovements({
            text: item.input,
            today,
            currencies: ["ARS"],
            accounts: context.accounts.map(({ name, kind }) => ({ name, kind })),
            categories: context.categories.map(({ name, kind }) => ({ name, kind })),
          });

          outcomes.push(evaluateCase(item, resolveBatch(raw, context), context));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Error desconocido del proveedor";

          outcomes.push(
            evaluateCase(item, { movements: [], unparsedText: message }, context, message),
          );
        }
      }

      const summary = summarize(outcomes);

      console.log(formatReport(outcomes, summary));

      expect(thresholdViolations(summary)).toEqual([]);
    },
    900_000,
  );
});
