#!/usr/bin/env node
/**
 * check-css-puro.mjs — el candado de «cero CSS a mano».
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ EXISTE
 * La persona pidió «una migración completa a tailwindcss: no puede estar en css
 * común el proyecto». En un proyecto Tailwind v4 el CSS global es donde vive
 * la CONFIGURACIÓN (`@theme`, `@custom-variant`, `@utility`, `@layer base`), y
 * lo que sobra —y no puede volver— es el ESTILO DE COMPONENTE escrito a mano
 * (selectores sueltos tipo `.monto-tarjeta { }` o `body { }`).
 *
 * Sin un candado, la primera persona que necesite un color raro abre el CSS
 * global y escribe una regla: en tres meses el proyecto vuelve a tener «css
 * común». Este script es el que dice que no.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ ACEPTA
 * En el nivel superior de un archivo `.css` sólo se aceptan:
 *
 *   · `@import`         — el import de Tailwind y los que hagan falta.
 *   · `@theme`          — el design system (variables). acá vive la fuente.
 *   · `@custom-variant` — las variantes propias (`touch:`, `angosta:`).
 *   · `@utility`        — las utilidades propias del proyecto.
 *   · `@layer base`     — los DEFAULTS de elemento (el objetivo táctil de 44 px).
 *
 * Y dentro de esos at-rules se puede escribir lo que haga falta: son la
 * configuración. Lo que no se puede es un SELECTOR suelto en cualquier otro
 * lugar (`body { }`, `.algo { }`, un `@media` con reglas en el nivel superior,
 * un `@layer components { .card { } }`).
 *
 * Además hay una regla que blinda el bug que motivó esta ronda: la
 * `font-family` NO se puede declarar fuera del `@theme` (por eso la app
 * renderizaba en Arial: la fuente se pisaba con una regla a mano). La fuente
 * sale del theme y de la utilidad `font-sans`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRATO DE SALIDA (el mismo que la auditoría y las baterías)
 *   · imprime `RESULT ok=N fail=M` en la última línea;
 *   · sale con código 1 si hay alguna falla, 0 si no.
 *
 * El conteo: un check por archivo (que se pueda leer) + un check por
 * construcción de nivel superior (que sea configuración permitida) + un check
 * de repo (que haya un CSS que importe Tailwind). Una construcción con
 * problemas cuenta como FALLA (una vez), y abajo se detailan todos.
 *
 * Uso:
 *   node scripts/check-css-puro.mjs               # todos los .css del repo
 *   node scripts/check-css-puro.mjs app/x.css     # sólo esos archivos
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** At-rules que pueden aparecer en el nivel superior de un CSS. */
const AT_NIVEL_SUPERIOR = new Set([
  "import",
  "charset",
  "theme",
  "custom-variant",
  "utility",
  "layer",
]);

/**
 * At-rules dentro de los cuales el contenido es LIBRE: son la forma
 * oficial de declarar configuración y utilidades.
 *
 *   · `@theme` / `@custom-variant` / `@utility` declaran el design system.
 *   · `@layer base` es donde viven los defaults de ELEMENTO (el objetivo
 *     táctil de 44 px): no es estilo de componente, es el piso del sistema.
 *
 * OJO: «libre» NO significa «cualquier cosa». El contenido sigue teniendo
 * reglas (ver `contextoDe`): en `@theme` y `@utility` no puede haber un
 * SELECTOR (eso sería el estilo de un componente escrito a mano) y en
 * `@layer base` sólo puede haber defaults de ELEMENTO (selectores de tipo:
 * `button`, `input`, `button:hover`…; nunca `.mi-clase`).
 *
 * Este matiz lo encontró el tester de la Fase 9: con `@layer base`Declared
 * libre, el gate aceptaba `@layer base { .mi-estilo { … } }` — o sea, el
 * gate «puro» dejaba pasar CSS a mano, y ese CSS se aplicaba de verdad en
 * la app (medido: `getComputedStyle(.monto-ficha).color` = rgb(255, 0, 0)).
 */
const CONTEXTO_LIBRE = new Set(["theme", "custom-variant", "utility"]);

/** Propiedades que fijan la fuente: sólo se pueden declarar en `@theme`. */
const PROPIEDADES_FUENTE = new Set(["font", "font-family", "-webkit-font-family"]);

/**
 * ¿Este selector es un DEFAULT DE ELEMENTO (o sea, un selector de tipo)?
 *
 * `button`, `input`, `select`, `textarea`, `button:hover`, `*` → sí.
 * `.mi-clase`, `#mi-id`, `input[type="text"]` → no: son selectores de
 * clase/id/atributo, y un selector de clase en la capa base es estilo de
 * componente escrito a mano.
 */
export function esDefaultDeElemento(selector) {
  return selector
    .split(",")
    .map((parte) => parte.trim())
    .filter((parte) => parte.length > 0)
    .every((parte) => !/[.#\[]/.test(parte));
}

/**
 * ¿En qué contexto está el selector que se está leyendo?
 *
 * Se mira la pila de construcciones de ABAJO hacia ARRIBA y gana el
 * contexto más específico:
 *
 *   · "theme"          → dentro de `@theme` (o de algo anidado en él).
 *   · "utility"        → dentro de `@utility`.
 *   · "custom-variant" → dentro de `@custom-variant` (el cuerpo de una
 *                         variante es una variante: puede ser un selector
 *                         `&:hover`, como el patrón oficial de Tailwind).
 *   · "layer-base"     → dentro de `@layer base`.
 *   · "libre"          → dentro de una variante (el contexto anterior).
 *   · "ninguno"        → en el nivel superior o dentro de cualquier otra
 *                         cosa (`@media` suelto, `@layer components`…).
 */
function contextoDe(pila) {
  let hayVariante = false;
  for (const c of pila) {
    if (c.tipo !== "atrule") continue;
    if (c.nombre === "theme") return "theme";
    if (c.nombre === "utility") return "utility";
    if (c.nombre === "custom-variant") hayVariante = true;
    if (c.nombre === "layer" && c.params.trim() === "base") return "layer-base";
  }
  return hayVariante ? "libre" : "ninguno";
}

/* ─────────────────────────────────────────────────────────────────────────────
 * EL LECTOR DE CSS
 *
 * Un lector propio, sin dependencias: recorre el archivo y anota dónde
 * empieza cada construcción. No necesita entender CSS entero —sólo saber
 * qué es un at-rule, qué es un selector y qué es una declaración— y eso lo
 * hace sin confundirse con un `{` dentro de un comentario o de una cadena.
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Analiza un CSS y devuelve sus construcciones de nivel superior y los
 * problemas de cada una.
 *
 * @param {string} css      el contenido del archivo
 * @param {string} archivo  el nombre del archivo (para el reporte)
 * @returns {{construcciones: {texto:string, linea:number, problemas:{linea:number, motivo:string, detalle:string}[]}[], problemas:{linea:number, motivo:string, detalle:string}[]}}
 */
export function analizarCss(css, archivo = "(css)") {
  const construcciones = [];
  const problemas = [];
  const imports = [];
  const pila = [];

  let i = 0;
  let linea = 1;
  let preludio = "";
  let preludioLinea = 1;
  const n = css.length;

  /** La construcción de nivel superior a la que pertenece lo que se lee. */
  const actual = () => construcciones[construcciones.length - 1];

  /** ¿Estamos dentro de un `@theme`? (la fuente sólo se declara ahí) */
  const enTheme = () =>
    pila.some((c) => c.tipo === "atrule" && c.nombre === "theme");

  const problema = (motivo, detalle, enLinea = linea) => {
    const p = { archivo, linea: enLinea, motivo, detalle };
    problemas.push(p);
    if (actual()) actual().problemas.push(p);
  };

  while (i < n) {
    const ch = css[i];

    // Comentario: se salta entero (puede tener llaves adentro).
    if (ch === "/" && css[i + 1] === "*") {
      const fin = css.indexOf("*/", i + 2);
      const hasta = fin === -1 ? n : fin + 2;
      linea += (css.slice(i, hasta).match(/\n/g) ?? []).length;
      i = hasta;
      continue;
    }

    // Cadena: se lee entera (puede tener llaves adentro).
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (css[j] === "\\") j += 2;
        else if (css[j] === ch) {
          j += 1;
          break;
        } else {
          if (css[j] === "\n") linea += 1;
          j += 1;
        }
      }
      preludio += css.slice(i, j);
      i = j;
      continue;
    }

    if (ch === "{") {
      const texto = preludio.trim();
      if (texto.startsWith("@")) {
        const m = /^@([\w-]+)\s*([\s\S]*)$/.exec(texto);
        const nombre = m ? m[1] : texto.slice(1);
        const params = m ? m[2].trim() : "";
        if (pila.length === 0) {
          if (!AT_NIVEL_SUPERIOR.has(nombre)) {
            construcciones.push({
              texto: `@${nombre} ${params}`.trim(),
              linea: preludioLinea,
              problemas: [],
            });
            problema(
              "at-rule no permitido en el nivel superior",
              `@${nombre} ${params}`.trim(),
              preludioLinea,
            );
          } else {
            construcciones.push({
              texto: `@${nombre} ${params}`.trim(),
              linea: preludioLinea,
              problemas: [],
            });
          }
        }
        pila.push({ tipo: "atrule", nombre, params });
      } else {
        if (pila.length === 0) {
          construcciones.push({ texto, linea: preludioLinea, problemas: [] });
        }
        // Un SELECTOR. Depende del contexto en el que vive:
        const contexto = contextoDe(pila);
        if (contexto === "ninguno") {
          problema(
            "selector suelto: el estilo de un componente no vive en el CSS global",
            texto,
            preludioLinea,
          );
        } else if (contexto === "theme" || contexto === "utility") {
          problema(
            `un selector no puede vivir dentro de @${contexto}: eso es el estilo de un componente escrito a mano`,
            texto,
            preludioLinea,
          );
        } else if (contexto === "layer-base" && !esDefaultDeElemento(texto)) {
          problema(
            "selector de clase dentro de @layer base: en la capa base sólo hay defaults de ELEMENTO (button, input…)",
            texto,
            preludioLinea,
          );
        }
        pila.push({ tipo: "rule", selector: texto });
      }
      preludio = "";
      i += 1;
      continue;
    }

    if (ch === "}") {
      pila.pop();
      preludio = "";
      i += 1;
      continue;
    }

    if (ch === ";") {
      const texto = preludio.trim();
      if (texto.startsWith("@")) {
        const m = /^@([\w-]+)\s*([\s\S]*)$/.exec(texto);
        const nombre = m ? m[1] : texto.slice(1);
        if (pila.length === 0) {
          construcciones.push({ texto: `@${nombre}`, linea: preludioLinea, problemas: [] });
          if (!AT_NIVEL_SUPERIOR.has(nombre)) {
            problema(
              "at-rule no permitido en el nivel superior",
              `@${nombre}`,
              preludioLinea,
            );
          }
        }
        // Un `@import` es la puerta de entrada a otro archivo: hay que
        // recordarlo para escanearlo también (si no, el CSS a mano se
        // esconde en el archivo importado y el gate no lo ve).
        if (nombre === "import") {
          const mImport = /["']([^"']+)["']/.exec(texto);
          if (mImport) imports.push(mImport[1]);
        }
      } else if (texto.length > 0) {
        const propiedad = texto.split(":")[0].trim().toLowerCase();
        if (pila.length === 0) {
          problema("declaración suelta en el nivel superior", texto, preludioLinea);
        } else if (PROPIEDADES_FUENTE.has(propiedad) && !enTheme()) {
          problema(
            "la fuente se declara en el `@theme`, no en una regla a mano",
            texto,
            preludioLinea,
          );
        }
      }
      preludio = "";
      i += 1;
      continue;
    }

    if (ch === "\n") {
      linea += 1;
      preludio += ch;
      i += 1;
      continue;
    }

    if (preludio.trim() === "" && !/\s/.test(ch)) {
      preludioLinea = linea;
    }
    preludio += ch;
    i += 1;
  }

  if (preludio.trim().length > 0) {
    problema("el archivo termina con una construcción sin cerrar", preludio.trim());
  }

  return { construcciones, problemas, imports };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * EL RECORRIDO DEL REPO
 * ───────────────────────────────────────────────────────────────────────────── */

const IGNORADOS = new Set([
  "node_modules",
  ".next",
  ".git",
  "coverage",
  "reports",
  "dist",
  "out",
  ".turbo",
  "playwright-report",
  "test-results",
]);

/** Todos los `.css` del repo (menos los directorios que no son código). */
export function archivosCss(raiz = RAIZ) {
  const encontrados = [];
  const recorrer = (dir) => {
    let entradas;
    try {
      entradas = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entrada of entradas) {
      if (entrada.isDirectory()) {
        if (IGNORADOS.has(entrada.name)) continue;
        recorrer(join(dir, entrada.name));
        continue;
      }
      if (entrada.isFile() && entrada.name.toLowerCase().endsWith(".css")) {
        encontrados.push(join(dir, entrada.name));
      }
    }
  };
  recorrer(raiz);
  return encontrados.sort();
}

/* ─────────────────────────────────────────────────────────────────────────────
 * EL PROGRAMA
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * ¿Este `@import` es un archivo del proyecto (y no un paquete)?
 *
 * Sólo se siguen los imports RELATIVOS (`./x.css`, `../x.css`, `/x.css`):
 * un `@import "tailwindcss"` es un paquete (tercero) y no se escanea.
 */
function esImportRelativo(ruta) {
  return (
    ruta.startsWith("./") ||
    ruta.startsWith("../") ||
    ruta.startsWith("/") ||
    ruta.startsWith(".\\") ||
    ruta.startsWith("..\\")
  );
}

function main() {
  const argumentos = process.argv.slice(2);
  const iniciales = argumentos.length
    ? argumentos.map((a) => resolve(a))
    : archivosCss();

  const problemas = [];
  let ok = 0;
  let fail = 0;

  // Los archivos ya escaneados (para no escanear dos veces el mismo).
  const escaneados = new Set();
  // La cola de archivos por escanear (los imports se agregan sobre la marcha).
  const cola = [...iniciales];
  // Los archivos que el gate miró (para el check de «importa Tailwind»).
  const vistos = [];

  while (cola.length > 0) {
    const archivo = cola.shift();
    if (escaneados.has(archivo)) continue;
    escaneados.add(archivo);

    let contenido = "";
    try {
      contenido = readFileSync(archivo, "utf8");
    } catch (error) {
      fail += 1;
      problemas.push({
        archivo,
        linea: 0,
        motivo: "no se puede leer el archivo",
        detalle: String(error.message ?? error),
      });
      continue;
    }
    ok += 1; // el archivo se pudo leer
    vistos.push({ archivo, contenido });
    const { construcciones, problemas: delArchivo, imports } = analizarCss(
      contenido,
      relative(RAIZ, archivo),
    );
    problemas.push(...delArchivo);
    for (const construccion of construcciones) {
      if (construccion.problemas.length > 0) fail += 1;
      else ok += 1;
    }

    // Los `@import` relativos: el archivo importado entra al radar también.
    // (Sin esto, el CSS a mano se esconde en el archivo importado: el gate
    // decía «CSS puro» mientras la app pintaba los montos de rojo.)
    for (const ruta of imports) {
      if (!esImportRelativo(ruta)) continue;
      const destino = resolve(dirname(archivo), ruta);
      if (destino.includes(`${sep}node_modules${sep}`)) continue;
      if (!existsSync(destino)) {
        fail += 1;
        problemas.push({
          archivo: relative(RAIZ, archivo),
          linea: 0,
          motivo: "el `@import` apunta a un archivo que no existe",
          detalle: ruta,
        });
        continue;
      }
      if (!escaneados.has(destino)) cola.push(destino);
    }
  }

  // El check de repo: tiene que haber un CSS que importe Tailwind.
  const importaTailwind = vistos.some(({ contenido }) =>
    /@import\s+["']tailwindcss["']/.test(contenido),
  );
  if (importaTailwind) ok += 1;
  else {
    fail += 1;
    problemas.push({
      archivo: "(repo)",
      linea: 0,
      motivo: "ningún CSS importa Tailwind",
      detalle: 'falta @import "tailwindcss"',
    });
  }

  if (problemas.length > 0) {
    console.log("CSS a mano (no permitido):\n");
    for (const p of problemas) {
      const donde = p.linea > 0 ? `${p.archivo}:${p.linea}` : p.archivo;
      console.log(`  · ${donde} — ${p.motivo}`);
      if (p.detalle) console.log(`      ${p.detalle}`);
    }
    console.log("");
  } else {
    console.log(
      `CSS puro: ${vistos.length} archivo(s) con sólo configuración de Tailwind.`,
    );
  }

  console.log(`RESULT ok=${ok} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

// Sólo se ejecuta como programa si se lo llama directo (no al importarlo).
const invocadoDirecto =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invocadoDirecto) main();
