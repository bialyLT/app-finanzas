import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Config de los REPROS del tester de calidad.
 *
 * Existe para que los repros corran con la ruta REAL (alias `@/`, mocks de
 * sesión/CSRF iguales a los de `lib/db.integration.test.ts`) SIN entrar en
 * `npm test`: el `include` de `vitest.config.ts` es `**\/*.test.ts`, así que si
 * estos archivos se llamaran `*.test.ts` la suite del proyecto los correría en
 * un worker paralelo y dos archivos se pelearían por la misma base
 * (`resetDatabase`), que es exactamente lo que el proyecto documenta que no hay
 * que hacer.
 *
 *   npx vitest run --config scripts/tester-quality/vitest.repro.config.mts
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // Sin `.env`, los repros se saltean solos (ver el `describe.skipIf`).
}

export default defineConfig({
  root: ROOT,
  resolve: { alias: { "@": ROOT } },
  test: {
    environment: "node",
    include: ["scripts/tester-quality/**/*.repro.ts"],
    clearMocks: true,
    restoreMocks: true,
    // Un solo archivo, un solo dueño de la base.
    fileParallelism: false,
  },
});
