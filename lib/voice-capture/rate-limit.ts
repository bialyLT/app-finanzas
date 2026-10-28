/**
 * Rate limiter simple en memoria para proteger la cuota de la API de IA.
 */

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

export class MemoryRateLimiter {
  private readonly records = new Map<string, RateLimitRecord>();

  constructor(
    private readonly maxRequests: number = 20,
    private readonly windowMs: number = 60 * 1000,
  ) {}

  check(key: string, now: number = Date.now()): { allowed: boolean; remaining: number } {
    const record = this.records.get(key);

    if (!record || now >= record.resetAt) {
      this.records.set(key, {
        count: 1,
        resetAt: now + this.windowMs,
      });
      return { allowed: true, remaining: this.maxRequests - 1 };
    }

    if (record.count >= this.maxRequests) {
      return { allowed: false, remaining: 0 };
    }

    record.count += 1;
    return {
      allowed: true,
      remaining: this.maxRequests - record.count,
    };
  }

  reset(): void {
    this.records.clear();
  }
}

export const parseRateLimiter = new MemoryRateLimiter(20, 60 * 1000);
