#!/usr/bin/env node
/**
 * medir-fuente.mjs — las MÉTRICAS de la fuente, medidas en el navegador.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTE SCRIPT EXISTE
 * ─────────────────────────────────────────────────────────────────────────────
 * El avance de un glifo (el ancho que ocupa) es una MÉTRICA DE LA FUENTE: no
 * es un número que se pueda elegir. Depende de cada glifo, del peso y de las
 * variantes numéricas. El modelo de medidas de `lib/format.ts` (el factor que
 * hace que un monto ENTRE en su tarjeta) está calibrado con esos números, así
 * que cuando cambia la fuente hay que VOLVER A MEDIR: si no, el modelo queda
 * descalibrado y el monto se sale de su caja (o se achica de más).
 *
 * El script tiene dos modos:
 *
 *   · `--candidatas` — mide las fuentes CANDIDATAS en una página local. Sirve
 *     para decidir (cifras tabulares reales, peso 800 real) antes de tocar la
 *     app. Descarga los `.woff2` de Google Fonts (los MISMOS que baja
 *     `next/font` en el build) y los sirve desde acá: no hay peticiones a
 *     Google en runtime, ni en la app ni en la medición.
 *
 *   · (por defecto) — mide la fuente REAL de la app que está arriba
 *     (`--url http://127.0.0.1:3101`): lo que se ve es lo que el navegador
 *     calcula con el `@font-face` que generó `next/font`. Es la cifra que
 *     calibra el modelo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LO QUE MIDE (y por qué el motor de texto manda)
 * ─────────────────────────────────────────────────────────────────────────────
 *   · el avance (en `em`) de cada dígito, de los separadores (`.` y `,`), del
 *     `$`, del espacio, del `+` y de la `−`, en los pesos que usa la app;
 *   · lo MISMO con `font-variant-numeric: tabular-nums`: con cifras
 *     tabulares el avance de `0`, `1` y `8` tiene que ser IDÉNTICO (si no, el
 *     monto «baila» cuando cambia un dígito);
 *   · si el peso 800 es REAL: se compara el peso declarado por el `FontFace`
 *     (`document.fonts`) con el avance del eje `wght` de la fuente variable. Si
 *     la fuente llega al 800 con su propio eje, no hay negrito sintético.
 *
 * La medición es en el DOM (no en un canvas): el canvas no tiene
 * `font-variant-numeric`, y lo que hay que medir es lo que el navegador
 * LAYOUTEA.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USO
 * ─────────────────────────────────────────────────────────────────────────────
 *   node scripts/medir-fuente.mjs --candidatas
 *   node scripts/medir-fuente.mjs --url http://127.0.0.1:3101
 *   node scripts/medir-fuente.mjs --url http://127.0.0.1:3101 --salida docs/metricas-fuente.md
 */

import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openUi } from "./tester-fase7/cdp.mjs";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));

/* ─────────────────────────────────────────────────────────────────────────────
 * LAS CANDIDATAS (en el orden del brief: la primera que pasa, gana)
 * ─────────────────────────────────────────────────────────────────────────────
 * Cada candidata declara su familia, la consulta de Google Fonts (CSS2) y el
 * rango de peso que trae. `variable: true` = el archivo trae el eje `wght`.
 */
export const CANDIDATAS = [
  {
    id: "archivo",
    familia: "Archivo",
    consulta: "Archivo:wght@100..900",
    variable: true,
    nota: "variable 100-900 · la preferencia del brief",
  },
  {
    id: "public-sans",
    familia: "Public Sans",
    consulta: "Public+Sans:wght@100..900",
    variable: true,
    nota: "variable 100-900 · 1er fallback",
  },
  {
    id: "dm-sans",
    familia: "DM Sans",
    consulta: "DM+Sans:opsz,wght@9..40,100..1000",
    variable: true,
    nota: "variable 100-1000 · 2do fallback",
  },
  {
    id: "figtree",
    familia: "Figtree",
    consulta: "Figtree:wght@300..900",
    variable: true,
    nota: "variable 300-900 · 3er fallback",
  },
];

/**
 * Los glifos que se miden: los de un monto, más los signos.
 *
 * OJO con el espacio: `Intl.NumberFormat("es-AR", {style:"currency"})` separa
 * el `$` del número con U+00A0 (espacio duro), NO con un espacio normal. Y
 * hay dos signos distintos en la app: el «+» (U+002B) y la «−» (U+2212) que
 * escribe el markup de las filas de movimiento, y el «-» (U+002D) que pone
 * `Intl` cuando el número es negativo. Los tres se miden.
 */
const GLIFOS = ["0", "1", "8", "9", ".", ",", "$", " ", "\u00A0", "+", "-", "\u2212"];

/** Los pesos que usa la app: 400 (texto), 700 (fichas), 800 (tarjetas). */
const PESOS = [400, 700, 800];

/** La misma medición, corrida dentro de la página. */
const MEDIR = `(() => {
  const cs = getComputedStyle(document.body);
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;";
  document.body.appendChild(probe);
  const medir = (texto, familia, peso, tabular) => {
    probe.style.fontFamily = familia;
    probe.style.fontSize = "100px";
    probe.style.fontWeight = String(peso);
    probe.style.fontVariantNumeric = tabular ? "tabular-nums" : "normal";
    probe.style.fontVariantNumeric = tabular ? "'tnum' 1" : "normal";
    probe.textContent = texto;
    return probe.getBoundingClientRect().width / 100;
  };
  const redondear = (n) => Math.round(n * 10000) / 10000;
  const pesos = ${JSON.stringify(PESOS)};
  const glifos = ${JSON.stringify(GLIFOS)};
  const medirFamilia = (familia) => {
    const out = { pesos: {}, tabular: {} };
    for (const peso of pesos) {
      const normal = {};
      const tabular = {};
      for (const g of glifos) {
        normal[g] = redondear(medir(g, familia, peso, false));
        tabular[g] = redondear(medir(g, familia, peso, true));
      }
      out.pesos[peso] = normal;
      out.tabular[peso] = tabular;
    }
    return out;
  };
  const faces = [];
  for (const f of document.fonts) {
    faces.push({ familia: f.family, peso: f.weight, estilo: f.style, estado: f.status });
  }
  return {
    body: cs.fontFamily,
    faces,
    archivo: medirFamilia(cs.fontFamily),
    medidas: cs.fontFamily,
  };
})()`;

/* ─────────────────────────────────────────────────────────────────────────────
 * LA PÁGINA DE CANDIDATAS
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Descarga el `.woff2` de la subfamilia `latin` de una familia de Google.
 *
 * Es el MISMO archivo que baja `next/font` con `subsets: ["latin"]`: la CSS2
 * de Google devuelve la fuente variable (o el archivo estático del peso) y el
 * `unicode-range` del subconjunto `latin`. Se toma ese subconjunto porque es
 * el que cubre el castellano (ñ, á, ¿, ¡, — y la «−» U+2212).
 */
async function bajarCss(consulta) {
  const url = `https://fonts.googleapis.com/css2?family=${consulta}&display=swap`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`Google Fonts ${res.status} para ${consulta}`);
  return res.text();
}

/** El bloque `latin` de la CSS de Google: el `url` del woff2 y el peso. */
export function bloqueLatin(css) {
  // `split` con un grupo capturado deja: [antes, nombre, cuerpo, nombre, cuerpo…].
  // Con `.slice(1)` el primer elemento es el primer nombre.
  const bloques = css.split(/\/\*\s*([a-z-]+)\s*\*\//i).slice(1);
  for (let i = 0; i < bloques.length; i += 2) {
    const subconjunto = bloques[i].trim();
    const cuerpo = bloques[i + 1] ?? "";
    if (subconjunto !== "latin") continue;
    const url = cuerpo.match(/url\((https:\/\/[^)]+\.woff2)\)/)?.[1];
    const peso = cuerpo.match(/font-weight:\s*([^;]+);/)?.[1]?.trim() ?? "400";
    if (url) return { url, peso };
  }
  throw new Error("no encontré el subconjunto latin en la CSS de Google");
}

/* ─────────────────────────────────────────────────────────────────────────────
 * EL REPORTE
 * ───────────────────────────────────────────────────────────────────────────── */

/** La tabla de avances de una familia (para el informe y para el doc). */
function tablaDe(medida, titulo) {
  const lineas = [];
  lineas.push(`### ${titulo}`);
  lineas.push("");
  lineas.push("| peso | glifo | avance em (normal) | avance em (tabular-nums) |");
  lineas.push("|---|---|---|---|");
  for (const peso of PESOS) {
    for (const g of GLIFOS) {
      const n = medida.pesos[peso][g];
      const t = medida.tabular[peso][g];
      lineas.push(`| ${peso} | «${g === " " ? " " : g}» | ${n} | ${t} |`);
    }
  }
  lineas.push("");
  return lineas.join("\n");
}

/** ¿Las cifras tabulares son REALES? (0, 1 y 8 con el mismo avance) */
function tabularReal(medida) {
  const out = [];
  for (const peso of PESOS) {
    const t = medida.tabular[peso];
    const iguales = t["0"] === t["1"] && t["1"] === t["8"];
    out.push({
      peso,
      tabular: iguales,
      digitos: [t["0"], t["1"], t["8"]],
      normal: [medida.pesos[peso]["0"], medida.pesos[peso]["1"], medida.pesos[peso]["8"]],
    });
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * EL PROGRAMA
 * ───────────────────────────────────────────────────────────────────────────── */

async function main() {
  const args = process.argv.slice(2);
  const candidatas = args.includes("--candidatas");
  const urlIdx = args.findIndex((a) => a.startsWith("--url"));
  const url = urlIdx >= 0 ? args[urlIdx + 1] : "http://127.0.0.1:3000";
  const salidaIdx = args.findIndex((a) => a.startsWith("--salida"));
  const salida = salidaIdx >= 0 ? args[salidaIdx + 1] : null;

  let server = null;
  let destino = url;
  const archivos = new Map();

  if (candidatas) {
    console.log("Descargando las candidatas (subconjunto latin)…");
    for (const c of CANDIDATAS) {
      const css = await bajarCss(c.consulta);
      const { url: woff, peso } = bloqueLatin(css);
      const res = await fetch(woff);
      if (!res.ok) throw new Error(`No pude bajar el woff2 de ${c.familia}`);
      const buf = Buffer.from(await res.arrayBuffer());
      archivos.set(c.id, buf);
      console.log(
        `  · ${c.familia.padEnd(12)} ${(buf.length / 1024).toFixed(1)} KB · peso declarado: ${peso}`,
      );
    }

    const css = CANDIDATAS.map((c) => {
      const peso = c.variable ? "100 900" : "400";
      return `@font-face { font-family: "${c.familia}"; font-style: normal; font-weight: ${peso}; src: url("/f/${c.id}.woff2") format("woff2"); }`;
    }).join("\n");

    const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>medición</title>
<style>${css}
body { font-family: sans-serif; }</style></head><body><p>medición de fuentes</p></body></html>`;

    server = createServer((req, res) => {
      const m = req.url.match(/^\/f\/([a-z-]+)\.woff2$/);
      if (m && archivos.has(m[1])) {
        res.writeHead(200, { "content-type": "font/woff2" });
        res.end(archivos.get(m[1]));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    destino = `http://127.0.0.1:${server.address().port}/`;
    console.log(`  · página de medición en ${destino}`);
  }

  const ui = await openUi({
    port: 9388,
    profileDir: `${process.env.TEMP ?? "C:\\Windows\\Temp"}\\opencode\\medir-fuente-profile`,
    viewport: { width: 800, height: 600 },
  });

  const informe = [];
  try {
    await ui.navigate(destino);
    // La fuente tiene que estar CARGADA antes de medir: si no, el navegador
    // mide con el fallback y el número es una mentira.
    await ui.evalJs(`document.fonts.ready.then(() => true)`);
    await ui.evalJs(`(async () => { await document.fonts.load("800 16px sans-serif"); return true; })()`);

    if (candidatas) {
      for (const c of CANDIDATAS) {
        // La fuente tiene que estar CARGADA: si se mide sin cargar, el
        // navegador mide con el FALLBACK y el número es una mentira (el
        // fallback mide 0,5 em en todos los dígitos y parece tabular).
        const carga = await ui.evalJs(
          `(async () => {
            const f = await document.fonts.load('800 100px ${c.familia}');
            await document.fonts.ready;
            return {
              cargadas: f.length,
              disponible: document.fonts.check('800 16px ${c.familia}'),
            };
          })()`,
        );
        if (!carga.disponible) {
          console.log(`  · ${c.familia}: la fuente NO se pudo cargar (${JSON.stringify(carga)})`);
          continue;
        }
        const medida = await ui.evalJs(
          `(() => {
            const cs = getComputedStyle(document.body);
            const probe = document.createElement("span");
            probe.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;";
            document.body.appendChild(probe);
            const medir = (t, peso, tabular) => {
              probe.style.fontFamily = ${JSON.stringify(`"${c.familia}"`)};
              probe.style.fontSize = "100px";
              probe.style.fontWeight = String(peso);
              probe.style.fontVariantNumeric = tabular ? "tabular-nums" : "normal";
              probe.textContent = t;
              return Math.round(probe.getBoundingClientRect().width * 10000) / 10000;
            };
            const out = { pesos: {}, tabular: {} };
            for (const peso of ${JSON.stringify(PESOS)}) {
              out.pesos[peso] = {};
              out.tabular[peso] = {};
              for (const g of ${JSON.stringify(GLIFOS)}) {
                out.pesos[peso][g] = medir(g, peso, false);
                out.tabular[peso][g] = medir(g, peso, true);
              }
            }
            return out;
          })()`,
        );
        console.log("");
        console.log(`── ${c.familia} (${c.nota}) ──`);
        console.log(`   fuente cargada: ${carga.disponible ? "sí" : "no"} (${JSON.stringify(carga.cargadas)} face(s))`);
        for (const fila of tabularReal(medida)) {
          console.log(
            `   peso ${fila.peso}: tabular=${fila.tabular ? "SÍ" : "NO"} · ` +
              `dígitos con tnum: ${fila.digitos.join(" / ")} · sin tnum: ${fila.normal.join(" / ")}`,
          );
        }
        const p800 = medida.pesos[800];
        console.log(
          `   peso 800: 0=${p800["0"]} 1=${p800["1"]} 8=${p800["8"]} $=${p800["$"]} ,=${p800[","]} +=${p800["+"]}`,
        );
        informe.push({ familia: c.familia, id: c.id, medida, tabular: tabularReal(medida) });
        if (args.includes("--tabla")) {
          console.log(tablaDe(medida, `${c.familia} — avances (em)`));
        }
      }
    } else {
      const resultado = await ui.evalJs(MEDIR);
      console.log(`Fuente del body: ${resultado.body}`);
      console.log(`FontFaces: ${JSON.stringify(resultado.faces)}`);
      console.log("");
      for (const fila of tabularReal(resultado.archivo)) {
        console.log(
          `   peso ${fila.peso}: tabular=${fila.tabular ? "SÍ" : "NO"} · ` +
            `dígitos con tnum: ${fila.digitos.join(" / ")} · sin tnum: ${fila.normal.join(" / ")}`,
        );
      }
      console.log("");
      console.log(tablaDe(resultado.archivo, "Avances medidos (em)"));
      informe.push({ familia: resultado.body, medida: resultado.archivo, faces: resultado.faces });
    }
  } finally {
    await ui.close();
    if (server) server.close();
  }

  if (salida) {
    const partes = [`# Métricas de la fuente`, ``, `Medido en el navegador (Chrome, motor de texto).`, ``];
    for (const i of informe) {
      partes.push(tablaDe(i.medida, i.familia));
    }
    const destinoArchivo = salida.startsWith("/") || /^[A-Za-z]:/.test(salida)
      ? salida
      : join(RAIZ, salida);
    mkdirSync(join(destinoArchivo, ".."), { recursive: true });
    writeFileSync(destinoArchivo, partes.join("\n"), "utf8");
    console.log(`\nEscrito: ${destinoArchivo}`);
  }
}

await main();
