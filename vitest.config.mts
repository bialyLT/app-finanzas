import { defineConfig } from "vitest/config";
import path from "node:path";

// Carga `.env` para que los tests tengan DATABASE_URL y DATABASE_URL_TEST.
// `process.loadEnvFile()` es nativo de Node 20.6+ — no hace falta agregar
// `dotenv` como dependencia sólo para esto.
try {
  process.loadEnvFile();
} catch {
  // Si no hay `.env`, se sigue igual: los tests que necesitan base de datos se
  // saltean solos (ver lib/db.integration.test.ts).
}

export default defineConfig({
  test: {
    // Los tests de lógica pura corren en Node. La integración con la base usa
    // Prisma directamente, que también es Node. Los tests de las primitivas de
    // UI se renderizan con `react-dom/server` (no hay jsdom): `include` acepta
    // `.tsx` para que puedan escribir JSX sin inventar un DOM.
    environment: "node",

    include: ["**/*.test.ts", "**/*.test.tsx"],

    // `.next` contiene copias compiladas de todo: sin esto, vitest corre los
    // tests dos veces y la salida se vuelve ilegible.
    exclude: ["node_modules/**", ".next/**", "dist/**"],

    clearMocks: true,
    restoreMocks: true,
  },
  resolve: {
    // Mismo alias que tsconfig.json ("@/*" → raíz del proyecto), para que los
    // imports de los tests sean idénticos a los del código de la app.
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
    },
  },
});
