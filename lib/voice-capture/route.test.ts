import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/parse/route";
import * as csrfModule from "@/lib/auth/csrf";
import * as dalModule from "@/lib/auth/dal";
import { prisma } from "@/lib/prisma";
import { MockProvider, setAiProvider } from "./provider";
import { parseRateLimiter } from "./rate-limit";

vi.mock("@/lib/auth/dal", () => ({
  requireApiSession: vi.fn(),
  unauthorized: vi.fn(() => new Response(JSON.stringify({ error: "No autorizado" }), { status: 401 })),
}));

vi.mock("@/lib/auth/csrf", () => ({
  assertSameOrigin: vi.fn(() => null),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    account: {
      findMany: vi.fn().mockResolvedValue([
        { id: "acc-1", name: "Banco Galicia", kind: "BANK" },
        { id: "acc-2", name: "Efectivo", kind: "CASH" },
      ]),
    },
    category: {
      findMany: vi.fn().mockResolvedValue([
        { id: "cat-1", name: "Supermercado", kind: "EXPENSE" },
      ]),
    },
  },
}));

describe("POST /api/parse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseRateLimiter.reset();
    setAiProvider(null);
  });

  it("devuelve 401 si no hay sesión activa", async () => {
    vi.mocked(dalModule.requireApiSession).mockResolvedValue(false as any);

    const req = new Request("http://localhost:3000/api/parse", {
      method: "POST",
      body: JSON.stringify({ text: "100 en efectivo" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("devuelve 400 si no hay ni texto ni comprobante", async () => {
    vi.mocked(dalModule.requireApiSession).mockResolvedValue({ id: "user" } as any);

    const req = new Request("http://localhost:3000/api/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Tenés que enviar un texto o adjuntar un comprobante");
  });

  it("devuelve 200 con el lote resuelto usando MockProvider", async () => {
    vi.mocked(dalModule.requireApiSession).mockResolvedValue({ id: "user" } as any);

    const mockAiOutput = {
      movements: [
        {
          kind: "EXPENSE",
          amount: 4500,
          date: "2026-10-22",
          description: "Supermercado",
          categoryName: "Supermercado",
          accountName: "Banco Galicia",
          fromAccountName: null,
          toAccountName: null,
          installments: null,
          sourceText: "gasté 4500 en el súper con Galicia",
          clarifications: [],
        },
      ],
      unparsedText: null,
    };

    setAiProvider(new MockProvider(mockAiOutput));

    const req = new Request("http://localhost:3000/api/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "gasté 4500 en el súper con Galicia" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.movements).toHaveLength(1);
    expect(data.movements[0].accountId).toBe("acc-1");
    expect(data.movements[0].categoryId).toBe("cat-1");
    expect(data.movements[0].amount).toBe(4500);
  });

  it("devuelve 429 si se supera el rate limit", async () => {
    vi.mocked(dalModule.requireApiSession).mockResolvedValue({ id: "user" } as any);
    setAiProvider(new MockProvider({ movements: [], unparsedText: null }));

    // Realizamos 20 llamadas permitidas
    for (let i = 0; i < 20; i++) {
      const req = new Request("http://localhost:3000/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "1.2.3.4" },
        body: JSON.stringify({ text: "test" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
    }

    // La 21ª llamada debe rebotar con 429
    const reqExceeded = new Request("http://localhost:3000/api/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "1.2.3.4" },
      body: JSON.stringify({ text: "test" }),
    });
    const resExceeded = await POST(reqExceeded);
    expect(resExceeded.status).toBe(429);
  });
});
