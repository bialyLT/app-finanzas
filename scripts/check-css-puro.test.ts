import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * El candado de «cero CSS a mano» tiene que SABER detectar el CSS a mano.
 *
 * Un gate que no puede fallar no es un gate: por eso estos tests no miran
 * sólo que el CSS del proyecto esté limpio, sino que le pasan al gate CSS
 *-ROMPIDO a propósito y exigen que lo rechace.
 */

const RAIZ = resolve(import.meta.dirname, "..");
const GATE = join(RAIZ, "scripts", "check-css-puro.mjs");

/** Corre el gate y devuelve el código de salida y la salida completa. */
function correr(archivos: string[] = []) {
  const r = spawnSync(process.execPath, [GATE, ...archivos], {
    cwd: RAIZ,
    encoding: "utf8",
  });
  return { code: r.status, salida: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** La última línea `RESULT ok=N fail=M` de la salida. */
function resultado(salida: string) {
  const m = [...salida.matchAll(/RESULT ok=(\d+) fail=(\d+)/g)].pop();
  return m ? { ok: Number(m[1]), fail: Number(m[2]) } : null;
}

/** Escribe un CSS temporal y corre el gate contra él. */
function contraCss(contenido: string) {
  const dir = mkdtempSync(join(tmpdir(), "css-puro-"));
  try {
    const archivo = join(dir, "prueba.css");
    writeFileSync(archivo, contenido, "utf8");
    return correr([archivo]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("check-css-puro", () => {
  it("el CSS del proyecto es sólo configuración de Tailwind", () => {
    const r = correr();
    expect(resultado(r.salida)).not.toBeNull();
    expect(resultado(r.salida)!.fail).toBe(0);
    expect(r.code).toBe(0);
  });

  it("rechaza un selector de clase suelto", () => {
    const r = contraCss(
      `@import "tailwindcss";\n.monto-tarjeta { font-size: 12px; }\n`,
    );
    expect(resultado(r.salida)!.fail).toBeGreaterThan(0);
    expect(r.code).toBe(1);
  });

  it("rechaza una regla de elemento suelta (el `body { }` que pisaba la fuente)", () => {
    const r = contraCss(`@import "tailwindcss";\nbody { color: red; }\n`);
    expect(resultado(r.salida)!.fail).toBeGreaterThan(0);
    expect(r.code).toBe(1);
  });

  it("rechaza una `font-family` declarada fuera del `@theme`", () => {
    const r = contraCss(
      `@import "tailwindcss";\n@layer base { body { font-family: Arial; } }\n`,
    );
    expect(resultado(r.salida)!.fail).toBeGreaterThan(0);
    expect(r.code).toBe(1);
  });

  it("rechaza un `@media` con reglas en el nivel superior", () => {
    const r = contraCss(
      `@import "tailwindcss";\n@media (min-width: 640px) { .algo { color: red; } }\n`,
    );
    expect(resultado(r.salida)!.fail).toBeGreaterThan(0);
    expect(r.code).toBe(1);
  });

  it("acepta `@utility`, `@custom-variant`, `@theme` y `@layer base`", () => {
    const r = contraCss(
      [
        `@import "tailwindcss";`,
        `@custom-variant touch { @media (any-pointer: coarse) { @slot; } }`,
        `@theme inline { --font-sans: var(--font-geist-sans); }`,
        `@layer base { @media (any-pointer: coarse) { button { min-height: 44px; } } }`,
        `@utility monto-ficha { font-size: clamp(0.5rem, 0.875rem, 0.875rem); }`,
        "",
      ].join("\n"),
    );
    expect(resultado(r.salida)!.fail).toBe(0);
    expect(r.code).toBe(0);
  });

  /* ───────────────────────────────────────────────────────────────────────
   * LOS ÁNGULOS (agregados por el tester de la Fase 9)
   *
   * Un gate que se puede esquivar no es un gate. Estos tests son los que
   * encontraron los huecos:
   *
   *   · `@layer base`Declared libre: alguien escondía el estilo de un
   *     COMPONENTE ahí dentro y el gate lo aceptaba. En la capa base sólo
   *     pueden vivir defaults de ELEMENTO (selectores de tipo).
   *   · `@theme` y `@utility` libres: un selector de clase dentro de ellos
   *     es estilo de componente a mano, igual de prohibido.
   *   · el `@import` a otro archivo: el gate escaneaba los `.css` del repo
   *     pero no seguía los `@import`: un archivo con estilos a mano podía
   *     quedar fuera del radar.
   * ─────────────────────────────────────────────────────────────────────── */
  it("rechaza un selector de clase escondido dentro de `@layer base`", () => {
    const r = contraCss(
      `@import "tailwindcss";\n@layer base { .mi-estilo { color: red; } }\n`,
    );
    expect(resultado(r.salida)!.fail).toBeGreaterThan(0);
    expect(r.code).toBe(1);
  });

  it("rechaza un selector de clase dentro de `@layer base` y de un `@media`", () => {
    const r = contraCss(
      `@import "tailwindcss";\n@layer base { @media (min-width: 640px) { .mi-estilo { color: red; } } }\n`,
    );
    expect(resultado(r.salida)!.fail).toBeGreaterThan(0);
    expect(r.code).toBe(1);
  });

  it("rechaza un selector por id dentro de `@layer base`", () => {
    const r = contraCss(
      `@import "tailwindcss";\n@layer base { #mi-id { color: red; } }\n`,
    );
    expect(resultado(r.salida)!.fail).toBeGreaterThan(0);
    expect(r.code).toBe(1);
  });

  it("rechaza un selector de clase dentro de `@theme`", () => {
    const r = contraCss(
      `@import "tailwindcss";\n@theme { .mi-estilo { color: red; } }\n`,
    );
    expect(resultado(r.salida)!.fail).toBeGreaterThan(0);
    expect(r.code).toBe(1);
  });

  it("rechaza un selector de clase dentro de `@utility`", () => {
    const r = contraCss(
      `@import "tailwindcss";\n@utility monto-ficha { .mi-estilo { color: red; } }\n`,
    );
    expect(resultado(r.salida)!.fail).toBeGreaterThan(0);
    expect(r.code).toBe(1);
  });

  it("sigue el `@import` y rechaza el CSS a mano que viene de otro archivo", () => {
    // Dos archivos: el principal importa al segundo, que tiene el estilo a
    // mano. El gate tiene que seguir el import y verlo.
    const dir = mkdtempSync(join(tmpdir(), "css-puro-import-"));
    try {
      const importado = join(dir, "estilos.css");
      writeFileSync(importado, `.mi-estilo { color: red; }\n`, "utf8");
      const principal = join(dir, "principal.css");
      writeFileSync(principal, `@import "tailwindcss";\n@import "./estilos.css";\n`, "utf8");
      const r = correr([principal]);
      expect(resultado(r.salida)!.fail).toBeGreaterThan(0);
      expect(r.code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("acepta un `@layer base` con defaults de ELEMENTO (el caso del objetivo táctil)", () => {
    const r = contraCss(
      `@import "tailwindcss";\n@layer base { button, input, select, textarea { min-height: 44px; min-width: 44px; } }\n`,
    );
    expect(resultado(r.salida)!.fail).toBe(0);
    expect(r.code).toBe(0);
  });

  /* ───────────────────────────────────────────────────────────────────────
   * LOS BLOQUES DE TOKENS (F1)
   *
   * El `@theme` mapea variables, pero las variables pueden declararse en un
   * `:root` (o en un `.dark` el día que exista). Eso es CONFIGURACIÓN, no
   * estilo de componente, así que el gate lo admite — con dos candados: adentro
   * sólo hay variables (`--token: …`) y no se anidan reglas. Sin los candados,
   * `:root` sería la puerta de atrás para escribir `color: red` a mano.
   * ─────────────────────────────────────────────────────────────────────── */
  it("acepta un bloque de tokens `:root` en el nivel superior", () => {
    const r = contraCss(
      `@import "tailwindcss";\n:root { --surface: #07111f; --fg: #e6f0fa; }\n`,
    );
    expect(resultado(r.salida)!.fail).toBe(0);
    expect(r.code).toBe(0);
  });

  it("acepta un bloque de tokens `.dark` (el gemelo que todavía no se usa)", () => {
    const r = contraCss(
      `@import "tailwindcss";\n.dark { --surface: #07111f; }\n`,
    );
    expect(resultado(r.salida)!.fail).toBe(0);
    expect(r.code).toBe(0);
  });

  it("acepta la lista `:root, .dark` (los dos esquemas en un bloque)", () => {
    const r = contraCss(
      `@import "tailwindcss";\n:root, .dark { --surface: #07111f; }\n`,
    );
    expect(resultado(r.salida)!.fail).toBe(0);
    expect(r.code).toBe(0);
  });

  it("rechaza un bloque de tokens mezclado con un selector de clase", () => {
    const r = contraCss(
      `@import "tailwindcss";\n:root, .mi-estilo { --surface: #07111f; }\n`,
    );
    expect(resultado(r.salida)!.fail).toBeGreaterThan(0);
    expect(r.code).toBe(1);
  });

  it("rechaza una propiedad de estilo dentro de un bloque de tokens", () => {
    const r = contraCss(`@import "tailwindcss";\n:root { color: red; }\n`);
    expect(resultado(r.salida)!.fail).toBeGreaterThan(0);
    expect(r.code).toBe(1);
    expect(r.salida).toMatch(/sólo declara variables/i);
  });

  it("rechaza una regla anidada dentro de un bloque de tokens", () => {
    const r = contraCss(
      `@import "tailwindcss";\n.dark { .mi-estilo { color: red; } }\n`,
    );
    expect(resultado(r.salida)!.fail).toBeGreaterThan(0);
    expect(r.code).toBe(1);
  });

  it("rechaza un `@media` anidado dentro de un bloque de tokens", () => {
    const r = contraCss(
      `@import "tailwindcss";\n:root { @media (min-width: 640px) { --surface: #fff; } }\n`,
    );
    expect(resultado(r.salida)!.fail).toBeGreaterThan(0);
    expect(r.code).toBe(1);
  });
});
