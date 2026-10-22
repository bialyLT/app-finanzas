#!/usr/bin/env node
/**
 * Batería 27 · LOS HUECOS DE LA RONDA: el ejemplo del campo, el `exact: false`
 * y el camino del desembolso
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ ATACA
 *
 * Las baterías 24, 25 y 26 cubren el solver, la API y la geometría. Esta cubre
 * las tres cosas que quedaban fuera:
 *
 *   1. EL EJEMPLO DEL CAMPO: el «placeholder» de la cuota y del total tiene que
 *      ser un valor que la app ACEPTA. Un ejemplo que la propia app rechaza es
 *      una contradicción: la persona copia el ejemplo y la app le dice que no
 *      alcanza.
 *   2. EL `exact: false` EN LA UI: hay cuotas que la grilla de 4 decimales no
 *      clava. Ahí la app tiene que avisar (`exact: false`) y mostrar el número
 *      REAL (nunca el tipeado), y lo que se guarda tiene que ser el del
 *      cronograma que cierra en 0 exacto.
 *   3. EL DESEMBOLSO: es una TRANSFERENCIA entre cuentas propias (NUNCA un
 *      ingreso ni un gasto) y el mes no se mueve por él.
 *   4. EL BOTÓN DE GUARDAR NUNCA ESTÁ MUERTO SIN EXPLICACIÓN: si no hay
 *      cuentas de dinero, la persona tiene que poder saber por qué no puede
 *      guardar (con el botón apagado, el aviso tiene que estar A LA VISTA).
 *   5. El paso del desembolso no muestra el CÓDIGO (un comentario JSX que se
 *      renderiza como texto).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LOS NÚMEROS (calculados a mano, los mismos que el smoke y los flows)
 *
 *   francés · 500.000 · 12 cuotas · 60 % TNA
 *     i = 60/100/12 = 0,05
 *     cuota = 500.000·0,05 / (1 − 1,05^−12) = 56.412,71
 *     total = 676.952,44   interés = 176.952,44   mínimo (tasa 0) = 41.666,67
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAS RIENDAS
 *
 * Base `finanzas_test` e instancia `:3101` (`lib-fase9r3.mjs`). Los fixtures
 * se borran POR ID.
 */

import {
  api,
  check,
  checkTrue,
  correrBateria,
  section,
} from "./lib-fase9r3.mjs";
import {
  abrirModal,
  applyViewport,
  openUi,
  sleep,
  verifyViewport,
} from "./lib.mjs";

const BASE = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3101";
const TAG = "T9R6";

/** La vista previa por GET (la que usa el formulario). */
async function preview(params) {
  const query = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();
  return api(`/api/loans/preview?${query}`);
}

/** Escribe en un campo (con foco real y con el scroll que lo deja alcanzable). */
async function escribir(ui, selector, texto) {
  await ui.evalJs(
    `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`,
  );
  await sleep(280);
  const c = await ui.centerOf(selector);
  if (!c) throw new Error(`No existe ${selector}`);
  await ui.clickAt(c.x, c.y);
  await sleep(120);
  await ui.insertText(texto);
  await sleep(250);
}

/** Vacía un campo de la forma que React ve (el setter nativo + input). */
async function vaciar(ui, selector) {
  await ui.evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value",
    ).set;
    setter.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await sleep(200);
}

/** El área que scrollea del modal, arriba del todo. */
async function scrollAlTope(ui) {
  await ui.evalJs(`(() => {
    const panel = document.querySelector('[role="dialog"]');
    for (const el of panel.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      if (cs.overflowY === "auto" || cs.overflowY === "scroll") {
        el.scrollTop = 0;
        return true;
      }
    }
    return false;
  })()`);
  await sleep(300);
}

async function main(prisma) {
  /* ─────────────────────────────────────────────────────────────────────────
   * 1 · EL EJEMPLO DEL CAMPO: lo que la app sugiere tiene que ser aceptable
   * ───────────────────────────────────────────────────────────────────────── */
  section("El ejemplo del campo tiene que ser un valor que la app ACEPTA");

  const ui = await openUi({
    port: 9380,
    profileDir: `${process.env.TEMP}\\opencode\\tester-r6-profile-9380`,
  });

  try {
    // La cuenta de DINERO del fixture: sin ella el alta no se puede hacer (el
    // desembolso es una transferencia entre cuentas) y el botón queda apagado.
    // Se borra por id en el `limpiar`.
    await prisma.account.create({
      data: {
        name: `${TAG} caja`,
        kind: "CASH",
        openingBalance: "100000.00",
      },
    });

    await applyViewport(ui, { width: 375, height: 667 }, { touch: true });
    await ui.navigate(`${BASE}/prestamos`);
    await ui.waitFor("document.readyState === 'complete'", { label: "carga" });
    await sleep(700);
    await ui.loginIfNeeded();
    await sleep(400);
    await verifyViewport(ui, { width: 375, height: 667 }, { touch: true });
    await abrirModal(ui, "#loans-new", '[role="dialog"]');
    await sleep(400);

    const placeholders = await ui.evalJs(`(() => {
      const q = (s) => document.querySelector(s);
      return {
        cuota: q("#loanalta-payment") ? q("#loanalta-payment").placeholder : null,
        total: q("#loanalta-total") ? q("#loanalta-total").placeholder : null,
        monto: q("#loanalta-principal") ? q("#loanalta-principal").placeholder : null,
        cuotas: q("#loanalta-count") ? q("#loanalta-count").placeholder : null,
        tna: q("#loanalta-tna") ? q("#loanalta-tna").placeholder : null,
      };
    })()`);

    // El ejemplo de la CUOTA: con el ejemplo canónico (500.000 · 12 · 60 %),
    // el valor del ejemplo tiene que ser una cuota que la app ACEPTA.
    const ejemploCuota = placeholders.cuota ?? "";
    const comoNumero = ejemploCuota.replace(/\./g, "").replace(",", ".");
    const porCuotaEjemplo = await preview({
      principal: "500000",
      installmentCount: 12,
      system: "FRENCH",
      mode: "PAYMENT",
      payment: comoNumero,
    });
    checkTrue(
      "el ejemplo de la CUOTA es un valor que la app acepta (no dice «no alcanza»)",
      porCuotaEjemplo.status === 200,
      `«${ejemploCuota}» → ${porCuotaEjemplo.status} · ${porCuotaEjemplo.body?.error ?? ""}`,
    );
    check(
      "el ejemplo de la CUOTA es la cuota del ejemplo canónico (56.412,71)",
      porCuotaEjemplo.body?.payment,
      "56412.71",
    );

    // El ejemplo del TOTAL: tiene que ser un total que la app ACEPTA y que
    // corresponde al mismo ejemplo canónico.
    await scrollAlTope(ui);
    await ui.clickEl("#loanalta-mode-TOTAL");
    await sleep(600);
    const ejemploTotal = await ui.evalJs(
      `document.querySelector("#loanalta-total")?.placeholder ?? ""`,
    );
    const totalComoNumero = ejemploTotal.replace(/\./g, "").replace(",", ".");
    const porTotalEjemplo = await preview({
      principal: "500000",
      installmentCount: 12,
      system: "FRENCH",
      mode: "TOTAL",
      total: totalComoNumero,
    });
    checkTrue(
      "el ejemplo del TOTAL es un valor que la app acepta",
      porTotalEjemplo.status === 200,
      `«${ejemploTotal}» → ${porTotalEjemplo.status} · ${porTotalEjemplo.body?.error ?? ""}`,
    );
    check(
      "el ejemplo del TOTAL es el total del ejemplo canónico (676.952,44)",
      porTotalEjemplo.body?.totalPaid,
      "676952.44",
    );

    // Y el ejemplo de la tasa: 60 % es la tasa del ejemplo canónico.
    await scrollAlTope(ui);
    await ui.clickEl("#loanalta-mode-RATE");
    await sleep(600);
    check("el ejemplo de la TASA es el 60 %", placeholders.tna, "60");
    check("el ejemplo del MONTO es 500.000", placeholders.monto, "500.000");
    check("el ejemplo de la CANTIDAD de cuotas es 12", placeholders.cuotas, "12");

    /* ───────────────────────────────────────────────────────────────────────
     * 2 · EL `exact: false` EN LA UI
     * ─────────────────────────────────────────────────────────────────────── */
    section("El aviso de «no es el valor exacto» (la grilla de 4 decimales)");

    await scrollAlTope(ui);
    await ui.clickEl("#loanalta-mode-PAYMENT");
    await sleep(600);
    await escribir(ui, "#loanalta-principal", "500000");
    await escribir(ui, "#loanalta-count", "12");
    await escribir(ui, "#loanalta-payment", "56412,005");
    await sleep(1800);

    const estadoExacto = await ui.evalJs(`(() => {
      const q = (s) => document.querySelector(s);
      const panel = q('[role="dialog"]');
      const preview = q("#loanalta-preview");
      return {
        paymentTyped: q("#loanalta-payment") ? q("#loanalta-payment").value : null,
        preview: preview ? preview.innerText.replace(/\\s+/g, " ").trim() : null,
        previewRate: q("#loanalta-preview-rate") ? q("#loanalta-preview-rate").innerText.replace(/\\s+/g, " ").trim() : null,
        aviso: panel.innerText.includes("es el valor más cercano que la tasa guardada permite"),
        error: q("#loanalta-preview-error") ? q("#loanalta-preview-error").innerText.trim() : null,
      };
    })()`);

    checkTrue(
      "con una cuota que la grilla no clava, la app AVISA",
      estadoExacto.aviso === true,
      estadoExacto.preview,
    );
    checkTrue(
      "el aviso dice la cuota REAL (56.412,02), no la tipeada",
      /56\.412,02/.test(estadoExacto.preview ?? ""),
      estadoExacto.preview,
    );
    check(
      "lo tipeado NO se pisa: el campo sigue con lo que escribió la persona",
      estadoExacto.paymentTyped,
      "56412,005",
    );
    checkTrue(
      "y la tasa que se muestra es la derivada (60,00 % anual a dos decimales)",
      /60,00\s*%\s*anual/.test(estadoExacto.previewRate ?? ""),
      estadoExacto.previewRate,
    );

    /* ───────────────────────────────────────────────────────────────────────
     * 4 · LA VISTA PREVIA NO PUEDE MOSTRAR UN DATO QUE LA PERSONA YA BORRÓ
     * ─────────────────────────────────────────────────────────────────────── */
    section("La vista previa no muestra lo que la persona ya borró");

    // Se pone la red LENTA (2.500 ms de latencia): así la respuesta del
    // pedido llega DESPUÉS de que la persona borre lo que escribió. Sin la
    // latencia la carrera es de milisegundos y no se ve; con 600 cuotas en el
    // sistema alemán la vista previa tarda más de un segundo igual.
    await ui.send("Network.enable", {});
    await ui.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 2500,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });

    await scrollAlTope(ui);
    await escribir(ui, "#loanalta-payment", "56412,71");
    await sleep(900); // el pedido ya salió (el debounce es de 300 ms)
    await vaciar(ui, "#loanalta-payment"); // la persona BORRA lo que escribió
    await sleep(400);
    const justoDespues = await ui.evalJs(`(() => {
      const q = (s) => document.querySelector(s);
      return {
        payment: q("#loanalta-payment") ? q("#loanalta-payment").value : null,
        preview: q("#loanalta-preview") ? q("#loanalta-preview").innerText.replace(/\\s+/g, " ").trim() : null,
      };
    })()`);
    check(
      "justo después de borrar, la vista previa está limpia",
      justoDespues.preview,
      null,
    );
    await sleep(4000); // llega la respuesta del pedido VIEJO
    const despues = await ui.evalJs(`(() => {
      const q = (s) => document.querySelector(s);
      return {
        payment: q("#loanalta-payment") ? q("#loanalta-payment").value : null,
        preview: q("#loanalta-preview") ? q("#loanalta-preview").innerText.replace(/\\s+/g, " ").trim() : null,
      };
    })()`);
    check(
      "la respuesta vieja NO vuelve a pintar la cuota borrada",
      despues.preview,
      null,
    );
    check(
      "y el campo sigue vacío (no se inventó nada)",
      despues.payment,
      "",
    );

    await ui.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });

    /* ───────────────────────────────────────────────────────────────────────
     * 3 · EL DESEMBOLSO: una TRANSFERENCIA (no un ingreso ni un gasto)
     * ─────────────────────────────────────────────────────────────────────── */
    section("El desembolso es una transferencia entre cuentas propias");

    // La sección anterior dejó el campo de la cuota VACÍA (a propósito): se
    // vuelve a cargar la que produce el `exact: false`.
    await escribir(ui, "#loanalta-payment", "56412,005");
    await sleep(1500);
    await escribir(ui, "#loanalta-name", `${TAG} desembolso`);
    await sleep(1200);
    const antesDelDesembolso = await prisma.movement.count();
    await ui.clickEl("#loanalta-submit");
    await sleep(2500);

    // El paso 2 no puede mostrar el código.
    const pasoDos = await ui.evalJs(`(() => {
      const panel = document.querySelector('[role="dialog"]');
      const texto = panel ? panel.innerText : "";
      return {
        hayDisburse: !!document.querySelector("#loanalta-disburse-go"),
        muestraCodigo: /\\/\\*|Paso 2:/.test(texto),
        texto: texto.replace(/\\s+/g, " ").slice(0, 300),
      };
    })()`);
    check("el alta llegó al paso del desembolso", pasoDos.hayDisburse, true);
    check(
      "el paso del desembolso NO muestra el comentario del código",
      pasoDos.muestraCodigo,
      false,
    );

    const cuenta = await prisma.account.findFirst({
      where: { name: `${TAG} desembolso` },
      orderBy: { createdAt: "desc" },
    });
    checkTrue("el préstamo se creó", !!cuenta, "no está en la base");
    if (cuenta) {
      const filas = await prisma.installment.findMany({
        where: { accountId: cuenta.id },
        orderBy: { number: "asc" },
      });
      check(
        "la tasa guardada es la derivada (59,9974 %)",
        cuenta.tnaPercent.toFixed(4),
        "59.9974",
      );
      check(
        "la primera cuota guardada es la REAL (56.412,02)",
        filas[0].payment.toFixed(2),
        "56412.02",
      );
      check(
        "el cronograma guardado cierra en 0 EXACTO",
        filas[filas.length - 1].remainingBalance.toFixed(2),
        "0.00",
      );
      check(
        "y amortiza exactamente el capital",
        filas
          .reduce((acc, i) => acc + Number(i.principal.toFixed(2)), 0)
          .toFixed(2),
        "500000.00",
      );

      // El desembolso: que sea una TRANSFERENCIA y que no mueva el mes.
      const caja = await prisma.account.findFirst({
        where: { kind: "CASH", name: { startsWith: `${TAG} ` } },
      });
      if (caja) {
        await ui.clickEl("#loanalta-disburse-go");
        await sleep(2500);
        const movs = await prisma.movement.findMany({
          where: { OR: [{ accountId: cuenta.id }, { toAccountId: cuenta.id }] },
        });
        check(
          "el desembolso es UNA transferencia",
          movs.length,
          1,
        );
        check(
          "y es de tipo TRANSFER (no un ingreso ni un gasto)",
          movs[0]?.kind,
          "TRANSFER",
        );
        check(
          "por el capital entero (500.000,00)",
          movs[0]?.amount.toFixed(2),
          "500000.00",
        );
        check(
          "ningún movimiento nuevo es un ingreso o un gasto",
          movs.filter((m) => m.kind === "INCOME" || m.kind === "EXPENSE").length,
          0,
        );
        check(
          "el mes no se movió: los movimientos del préstamo son 1",
          await prisma.movement.count(),
          antesDelDesembolso + 1,
        );
      }
    }
  } finally {
    await ui.close();
  }
}

/**
 * EL BOTÓN DE GUARDAR NUNCA ESTÁ MUERTO SIN EXPLICACIÓN.
 *
 * Sin cuentas de banco o efectivo no se puede crear el préstamo (el
 * desembolso es una transferencia entre cuentas). La persona tiene que poder
 * saber POR QUÉ: si el botón está apagado, el aviso tiene que estar a la vista
 * (la banda del pie está siempre a la vista; la columna de la derecha, no).
 */
async function botonMuertoSinExplicacion(prisma) {
  section("El botón de guardar nunca está muerto sin explicación");

  const ui = await openUi({
    port: 9381,
    profileDir: `${process.env.TEMP}\\opencode\\tester-r6-profile-9381`,
  });

  // Para Reproducir el caso «no hay cuentas de dinero» hay que SACAR las
  // cuentas de dinero de la vista: se ARCHIVAN (por id) y se RESTAURAN al
  // terminar. Archivar es reversible y no toca una sola fila de la base de la
  // persona (la rienda de `lib-fase9r3.mjs` sigue vigente).
  const deDinero = await prisma.account.findMany({
    where: { kind: { in: ["CASH", "BANK"] }, archived: false },
    select: { id: true },
  });
  const idsDinero = deDinero.map((a) => a.id);

  try {
    if (idsDinero.length > 0) {
      await prisma.account.updateMany({
        where: { id: { in: idsDinero } },
        data: { archived: true },
      });
    }

    await applyViewport(ui, { width: 320, height: 568 }, { touch: true });
    await ui.navigate(`${BASE}/prestamos`);
    await ui.waitFor("document.readyState === 'complete'", { label: "carga" });
    await sleep(700);
    await ui.loginIfNeeded();
    await sleep(400);
    await verifyViewport(ui, { width: 320, height: 568 }, { touch: true });
    await abrirModal(ui, "#loans-new", '[role="dialog"]');
    await sleep(600);

    const estado = await ui.evalJs(`(() => {
      const panel = document.querySelector('[role="dialog"]');
      const b = document.querySelector("#loanalta-submit");
      const parrafos = [...panel.querySelectorAll("p")];
      const aviso = parrafos.find((p) =>
        /No hay cuentas de banco o efectivo/.test(p.textContent),
      );
      const r = aviso ? aviso.getBoundingClientRect() : null;
      const alto = window.innerHeight;
      // La banda del pie: el hermano del área que scrollea.
      let pie = null;
      for (const el of panel.querySelectorAll("*")) {
        const cs = getComputedStyle(el);
        if (cs.overflowY === "auto" || cs.overflowY === "scroll") {
          pie = el.nextElementSibling ? el.nextElementSibling.getBoundingClientRect() : null;
          break;
        }
      }
      const enElPie = r && pie ? r.top >= pie.top : false;
      return {
        disabled: b ? b.disabled : null,
        avisoExiste: !!aviso,
        avisoVisibleEnPantalla: r ? r.bottom > 0 && r.top < alto : false,
        avisoEnElPie: enElPie,
        altoVentana: alto,
      };
    })()`);

    checkTrue(
      "hay un aviso que explica que faltan cuentas de dinero",
      estado.avisoExiste,
      JSON.stringify(estado),
    );

    if (estado.disabled) {
      // Botón apagado: la explicación tiene que estar A LA VISTA.
      checkTrue(
        "con el botón apagado, la explicación está A LA VISTA (no debajo del pliegue)",
        estado.avisoVisibleEnPantalla && estado.avisoEnElPie,
        JSON.stringify(estado),
      );
    } else {
      // Botón habilitado: tocarlo tiene que explicar qué pasa. El formulario
      // va COMPLETO (si no, el primer mensaje es el de los datos que faltan y
      // el de las cuentas de dinero no aparece nunca).
      await escribir(ui, "#loanalta-name", `${TAG} sin caja`);
      await escribir(ui, "#loanalta-principal", "500000");
      await escribir(ui, "#loanalta-count", "12");
      await escribir(ui, "#loanalta-payment", "56412,71");
      await sleep(1500);
      const c = await ui.centerOf("#loanalta-submit");
      await ui.clickAt(c.x, c.y);
      await sleep(1200);
      const error = await ui.evalJs(
        `(() => { const e = document.querySelector("#loanalta-error");
          if (!e) return null; const r = e.getBoundingClientRect();
          return { texto: e.textContent.trim(), visible: r.bottom > 0 && r.top < window.innerHeight }; })()`,
      );
      checkTrue(
        "con el botón habilitado, tocarlo explica qué falta (y se lo ve)",
        !!error && error.visible && /cuenta de banco o efectivo/i.test(error.texto),
        JSON.stringify(error),
      );
      const creado = await prisma.account.count({
        where: { name: `${TAG} sin caja` },
      });
      check("y NO se creó ningún préstamo", creado, 0);
    }
  } finally {
    await ui.close();
    // Las cuentas de dinero vuelven a su estado (por id).
    if (idsDinero.length > 0) {
      await prisma.account.updateMany({
        where: { id: { in: idsDinero } },
        data: { archived: false },
      });
    }
  }
}

correrBateria({
  etiqueta: "bateria 27 (ejemplo, exact:false y desembolso)",
  main: async (prisma) => {
    await main(prisma);
    await botonMuertoSinExplicacion(prisma);
  },
  limpiar: async (prisma) => {
    const cuentas = await prisma.account.findMany({
      where: { name: { startsWith: `${TAG} ` } },
      select: { id: true },
    });
    const ids = cuentas.map((c) => c.id);
    if (ids.length > 0) {
      await prisma.installment.deleteMany({ where: { accountId: { in: ids } } });
      await prisma.movement.deleteMany({
        where: { OR: [{ accountId: { in: ids } }, { toAccountId: { in: ids } }] },
      });
      await prisma.account.deleteMany({ where: { id: { in: ids } } });
    }
  },
});
