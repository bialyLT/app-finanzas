#!/usr/bin/env node
/**
 * check-estilo-propio.mjs — el candado de «cero default».
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ EXISTE
 * La app tenía «aspecto de fábrica»: 416 clases `zinc-*` (la paleta gris de
 * Tailwind), 151 `rounded-xl` (el mismo radio en todo), emoji usados como
 * iconos y colores sueltos en el markup. No era un error: era la ausencia de
 * decisiones. Y sin un candado, la primera persona que necesite un color
 * raro abre un `.tsx` y escribe `text-zinc-500`: en tres meses la app vuelve
 * al aspecto de fábrica y nadie se entera.
 *
 * Este script es el que dice que no.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAS SIETE REGLAS
 *   1 · PALETA DE FÁBRICA: una sola clase de la paleta por defecto de
 *       Tailwind (`zinc-*`, `slate-*`, `gray-*`, `neutral-*`, `stone-*`,
 *       `red-*`, `emerald-*`, `blue-*`, `sky-*`, `amber-*`, `rose-*`, `pink-*`…) es
 *       una falla. Los colores son TOKENS con nombre (`text-fg-muted`).
 *       Excepción: `black` y `white` (el velo del modal y el neutro).
 *   2 · EMOJI como icono: un emoji es un icono de otra tipografía, con otro
 *       grosor y otra escala. Los iconos son de `lucide-react`.
 *   3 · RADIO fuera de escala: sólo `md` (6 px), `lg` (8 px), `full` y
 *       `none` (y sus variantes direccionales). `rounded-xl` genérico está
 *       prohibido: cada radio dice algo. Tampoco valen el radio pelado
 *       (`rounded`), el arbitrario (`rounded-[10px]`) ni las variantes
 *       lógicas de esquina (`rounded-ss-xl`).
 *   4 · COLOR SUELTO en el markup (`bg-[#07111F]`, `bg-[rgb(7,17,31)]`, un
 *       `color: "#07111F"` en línea): un color sin nombre no se puede cambiar
 *       ni auditar. Va en el `@theme`.
 *   5 · GRADIENTE (`bg-linear-*` —el nombre de Tailwind v4—, `bg-gradient-*`,
 *       `bg-radial-*`, `from-*`, `via-*`, `to-*`): el spike de estilos que
 *       eligió la persona («C · Noche») no tiene ni uno.
 *   6 · FUENTE fuera del tema: la fuente sale del `@theme` (`font-sans`,
 *       `font-mono`); una `font-family` a mano la pisa (ya pasó: la app
 *       renderizaba en Arial). `font-bold` es un PESO, no una fuente: no cae.
 *   7 · `dark:` EN UN COLOR: el token ya es el del esquema que está en
 *       pantalla, así que el markup no lleva `dark:` en ningún color
 *       (`docs/design-system.md` §5.8).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRATO DE SALIDA (el mismo que `check-css-puro.mjs` y la auditoría)
 *   · imprime `RESULT ok=N fail=M` en la última línea;
 *   · sale con código 1 si hay alguna falla, 0 si no.
 *
 * El conteo: un check por archivo (que se pueda leer) + un check por regla
 * evaluada en ese archivo (ok si la regla se respeta, falla si hay al menos
 * una violación) + un check de repo (que el `@theme` declare los tokens).
 *
 * Uso:
 *   node scripts/check-estilo-propio.mjs
 *   node scripts/check-estilo-propio.mjs app/page.tsx
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * Las familias de la paleta por defecto de Tailwind.
 *
 * LA LISTA TIENE QUE ESTAR COMPLETA: el gate promete «una sola clase de la
 * paleta por defecto es una falla», y `pink` faltaba (probado: `bg-pink-500`
 * pasaba con exit 0 y SÍ compila — `background-color: var(--color-pink-500)`).
 * Las 22 familias de Tailwind v4 son: red · orange · amber · yellow · lime ·
 * green · emerald · teal · cyan · sky · blue · indigo · violet · purple ·
 * fuchsia · pink · rose · slate · gray · zinc · neutral · stone.
 */
export const PALETAS_FABRICA = [
  "zinc", "slate", "gray", "neutral", "stone", "red", "emerald", "green",
  "blue", "sky", "amber", "orange", "yellow", "indigo", "purple", "rose",
  "cyan", "teal", "lime", "violet", "fuchsia", "pink",
];

/** Los radios de la escala del design system (md 6px · lg 8px · full · none). */
export const ESCALA_RADIOS = ["md", "lg", "full", "none"];

/**
 * Los pesos de fuente NO son familias: `font-bold` no es una fuente fuera del
 * tema (y `font-black` tampoco, aunque "black" también sea un color).
 */
const PESOS_FUENTE = new Set([
  "thin", "extralight", "light", "normal", "medium", "semibold", "bold",
  "extrabold", "black",
]);

/** Las familias de fuente que SÍ salen del `@theme`. */
const FAMILIAS_TEMA = new Set(["sans", "mono"]);

/** Los tokens que el `@theme` tiene que declarar. */
export const TOKENS_ESPERADOS = [
  "surface", "surface-2", "surface-3", "line", "line-strong",
  "fg", "fg-muted", "fg-subtle", "primary", "primary-fg",
  "success", "danger", "warning", "transfer", "focus",
];

/** Las utilidades de color que pueden llevar una paleta. */
const UTILIDADES_COLOR =
  "bg|text|border|ring|fill|stroke|divide|outline|decoration|accent|caret|placeholder|from|via|to";

/** Las mismas, como lista (para la regla 7: ¿esto es un color?). */
const UTILIDADES_COLOR_LISTA = UTILIDADES_COLOR.split("|");

/* ─────────────────────────────────────────────────────────────────────────────
 * EL LECTOR DE ARCHIVOS
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Los directorios que el gate NO mira.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTA LISTA ESTÁ PARTIDA EN DOS
 * `reports` (la carpeta de salida de las auditorías) estaba en la lista de
 * ignorados POR NOMBRE, y eso hacía invisible CUALQUIER directorio llamado
 * `reports`: también `app/api/reports/`, que es código de la app. El gate
 * veía 92 de los 93 archivos de `app/`, `components/` y `lib/` (comprobado:
 * `app/api/reports/route.ts` no estaba en la lista).
 *
 * Ahora: los directorios de SALIDA se ignoran sólo en la raíz del repo, y los
 * de dependencias (`node_modules`, `.next`) se ignoran en cualquier nivel.
 */
const IGNORADOS_SOLO_RAIZ = new Set([
  "reports", "coverage", "dist", "out", ".turbo", "playwright-report",
  "test-results", "f9r5-cdp-profile",
]);

const IGNORADOS_CUALQUIER_NIVEL = new Set(["node_modules", ".next", ".git"]);

/** Los directorios donde vive la INTERFAZ (lo que el gate mira). */
const DIRECTORIOS = ["app", "components", "lib"];

/** Todos los archivos de código del repo que pueden tener clases. */
export function archivosCodigo(raiz = RAIZ) {
  const encontrados = [];
  const recorrer = (dir, raizDelRepo = false) => {
    let entradas;
    try {
      entradas = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entrada of entradas) {
      if (IGNORADOS_CUALQUIER_NIVEL.has(entrada.name)) continue;
      if (raizDelRepo && IGNORADOS_SOLO_RAIZ.has(entrada.name)) continue;
      const p = join(dir, entrada.name);
      if (entrada.isDirectory()) {
        recorrer(p, false);
        continue;
      }
      if (entrada.isFile() && /\.(tsx|ts)$/.test(entrada.name)) {
        encontrados.push(p);
      }
    }
  };
  // Sólo la interfaz: `scripts/` es el arnés (y ahí el texto «font-family»
  // aparece en los tests del gate de CSS, no en una clase).
  for (const d of DIRECTORIOS) recorrer(join(raiz, d), false);
  return encontrados.sort();
}

/**
 * Deja el archivo sin comentarios (los comentarios se vacían pero se conservan
 * los saltos de línea): los comentarios explican el código, y un emoji en un
 * comentario no es un icono.
 */
export function sinComentarios(texto) {
  let salida = "";
  let i = 0;
  const n = texto.length;
  while (i < n) {
    const c = texto[i];
    if (c === "/" && texto[i + 1] === "/") {
      while (i < n && texto[i] !== "\n") {
        salida += " ";
        i += 1;
      }
      continue;
    }
    if (c === "/" && texto[i + 1] === "*") {
      while (i < n && !(texto[i] === "*" && texto[i + 1] === "/")) {
        salida += texto[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      salida += "  ";
      i += 2;
      continue;
    }
    salida += c;
    i += 1;
  }
  return salida;
}

/**
 * Los literales de texto del archivo (los lugares donde puede haber una lista
 * de clases). Los comentarios quedan afuera.
 */
export function literales(texto) {
  const out = [];
  const limpio = sinComentarios(texto);
  let i = 0;
  const n = limpio.length;
  while (i < n) {
    const c = limpio[i];
    if (c === '"' || c === "'" || c === "`") {
      const cierre = c;
      i += 1;
      const inicio = i;
      while (i < n) {
        if (limpio[i] === "\\") {
          i += 2;
          continue;
        }
        if (limpio[i] === cierre) break;
        i += 1;
      }
      out.push({ inicio, fin: i, valor: limpio.slice(inicio, i) });
      i += 1;
      continue;
    }
    i += 1;
  }
  return out;
}

/** La línea (1-based) de un desplazamiento. */
function lineaDe(texto, desplazamiento) {
  let linea = 1;
  for (let i = 0; i < desplazamiento && i < texto.length; i += 1) {
    if (texto[i] === "\n") linea += 1;
  }
  return linea;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * LAS REGLAS
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Analiza un archivo y devuelve sus violaciones.
 *
 * @param {string} contenido
 * @param {string} archivo
 * @returns {{regla:string, linea:number, detalle:string}[]}
 */
export function analizarArchivo(contenido, archivo = "(archivo)") {
  const violaciones = [];
  const sinCom = sinComentarios(contenido);

  // ── Regla 2 · emoji como icono ───────────────────────────────────────────
  // Se busca en el archivo SIN comentarios: un emoji en un comentario no es
  // un icono, pero sí lo es en el texto de la interfaz.
  const emojiRe = /\p{Extended_Pictographic}/gu;
  let m;
  while ((m = emojiRe.exec(sinCom)) !== null) {
    violaciones.push({
      regla: "emoji",
      linea: lineaDe(sinCom, m.index),
      detalle: `«${m[0]}» es un icono de otra tipografía: usá un icono de lucide-react`,
    });
  }

  // ── Regla 4 (bis) · un color suelto en un ESTILO EN LÍNEA ────────────────
  // `style={{ color: "#07111F" }}`: el color no está en una clase, así que la
  // regla de las clases no lo ve. El patrón va sobre el archivo entero (sin
  // comentarios) porque la clave y el valor están en literales distintos.
  const estiloEnLinea =
    /\b(color|background|backgroundColor|borderColor|fill|stroke|outlineColor|textDecorationColor)\s*:\s*["'`]?#[0-9a-fA-F]{3,8}\b/g;
  while ((m = estiloEnLinea.exec(sinCom)) !== null) {
    violaciones.push({
      regla: "hex-suelto",
      linea: lineaDe(sinCom, m.index),
      detalle: `«${m[0]}» es un color sin nombre: va en el @theme como token`,
    });
  }

  // ── Las reglas de clase, sobre los literales ─────────────────────────────
  for (const lit of literales(contenido)) {
    const clases = lit.valor.split(/[\s"'`]+/).filter(Boolean);
    for (const clase of clases) {
      // Las variantes (`hover:`, `dark:`, `md:`…) NO se pierden: el prefijo
      // `dark:` es lo que la regla 7 prohibe.
      const partes = clase.split(":");
      const base = partes[partes.length - 1] ?? clase;
      const variantes = partes.slice(0, -1);

      // 1 · la paleta de fábrica.
      const familia = base.match(
        new RegExp(`^(?:${UTILIDADES_COLOR})-(${PALETAS_FABRICA.join("|")})-\\d`),
      );
      if (familia) {
        violaciones.push({
          regla: "paleta-fabrica",
          linea: lineaDe(contenido, lit.inicio),
          detalle: `«${clase}» es la paleta por defecto de Tailwind: usá un token (${familia[1]} → semántico)`,
        });
        continue;
      }

      // 3 · el radio fuera de escala.
      //   · `rounded` pelado, `rounded-[10px]` (arbitrario) y las variantes
      //     lógicas de esquina (`rounded-ss-xl`) salen todos por el mismo
      //     camino: el ÚLTIMO segmento es el tamaño y tiene que estar en la
      //     escala.
      if (/^rounded(\[|-[a-z]*\[)/.test(base)) {
        violaciones.push({
          regla: "radio-fuera-de-escala",
          linea: lineaDe(contenido, lit.inicio),
          detalle: `«${clase}» es un radio arbitrario: la escala es md 6px · lg 8px · full · none`,
        });
      } else if (base.startsWith("rounded")) {
        const segmentos = base.split("-");
        const tam = segmentos.length === 1 ? "" : segmentos[segmentos.length - 1];
        if (!ESCALA_RADIOS.includes(tam)) {
          violaciones.push({
            regla: "radio-fuera-de-escala",
            linea: lineaDe(contenido, lit.inicio),
            detalle: `«${clase}» está fuera de la escala (md 6px · lg 8px · full · none)`,
          });
        }
      }

      // 4 · un color suelto: el hex y también las otras notaciones
      //     (`bg-[rgb(7,17,31)]`, `bg-[oklch(...)]`) y el color de un estilo
      //     en línea (`style={{ color: "#07111F" }}`).
      const colorSuelto =
        /\[#[0-9a-fA-F]{3,8}\]/.test(clase) ||
        /\[(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\([^)\]]*\)\]/.test(clase);
      if (colorSuelto) {
        violaciones.push({
          regla: "hex-suelto",
          linea: lineaDe(contenido, lit.inicio),
          detalle: `«${clase}» es un color sin nombre: va en el @theme como token`,
        });
      }

      // 5 · un gradiente.
      //   En Tailwind v4 el gradiente se llama `bg-linear-*` (el nombre viejo
      //   `bg-gradient-*` se migra solo) y el radial es `bg-radial-*`.
      if (
        /^bg-(gradient|linear|radial)-/.test(base) ||
        /^(from|via|to)-/.test(base)
      ) {
        violaciones.push({
          regla: "gradiente",
          linea: lineaDe(contenido, lit.inicio),
          detalle: `«${clase}» es un gradiente: el estilo «C · Noche» no tiene ninguno`,
        });
      }

      // 6 · una fuente fuera del tema.
      if (base.startsWith("font-")) {
        const valor = base.slice(5);
        const fueraDelTema =
          valor.startsWith("[") ||
          (!PESOS_FUENTE.has(valor) && !FAMILIAS_TEMA.has(valor));
        if (fueraDelTema) {
          violaciones.push({
            regla: "fuente-fuera-del-tema",
            linea: lineaDe(contenido, lit.inicio),
            detalle: `«${clase}»: la fuente sale del @theme (font-sans / font-mono)`,
          });
        }
      }

      // 7 · `dark:` en un COLOR.
      //   El token ya es el del esquema que está en pantalla: el markup no
      //   lleva `dark:` en ningún color (docs/design-system.md §5.8).
      if (variantes.includes("dark")) {
        const esColor = UTILIDADES_COLOR_LISTA.some(
          (u) => base === u || base.startsWith(`${u}-`),
        );
        if (esColor) {
          violaciones.push({
            regla: "dark-en-un-color",
            linea: lineaDe(contenido, lit.inicio),
            detalle: `«${clase}»: el token ya es el del esquema; el markup no lleva «dark:» en ningún color`,
          });
        }
      }
    }
  }

  return violaciones;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * EL PROGRAMA
 * ───────────────────────────────────────────────────────────────────────────── */

function main() {
  const argumentos = process.argv.slice(2);
  const iniciales = argumentos.length
    ? argumentos.map((a) => resolve(a))
    : archivosCodigo();

  const problemas = [];
  let ok = 0;
  let fail = 0;

  for (const archivo of iniciales) {
    let contenido = "";
    try {
      contenido = readFileSync(archivo, "utf8");
    } catch (error) {
      fail += 1;
      problemas.push({
        archivo: relative(RAIZ, archivo),
        linea: 0,
        regla: "lectura",
        detalle: String(error.message ?? error),
      });
      continue;
    }
    ok += 1; // el archivo se pudo leer

    const violaciones = analizarArchivo(contenido, relative(RAIZ, archivo));
    // Un check por regla: si la regla se respeta en este archivo, cuenta ok.
    const reglas = new Set(violaciones.map((v) => v.regla));
    const reglasEvaluadas = 7;
    if (violaciones.length === 0) {
      ok += reglasEvaluadas;
    } else {
      ok += reglasEvaluadas - reglas.size;
      fail += 1; // el archivo falla (una vez), abajo se detallan todas
    }
    for (const v of violaciones) {
      problemas.push({ archivo: relative(RAIZ, archivo), ...v });
    }
  }

  // El check de repo: el `@theme` tiene que declarar los tokens.
  const globals = join(RAIZ, "app", "globals.css");
  let tema = "";
  try {
    tema = readFileSync(globals, "utf8");
  } catch {
    tema = "";
  }
  const faltantes = TOKENS_ESPERADOS.filter(
    (t) => !tema.includes(`--color-${t}: var(--${t})`),
  );
  if (faltantes.length === 0) ok += 1;
  else {
    fail += 1;
    problemas.push({
      archivo: "app/globals.css",
      linea: 0,
      regla: "tokens",
      detalle: `el @theme no declara: ${faltantes.join(", ")}`,
    });
  }

  // ── El segundo check de repo: los tokens tienen VALOR en los DOS esquemas.
  //
  // POR QUÉ ESTE CHECK EXISTE
  // El primero sólo mira que el `@theme` DECLARE los quince tokens
  // (`--color-fg-subtle: var(--fg-subtle)`). Con eso, borrar el VALOR de un
  // token en `:root` pasaba el gate con exit 0: el token queda muerto (la
  // utilidad compila a un `var(--fg-subtle)` sin definir) y nadie se entera.
  // Un token sin valor es un token que no entra.
  const sinValor = tokensSinValor(tema);
  if (sinValor.length === 0) ok += 1;
  else {
    fail += 1;
    problemas.push({
      archivo: "app/globals.css",
      linea: 0,
      regla: "tokens",
      detalle: `el token no tiene valor en: ${sinValor.join(", ")}`,
    });
  }

  if (problemas.length > 0) {
    console.log("Estilo propio (no permitido):\n");
    for (const p of problemas) {
      const donde = p.linea > 0 ? `${p.archivo}:${p.linea}` : p.archivo;
      console.log(`  · ${donde} — ${p.regla}: ${p.detalle}`);
    }
    console.log("");
  } else {
    console.log(
      `Estilo propio: ${iniciales.length} archivo(s) sin color de fábrica, sin emoji, sin radio fuera de escala, sin color suelto, sin gradiente, sin fuente fuera del tema y sin «dark:» en un color.`,
    );
  }

  console.log(`RESULT ok=${ok} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

/**
 * Los tokens que NO tienen valor en los dos esquemas.
 *
 * El CSS global tiene el esquema claro en el `:root` de la capa base y el
 * «Noche» en el `@media (prefers-color-scheme: dark)`. Un token al que le
 * falta el valor en cualquiera de los dos es un token muerto en ese esquema.
 */
export function tokensSinValor(css) {
  const claro = css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)"));
  const oscuro = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
  const tiene = (bloque, token) =>
    new RegExp(`--${token}\\s*:\\s*(#[0-9a-fA-F]{3,8}|oklch\\([^)]*\\)|rgb\\([^)]*\\))`).test(bloque);
  const faltan = [];
  for (const t of TOKENS_ESPERADOS) {
    if (!tiene(claro, t)) faltan.push(`claro:${t}`);
    if (!tiene(oscuro, t)) faltan.push(`oscuro:${t}`);
  }
  return faltan;
}

const invocadoDirecto =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invocadoDirecto) main();
