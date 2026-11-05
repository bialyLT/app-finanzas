import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Config de las SONDAS de la ronda F4.5.
 *
 * Igual que `vitest.repro.config.mts`: los `.probe.ts` NO entran en `npm test`
 * (`include` de la raíz es `**\/*.test.ts`). Acá se prueban contratos del
 * motor de voz con la ruta REAL (`@/`), sin base de datos.
 *
 *   npx vitest run --config scripts/tester-quality/vitest.f45.config.mts
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

export default defineConfig({
  root: ROOT,
  resolve: { alias: { "@": ROOT } },
  test: {
    environment: "node",
    include: ["scripts/tester-quality/**/*.probe.ts"],
    clearMocks: true,
    restoreMocks: true,
    fileParallelism: false,
  },
});
