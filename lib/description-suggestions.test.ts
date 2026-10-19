import { describe, expect, it } from "vitest";
import {
  amountToCents,
  buildDescriptionSuggestions,
  centsToAmount,
  medianAmount,
  normalizeDescription,
  type SuggestionMovementLike,
} from "./description-suggestions";

function movement(
  overrides: Partial<SuggestionMovementLike> = {},
): SuggestionMovementLike {
  return {
    kind: "EXPENSE",
    amount: "1500.00",
    date: "2026-08-01",
    description: "Café con leche",
    account: { id: "bank", name: "Banco", archived: false },
    toAccount: null,
    category: { id: "comida", name: "Comida", kind: "EXPENSE" },
    ...overrides,
  };
}

describe("normalizeDescription", () => {
  it("ignora acentos, mayúsculas y espacios de más", () => {
    expect(normalizeDescription("  CAFÉ   con Leche ")).toBe("cafe con leche");
  });
});

describe("medianAmount", () => {
  it("con cantidad impar devuelve el valor del medio", () => {
    expect(medianAmount(["100.00", "300.00", "200.00"])).toBe("200.00");
  });

  it("con cantidad par promedia los dos del medio", () => {
    expect(medianAmount(["100.00", "200.00"])).toBe("150.00");
    expect(medianAmount(["100.00", "200.02"])).toBe("150.01");
  });

  it("redondea half-even al centavo", () => {
    // 100,00 y 200,01 → 150,005: half-even baja a 150,00 (150 es par).
    expect(medianAmount(["100.00", "200.01"])).toBe("150.00");
    // 100,01 y 200,02 → 150,015: half-even sube a 150,02 (150,02 es par).
    expect(medianAmount(["100.01", "200.02"])).toBe("150.02");
  });

  it("convierte centavos de ida y vuelta sin perder precisión", () => {
    expect(centsToAmount(amountToCents("123456789.99"))).toBe("123456789.99");
    expect(centsToAmount(amountToCents("0.05"))).toBe("0.05");
  });
});

describe("buildDescriptionSuggestions", () => {
  it("agrupa por descripción normalizada y muestra la variante más frecuente", () => {
    const result = buildDescriptionSuggestions(
      [
        movement({ description: "Café con leche", date: "2026-08-01" }),
        movement({ description: "cafe con leche", date: "2026-08-03" }),
        movement({ description: "Café con leche", date: "2026-08-04" }),
      ],
      "caf",
    );

    expect(result).toHaveLength(1);
    expect(result[0].frequency).toBe(3);
    expect(result[0].description).toBe("Café con leche");
    expect(result[0].amount).toBe("1500.00");
    expect(result[0].lastDate).toBe("2026-08-04");
    expect(result[0].account).toEqual({ id: "bank", name: "Banco" });
    expect(result[0].category).toEqual({ id: "comida", name: "Comida" });
  });

  it("ordena por match, después frecuencia y después recencia", () => {
    const result = buildDescriptionSuggestions(
      [
        movement({ description: "Súper", amount: "5000.00", date: "2026-08-10" }),
        movement({ description: "Súper chino", amount: "3000.00", date: "2026-08-05" }),
        movement({ description: "Súper chino", amount: "3100.00", date: "2026-08-07" }),
        movement({ description: "Taxi", amount: "900.00", date: "2026-08-11" }),
      ],
      "super",
    );

    expect(result.map((item) => item.description)).toEqual([
      "Súper chino",
      "Súper",
    ]);
  });

  it("prefiere la cuenta y la categoría más frecuentes", () => {
    const result = buildDescriptionSuggestions(
      [
        movement({ account: { id: "cash", name: "Efectivo", archived: false } }),
        movement({ account: { id: "cash", name: "Efectivo", archived: false } }),
        movement({ account: { id: "bank", name: "Banco", archived: false } }),
      ],
      "cafe",
    );

    expect(result[0].account.id).toBe("cash");
  });

  it("descarta cuentas archivadas y transferencias sin destino", () => {
    const result = buildDescriptionSuggestions(
      [
        movement({ account: { id: "old", name: "Vieja", archived: true } }),
        movement({
          kind: "TRANSFER",
          account: { id: "bank", name: "Banco", archived: false },
          toAccount: { id: "old2", name: "Vieja 2", archived: true },
          category: null,
        }),
      ],
      "",
    );

    expect(result).toEqual([]);
  });

  it("no mezcla categorías del tipo contrario", () => {
    const result = buildDescriptionSuggestions(
      [
        movement({ kind: "EXPENSE" }),
        movement({
          kind: "INCOME",
          amount: "2000.00",
          category: { id: "sueldo", name: "Sueldo", kind: "INCOME" },
        }),
      ],
      "cafe",
    );

    expect(result).toHaveLength(2);
    expect(result.find((item) => item.kind === "INCOME")?.category?.name).toBe(
      "Sueldo",
    );
  });

  it("respeta el límite pedido", () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      movement({ description: `Compra ${index}`, amount: `${100 + index}.00` }),
    );
    expect(buildDescriptionSuggestions(rows, "compra", 3)).toHaveLength(3);
  });

  it("con query vacía devuelve las más frecuentes/recientes", () => {
    const result = buildDescriptionSuggestions(
      [
        movement({ description: "Café", date: "2026-08-01" }),
        movement({ description: "Taxi", date: "2026-08-10" }),
        movement({ description: "Taxi", date: "2026-08-11" }),
      ],
      "",
    );

    expect(result[0].description).toBe("Taxi");
  });
});
