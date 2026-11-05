/**
 * Sondas del contrato de monedas del motor de voz (F4.5).
 *
 * Se corren con `vitest.f45.config.mts` y NO forman parte de `npm test`. Cada
 * `it` codifica una expectativa del brief; si falla, el mensaje es el hallazgo.
 */
import { describe, expect, it } from "vitest";
import { buildPrompt } from "../../lib/voice-capture/prompt";
import { resolveBatch, type ResolveContext } from "../../lib/voice-capture/resolve";
import type { ParseInput } from "../../lib/voice-capture/provider";

const context: ResolveContext = {
  today: "2026-10-22",
  currencies: ["ARS", "USD"],
  accounts: [
    { id: "acc-1", name: "Banco Galicia", kind: "BANK", currency: "ARS" },
    { id: "acc-2", name: "Efectivo", kind: "CASH", currency: "ARS" },
    { id: "acc-5", name: "Caja Dólares", kind: "CASH", currency: "USD" },
  ],
  categories: [],
};

function transfer(overrides: Record<string, unknown> = {}) {
  return {
    movements: [
      {
        kind: "TRANSFER",
        amount: 100000,
        date: "2026-10-22",
        description: "Compra de dólares",
        categoryName: null,
        accountName: null,
        fromAccountName: "Banco Galicia",
        toAccountName: "Caja Dólares",
        installments: null,
        currency: null,
        sourceText: "pasé 100 lucas de Galicia a la caja de dólares",
        clarifications: [],
        ...overrides,
      },
    ],
    unparsedText: null,
  };
}

describe("F4.5 · prioridad de las aclaraciones de moneda", () => {
  it("transferencia cruzada gana sobre 'distinta de la cuenta' (brief: cruzada > distinta)", () => {
    // El modelo declara la moneda de DESTINO. Las dos reglas aplican: la
    // moneda no coincide con la cuenta de origen (ARS) y la transferencia
    // cruza monedas. La más accionable es "cargala a mano" (falta toAmount).
    const resolved = resolveBatch(transfer({ currency: "USD" }), context);
    const clarifications = resolved.movements[0]!.clarifications.filter(
      (c) => c.field === "currency",
    );
    expect(clarifications).toHaveLength(1);
    expect(clarifications[0]?.reason).toContain("a mano");
  });

  it("moneda no habilitada gana sobre transferencia cruzada", () => {
    const resolved = resolveBatch(
      transfer({ currency: "EUR" }),
      context,
    );
    const clarifications = resolved.movements[0]!.clarifications.filter(
      (c) => c.field === "currency",
    );
    expect(clarifications).toHaveLength(1);
    expect(clarifications[0]?.reason).toContain("no está habilitada");
    expect(clarifications[0]?.options).toEqual(["ARS", "USD"]);
  });
});

describe("F4.5 · listas vacías", () => {
  it("una lista vacía de habilitadas no ofrece options vacías (dead-end)", () => {
    const resolved = resolveBatch(
      transfer({ currency: "ARS" }),
      { ...context, currencies: [] },
    );
    const clarif = resolved.movements[0]!.clarifications.find(
      (c) => c.field === "currency",
    );
    expect(clarif).toBeDefined();
    // `options: []` es una aclaración sin respuesta posible.
    expect(clarif?.options?.length ?? 1).toBeGreaterThan(0);
  });

  it("el prompt con lista vacía no arma una sección en blanco", () => {
    const input: ParseInput = {
      text: "gasté 1000",
      today: "2026-10-22",
      currencies: [],
      accounts: [],
      categories: [],
    };
    const prompt = buildPrompt(input);
    expect(prompt).toContain("(ninguna moneda habilitada)");
  });

  it("el prompt con una lista vacía no menciona USD ni dólares", () => {
    const input: ParseInput = {
      text: "gasté 1000",
      today: "2026-10-22",
      currencies: [],
      accounts: [],
      categories: [],
    };
    const prompt = buildPrompt(input);
    expect(prompt).not.toContain("USD");
    expect(prompt).not.toContain("dólares");
  });
});
