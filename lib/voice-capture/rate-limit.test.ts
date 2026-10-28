import { describe, expect, it } from "vitest";
import { MemoryRateLimiter } from "./rate-limit";

describe("voice-capture / MemoryRateLimiter", () => {
  it("permite solicitudes dentro del límite y bloquea cuando se supera", () => {
    const limiter = new MemoryRateLimiter(3, 1000);
    const key = "user-ip-1";

    expect(limiter.check(key, 100).allowed).toBe(true);
    expect(limiter.check(key, 200).allowed).toBe(true);
    expect(limiter.check(key, 300).allowed).toBe(true);

    const fourth = limiter.check(key, 400);
    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
  });

  it("reinicia el conteo cuando expira la ventana de tiempo", () => {
    const limiter = new MemoryRateLimiter(2, 500);
    const key = "user-ip-2";

    expect(limiter.check(key, 1000).allowed).toBe(true);
    expect(limiter.check(key, 1100).allowed).toBe(true);
    expect(limiter.check(key, 1200).allowed).toBe(false);

    // Pasados los 500ms de ventana (1000 + 500 = 1500)
    expect(limiter.check(key, 1600).allowed).toBe(true);
  });
});
