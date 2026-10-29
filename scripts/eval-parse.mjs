#!/usr/bin/env node
/**
 * Runner de evaluación en vivo para medir la precisión de Gemini contra
 * el dataset en español rioplatense (Fase 5 · T5.2).
 *
 * Requiere GEMINI_API_KEY en el entorno o en .env.
 *
 * Uso:
 *   node scripts/eval-parse.mjs
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DATASET_PATH = resolve(process.cwd(), "lib/voice-capture/dataset.json");
const dataset = JSON.parse(readFileSync(DATASET_PATH, "utf-8"));

// Leemos .env manualmente si existe
try {
  const envContent = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
      const [key, ...vals] = trimmed.split("=");
      if (!process.env[key.trim()]) {
        process.env[key.trim()] = vals.join("=").trim().replace(/^["']|["']$/g, "");
      }
    }
  }
} catch {
  // .env opcional
}

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.log("ℹ GEMINI_API_KEY no detectada. Para evaluar el modelo en vivo, seteá GEMINI_API_KEY.");
  console.log("✓ Para verificar los casos contra el pipeline de resolución, ejecutá: npx vitest run lib/voice-capture/dataset.test.ts");
  process.exit(0);
}

const model = process.env.AI_MODEL || "gemini-2.5-flash";

async function evaluateLive() {
  console.log(`\n======================================================`);
  console.log(` EVALUACIÓN EN VIVO CON GEMINI (${model})`);
  console.log(` Casos a evaluar: ${dataset.length}`);
  console.log(`======================================================\n`);

  let passed = 0;
  let failed = 0;

  for (const item of dataset) {
    process.stdout.write(`Probando [${item.id}] "${item.input}" ... `);

    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model,
      )}:generateContent?key=${encodeURIComponent(apiKey)}`;

      const promptText = `Sos un motor de extracción financiera para Argentina. Extraé los movimientos en JSON estricto con campos: kind (INCOME | EXPENSE | TRANSFER), amount (número), description, accountName, fromAccountName, toAccountName, installments, clarifications. Si es pago de tarjeta, jamás uses EXPENSE (usá TRANSFER hacia la tarjeta). Texto: "${item.input}"`;

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }],
          generationConfig: { responseMimeType: "application/json" },
        }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }

      const data = await res.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      const parsed = JSON.parse(rawText);

      // Verificamos regla de oro para tarjetas
      if (item.expected?.neverKind) {
        const first = Array.isArray(parsed) ? parsed[0] : parsed?.movements?.[0] ?? parsed;
        if (first?.kind === item.expected.neverKind) {
          throw new Error(`Violó regla neverKind: devolvió ${first.kind}`);
        }
      }

      passed++;
      console.log(`OK`);
    } catch (err) {
      failed++;
      console.log(`FALLÓ: ${err.message}`);
    }
  }

  console.log(`\nResumen: ${passed} pasaron, ${failed} fallaron.`);
}

evaluateLive();
