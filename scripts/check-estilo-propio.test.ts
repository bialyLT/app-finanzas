import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * El candado de «cero default» tiene que SABER detectar la fábrica de vuelta.
 *
 * Un gate que no puede fallar no es un gate: por eso estos tests no miran sólo
 * que el repo esté limpio, sino que le pasan al gate CADA regla rota a
 * propósito y exigen que la rechace.
 *
 * Y además miden su propio contrato: que el gate mire TODOS los archivos de
 * la interfaz (una carpeta de salida llamada `reports` no puede tapar la
 * carpeta de la API) y que los quince tokens tengan valor en los DOS
 * esquemas.
 */

const RAIZ = resolve(import.meta.dirname, "..");
const GATE = join(RAIZ, "scripts", "check-estilo-propio.mjs");
const GLOBALS = join(RAIZ, "app", "globals.css");

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

/** Escribe un `.tsx` temporal y corre el gate contra él. */
function contraTsx(contenido: string) {
  const dir = mkdtempSync(join(tmpdir(), "estilo-propio-"));
  try {
    const archivo = join(dir, "prueba.tsx");
    writeFileSync(archivo, contenido, "utf8");
    return correr([archivo]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** ¿El gate rechazó este contenido? ¿Y nombró el problema? */
function rechaza(contenido: string, palabra: string) {
  const r = contraTsx(contenido);
  const salida = r.salida;
  return {
    rechazado: r.code === 1 && (resultado(salida)?.fail ?? 0) > 0,
    nombra: salida.toLowerCase().includes(palabra.toLowerCase()),
    salida,
  };
}

describe("check-estilo-propio", () => {
  it("el repo entero está limpio", () => {
    const r = correr();
    expect(resultado(r.salida)).not.toBeNull();
    expect(resultado(r.salida)!.fail).toBe(0);
    expect(r.code).toBe(0);
  }, 30_000); // el gate sobre los 93 archivos: un proceso, ~4 s

  it("rechaza una clase de la paleta de fábrica", () => {
    const r = rechaza(`export const A = () => <p className="text-zinc-500">h</p>;\n`, "paleta");
    expect(r.rechazado).toBe(true);
    expect(r.nombra).toBe(true);
  });

  it("rechaza CUALQUIER paleta de fábrica, pink incluida (las 22 familias)", () => {
    for (const familia of [
      "zinc", "slate", "gray", "neutral", "stone", "red", "orange", "amber",
      "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue",
      "indigo", "violet", "purple", "fuchsia", "pink", "rose",
    ]) {
      const r = contraTsx(`export const A = () => <p className="text-${familia}-500">h</p>;\n`);
      expect(resultado(r.salida)!.fail, `text-${familia}-500 tiene que fallar`).toBeGreaterThan(0);
      expect(r.code, `text-${familia}-500 tiene que salir con 1`).toBe(1);
    }
  }, 60_000); // 22 corridas del gate (un proceso cada una)

  it("rechaza un emoji como icono", () => {
    const r = rechaza(`export const A = () => <button aria-label="borrar">🗑</button>;\n`, "emoji");
    expect(r.rechazado).toBe(true);
    expect(r.nombra).toBe(true);
  });

  it("rechaza un radio fuera de la escala", () => {
    const r = rechaza(`export const A = () => <div className="rounded-xl">h</div>;\n`, "radio");
    expect(r.rechazado).toBe(true);
    expect(r.nombra).toBe(true);
  });

  it("rechaza un hex suelto", () => {
    const r = rechaza(`export const A = () => <div className="bg-[#07111F]">h</div>;\n`, "color");
    expect(r.rechazado).toBe(true);
    expect(r.nombra).toBe(true);
  });

  it("rechaza un color arbitrario que no es hex", () => {
    const r = rechaza(`export const A = () => <div className="bg-[oklch(0.7_0.1_200)]">h</div>;\n`, "color");
    expect(r.rechazado).toBe(true);
  });

  it("rechaza un gradiente", () => {
    const r = rechaza(`export const A = () => <div className="bg-gradient-to-r from-surface to-surface-2">h</div>;\n`, "gradiente");
    expect(r.rechazado).toBe(true);
    expect(r.nombra).toBe(true);
  });

  it("rechaza una fuente fuera del tema", () => {
    const r = rechaza(`export const A = () => <div className="font-[Comic_Sans_MS]">h</div>;\n`, "fuente");
    expect(r.rechazado).toBe(true);
    expect(r.nombra).toBe(true);
  });

  it("rechaza una familia de fuente que no es del tema (font-serif)", () => {
    const r = rechaza(`export const A = () => <div className="font-serif">h</div>;\n`, "fuente");
    expect(r.rechazado).toBe(true);
  });

  it("rechaza un tamaño de letra fuera de la escala (text-2xl)", () => {
    const r = rechaza(`export const A = () => <p className="text-2xl">h</p>;\n`, "escala");
    expect(r.rechazado).toBe(true);
    expect(r.nombra).toBe(true);
  });

  it("rechaza un cuerpo arbitrario (text-[11px] / text-[15px])", () => {
    for (const tamano of ["text-[11px]", "text-[15px]", "text-[0.9rem]"]) {
      const r = contraTsx(`export const A = () => <p className="${tamano}">h</p>;\n`);
      expect(
        resultado(r.salida)!.fail,
        `${tamano} tiene que fallar: el cuerpo sale del @theme`,
      ).toBeGreaterThan(0);
      expect(r.code, `${tamano} tiene que salir con 1`).toBe(1);
      expect(r.salida, `${tamano} tiene que nombrar la escala`).toMatch(/escala/);
    }
  });

  it("rechaza TODOS los tamaños de fábrica que no son de la escala", () => {
    for (const tamano of ["md", "2xl", "3xl", "4xl"]) {
      const r = contraTsx(`export const A = () => <p className="text-${tamano}">h</p>;\n`);
      expect(resultado(r.salida)!.fail, `text-${tamano} tiene que fallar`).toBeGreaterThan(0);
    }
  });

  it("rechaza un `dark:` en un color", () => {
    const r = rechaza(`export const A = () => <div className="dark:bg-black/90">h</div>;\n`, "dark");
    expect(r.rechazado).toBe(true);
  });

  it("ACEPTA lo que el design system permite", () => {
    const permitidos = [
      `export const A = () => <p className="text-fg-muted bg-surface-2 border-line-strong">h</p>;\n`,
      `export const A = () => <div className="rounded-md"><span className="rounded-lg"/><i className="rounded-full"/></div>;\n`,
      `export const A = () => <div className="bg-black/60 text-white">h</div>;\n`,
      `export const A = () => <div className="font-sans"><code className="font-mono">1</code></div>;\n`,
      // los PESOS de fuente no son familias
      `export const A = () => <div className="font-bold font-medium">h</div>;\n`,
      // un tinte (un token con opacidad)
      `export const A = () => <div className="bg-danger/10 border-warning/40">h</div>;\n`,
      // los cinco pasos de la escala SÍ son el cuerpo de letra del sistema
      `export const A = () => <div className="text-xs text-sm text-base text-lg text-xl">h</div>;\n`,
      // `text-` que no es un tamaño (alineación) y las cifras tabulares
      `export const A = () => <p className="text-center text-right monto">h</p>;\n`,
      // un token por variable CSS (los gráficos)
      `export const A = () => <div style={{ backgroundColor: "var(--success)" }}>h</div>;\n`,
    ];
    for (const contenido of permitidos) {
      const r = contraTsx(contenido);
      expect(resultado(r.salida)!.fail, contenido.slice(0, 70)).toBe(0);
      expect(r.code, contenido.slice(0, 70)).toBe(0);
    }
  }, 60_000); // ocho corridas del gate

  it("el gate mira TODOS los archivos de la interfaz (una carpeta `reports` no tapa la API)", () => {
    const r = correr();
    const m = r.salida.match(/Estilo propio: (\d+) archivo\(s\)/);
    expect(m).not.toBeNull();
    // app/ + components/ + lib/. Los `components/ui` los tiene que mirar el
    // gate igual que el resto: si una primitiva trae `rounded-xl` o un hex,
    // la ronda no cierra.
    expect(Number(m![1])).toBeGreaterThanOrEqual(108);
  }, 30_000);

  it("el @theme declara la familia elegida y la escala de cinco pasos", () => {
    const r = correr();
    expect(resultado(r.salida)!.fail).toBe(0);

    const css = readFileSync(GLOBALS, "utf8");
    // La familia es una decisión del sistema: Archivo (no la de Next) + IBM
    // Plex Mono. El gate la sujeta, así que volver a Geist es una falla.
    expect(css).toMatch(/--font-sans:\s*var\(--font-archivo\)/);
    expect(css).toMatch(/--font-mono:\s*var\(--font-plex-mono\)/);
    // Los cinco pasos y el tope de 24 px con el que está calibrado factorMonto.
    for (const paso of ["xs", "sm", "base", "lg", "xl"]) {
      expect(css, `falta --text-${paso} en el @theme`).toMatch(
        new RegExp(`--text-${paso}\\s*:`),
      );
    }
    expect(css).toMatch(/--text-xl:\s*1\.5rem\s*;/);
  }, 30_000);

  it("el @theme declara los quince tokens y cada uno tiene valor en los dos esquemas", () => {
    const r = correr();
    expect(resultado(r.salida)!.fail).toBe(0);

    const css = readFileSync(GLOBALS, "utf8");
    const tokens = [
      "surface", "surface-2", "surface-3", "line", "line-strong",
      "fg", "fg-muted", "fg-subtle", "primary", "primary-fg",
      "success", "danger", "warning", "transfer", "focus",
    ];
    for (const t of tokens) {
      expect(css, `falta --color-${t} en el @theme`).toContain(`--color-${t}: var(--${t})`);
    }
    const claro = css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)"));
    const oscuro = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
    for (const t of tokens) {
      expect(claro, `falta el valor de --${t} en el esquema claro`).toMatch(
        new RegExp(`--${t}\\s*:\\s*(#[0-9a-fA-F]{3,8}|oklch\\([^)]*\\)|rgb\\([^)]*\\))`),
      );
      expect(oscuro, `falta el valor de --${t} en el esquema oscuro`).toMatch(
        new RegExp(`--${t}\\s*:\\s*(#[0-9a-fA-F]{3,8}|oklch\\([^)]*\\)|rgb\\([^)]*\\))`),
      );
    }
  }, 30_000);
});
