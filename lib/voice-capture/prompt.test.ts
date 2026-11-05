import { describe, expect, it } from "vitest";
import { buildPrompt } from "./prompt";
import type { ParseInput } from "./provider";

describe("voice-capture / buildPrompt", () => {
  const baseInput: ParseInput = {
    text: "gasté 20 lucas en el súper con Galicia",
    today: "2026-10-22",
    currencies: ["ARS"],
    accounts: [
      { name: "Galicia", kind: "BANK" },
      { name: "Efectivo", kind: "CASH" },
      { name: "Visa Galicia", kind: "CREDIT_CARD" },
      { name: "Préstamo Banco", kind: "LOAN" },
    ],
    categories: [
      { name: "Supermercado", kind: "EXPENSE" },
      { name: "Sueldo", kind: "INCOME" },
    ],
  };

  it("incluye la fecha de hoy y zona horaria", () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toContain("2026-10-22");
    expect(prompt).toContain("Argentina");
  });

  it("incluye las cuentas disponibles con su tipo pero NUNCA saldos", () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toContain("Galicia (BANK)");
    expect(prompt).toContain("Efectivo (CASH)");
    expect(prompt).toContain("Visa Galicia (CREDIT_CARD)");
    expect(prompt).not.toContain("saldo");
    expect(prompt).not.toContain("balance");
  });

  it("incluye las categorías disponibles con su tipo", () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toContain("Supermercado [EXPENSE]");
    expect(prompt).toContain("Sueldo [INCOME]");
  });

  it("contiene las reglas de oro fundamentales (tarjeta, préstamo, transferencias)", () => {
    const prompt = buildPrompt(baseInput);
    // Compra con tarjeta es gasto en la tarjeta
    expect(prompt).toContain("CREDIT_CARD");
    // Pago de tarjeta es transferencia, nunca gasto
    expect(prompt).toContain("TRANSFER");
    // No inventar división de cuotas de préstamo
    expect(prompt).toContain("loanSplit");
    // Instrucción de no adivinar y preferir aclaraciones
    expect(prompt).toContain("clarifications");
  });

  it("incluye el glosario de jerga rioplatense de montos", () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toContain("lucas");
    expect(prompt).toContain("palos");
    expect(prompt).toContain("mangos");
  });

  it("declara sólo las monedas habilitadas y no menciona las apagadas", () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toContain("ARS");
    expect(prompt).toContain("pesos");
    expect(prompt).not.toContain("USD");
    expect(prompt).not.toContain("dólares");
  });

  it("declara las dos monedas cuando ambas están habilitadas", () => {
    const prompt = buildPrompt({ ...baseInput, currencies: ["ARS", "USD"] });
    expect(prompt).toContain("ARS");
    expect(prompt).toContain("USD");
    expect(prompt).toContain("pesos");
    expect(prompt).toContain("dólares");
  });

  it("no menciona una moneda fuera de la lista habilitada como opción", () => {
    const prompt = buildPrompt({ ...baseInput, currencies: ["USD"] });
    expect(prompt).toContain("USD");
    expect(prompt).not.toContain("ARS");
  });
});
