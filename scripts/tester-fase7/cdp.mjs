#!/usr/bin/env node
/**
 * Cliente CDP mínimo para las sondas de UI de la Fase 7.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ CDP Y NO MAESTRO PARA ESTAS SONDAS
 * ─────────────────────────────────────────────────────────────────────────────
 * Hay preguntas que Maestro NO puede responder, y las tres importan en esta
 * ronda:
 *
 *   1. GEOMETRÍA con números: ¿dónde cae el centro del label de cada campo
 *      respecto del arranque del pie fijo? Maestro sólo expone un árbol en sus
 *      artefactos de corrida; medir exige leer `getBoundingClientRect` en vivo.
 *   2. TAP + TIPEO coordinado: reproducir "toqué donde veo el campo y perdí el
 *      texto sin error" es dispatch de mouse + `Input.insertText` sobre el
 *      MISMO viewport de la ventana de tests (1019×557, la que midió el árbol
 *      real del flow 04: `b=[0,0][1019,557]`).
 *   3. TIEMPO: cronometrar una compra de punta a punta con marcas in-page
 *      (`performance.now()`), sin la latencia de los roundtrips del driver.
 *
 * El sustrato es el MISMO Chrome que usa Maestro (build real, layout real). Lo
 * que NO reemplaza: la ejecución de los flows (esas siguen siendo la red).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CÓMO SE USA
 * ─────────────────────────────────────────────────────────────────────────────
 *   const ui = await openUi({ port: 9333, profileDir: "..." }); // abre Chrome
 *   await ui.navigate(`${BASE_URL}/`);
 *   await ui.loginIfNeeded();
 *   await ui.clickEl("#btn-expense");
 *   ...
 *   await ui.close();
 *
 * Chrome se mata ENTERO (taskkill /T) en `close()`, incluso si algo falló.
 * Un perfil dedicado (`f7-cdp-profile`) mantiene la sesión entre corridas; el
 * script igual verifica el estado de login antes de usarla.
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME =
  process.env.CHROME_PATH ??
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

/** El viewport EXACTO de la ventana de tests (árbol real del flow 04). */
export const TEST_VIEWPORT = { width: 1019, height: 557 };

async function portResponds(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portResponds(port)) return true;
    await sleep(300);
  }
  return false;
}

/**
 * Abre Chrome con debugging remoto y devuelve la capa de helpers.
 *
 * Si ya hay un Chrome escuchando en el puerto, se REUSA (no lo mata al cerrar:
 * `ownsChrome: false`). Si no, se lanza uno con perfil propio y `close()` lo
 * limpia con `taskkill /T` (Chrome deja hijos vivos si se mata sólo al padre).
 */
export async function openUi({
  port = 9333,
  profileDir = null,
  viewport = TEST_VIEWPORT,
} = {}) {
  let ownsChrome = false;
  let chromePid = null;

  if (!(await portResponds(port))) {
    if (!profileDir) {
      profileDir = `${process.env.TEMP ?? "C:\\Windows\\Temp"}\\opencode\\f7-cdp-profile`;
    }
    mkdirSync(profileDir, { recursive: true });
    const child = spawn(
      CHROME,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-sync",
        "--window-size=1019,640",
        "--window-position=0,0",
        "about:blank",
      ],
      { stdio: "ignore", windowsHide: false },
    );
    chromePid = child.pid;
    ownsChrome = true;
    // 45s y no 20: un perfil NUEVO puede tardar en el primer arranque (Chrome
    // inicializa crashpad/red antes de abrir el puerto), y matar ahí convierte
    // una espera en un falso "Chrome no arranca".
    const up = await waitPort(port, 45000);
    if (!up) {
      try {
        execFileSync("taskkill", ["/PID", String(chromePid), "/T", "/F"], {
          stdio: "ignore",
        });
      } catch {
        // Nada que hacer: el puerto nunca respondió.
      }
      throw new Error(`Chrome no abrió el puerto CDP ${port}.`);
    }
  }

  /* ── Conexión a una pestaña nueva ─────────────────────────────────────── */
  const created = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`,
    { method: "PUT" },
  );
  const target = await created.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);

  let id = 0;
  const pending = new Map();
  const eventWaiters = new Map();

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }
    if (message.method) {
      const waiters = eventWaiters.get(message.method);
      if (waiters?.length) {
        const [first, ...rest] = waiters;
        eventWaiters.set(message.method, rest);
        first(message.params);
      }
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const messageId = ++id;
      pending.set(messageId, { resolve, reject });
      ws.send(JSON.stringify({ id: messageId, method, params }));
    });

  const waitEvent = (method, timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timeout esperando el evento ${method}`)),
        timeoutMs,
      );
      const waiters = eventWaiters.get(method) ?? [];
      waiters.push((params) => {
        clearTimeout(timer);
        resolve(params);
      });
      eventWaiters.set(method, waiters);
    });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  });

  /* ── Sondas de página ─────────────────────────────────────────────────── */

  const evalJs = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          "evaluación falló",
      );
    }
    return result.result.value;
  };

  /** Espera a que `expression` sea truthy. Devuelve el valor o tira error. */
  const waitFor = async (expression, { timeout = 20000, label } = {}) => {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      last = await evalJs(expression).catch((error) => `error: ${error.message}`);
      if (last) return last;
      await sleep(150);
    }
    throw new Error(
      `Timeout esperando ${label ?? expression} (último: ${JSON.stringify(last)})`,
    );
  };

  const navigate = async (url) => {
    const loaded = waitEvent("Page.loadEventFired", 30000);
    await send("Page.navigate", { url });
    await loaded;
  };

  /**
   * Navega y espera de forma TOLERANTE.
   *
   * ─────────────────────────────────────────────────────────────────────────────
   * POR QUÉ EXISTE (y por qué no alcanza `navigate`)
   * `navigate` espera SÓLO `Page.loadEventFired`. Cuando ese evento no llega
   * (una carga servida desde caché, un contexto que se reemplaza, un evento
   * que se pierde entre dos navegaciones seguidas), el script muere con
   * «Timeout esperando el evento Page.loadEventFired» ANTES de medir nada: la
   * auditoría se cae sin decir qué vista ni qué ancho quedó sin auditar.
   *
   * Acá se acepta cualquiera de las dos señales, con un techo:
   *
   *   · `Page.loadEventFired` (el camino normal); o
   *   · `document.readyState === "complete"` del documento NUEVO.
   *
   * ─────────────────────────────────────────────────────────────────────────────
   * LA MARCA: CÓMO SE SABE QUE EL DOCUMENTO ES EL NUEVO
   * `readyState === "complete"` a secas miente: si la navegación todavía no
   * reemplazó el documento, el poll devuelve el `complete` de la página
   * ANTERIOR y la medición arranca sobre la vista vieja (con la misma URL es
   * indistinguible). Por eso, ANTES de navegar, se deja una marca en el
   * `window` del documento actual; el documento nuevo no la tiene. La espera
   * termina cuando el documento es nuevo Y está completo (o cuando llega el
   * evento de carga, que también implica documento nuevo).
   *
   * Si igual no llega ninguna señal dentro del techo, el error dice en qué URL
   * quedó y cuál fue el último estado. El que llama le agrega la vista y el
   * ancho: un timeout genérico no sirve para arreglar nada.
   */
  const navigateRobust = async (url, { timeout = 25000 } = {}) => {
    // La marca vive en el documento VIEJO: el nuevo no la hereda.
    let puedeMarcar = true;
    try {
      await evalJs(`(window.__auditNavMark = 1) === 1`);
    } catch {
      puedeMarcar = false; // about:blank recién abierto: no hay documento.
    }
    const inicio = Date.now();
    const resp = await send("Page.navigate", { url });
    if (resp?.errorText) {
      throw new Error(`la navegación devolvió "${resp.errorText}"`);
    }
    let ultimo = "";
    while (Date.now() - inicio < timeout) {
      try {
        const estado = await evalJs(
          `(document.readyState || "") + "|" +
           (${puedeMarcar ? "window.__auditNavMark === undefined" : "true"} ? "nuevo" : "viejo")`,
        );
        ultimo = estado;
        if (estado === "complete|nuevo") {
          return { url, ms: Date.now() - inicio, estado };
        }
      } catch (error) {
        ultimo = `contexto en transición (${error.message})`;
      }
      await sleep(100);
    }
    throw new Error(
      `la página no terminó de cargar en ${timeout} ms (url=${url}, último estado: ${ultimo || "?"})`,
    );
  };

  const clickAt = async (x, y) => {
    const p = { x, y, button: "left", clickCount: 1 };
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...p });
    await sleep(40);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...p });
    await sleep(60);
  };

  /** Centro del rect del elemento (como resuelve Maestro su tap point). */
  const centerOf = async (selector) => {
    const rect = await evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
    })()`);
    return rect;
  };

  /** Toca el CENTRO del elemento, aunque esté tapado (como un tap real). */
  const clickEl = async (selector) => {
    const rect = await centerOf(selector);
    if (!rect) throw new Error(`No existe ${selector} para tocar.`);
    await clickAt(rect.x, rect.y);
    return rect;
  };

  const insertText = (text) => send("Input.insertText", { text });

  /**
   * Una tecla REAL (keyDown+keyUp) — para atajos y Escape.
   * El driver web de Maestro sólo mapea ENTER y BACKSPACE en `pressKey`; acá
   * podemos mandar cualquier tecla porque es una sonda, no un flow.
   */
  const pressKey = async (key, { code, keyCode, text } = {}) => {
    const base = {
      key,
      code: code ?? key,
      windowsVirtualKeyCode: keyCode ?? key.charCodeAt(0),
      nativeVirtualKeyCode: keyCode ?? key.charCodeAt(0),
    };
    if (text) {
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        ...base,
        text,
        unmodifiedText: text,
      });
    } else {
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    }
    await sleep(20);
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(30);
  };

  const KEYS = {
    Escape: { key: "Escape", code: "Escape", keyCode: 27 },
    Enter: { key: "Enter", code: "Enter", keyCode: 13 },
    t: { key: "t", code: "KeyT", keyCode: 84, text: "t" },
    i: { key: "i", code: "KeyI", keyCode: 73, text: "i" },
    a: { key: "a", code: "KeyA", keyCode: 65, text: "a" },
  };

  const press = (name) => pressKey(KEYS[name].key, KEYS[name]);

  const screenshot = async (file) => {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    return file;
  };

  /** Login de la app si la página actual es la de acceso. */
  const loginIfNeeded = async () => {
    const needs = await evalJs(`!!document.querySelector("#password")`);
    if (!needs) return false;
    await evalJs(`document.querySelector("#password").focus()`);
    await insertText(process.env.APP_PASSWORD ?? "finanzas-dev");
    await evalJs(
      `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Entrar")?.click()`,
    );
    await waitFor(`!document.querySelector("#password")`, {
      timeout: 30000,
      label: "que el login complete",
    });
    return true;
  };

  /** Cierra la pestaña y, si lanzamos el Chrome, lo mata entero. */
  const close = async () => {
    try {
      ws.close();
    } catch {
      // La conexión ya estaba cerrada.
    }
    if (ownsChrome && chromePid) {
      try {
        execFileSync("taskkill", ["/PID", String(chromePid), "/T", "/F"], {
          stdio: "ignore",
        });
      } catch {
        // Puede haberse cerrado solo; no es motivo para fallar la corrida.
      }
    }
  };

  return {
    send,
    evalJs,
    waitFor,
    navigate,
    navigateRobust,
    clickAt,
    clickEl,
    centerOf,
    insertText,
    pressKey,
    press,
    screenshot,
    loginIfNeeded,
    close,
    port,
    ownsChrome,
  };
}
