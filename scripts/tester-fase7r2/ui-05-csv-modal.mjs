#!/usr/bin/env node
/**
 * ui-05 · IMPORTADOR CSV — flujo completo por UI (Fase 7 ronda 2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ ATA CA ESTA BATERÍA
 * ─────────────────────────────────────────────────────────────────────────────
 * `ui-04` midió la geometría del importador (campos, pie sticky, banda) en sus
 * dos estados (vacío y con preview). Lo que falta es el COMPORTAMIENTO:
 *
 *   1. SIN TEXTO: previsualizar avisa por `#csv-error` y NO llama al servidor.
 *   2. PREVIEW VÁLIDO: resumen 2/2/0/0/0, filas «Válida», totales, categoría
 *      nueva anunciada y `#csv-confirm` habilitado. Exactamente 1 POST.
 *   3. INVALIDACIÓN: cambiar el texto quita el preview y deshabilita confirmar
 *      (nadie confirma algo distinto de lo que previsualizó). Después se puede
 *      volver a previsualizar.
 *   4. FILA INVÁLIDA: `invalidRows=1` bloquea confirmar; el click (en un botón
 *      deshabilitado) no importa NADA: 0 commits y la línea base de hoy intacta.
 *   5. ARCHIVO: `#csv-file` via `DOM.setFileInputFiles` (CDP) llena el textarea
 *      con el contenido, muestra el nombre y también invalida el preview.
 *   6. DOBLE CLICK EN CONFIRMAR: exactamente 1 POST a `/api/import/csv` y
 *      exactamente 2 movimientos nuevos (el candado de busy de la UI + el
 *      advisory lock del servidor). Vista de resultado con totales.
 *   7. `onImported`: el panel de atrás ya muestra las descripciones importadas
 *      antes de cerrar; cerrar con «Listo» esconde el pie (no queda un
 *      confirmar fantasma).
 *   8. RE-PEGAR el mismo CSV: 2 duplicadas, 0 importables, confirmar
 *      deshabilitado y el aviso ámbar. Sigue habiendo 1 solo commit.
 *
 * El POST de commit se cuenta filtrando los `/preview` de los fetches
 * instrumentados: ambos comparten el prefijo `/api/import/csv`.
 *
 * Requiere: server en :3000 (build final). Chrome propio en el puerto 9355.
 */

import { writeFileSync } from "node:fs";
import {
  OUT_TMP,
  abrirPanel,
  check,
  checkTrue,
  dialogosNativos,
  get,
  instrumentar,
  localToday,
  openUi,
  pedidosA,
  runScript,
  section,
  sleep,
  tapInfo,
} from "./lib.mjs";

const TAG = "T_T7R2_UI5";
const PUERTO = 9355;

runScript({
  tag: TAG,
  main: async (prisma) => {
    /* ── Preparación ─────────────────────────────────────────────────────── */
    section("Preparación — cuentas propias y línea base de hoy");
    const banco = await prisma.account.create({
      data: { name: `${TAG} Banco`, kind: "BANK" },
    });
    const efectivo = await prisma.account.create({
      data: { name: `${TAG} Efectivo`, kind: "CASH" },
    });
    console.log(`  · cuentas: ${banco.name}, ${efectivo.name}`);

    const hoy = localToday();
    const movsHoy = async () => {
      const res = await get(`/api/transactions?from=${hoy}&to=${hoy}`);
      if (res.status !== 200) throw new Error(`/api/transactions de hoy: ${res.status}`);
      return res.body?.movements ?? [];
    };
    const idsHoy = async () => (await movsHoy()).map((m) => m.id).sort();
    const baseline = await idsHoy();
    // La línea base NO tiene que arrancar vacía: la suite completa deja sus
    // propias fixtures fechadas HOY (los flows cargan movimientos de hoy), y
    // esta batería también puede correr con ese estado. Lo que NO puede haber
    // es basura de una corrida anterior de ESTA batería (el cleanup de arriba
    // ya la sacó). La garantía que importa —que ningún paso de acá mueva la
    // línea base— se verifica igual contra estos mismos ids, más abajo.
    const sucios = (await movsHoy()).filter((m) =>
      String(m.description ?? "").includes(TAG),
    );
    check("la línea base de hoy no arrastra restos de esta batería", sucios.length, 0);

    const csvValido = [
      "fecha,tipo,monto,cuenta,categoria,descripcion",
      `${hoy},EXPENSE,1500,${TAG} Banco,${TAG} Cat,${TAG} fila uno`,
      `${hoy},INCOME,2500,${TAG} Efectivo,,${TAG} fila dos`,
    ].join("\n");
    const csvInvalido = [
      "fecha,tipo,monto,cuenta,categoria,descripcion",
      `${hoy},EXPENSE,1500,${TAG} Banco,${TAG} Cat,${TAG} fila uno`,
      `${hoy},EXPENSE,no-es-numero,${TAG} Banco,,${TAG} fila rota`,
    ].join("\n");
    const rutaCsv = `${OUT_TMP}\\t7r2-ui05.csv`;
    writeFileSync(rutaCsv, csvValido, "utf8");

    /* ── La UI ───────────────────────────────────────────────────────────── */
    let ui;
    try {
      ui = await openUi({ port: PUERTO });
      await abrirPanel(ui);
      await instrumentar(ui);

      /* Helpers locales (mismo patrón que ui-04: ventana sorda → reintentos). */
      const abrirImportador = async () => {
        for (let i = 1; i <= 4; i += 1) {
          // Igual que ui-04: el botón vive abajo del pliegue; sin centrarlo, el
          // click real cae fuera del viewport y se pierde sin error.
          await ui.evalJs(
            `document.getElementById("btn-import-csv")?.scrollIntoView({ block: "center" })`,
          );
          await sleep(i === 1 ? 220 : 280);
          await ui.clickEl("#btn-import-csv");
          try {
            await ui.waitFor(`!!document.getElementById("csv-text")`, {
              timeout: 2500,
              label: "el importador CSV",
            });
            return i;
          } catch {
            // Reintento: click en la ventana sorda / pre-hidratación.
          }
        }
        throw new Error("#btn-import-csv no abrió el importador");
      };

      const setTexto = (selector, texto) =>
        ui.evalJs(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
          setter.call(el, ${JSON.stringify(texto)});
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return el.value.length;
        })()`);

      const norm = (s) => String(s ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

      const resumen5 = () =>
        ui.evalJs(`(() =>
          [...document.querySelectorAll("#csv-summary > div")].map((d) => d.querySelectorAll("p")[1]?.textContent ?? null)
        )()`);

      const estadoFila = (linea) =>
        ui.evalJs(`document.querySelector("#csv-row-${linea} td:nth-child(2) span")?.textContent ?? null`);

      const parrafoPreview = async (indice = 0) =>
        norm(
          await ui.evalJs(
            `[...document.querySelectorAll("#csv-preview > p")].map((p) => p.textContent)[${indice}] ?? null`,
          ),
        );

      const confirmarDeshabilitado = () =>
        ui.evalJs(`document.getElementById("csv-confirm")?.disabled ?? null`);

      /** POSTs a /api/import/csv separados en preview y commit. */
      const pedidosImport = async () => {
        const todos = (await pedidosA(ui, "/api/import/csv")) ?? [];
        return {
          todos: todos.length,
          previews: todos.filter((f) => f.url.includes("/preview")).length,
          commits: todos.filter((f) => !f.url.includes("/preview")).length,
        };
      };

      const previsualizar = async (label) => {
        await ui.evalJs(`document.getElementById("csv-preview-button")?.click()`);
        await ui.waitFor(`!!document.getElementById("csv-summary")`, {
          timeout: 10000,
          label,
        });
      };

      /* ── 1. Apertura y estado vacío ──────────────────────────────────────── */
      section("1 · Apertura y estado vacío");
      const intentos = await abrirImportador();
      console.log(`  · intentos para abrir el importador: ${intentos}`);
      check("el diálogo tiene el rol y el nombre accesible", await ui.evalJs(
        `document.querySelector('[role="dialog"]')?.getAttribute("aria-label")`,
      ), "Importar movimientos desde CSV");
      check("Confirmar arranca deshabilitado", await confirmarDeshabilitado(), true);

      await ui.evalJs(`document.getElementById("csv-preview-button")?.click()`);
      await sleep(200);
      check(
        "sin texto: el aviso es el esperado",
        norm(await ui.evalJs(`document.getElementById("csv-error")?.textContent ?? null`)),
        "Pegá el texto del CSV antes de previsualizar.",
      );
      check("sin texto: no se llamó al servidor", (await pedidosImport()).todos, 0);

      /* ── 2. Preview válido ───────────────────────────────────────────────── */
      section("2 · Preview válido (2 filas)");
      await setTexto("#csv-text", csvValido);
      await sleep(120);
      await previsualizar("la previsualización válida");
      check("resumen 2/2/0/0/0", (await resumen5()).join(","), "2,2,0,0,0");
      check("fila 2 marcada Válida", await estadoFila(2), "Válida");
      check("fila 3 marcada Válida", await estadoFila(3), "Válida");
      check("Confirmar se habilitó", await confirmarDeshabilitado(), false);
      checkTrue(
        "totales del preview con plata bien formateada",
        (await parrafoPreview(0)).includes(
          "Se importarían 2 movimientos: ingresos $ 2.500,00 · gastos $ 1.500,00 · transferencias $ 0,00.",
        ),
        await parrafoPreview(0),
      );
      checkTrue(
        "la categoría nueva se anuncia",
        (await parrafoPreview(1)).includes(`${TAG} Cat`),
        await parrafoPreview(1),
      );
      check("exactamente 1 POST de preview", (await pedidosImport()).previews, 1);
      check("0 commits todavía", (await pedidosImport()).commits, 0);
      await ui.screenshot(`${OUT_TMP}/t7r2-ui05-preview.png`);

      /* ── 3. Cambiar el texto invalida el preview ─────────────────────────── */
      section("3 · El texto manda: cambiar invalida el preview");
      await setTexto("#csv-text", `${csvValido}\n`);
      await sleep(150);
      check(
        "cambiar el texto quita el preview",
        await ui.evalJs(`!!document.getElementById("csv-summary")`),
        false,
      );
      check("y deshabilita Confirmar", await confirmarDeshabilitado(), true);
      check("sin POST nuevo por cambiar texto", (await pedidosImport()).previews, 1);

      await setTexto("#csv-text", csvValido);
      await sleep(120);
      await previsualizar("la previsualización repetida");
      check("se puede volver a previsualizar", (await resumen5()).join(","), "2,2,0,0,0");
      check("2 POSTs de preview", (await pedidosImport()).previews, 2);

      /* ── 4. Fila inválida = todo bloqueado ───────────────────────────────── */
      section("4 · Fila inválida: nada se importa");
      await setTexto("#csv-text", csvInvalido);
      await sleep(120);
      await previsualizar("la previsualización con fila inválida");
      check("resumen 2/1/1/0/0", (await resumen5()).join(","), "2,1,1,0,0");
      check("fila 3 marcada Inválida", await estadoFila(3), "Inválida");
      check("Confirmar queda deshabilitado", await confirmarDeshabilitado(), true);
      const avisoInvalido = (await Promise.all([0, 1, 2, 3].map((i) => parrafoPreview(i)))).find(
        (p) => p.includes("Hay filas inválidas"),
      );
      checkTrue("aviso de bloqueo por filas inválidas", !!avisoInvalido, JSON.stringify(avisoInvalido));
      for (let i = 0; i < 3; i += 1) {
        await ui.evalJs(`document.getElementById("csv-confirm")?.click()`);
        await sleep(100);
      }
      check("click en Confirmar deshabilitado → 0 commits", (await pedidosImport()).commits, 0);
      check("la línea base de hoy sigue intacta", (await idsHoy()).join(","), baseline.join(","));

      /* ── 5. Archivo CSV por el input file (CDP) ──────────────────────────── */
      section("5 · Archivo .csv por el input file");
      const nodo = await ui.send("Runtime.evaluate", {
        expression: `document.getElementById("csv-file")`,
      });
      await ui.send("DOM.setFileInputFiles", {
        files: [rutaCsv],
        objectId: nodo.result.objectId,
      });
      await ui.waitFor(
        `document.getElementById("csv-text").value.includes(${JSON.stringify(`${TAG} fila dos`)})`,
        { timeout: 5000, label: "el contenido del archivo en el textarea" },
      );
      check(
        "el archivo llenó el textarea completo",
        await ui.evalJs(`document.getElementById("csv-text").value.length`),
        csvValido.length,
      );
      checkTrue(
        "el nombre del archivo se muestra",
        norm(await ui.evalJs(`document.body.innerText`)).includes("Archivo: t7r2-ui05.csv"),
      );
      check(
        "cargar un archivo también invalida el preview",
        await ui.evalJs(`!!document.getElementById("csv-summary")`),
        false,
      );
      check("cargar archivo no agrega POSTs", (await pedidosImport()).previews, 3);

      /* ── 6. Doble click en Confirmar → 1 commit, 2 movimientos ───────────── */
      section("6 · Confirmar (doble click) → un solo commit");
      await previsualizar("la previsualización previa al commit");
      check("4 POSTs de preview (archivo incluido)", (await pedidosImport()).previews, 4);
      check("Confirmar habilitado", await confirmarDeshabilitado(), false);

      await ui.clickEl("#csv-confirm");
      await ui.clickEl("#csv-confirm");
      await ui.waitFor(`!!document.getElementById("csv-result")`, {
        timeout: 10000,
        label: "la vista de resultado",
      });
      await sleep(500); // margen: un segundo POST rezagado se vería acá
      const pedidosPostCommit = await pedidosImport();
      check("exactamente 1 POST de commit", pedidosPostCommit.commits, 1);

      const textoResultado = norm(
        await ui.evalJs(`document.getElementById("csv-result")?.textContent ?? null`),
      );
      checkTrue(
        "el resultado dice 2 movimientos",
        textoResultado.includes("Importación completa: 2 movimientos."),
        textoResultado,
      );
      checkTrue(
        "el resultado trae los totales",
        textoResultado.includes(
          "Ingresos $ 2.500,00 · Gastos $ 1.500,00 · Transferencias $ 0,00.",
        ),
        textoResultado,
      );
      checkTrue(
        "el resultado lista la categoría creada",
        textoResultado.includes(`Categorías creadas: ${TAG} Cat.`),
        textoResultado,
      );
      check(
        "el pie del formulario ya no está (no queda un Confirmar fantasma)",
        await ui.evalJs(`!!document.getElementById("csv-confirm")`),
        false,
      );
      const tapResultado = await tapInfo(ui, ["#csv-result-close"]);
      for (const t of tapResultado) {
        checkTrue("#csv-result-close: el tap le llega", t.existe && t.toqueLlega === true, JSON.stringify(t));
      }
      await ui.screenshot(`${OUT_TMP}/t7r2-ui05-result.png`);

      /* ── 7. Los movimientos existen y el panel se refrescó ───────────────── */
      section("7 · Verdad en la API y refresco del panel");
      const importados = (await movsHoy()).filter((m) => (m.description ?? "").startsWith(TAG));
      check("API: exactamente 2 movimientos importados", importados.length, 2);
      const gasto = importados.find((m) => m.kind === "EXPENSE");
      const ingreso = importados.find((m) => m.kind === "INCOME");
      check("el gasto es de $ 1.500", Number(gasto?.amount ?? 0), 1500);
      check("el ingreso es de $ 2.500", Number(ingreso?.amount ?? 0), 2500);
      check("el gasto tiene la categoría nueva", gasto?.category?.name ?? null, `${TAG} Cat`);
      check("el gasto no tiene cuenta destino", gasto?.toAccount ?? null, null);

      await ui.waitFor(
        `document.body.innerText.includes(${JSON.stringify(`${TAG} fila uno`)})`,
        { timeout: 8000, label: "el panel refrescado con lo importado" },
      );
      checkTrue("onImported: el panel ya muestra la descripción importada", true);

      await ui.evalJs(`document.getElementById("csv-result-close")?.click()`);
      await ui.waitFor(`!document.getElementById("csv-text")`, {
        timeout: 4000,
        label: "el cierre del importador",
      });
      check("«Listo» cierra el importador", await ui.evalJs(`!!document.getElementById("csv-text")`), false);

      /* ── 8. Re-pegar el mismo CSV → duplicadas ───────────────────────────── */
      section("8 · Re-pegar el mismo CSV: duplicadas y bloqueo");
      await abrirImportador();
      await setTexto("#csv-text", csvValido);
      await sleep(120);
      await previsualizar("la previsualización con duplicadas");
      check("resumen 2/0/0/2/0", (await resumen5()).join(","), "2,0,0,2,0");
      check("fila 2 marcada Duplicada", await estadoFila(2), "Duplicada");
      check("fila 3 marcada Duplicada", await estadoFila(3), "Duplicada");
      check("Confirmar deshabilitado (0 importables)", await confirmarDeshabilitado(), true);
      const avisoDup = (await Promise.all([0, 1, 2].map((i) => parrafoPreview(i)))).find((p) =>
        p.includes("filas ya existen y se omiten"),
      );
      checkTrue("aviso ámbar de duplicadas", !!avisoDup, JSON.stringify(avisoDup));
      check("sigue habiendo 1 solo commit", (await pedidosImport()).commits, 1);

      /* ── 9. Limpieza y cierre ────────────────────────────────────────────── */
      section("9 · Limpieza y cierre");
      await prisma.movement.deleteMany({
        where: { id: { in: importados.map((m) => m.id) } },
      });
      check("la línea base de hoy queda igual que al empezar", (await idsHoy()).join(","), baseline.join(","));
      const dialogos = await dialogosNativos(ui);
      check("ningún diálogo nativo en todo el recorrido", (dialogos ?? []).length, 0);
      const errores = await ui.evalJs(`(window.__t7r2 ? window.__t7r2.errores : null)`);
      check("ninguna excepción de página", (errores ?? []).length, 0);
    } finally {
      await ui?.close();
    }
  },
});
