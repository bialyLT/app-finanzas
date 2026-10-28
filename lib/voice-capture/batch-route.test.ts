import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/transactions/batch/route";
import * as dalModule from "@/lib/auth/dal";
import * as csrfModule from "@/lib/auth/csrf";
import * as batchService from "@/lib/voice-capture/batch-service";

vi.mock("@/lib/auth/dal", () => ({
  requireApiSession: vi.fn(),
  unauthorized: vi.fn(() => new Response(JSON.stringify({ error: "No autorizado" }), { status: 401 })),
}));

vi.mock("@/lib/auth/csrf", () => ({
  assertSameOrigin: vi.fn(() => null),
}));

vi.mock("@/lib/voice-capture/batch-service", async () => {
  const actual = await vi.importActual<typeof import("./batch-service")>("./batch-service");
  return {
    ...actual,
    saveMovementBatch: vi.fn(),
  };
});

describe("POST /api/transactions/batch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("devuelve 401 si no hay sesión activa", async () => {
    vi.mocked(dalModule.requireApiSession).mockResolvedValue(false as any);

    const req = new Request("http://localhost:3000/api/transactions/batch", {
      method: "POST",
      body: JSON.stringify({ movements: [] }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("devuelve 400 si movements está vacío", async () => {
    vi.mocked(dalModule.requireApiSession).mockResolvedValue({ id: "user" } as any);

    const req = new Request("http://localhost:3000/api/transactions/batch", {
      method: "POST",
      body: JSON.stringify({ movements: [] }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("no puede estar vacía");
  });

  it("devuelve 201 y delega a saveMovementBatch en caso exitoso", async () => {
    vi.mocked(dalModule.requireApiSession).mockResolvedValue({ id: "user" } as any);
    vi.mocked(batchService.saveMovementBatch).mockResolvedValue({ count: 1 });

    const movements = [
      {
        kind: "EXPENSE",
        amount: 2500,
        date: "2026-10-22",
        description: "Farmacia",
        accountId: "acc-1",
      },
    ];

    const req = new Request("http://localhost:3000/api/transactions/batch", {
      method: "POST",
      body: JSON.stringify({ movements }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.count).toBe(1);
  });
});
