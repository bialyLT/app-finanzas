/**
 * El borde HTTP de la moneda: `?currency=` y su default.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ SE VERIFICA
 * ─────────────────────────────────────────────────────────────────────────────
 *   · `parseCurrencyParam` es la única traducción de URL → moneda: ausente =
 *     ARS (el comportamiento de siempre), válida = esa moneda, inválida = error
 *     (nunca un default silencioso).
 *   · `GET /api/accounts` responde 400 con una moneda desconocida, y pasa la
 *     moneda resuelta a las funciones que agregan plata (patrimonio y serie).
 *     Las consultas están mockeadas: acá se prueba el contrato del borde, no la
 *     base (eso vive en `db.integration.test.ts`).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURRENCIES,
  DEFAULT_CURRENCY,
  currencyNoun,
  isCrossCurrencyTransfer,
  isCurrency,
  parseCurrencyBody,
  parseCurrencyParam,
} from "./currency";
import { money } from "./money";
import * as dal from "@/lib/auth/dal";
import * as balance from "@/lib/balance";
import * as queries from "@/lib/queries";
import { GET } from "@/app/api/accounts/route";

vi.mock("@/lib/auth/dal", () => ({
  requireApiSession: vi.fn(),
  unauthorized: vi.fn(
    () =>
      new Response(JSON.stringify({ error: "No autorizado" }), { status: 401 }),
  ),
}));

vi.mock("@/lib/balance", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/balance")>("@/lib/balance");
  return { ...actual, getAccountBalances: vi.fn(), getNetWorth: vi.fn() };
});

vi.mock("@/lib/queries", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/queries")>("@/lib/queries");
  return { ...actual, getNetWorthSeries: vi.fn() };
});

describe("parseCurrencyParam", () => {
  it("sin parámetro devuelve ARS: el comportamiento de siempre", () => {
    expect(parseCurrencyParam(null)).toEqual({
      ok: true,
      currency: DEFAULT_CURRENCY,
    });
    expect(DEFAULT_CURRENCY).toBe("ARS");
  });

  it("acepta exactamente las monedas conocidas", () => {
    for (const currency of CURRENCIES) {
      expect(parseCurrencyParam(currency)).toEqual({ ok: true, currency });
      expect(isCurrency(currency)).toBe(true);
    }
  });

  it("rechaza una moneda desconocida en vez de caer a ARS", () => {
    const parsed = parseCurrencyParam("EUR");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("ARS o USD");
  });

  it("la comparación es exacta: minúsculas, espacios y vacío no son monedas", () => {
    for (const hostile of ["usd", "USD ", " usd", "", "ARS/USD", "0"]) {
      expect(parseCurrencyParam(hostile).ok).toBe(false);
    }
  });

  it("sólo acepta strings (la firma ya excluye arrays y números)", () => {
    expect(isCurrency(["USD"])).toBe(false);
    expect(isCurrency(1)).toBe(false);
    expect(isCurrency(null)).toBe(false);
    expect(isCurrency(undefined)).toBe(false);
  });
});

describe("isCrossCurrencyTransfer · cuándo hace falta el segundo monto (Fase 4.4)", () => {
  it("dos cuentas en la misma moneda NO piden el segundo monto", () => {
    expect(isCrossCurrencyTransfer("ARS", "ARS")).toBe(false);
    expect(isCrossCurrencyTransfer("USD", "USD")).toBe(false);
  });

  it("monedas distintas piden el segundo monto", () => {
    expect(isCrossCurrencyTransfer("ARS", "USD")).toBe(true);
    expect(isCrossCurrencyTransfer("USD", "ARS")).toBe(true);
  });

  it("sin las dos cuentas elegidas no hay condición que evaluar", () => {
    // `null !== null` da false, pero el caso importa: el formulario renderiza
    // antes de que existan las dos cuentas y no puede quedar pidiendo un monto
    // que la API después no acepta.
    expect(isCrossCurrencyTransfer(null, "USD")).toBe(false);
    expect(isCrossCurrencyTransfer("ARS", null)).toBe(false);
    expect(isCrossCurrencyTransfer(undefined, undefined)).toBe(false);
  });
});

describe("parseCurrencyBody · la moneda en el cuerpo de una cuenta (Fase 4.3)", () => {
  it("ausente, null o vacío es «no vino»: el default lo decide la ruta", () => {
    expect(parseCurrencyBody(undefined)).toBeNull();
    expect(parseCurrencyBody(null)).toBeNull();
    expect(parseCurrencyBody("")).toBeNull();
  });

  it("acepta sólo las monedas conocidas, sin tolerancias", () => {
    for (const currency of CURRENCIES) {
      expect(parseCurrencyBody(currency)).toBe(currency);
    }
    for (const hostile of ["EUR", "usd", "USD ", " usd", 3, true, ["USD"], {}]) {
      expect(parseCurrencyBody(hostile)).toBe("invalid");
    }
  });

  it("nombra la moneda para un mensaje: pesos y dólares", () => {
    expect(currencyNoun("ARS")).toBe("pesos");
    expect(currencyNoun("USD")).toBe("dólares");
  });
});

describe("errores de la base que hablan de monedas (Fase 4)", () => {  // Los marcadores son los que RAISE el trigger / nombran los CHECK de la
  // migración `20261104120000_fase4_monedas`. Sin este mapeo, el rechazo de la
  // base llega como un 500 genérico: la persona no sabe que el problema es la
  // moneda ni qué hacer.
  const cases = [
    {
      marker: "[finanzas:transferencia_entre_monedas_sin_monto_destino]",
      status: 400,
      message: /monedas distintas/i,
    },
    {
      marker: "[finanzas:monto_destino_en_misma_moneda]",
      status: 400,
      message: /misma moneda/i,
    },
    {
      marker: "[finanzas:cuenta_en_uso_no_cambia_moneda]",
      status: 409,
      message: /no se puede cambiar su moneda/i,
    },
    {
      marker: "movement_to_amount_positive",
      status: 400,
      message: /mayor a cero/i,
    },
    {
      marker: "movement_to_amount_only_on_transfer",
      status: 400,
      message: /sólo existe en una transferencia/i,
    },
  ];

  for (const item of cases) {
    it(`mapea ${item.marker} a ${item.status}`, () => {
      const described = queries.describeDatabaseError({
        message: `Error occurred during query execution: ${item.marker}`,
      });
      expect(described?.status).toBe(item.status);
      expect(described?.message).toMatch(item.message);
    });
  }

  it("un error ajeno sigue devolviendo null (no inventa un 400)", () => {
    expect(
      queries.describeDatabaseError({ message: "algo que nadie mapeó" }),
    ).toBeNull();
  });
});

describe("GET /api/accounts · ?currency=", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(dal.requireApiSession).mockResolvedValue({ v: 1, iat: 0, exp: 0 });
    vi.mocked(balance.getAccountBalances).mockResolvedValue([]);
    vi.mocked(balance.getNetWorth).mockResolvedValue({
      assets: money("0"),
      liabilities: money("0"),
      net: money("0"),
    });
    vi.mocked(queries.getNetWorthSeries).mockResolvedValue([]);
  });

  it("una moneda inválida es 400 y no consulta la base", async () => {
    const res = await GET(
      new Request("http://localhost:3000/api/accounts?currency=EUR"),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "`currency` tiene que ser una moneda válida: ARS o USD.",
    });
    expect(balance.getNetWorth).not.toHaveBeenCalled();
    expect(queries.getNetWorthSeries).not.toHaveBeenCalled();
  });

  it("?currency=USD llega a las consultas que agregan plata", async () => {
    const res = await GET(
      new Request(
        "http://localhost:3000/api/accounts?asOf=2026-10-31&currency=USD",
      ),
    );

    expect(res.status).toBe(200);
    expect(balance.getNetWorth).toHaveBeenCalledWith(expect.anything(), {
      asOf: "2026-10-31",
      currency: "USD",
    });
    expect(queries.getNetWorthSeries).toHaveBeenCalledWith(expect.anything(), {
      anchor: "2026-10-31",
      currency: "USD",
    });
  });

  it("sin parámetro la respuesta sigue siendo en ARS", async () => {
    const res = await GET(
      new Request("http://localhost:3000/api/accounts?asOf=2026-10-31"),
    );

    expect(res.status).toBe(200);
    expect(balance.getNetWorth).toHaveBeenCalledWith(expect.anything(), {
      asOf: "2026-10-31",
      currency: "ARS",
    });
    expect(queries.getNetWorthSeries).toHaveBeenCalledWith(expect.anything(), {
      anchor: "2026-10-31",
      currency: "ARS",
    });
  });
});
