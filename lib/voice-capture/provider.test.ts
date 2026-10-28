import { describe, expect, it, vi } from "vitest";
import {
  GeminiProvider,
  MockProvider,
  type ParseInput,
} from "./provider";

const sampleInput: ParseInput = {
  text: "gasté 4500 en el súper con la Galicia",
  today: "2026-10-22",
  accounts: [{ name: "Galicia", kind: "BANK" }],
  categories: [{ name: "Supermercado", kind: "EXPENSE" }],
};

describe("voice-capture / AiProvider", () => {
  describe("MockProvider", () => {
    it("devuelve la respuesta configurada", async () => {
      const mockResult = {
        movements: [
          {
            kind: "EXPENSE",
            amount: 4500,
            date: "2026-10-22",
            description: "Supermercado",
            categoryName: "Supermercado",
            accountName: "Galicia",
            fromAccountName: null,
            toAccountName: null,
            installments: null,
            sourceText: "gasté 4500 en el súper con la Galicia",
            clarifications: [],
          },
        ],
        unparsedText: null,
      };

      const provider = new MockProvider(mockResult);
      const res = await provider.parseMovements(sampleInput);
      expect(res).toEqual(mockResult);
    });

    it("permite actualizar o mockear una función dinámica", async () => {
      const provider = new MockProvider((input) => ({
        movements: [],
        unparsedText: input.text,
      }));

      const res = (await provider.parseMovements(sampleInput)) as {
        unparsedText: string;
      };
      expect(res.unparsedText).toBe("gasté 4500 en el súper con la Galicia");
    });
  });

  describe("GeminiProvider", () => {
    it("falla si la API key no está configurada", async () => {
      const provider = new GeminiProvider({ apiKey: "" });
      await expect(provider.parseMovements(sampleInput)).rejects.toThrow(
        /GEMINI_API_KEY no está configurada/,
      );
    });

    it("realiza la llamada HTTP a Gemini con responseMimeType json", async () => {
      const mockResponseData = {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    movements: [
                      {
                        kind: "EXPENSE",
                        amount: 4500,
                        date: "2026-10-22",
                        description: "Supermercado",
                        categoryName: "Supermercado",
                        accountName: "Galicia",
                        fromAccountName: null,
                        toAccountName: null,
                        installments: null,
                        sourceText: "gasté 4500 en el súper con la Galicia",
                        clarifications: [],
                      },
                    ],
                    unparsedText: null,
                  }),
                },
              ],
            },
          },
        ],
      };

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockResponseData,
      });

      const provider = new GeminiProvider({
        apiKey: "test-secret-key",
        model: "gemini-2.5-flash",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      const result = (await provider.parseMovements(sampleInput)) as {
        movements: Array<{ amount: number }>;
      };
      expect(result.movements[0].amount).toBe(4500);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain("gemini-2.5-flash:generateContent?key=test-secret-key");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body.generationConfig.responseMimeType).toBe("application/json");
    });

    it("reintenta ante error 5xx transitorio y tiene éxito en el segundo intento", async () => {
      const mockResponseData = {
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify({ movements: [], unparsedText: null }) }],
            },
          },
        ],
      };

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
          json: async () => ({ error: "Temporary overload" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => mockResponseData,
        });

      const provider = new GeminiProvider({
        apiKey: "test-key",
        fetchFn: fetchMock as unknown as typeof fetch,
        retryDelayMs: 1, // rápido para tests
      });

      const res = await provider.parseMovements(sampleInput);
      expect(res).toEqual({ movements: [], unparsedText: null });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("nunca filtra la API key en el mensaje de error", async () => {
      const secretKey = "super-secret-xyz123";
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: async () => ({ error: { message: "Invalid payload format" } }),
      });

      const provider = new GeminiProvider({
        apiKey: secretKey,
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      let caughtError: Error | null = null;
      try {
        await provider.parseMovements(sampleInput);
      } catch (err: unknown) {
        caughtError = err as Error;
      }
      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtError?.message).not.toContain(secretKey);
    });
  });
});
