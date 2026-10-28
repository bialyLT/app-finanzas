/**
 * Proveedor de Inteligencia Artificial intercambiable para la interpretación
 * de lenguaje natural en movimientos financieros.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PRINCIPIO DE AISLAMIENTO
 * ─────────────────────────────────────────────────────────────────────────────
 * El proveedor solo sabe interactuar con el LLM y devolver JSON estructurado.
 * No accede a la base de datos ni ejecuta lógica de negocio.
 * Toda la comunicación con Gemini se hace vía REST nativo (fetch), sin SDKs.
 */

import { buildPrompt } from "./prompt";

export interface ParseAccountContext {
  name: string;
  kind: string;
}

export interface ParseCategoryContext {
  name: string;
  kind: string;
}

export interface ParseInput {
  text: string;
  today: string; // AAAA-MM-DD
  accounts: ParseAccountContext[];
  categories: ParseCategoryContext[];
  image?: { base64: string; mimeType: string };
}

export interface AiProvider {
  parseMovements(input: ParseInput): Promise<unknown>;
}

let globalAiProvider: AiProvider | null = null;

export function setAiProvider(provider: AiProvider | null): void {
  globalAiProvider = provider;
}

export function getAiProvider(): AiProvider {
  if (globalAiProvider) return globalAiProvider;
  return new GeminiProvider();
}

/**
 * Proveedor para tests e integración sin llamadas a servicios externos.
 */
export class MockProvider implements AiProvider {
  constructor(
    private readonly response:
      | unknown
      | ((input: ParseInput) => Promise<unknown> | unknown),
  ) {}

  async parseMovements(input: ParseInput): Promise<unknown> {
    if (typeof this.response === "function") {
      return this.response(input);
    }
    return this.response;
  }
}

export interface GeminiProviderOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  fetchFn?: typeof fetch;
}

/**
 * Proveedor oficial para Google Gemini vía API REST pública.
 */
export class GeminiProvider implements AiProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options?: GeminiProviderOptions) {
    this.apiKey = options?.apiKey ?? process.env.GEMINI_API_KEY ?? "";
    this.model = options?.model ?? process.env.AI_MODEL ?? "gemini-2.5-flash";
    this.timeoutMs = options?.timeoutMs ?? 15000;
    this.retryDelayMs = options?.retryDelayMs ?? 1000;
    this.fetchFn = options?.fetchFn ?? fetch;
  }

  async parseMovements(input: ParseInput): Promise<unknown> {
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      throw new Error(
        "GEMINI_API_KEY no está configurada en las variables de entorno del servidor.",
      );
    }

    const prompt = this.composePrompt(input);
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      this.model,
    )}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    const contentsParts: Array<Record<string, unknown>> = [{ text: prompt }];

    if (input.image) {
      contentsParts.push({
        inlineData: {
          mimeType: input.image.mimeType,
          data: input.image.base64,
        },
      });
    }

    const payload = {
      contents: [{ parts: contentsParts }],
      generationConfig: {
        responseMimeType: "application/json",
      },
    };

    let lastError: Error | null = null;

    // Intentamos 1 vez + 1 reintento ante error transitorio
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0 && this.retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        const response = await this.fetchFn(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const status = response.status;
          let errorDetail = response.statusText;
          try {
            const errJson = (await response.json()) as {
              error?: { message?: string } | string;
            };
            if (typeof errJson?.error === "string") {
              errorDetail = errJson.error;
            } else if (
              typeof errJson?.error === "object" &&
              errJson.error?.message
            ) {
              errorDetail = errJson.error.message;
            }
          } catch {
            // Ignoramos error al leer JSON de respuesta de error
          }

          // Sanitizamos para no filtrar la API key bajo ninguna circunstancia
          const safeError = new Error(
            `Error en el servicio de IA (${status}): ${this.sanitize(
              errorDetail,
            )}`,
          );

          // Errores 5xx o 429 son transitorios y ameritan reintento
          if ((status >= 500 || status === 429) && attempt === 0) {
            lastError = safeError;
            continue;
          }

          throw safeError;
        }

        const data = (await response.json()) as {
          candidates?: Array<{
            content?: {
              parts?: Array<{ text?: string }>;
            };
          }>;
        };

        const rawText =
          data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";

        if (!rawText) {
          throw new Error("El modelo de IA devolvió una respuesta vacía.");
        }

        try {
          return JSON.parse(rawText);
        } catch {
          if (attempt === 0) {
            lastError = new Error("El modelo de IA devolvió JSON malformado.");
            continue;
          }
          throw new Error("El modelo de IA devolvió JSON malformado.");
        }
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          err.name === "AbortError"
        ) {
          throw new Error(
            `El servicio de IA superó el tiempo límite de espera (${this.timeoutMs} ms).`,
          );
        }

        if (attempt === 0 && this.isTransientNetworkError(err)) {
          lastError =
            err instanceof Error
              ? new Error(this.sanitize(err.message))
              : new Error("Error transitorio de red.");
          continue;
        }

        if (err instanceof Error) {
          throw new Error(this.sanitize(err.message));
        }
        throw new Error("Error desconocido al invocar el proveedor de IA.");
      }
    }

    throw (
      lastError ??
      new Error("No se pudo obtener respuesta del proveedor de IA.")
    );
  }

  private composePrompt(input: ParseInput): string {
    return buildPrompt(input);
  }

  private isTransientNetworkError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return (
      msg.includes("fetch failed") ||
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      msg.includes("network")
    );
  }

  private sanitize(str: string): string {
    if (!this.apiKey) return str;
    return str.split(this.apiKey).join("[REDACTED_API_KEY]");
  }
}
