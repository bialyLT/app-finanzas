#!/usr/bin/env node
/**
 * Runner de evaluación en vivo (Fase 6 · T6.2 y T6.3).
 *
 * Corre el dataset rioplatense contra Gemini usando el pipeline real de la app
 * (`buildPrompt` → proveedor → `resolveBatch`) y falla si no se cumplen los
 * umbrales del plan.
 *
 * Uso:
 *   npm run eval:parse
 *
 * Requiere GEMINI_API_KEY en el entorno o en `.env`. Opcional: AI_MODEL para
 * elegir el modelo (por defecto `gemini-2.5-flash`).
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvFile() {
  try {
    const content = readFileSync(resolve(process.cwd(), ".env"), "utf-8");

    for (const line of content.split("\n")) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;

      const separator = trimmed.indexOf("=");
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed
        .slice(separator + 1)
        .trim()
        .replace(/^["']|["']$/g, "");

      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // `.env` es opcional: la key puede venir del entorno.
  }
}

loadEnvFile();

if (!process.env.GEMINI_API_KEY?.trim()) {
  console.error(
    "✗ Falta GEMINI_API_KEY. Sin key no se puede evaluar el modelo en vivo.\n" +
      "  Agregala a .env (sólo servidor) o exportala en la terminal.\n" +
      "  Para verificar el dataset y las reglas sin red: npm test -- lib/voice-capture",
  );
  process.exit(1);
}

const result = spawnSync(
  "npx",
  ["vitest", "run", "lib/voice-capture/eval.live.test.ts", "--reporter=verbose"],
  {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, EVAL_LIVE: "1" },
  },
);

process.exit(result.status ?? 1);
