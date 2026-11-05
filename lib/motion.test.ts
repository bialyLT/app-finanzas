import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * EL CANDADO DEL MOVIMIENTO (F3a).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ EXISTE
 * Los tokens de color, de radio y de tipografía tienen su candado en
 * `scripts/check-estilo-propio.mjs`. El movimiento entró en F3a y hasta ahora
 * su única defensa era la convención: nada impedía que un `duration-[200ms]`
 * o un `ease-[cubic-bezier(...)]` volviera al markup, que es exactamente lo
 * que el design system prohíbe (§5.9 de `docs/design-system.md`).
 *
 * Este test es el candado que faltaba, en tres frentes:
 *
 *   1. LOS TOKENS EXISTEN Y TIENEN VALOR. Un `--animate-*` que apunta a una
 *      duración sin declarar compila a `animation: … var(--nada)`: la
 *      animación no corre y nadie se entera. Igual que `tokensSinValor` con
 *      los colores.
 *   2. NINGÚN MODAL PASA DE 250 ms. El presupuesto de un modal es una regla
 *      del sistema, no un gusto: se calcula desde el `:root` real.
 *   3. EL MARKUP NO LLEVA VALORES SUELTOS. Duraciones, curvas y animaciones
 *      arbitrarias salen de los tokens del `@theme`; si aparecen en una
 *      clase, esto falla.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LO QUE ESTE TEST **NO** CUBRE (y por eso lo dice)
 * No ejecuta un navegador: verifica la CONFIGURACIÓN. Que la animación se vea
 * en pantalla y que `prefers-reduced-motion` no rompa el cierre del modal se
 * mide con Chrome (Emulation.setEmulatedMedia) — ver §6 del design system.
 */

const RAIZ = resolve(import.meta.dirname, "..");
const GLOBALS = join(RAIZ, "app", "globals.css");
const css = readFileSync(GLOBALS, "utf8");

/** La escala de duraciones del sistema, en ms (el presupuesto del modal es 250).
 *  No es una lista «paralela»: el test compara el CSS contra esta tabla, así
 *  que un token que cambie de valor sin actualizar la escala falla. */
const DURACIONES = { fast: 120, normal: 180, slow: 240 } as const;

/** Las dos curvas: una para entrar, otra para salir. */
const CURVAS = ["enter", "exit"] as const;

/** El `@theme` (nombres) y el `:root` del esquema claro (valores) viven en el
 * mismo archivo: se busca en todo el CSS, que es la única fuente de los
 * tokens (un `--animate-*` fuera de `globals.css` no existe). */
const theme = css;

/** El bloque `:root` del esquema claro: donde viven los valores de motion. */
function valorDeclarado(variable: string): string | null {
  const m = new RegExp(`--${variable}\\s*:\\s*([^;]+);`).exec(css);
  return m ? m[1].trim() : null;
}

/** El valor REAL de una duración en el `:root`, en ms (o `null` si no parsea).
 *  El presupuesto de 250 ms se calcula con ESTO, no con la tabla: si alguien
 *  sube `--motion-duration-normal` a 300 ms, el test lo ve. */
function duracionDeclarada(nombre: keyof typeof DURACIONES): number | null {
  const valor = valorDeclarado(`motion-duration-${nombre}`);
  if (!valor) return null;
  const m = /^(\d+)ms$/.exec(valor);
  return m ? Number(m[1]) : null;
}

/** Los archivos de la interfaz (los que llevan clases). */
function archivosDeInterfaz(): string[] {
  const encontrados: string[] = [];
  const recorrer = (dir: string) => {
    for (const entrada of readdirSync(dir, { withFileTypes: true })) {
      if (entrada.name === "node_modules" || entrada.name === ".next") continue;
      const ruta = join(dir, entrada.name);
      if (entrada.isDirectory()) recorrer(ruta);
      else if (/\.(tsx|ts)$/.test(entrada.name) && !/\.test\./.test(entrada.name)) {
        encontrados.push(ruta);
      }
    }
  };
  for (const dir of ["app", "components"]) recorrer(join(RAIZ, dir));
  return encontrados;
}

/** Saca los comentarios: una explicación puede nombrar un valor prohibido. */
function sinComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("motion · los tokens", () => {
  it("el @theme declara las cinco piezas de movimiento y todas tienen valor", () => {
    for (const nombre of Object.keys(DURACIONES) as Array<keyof typeof DURACIONES>) {
      expect(theme, `falta --animate-* o la duración ${nombre}`).toContain(
        `--motion-duration-${nombre}`,
      );
      const valor = valorDeclarado(`motion-duration-${nombre}`);
      expect(valor, `--motion-duration-${nombre} no tiene valor en :root`).not.toBeNull();
      expect(valor).toMatch(/^\d+ms$/);
      // La escala es 120/180/240: un token que se mueve sin actualizar el
      // sistema deja de ser un token y pasa a ser un número con nombre.
      expect(duracionDeclarada(nombre), `--motion-duration-${nombre} no vale ${DURACIONES[nombre]} ms`).toBe(
        DURACIONES[nombre],
      );
    }
    for (const curva of CURVAS) {
      const alias = new RegExp(`--ease-${curva}\\s*:\\s*var\\(--motion-ease-${curva}\\)`);
      expect(theme, `el @theme no expone ease-${curva}`).toMatch(alias);
      const valor = valorDeclarado(`motion-ease-${curva}`);
      expect(valor, `--motion-ease-${curva} no tiene valor en :root`).not.toBeNull();
      expect(valor).toMatch(/^cubic-bezier\(/);
    }
  });

  it("las animaciones del sistema son tokens, y sólo consumen las duraciones del sistema", () => {
    const animaciones = [...theme.matchAll(/--animate-([\w-]+)\s*:\s*([^;]+);/g)];
    expect(animaciones.length).toBeGreaterThanOrEqual(6);
    for (const [, nombre, valor] of animaciones) {
      // Nada de ms literales: la duración sale de un token.
      expect(valor, `--animate-${nombre} lleva una duración literal`).not.toMatch(/\d+ms/);
      expect(valor, `--animate-${nombre} no usa una duración del sistema`).toMatch(
        /var\(--motion-duration-(fast|normal|slow)\)/,
      );
      // Y la curva también es un token (entrar o salir), nunca un cubic-bezier suelto.
      expect(valor, `--animate-${nombre} no usa una curva del sistema`).toMatch(
        /var\(--ease-(enter|exit)\)/,
      );
    }
  });

  it("ninguna animación de modal, menú u overlay pasa de 250 ms", () => {
    // El presupuesto se calcula desde los valores REALES del `:root`, no desde
    // una lista aparte: si alguien sube `--motion-duration-normal`, esto falla.
    const animaciones = [...theme.matchAll(/--animate-([\w-]+)\s*:\s*([^;]+);/g)];
    for (const [token, nombre, valor] of animaciones) {
      const duracion = /var\(--motion-duration-(\w+)\)/.exec(valor)?.[1];
      expect(duracion, `${token}: no se puede calcular la duración`).toBeTruthy();
      const ms = duracionDeclarada(duracion as keyof typeof DURACIONES);
      expect(ms, `${token} usa una duración que no es del sistema`).not.toBeNull();
      // `slow` (240 ms) está reservado al aviso: un modal no llega ahí.
      const esDeAviso = nombre === "toast-in";
      if (!esDeAviso) {
        expect(ms!, `${token} dura ${ms} ms: un modal no pasa de 250`).toBeLessThanOrEqual(250);
      }
    }
  });
});

describe("motion · prefers-reduced-motion", () => {
  it("las tres duraciones caen a 0 ms bajo `reduce` (sin apagar la animación)", () => {
    const bloque = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\s*\}\s*\n\s*\}/.exec(
      css,
    );
    expect(bloque, "no hay una regla global de reduced-motion").not.toBeNull();
    const cuerpo = bloque![1];
    for (const nombre of Object.keys(DURACIONES)) {
      expect(cuerpo, `reduced-motion no anula --motion-duration-${nombre}`).toMatch(
        new RegExp(`--motion-duration-${nombre}\\s*:\\s*0ms`),
      );
    }
    // 0 ms y NO `animation: none`: con `none` el estado final no se aplica y
    // Radix desmonta el diálogo antes de tiempo (el pie salta).
    expect(cuerpo).not.toMatch(/animation\s*:\s*none/);
  });
});

describe("motion · el markup", () => {
  it("no lleva duraciones, curvas ni animaciones sueltas", () => {
    const prohibidos: Array<[RegExp, string]> = [
      [/\bduration-(?:\d|\[)/, "una duración literal (usá duration-fast/normal/slow)"],
      [/\bdelay-(?:\d|\[)/, "un retardo literal (no hay token: no lo uses)"],
      [/\bease-\[/, "una curva arbitraria (usá ease-enter/ease-exit)"],
      [/\bease-(?:in-out|in|out|linear)\b/, "una curva de fábrica (usá ease-enter/ease-exit)"],
      [/\banimate-\[/, "una animación arbitraria (usá un token --animate-*)"],
      [/\[(?:transition|animation):/, "una transición o animación escrita a mano"],
    ];
    const violaciones: string[] = [];
    for (const archivo of archivosDeInterfaz()) {
      const texto = sinComentarios(readFileSync(archivo, "utf8"));
      for (const [patron, motivo] of prohibidos) {
        const m = patron.exec(texto);
        if (m) violaciones.push(`${archivo.slice(RAIZ.length + 1)}: «${m[0]}» es ${motivo}`);
      }
    }
    expect(violaciones).toEqual([]);
  });

  it("el diálogo, la hoja y los menús esperan el cierre (`data-state=closed`)", () => {
    const casos: Array<[string, string]> = [
      ["components/ui/dialog.tsx", "data-[state=closed]:animate-fade-scale-out"],
      ["components/ui/sheet.tsx", "data-[state=closed]:animate-sheet-out"],
      ["components/ui/dropdown-menu.tsx", "data-[state=closed]:animate-fade-scale-out"],
      ["components/ui/select.tsx", "data-[state=closed]:animate-fade-scale-out"],
    ];
    for (const [ruta, esperado] of casos) {
      const texto = readFileSync(join(RAIZ, ruta), "utf8");
      expect(texto, `${ruta} no anima la salida`).toContain(esperado);
      expect(texto, `${ruta} no anima la entrada`).toMatch(
        /data-\[state=open\]:animate-(fade-scale-in|sheet-in)/,
      );
    }
  });

  it("la paleta y el aviso entran con la MISMA animación que los modales", () => {
    // Una sola animación para todos los overlays centrados: si mañana se
    // agrega una segunda curva, esto lo delata.
    const paleta = readFileSync(join(RAIZ, "components", "CommandPalette.tsx"), "utf8");
    expect(paleta).toContain("animate-fade-scale-in");
    const home = readFileSync(join(RAIZ, "app", "page.tsx"), "utf8");
    expect(home).toContain("animate-toast-in");
  });
});
