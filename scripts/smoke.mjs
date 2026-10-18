#!/usr/bin/env node
/**
 * Smoke test end-to-end contra la API real.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ HACE
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Borra los datos de la base de desarrollo (con `--reset`).
 * 2. Entra por `/api/auth/login` como lo haría el navegador.
 * 3. Crea cuentas y movimientos POR LA API, no con Prisma directo. Eso es lo
 *    que hace que sirva: ejercita la validación, el CSRF, el trigger de la base
 *    y la serialización a DTO — todo el camino real.
 * 4. Siembra el escenario completo (sueldo, gastos, préstamo y tarjeta) para que
 *    las pruebas de interfaz tengan algo real que mirar.
 * 5. VERIFICA los números contra valores calculados a mano. No alcanza con que
 *    la app no tire error: tiene que dar el patrimonio neto correcto.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USO
 * ─────────────────────────────────────────────────────────────────────────────
 *     node scripts/smoke.mjs              # siembra y verifica
 *     node scripts/smoke.mjs --reset      # además borra todo antes
 *     node scripts/smoke.mjs --check-only # no escribe nada, sólo verifica
 *
 * Requiere el servidor de desarrollo levantado:
 *     npm run db:local:start
 *     npm run dev
 */

import { PrismaClient } from "@prisma/client";

try {
  process.loadEnvFile();
} catch {
  // Sin .env se usan los valores por defecto de abajo.
}

const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000";
const PASSWORD = process.env.APP_PASSWORD ?? "finanzas-dev";

const args = new Set(process.argv.slice(2));
const shouldReset = args.has("--reset");
const checkOnly = args.has("--check-only");

let cookie = "";

/* ────────────────────────────────────────────────────────────────────────────
 * Utilidades
 * ──────────────────────────────────────────────────────────────────────────── */

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FALLA ${label}`);
    console.log(`        esperado: ${expected}`);
    console.log(`        obtenido: ${actual}`);
  }
}

function checkTrue(label, condition, detail = "") {
  const ok = Boolean(condition);
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FALLA ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/**
 * Petición autenticada.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ HACE FALTA MANDAR `Origin` A MANO
 * ─────────────────────────────────────────────────────────────────────────────
 * Las mutaciones pasan por `assertSameOrigin`, que compara el header `Origin`
 * con el `Host`. Es una segunda capa anti-CSRF además de `SameSite=Lax`.
 *
 * Node no manda `Origin` en sus peticiones (los navegadores sí), así que sin
 * esto TODAS las escrituras devolverían 403 — y el motivo no tendría nada que
 * ver con lo que se está probando.
 */
async function api(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Origin: BASE_URL,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers ?? {}),
    },
  });

  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const raw of setCookie) {
    const pair = raw.split(";")[0];
    if (pair?.startsWith("finanzas_session=")) cookie = pair;
  }

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  return { status: response.status, body };
}

async function post(path, body) {
  return api(path, { method: "POST", body: JSON.stringify(body) });
}

/* ────────────────────────────────────────────────────────────────────────────
 * El escenario
 * ──────────────────────────────────────────────────────────────────────────── */

const MES = "2026-10";

async function main() {
  console.log(`Smoke test contra ${BASE_URL}`);

  // ── Reset ──────────────────────────────────────────────────────────────────
  if (shouldReset) {
    section("Preparando la base");
    const prisma = new PrismaClient();
    // El orden importa. Las OCURRENCIAS van primero: borrar un movimiento
    // posteado dispara el `SetNull` del FK y dejaría la ocurrencia en POSTED
    // sin movimiento, que el CHECK `occurrence_shape_by_status` rechaza (el
    // DELETE fallaría). Los RESÚMENES y PLANES de tarjeta también van antes de
    // los movimientos: el plan referencia su gasto con un FK `Restrict`.
    // Después los movimientos (la FK a Account es `Restrict`: borrar las cuentas
    // antes fallaría) y por último reglas, categorías y cuentas.
    await prisma.statement.deleteMany();
    await prisma.cardPlan.deleteMany();
    await prisma.recurrenceOccurrence.deleteMany();
    // Las CUOTAS (Fase 4) van antes que las cuentas: la FK es CASCADE, pero el
    // orden explícito deja dicho que un préstamo no deja filas huérfanas.
    await prisma.installment.deleteMany();
    await prisma.movement.deleteMany();
    await prisma.recurrenceRule.deleteMany();
    await prisma.category.deleteMany();
    await prisma.account.deleteMany();
    await prisma.$disconnect();
    console.log("  base limpia");
  }

  // ── Login ──────────────────────────────────────────────────────────────────
  section("Autenticación");
  const login = await post("/api/auth/login", { password: PASSWORD });
  check("login responde 200", login.status, 200);
  checkTrue("recibimos la cookie de sesión", cookie.startsWith("finanzas_session="));

  if (!cookie) {
    console.error("\nSin sesión no se puede seguir. Abortado.");
    process.exit(1);
  }

  // ── La API está protegida ──────────────────────────────────────────────────
  section("Protección de la API");
  {
    const sinSesion = await fetch(`${BASE_URL}/api/accounts`, { headers: { Origin: BASE_URL } });
    check("sin sesión, /api/accounts responde 401", sinSesion.status, 401);

    const deudaSinSesion = await fetch(`${BASE_URL}/api/debts?month=${MES}`, {
      headers: { Origin: BASE_URL },
    });
    check("sin sesión, /api/debts responde 401", deudaSinSesion.status, 401);

    // Las rutas de la recurrencia también: las cuatro, una por una. Un
    // generador que se pueda disparar sin sesión postearía movimientos para
    // cualquiera que conozca la URL.
    const recGetSinSesion = await fetch(`${BASE_URL}/api/recurrence`, {
      headers: { Origin: BASE_URL },
    });
    check("sin sesión, GET /api/recurrence responde 401", recGetSinSesion.status, 401);

    const recRunSinSesion = await fetch(`${BASE_URL}/api/recurrence/run`, {
      method: "POST",
      headers: { Origin: BASE_URL },
    });
    check("sin sesión, POST /api/recurrence/run responde 401", recRunSinSesion.status, 401);

    const recReglasSinSesion = await fetch(`${BASE_URL}/api/recurrence/rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL },
      body: JSON.stringify({}),
    });
    check("sin sesión, POST /api/recurrence/rules responde 401", recReglasSinSesion.status, 401);

    const recOcurrenciasSinSesion = await fetch(`${BASE_URL}/api/recurrence/occurrences`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL },
      body: JSON.stringify({}),
    });
    check(
      "sin sesión, POST /api/recurrence/occurrences responde 401",
      recOcurrenciasSinSesion.status,
      401,
    );

    // Las tarjetas: leer la vista y disparar la corrida de resúmenes, el pago y
    // los planes tampoco pueden quedar abiertos. Una corrida sin sesión emitiría
    // documentos y un pago sin sesión movería plata.
    const tarjetasSinSesion = await fetch(`${BASE_URL}/api/cards`, {
      headers: { Origin: BASE_URL },
    });
    check("sin sesión, GET /api/cards responde 401", tarjetasSinSesion.status, 401);

    const resumenesSinSesion = await fetch(`${BASE_URL}/api/cards/statements`, {
      method: "POST",
      headers: { Origin: BASE_URL },
    });
    check(
      "sin sesión, POST /api/cards/statements responde 401",
      resumenesSinSesion.status,
      401,
    );

    const pagoSinSesion = await fetch(`${BASE_URL}/api/cards/statements/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL },
      body: JSON.stringify({}),
    });
    check(
      "sin sesión, POST /api/cards/statements/pay responde 401",
      pagoSinSesion.status,
      401,
    );

    const planSinSesion = await fetch(`${BASE_URL}/api/cards/plans`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL },
      body: JSON.stringify({}),
    });
    check("sin sesión, POST /api/cards/plans responde 401", planSinSesion.status, 401);

    const borrarPlanSinSesion = await fetch(`${BASE_URL}/api/cards/plans?id=x`, {
      method: "DELETE",
      headers: { Origin: BASE_URL },
    });
    check(
      "sin sesión, DELETE /api/cards/plans responde 401",
      borrarPlanSinSesion.status,
      401,
    );

    const previewSinSesion = await fetch(
      `${BASE_URL}/api/cards/plans/preview?total=100&installments=1`,
      { headers: { Origin: BASE_URL } },
    );
    check(
      "sin sesión, GET /api/cards/plans/preview responde 401",
      previewSinSesion.status,
      401,
    );

    // Los préstamos (Fase 4): la vista, la vista previa y —sobre todo— el pago
    // de una cuota mueven dinero y compromisos, así que van con la misma
    // protección que el resto.
    const prestamosSinSesion = await fetch(`${BASE_URL}/api/loans`, {
      headers: { Origin: BASE_URL },
    });
    check("sin sesión, GET /api/loans responde 401", prestamosSinSesion.status, 401);

    const previewPrestamoSinSesion = await fetch(
      `${BASE_URL}/api/loans/preview?principal=100000&tnaPercent=60&installmentCount=12`,
      { headers: { Origin: BASE_URL } },
    );
    check(
      "sin sesión, GET /api/loans/preview responde 401",
      previewPrestamoSinSesion.status,
      401,
    );

    const pagoPrestamoSinSesion = await fetch(`${BASE_URL}/api/loans/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL },
      body: JSON.stringify({}),
    });
    check(
      "sin sesión, POST /api/loans/pay responde 401",
      pagoPrestamoSinSesion.status,
      401,
    );

    // Y las MISMAS escrituras, ahora CON sesión pero con `Origin` ajeno: acá
    // actúa la segunda capa anti-CSRF (`assertSameOrigin`, además de
    // `SameSite=Lax`). Si esto no diera 403, un sitio externo podría disparar
    // el generador o crear reglas en nombre de la persona logueada.
    const conOrigenAjeno = (path, options = {}) =>
      fetch(`${BASE_URL}${path}`, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          Origin: "http://evil.example",
          Cookie: cookie,
        },
      });

    const runAjeno = await conOrigenAjeno("/api/recurrence/run", {
      method: "POST",
      body: "{}",
    });
    check("con Origin ajeno, POST /api/recurrence/run responde 403", runAjeno.status, 403);

    const reglasAjenas = await conOrigenAjeno("/api/recurrence/rules", {
      method: "POST",
      body: JSON.stringify({ title: "x" }),
    });
    check("con Origin ajeno, POST /api/recurrence/rules responde 403", reglasAjenas.status, 403);

    const patchAjeno = await conOrigenAjeno("/api/recurrence/rules", {
      method: "PATCH",
      body: JSON.stringify({ id: "x" }),
    });
    check("con Origin ajeno, PATCH /api/recurrence/rules responde 403", patchAjeno.status, 403);

    const deleteAjeno = await conOrigenAjeno("/api/recurrence/rules?id=x", {
      method: "DELETE",
    });
    check("con Origin ajeno, DELETE /api/recurrence/rules responde 403", deleteAjeno.status, 403);

    const ocurrenciaAjena = await conOrigenAjeno("/api/recurrence/occurrences", {
      method: "POST",
      body: JSON.stringify({ id: "x", action: "accept" }),
    });
    check(
      "con Origin ajeno, POST /api/recurrence/occurrences responde 403",
      ocurrenciaAjena.status,
      403,
    );

    // Tarjetas: las cuatro mutaciones, con origen ajeno.
    const resumenesAjenos = await conOrigenAjeno("/api/cards/statements", {
      method: "POST",
      body: "{}",
    });
    check(
      "con Origin ajeno, POST /api/cards/statements responde 403",
      resumenesAjenos.status,
      403,
    );

    const pagoAjeno = await conOrigenAjeno("/api/cards/statements/pay", {
      method: "POST",
      body: JSON.stringify({}),
    });
    check(
      "con Origin ajeno, POST /api/cards/statements/pay responde 403",
      pagoAjeno.status,
      403,
    );

    const planAjeno = await conOrigenAjeno("/api/cards/plans", {
      method: "POST",
      body: JSON.stringify({}),
    });
    check("con Origin ajeno, POST /api/cards/plans responde 403", planAjeno.status, 403);

    const borrarPlanAjeno = await conOrigenAjeno("/api/cards/plans?id=x", {
      method: "DELETE",
    });
    check(
      "con Origin ajeno, DELETE /api/cards/plans responde 403",
      borrarPlanAjeno.status,
      403,
    );

    // El pago de un préstamo es la mutación más sensible de la Fase 4: un sitio
    // externo no puede pagar cuotas en nombre de la persona logueada.
    const pagoPrestamoAjeno = await conOrigenAjeno("/api/loans/pay", {
      method: "POST",
      body: JSON.stringify({}),
    });
    check(
      "con Origin ajeno, POST /api/loans/pay responde 403",
      pagoPrestamoAjeno.status,
      403,
    );
  }

  // ── Cuerpos hostiles ───────────────────────────────────────────────────────
  // Un JSON VÁLIDO no es lo mismo que un objeto: `null`, `"hola"`, `42` y
  // `[1,2]` parsean sin error, así que envolver `req.json()` en try/catch no
  // alcanza. Si el cuerpo llega como `null` literal y la ruta lee `body.algo`,
  // el TypeError cae FUERA del try y el cliente ve un 500 que no explica nada
  // (así lo encontró la batería del tester: "reading 'title'", "reading
  // 'name'"). Contrato: todo cuerpo que no sea un objeto JSON se rechaza con
  // 400 y un mensaje que diga por qué.
  section("Cuerpos hostiles (400, nunca 500)");
  {
    const conCuerpoCrudo = (path, method, raw) =>
      fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Origin: BASE_URL,
          Cookie: cookie,
        },
        body: raw,
      });

    const casosHostiles = [
      ["null", "null"],
      ["texto", '"hola"'],
      ["número", "42"],
      ["array", "[1,2]"],
    ];

    const rutasConCuerpo = [
      ["/api/accounts", "POST"],
      ["/api/accounts", "PATCH"],
      ["/api/categories", "POST"],
      ["/api/transactions", "POST"],
      ["/api/recurrence/rules", "POST"],
      ["/api/recurrence/rules", "PATCH"],
      ["/api/recurrence/occurrences", "POST"],
      ["/api/cards/statements", "POST"],
      ["/api/cards/statements/pay", "POST"],
      ["/api/cards/plans", "POST"],
      ["/api/loans/pay", "POST"],
    ];

    for (const [path, method] of rutasConCuerpo) {
      for (const [nombreCaso, raw] of casosHostiles) {
        const respuesta = await conCuerpoCrudo(path, method, raw);
        check(`${method} ${path} · cuerpo ${nombreCaso} responde 400`, respuesta.status, 400);

        // El caso `null` además tiene que EXPLICAR qué está mal: un 400 mudo
        // obliga a adivinar (y a leer el código) al que escribe un cliente.
        if (nombreCaso === "null") {
          const cuerpo = await respuesta.json().catch(() => null);
          checkTrue(
            `${method} ${path} · cuerpo null explica el motivo`,
            typeof cuerpo?.error === "string" && cuerpo.error.includes("objeto JSON"),
            `body: ${JSON.stringify(cuerpo)}`,
          );
        }
      }
    }
  }

  if (checkOnly) {
    console.log("\n(--check-only: no se escribió nada)");
    return;
  }

  // ── Cuentas ────────────────────────────────────────────────────────────────
  section("Cuentas");

  // ─────────────────────────────────────────────────────────────────────────────
  // EL ORDEN DE CREACIÓN IMPORTA (para los tests de interfaz)
  // ─────────────────────────────────────────────────────────────────────────────
  // Las cuentas se listan por `createdAt`, y la PRIMERA es la que el formulario
  // preselecciona como cuenta de origen. Se crea primero el banco y no el
  // efectivo para que el caso por defecto —cargar un gasto— sea el realista:
  // la mayoría de los gastos salen de la cuenta bancaria, no del bolsillo.
  //
  // Si el orden cambiara, los flujos de Maestro (que no pueden elegir en un
  // `<select>` nativo) empezarían a cargar todo desde el efectivo y los saldos
  // verificados dejarían de coincidir.
  // ─────────────────────────────────────────────────────────────────────────────

  const banco = await post("/api/accounts", {
    name: "Banco Galicia",
    kind: "BANK",
    openingBalance: "100.000",
  });
  check("crea Banco Galicia (201)", banco.status, 201);
  check(
    "el saldo inicial se interpreta como 100000,00",
    banco.body?.openingBalance,
    "100000.00",
  );

  const efectivo = await post("/api/accounts", {
    name: "Efectivo",
    kind: "CASH",
    openingBalance: "0",
  });
  check("crea Efectivo (201)", efectivo.status, 201);

  const visa = await post("/api/accounts", {
    name: "Visa Santander",
    kind: "CREDIT_CARD",
  });
  check("crea la tarjeta Visa (201)", visa.status, 201);

  const prestamo = await post("/api/accounts", {
    name: "Préstamo personal",
    kind: "LOAN",
    principal: "500.000",
    tnaPercent: "60",
    installmentCount: 12,
    firstInstallmentDate: "2026-10-15",
  });
  check("crea el préstamo (201)", prestamo.status, 201);

  // ── Reglas que la base tiene que hacer cumplir ─────────────────────────────
  section("Invariantes (la API tiene que rechazar lo imposible)");

  {
    const r = await post("/api/transactions", {
      kind: "INCOME",
      amount: "500000",
      date: `${MES}-01`,
      accountId: prestamo.body?.id,
      categoryName: "Sueldo",
    });
    check("rechaza un ingreso en un préstamo (400)", r.status, 400);
    checkTrue(
      "y lo explica en castellano",
      typeof r.body?.error === "string" && r.body.error.includes("transferencia"),
      JSON.stringify(r.body),
    );
  }

  {
    const r = await post("/api/transactions", {
      kind: "TRANSFER",
      amount: "1000",
      date: `${MES}-01`,
      accountId: banco.body?.id,
      toAccountId: banco.body?.id,
    });
    check("rechaza una transferencia a la misma cuenta (400)", r.status, 400);
  }

  {
    const r = await post("/api/transactions", {
      kind: "TRANSFER",
      amount: "1000",
      date: `${MES}-01`,
      accountId: banco.body?.id,
      toAccountId: efectivo.body?.id,
      categoryName: "Comida",
    });
    check("rechaza una transferencia CON categoría (400)", r.status, 400);
  }

  {
    const r = await post("/api/transactions", {
      kind: "EXPENSE",
      amount: "0",
      date: `${MES}-01`,
      accountId: banco.body?.id,
      categoryName: "Comida",
    });
    check("rechaza un monto de cero (400)", r.status, 400);
  }

  {
    const r = await post("/api/transactions", {
      kind: "EXPENSE",
      amount: "1000",
      date: "2026-02-31",
      accountId: banco.body?.id,
      categoryName: "Comida",
    });
    check("rechaza el 31 de febrero (400)", r.status, 400);
  }

  {
    const r = await post("/api/accounts", {
      name: "Banco Galicia",
      kind: "BANK",
    });
    check("rechaza una cuenta con nombre repetido (409)", r.status, 409);
  }

  section("Normalización de categorías");
  {
    // Estas dos son la prueba de que «Comida» y «COMIDA» terminan en la misma
    // categoría. Se crean y después se BORRAN, para que no ensucien los totales
    // del mes que se verifican más abajo.
    const primera = await post("/api/transactions", {
      kind: "EXPENSE",
      amount: "100",
      date: "2026-08-02",
      accountId: efectivo.body?.id,
      categoryName: "Comida",
    });
    const segunda = await post("/api/transactions", {
      kind: "EXPENSE",
      amount: "100",
      date: "2026-08-03",
      accountId: efectivo.body?.id,
      categoryName: "COMIDA",
    });

    const { body } = await api("/api/categories?kind=EXPENSE");
    const comidas = (body?.categories ?? []).filter((c) =>
      c.name.toLowerCase().includes("comida"),
    );
    check("«Comida» y «COMIDA» son UNA sola categoría", comidas.length, 1);
    check("y conserva el nombre original", comidas[0]?.name, "Comida");

    for (const id of [primera.body?.id, segunda.body?.id]) {
      if (id) await api(`/api/transactions?id=${id}`, { method: "DELETE" });
    }
    check("los movimientos de prueba se borraron", true, true);
  }

  // ── El préstamo: el desembolso es una TRANSFERENCIA ────────────────────────
  section("Préstamo · desembolso y primera cuota");

  const preview = await api(
    "/api/loans/preview?principal=500000&tnaPercent=60&installmentCount=12",
  );
  check("la vista previa responde 200", preview.status, 200);
  check("la cuota es 56.412,71", preview.body?.payment, "56412.71");
  check(
    "de 12 cuotas, el costo real del préstamo son 176.952,44",
    preview.body?.totalInterest,
    "176952.44",
  );

  const primeraCuota = preview.body?.schedule?.[0];
  check("cuota 1 · interés", primeraCuota?.interest, "25000.00");
  check("cuota 1 · capital", primeraCuota?.principal, "31412.71");

  // El desembolso: NO es un ingreso.
  const desembolso = await post("/api/transactions", {
    kind: "TRANSFER",
    amount: "500.000",
    date: "2026-09-30",
    accountId: prestamo.body?.id,
    toAccountId: banco.body?.id,
    description: "Desembolso del préstamo",
  });
  check("registra el desembolso como transferencia (201)", desembolso.status, 201);

  // ── El mes ─────────────────────────────────────────────────────────────────
  section("Movimientos de octubre");

  const movimientos = [
    {
      kind: "INCOME",
      amount: "800.000",
      date: `${MES}-01`,
      accountId: banco.body?.id,
      categoryName: "Sueldo",
      description: "Sueldo de octubre",
    },
    {
      kind: "EXPENSE",
      amount: "250.000",
      date: `${MES}-03`,
      accountId: banco.body?.id,
      categoryName: "Alquiler",
      description: "Alquiler de octubre",
    },
    {
      kind: "EXPENSE",
      amount: "120.000",
      date: `${MES}-05`,
      accountId: banco.body?.id,
      categoryName: "Supermercado",
    },
    {
      kind: "EXPENSE",
      amount: "45.000",
      date: `${MES}-08`,
      accountId: banco.body?.id,
      categoryName: "Transporte",
    },
    {
      // La compra con tarjeta es un gasto AHORA y genera deuda AHORA.
      kind: "EXPENSE",
      amount: "50.000",
      date: `${MES}-12`,
      accountId: visa.body?.id,
      categoryName: "Ropa",
      description: "Compra con tarjeta",
    },
    {
      // La cuota se descompone como la descompone el banco.
      kind: "TRANSFER",
      amount: primeraCuota?.principal,
      date: `${MES}-15`,
      accountId: banco.body?.id,
      toAccountId: prestamo.body?.id,
      description: "Cuota 1 · capital",
    },
    {
      kind: "EXPENSE",
      amount: primeraCuota?.interest,
      date: `${MES}-15`,
      accountId: banco.body?.id,
      categoryName: "Intereses",
      description: "Cuota 1 · interés",
    },
  ];

  for (const movement of movimientos) {
    const r = await post("/api/transactions", movement);
    if (r.status !== 201) {
      failed += 1;
      console.log(`  FALLA al crear "${movement.categoryName ?? movement.description}": ${r.status} ${JSON.stringify(r.body)}`);
    } else {
      passed += 1;
      console.log(`  ok    ${movement.kind.padEnd(8)} ${String(movement.amount).padStart(10)} · ${movement.categoryName ?? movement.description}`);
    }
  }

  // ── Verificación de los números ────────────────────────────────────────────
  section("LOS NÚMEROS");

  const { body: accountsData } = await api(
    `/api/accounts?asOf=${MES}-31&includeArchived=false`,
  );
  const byName = (name) =>
    (accountsData?.accounts ?? []).find((a) => a.name === name);

  // Ingresos: 800.000 (sólo el sueldo — el préstamo NO es ingreso)
  // Gastos: 250.000 + 120.000 + 45.000 + 50.000 + 25.000 = 490.000
  //         (incluye el interés del préstamo, que es el único costo real)
  // Resultado: 310.000 → tasa de ahorro 38,75%

  const { body: movs } = await api(`/api/transactions?from=${MES}-01&to=${MES}-31`);
  const ingresos = (movs?.movements ?? []).filter((m) => m.kind === "INCOME");
  const gastos = (movs?.movements ?? []).filter((m) => m.kind === "EXPENSE");
  const transferencias = (movs?.movements ?? []).filter((m) => m.kind === "TRANSFER");

  const suma = (rows) =>
    rows.reduce((acc, m) => acc + Math.round(Number(m.amount) * 100), 0) / 100;

  check("hay 1 ingreso (el sueldo, y NADA más)", ingresos.length, 1);
  check("el ingreso es 800.000,00", suma(ingresos).toFixed(2), "800000.00");
  check("hay 5 gastos", gastos.length, 5);
  check("los gastos suman 490.000,00 — el préstamo no infla los gastos", suma(gastos).toFixed(2), "490000.00");
  // Una sola: la amortización de capital de la cuota. El desembolso del préstamo
  // es de septiembre y NO tiene que aparecer en octubre — si apareciera, el
  // rango del mes se estaría comiendo el mes anterior.
  check("hay 1 transferencia (y no 2: el desembolso es de septiembre)", transferencias.length, 1);

  // ── Los totales, calculados en el SERVIDOR ─────────────────────────────────
  //
  // Ojo con el detalle: las sumas de arriba (`suma(ingresos)`, `suma(gastos)`) NO
  // habrían encontrado el bug de los totales truncados, porque repiten el mismo
  // cálculo que hacía el cliente sobre la misma lista. Un test que reimplementa
  // el bug lo confirma en vez de encontrarlo.
  //
  // Lo que sí lo encuentra es comparar los `totals` —que la base agrega sin
  // tope— contra valores conocidos de antemano.
  section("Los totales del período, agregados en la base");
  check("totals.income = 800.000,00 (sólo el sueldo)", movs?.totals?.income, "800000.00");
  check("totals.expenses = 490.000,00", movs?.totals?.expenses, "490000.00");
  check(
    "totals.transfers = 31.412,71 (sólo el capital de la cuota: interés no es transferencia)",
    movs?.totals?.transfers,
    "31412.71",
  );
  check("totals.incomeCount = 1", movs?.totals?.incomeCount, 1);
  check("totals.expenseCount = 5", movs?.totals?.expenseCount, 5);
  check("totals.transferCount = 1", movs?.totals?.transferCount, 1);
  checkTrue("el período entra en una consulta, así que no está truncado", movs?.truncated === false);

  // ── Flujo de caja (liquidez): la plata que entró y salió de las cuentas ────
  //
  // El número se calcula a mano acá, para no repetir la fórmula que se está
  // probando:
  //
  //   Entradas: 800.000,00                  (sueldo → banco)
  //   Salidas:  250.000 + 120.000 + 45.000  (gastos que salieron del banco)
  //           + 25.000,00                   (interés de la cuota → banco)
  //           + 31.412,71                   (capital de la cuota: banco → préstamo)
  //           = 471.412,71
  //   Flujo:    800.000,00 − 471.412,71 = 328.587,29
  //
  // La compra con tarjeta (50.000) queda AFUERA a propósito: es un gasto
  // consumido, pero la plata sale recién al pagar el resumen — y este mes no se
  // pagó. Si contara, el flujo daría 278.587,29.
  //
  // Y el ahorro del mes es 310.000,00, así que los dos números son distintos:
  // ésa es toda la distinción del rediseño.
  check(
    "totals.cashFlow = 328.587,29 (liquidez, no ahorro)",
    movs?.totals?.cashFlow,
    "328587.29",
  );

  // ── Coherencia temporal: el desembolso suma en el AÑO, no en el mes ────────
  //
  // El desembolso es del 30/09: tiene que entrar al flujo del año completo y
  // NO al de octubre. Es la misma lección del bug B3 —el rango del mes no se
  // come el mes anterior— aplicada a la liquidez.
  {
    const { body: flujoSeptiembre } = await api(
      "/api/transactions?from=2026-09-01&to=2026-09-30",
    );
    // En septiembre lo único que pasó fue el desembolso: entró al banco.
    check(
      "el flujo de septiembre es +500.000,00 (el desembolso ENTRA a la caja)",
      flujoSeptiembre?.totals?.cashFlow,
      "500000.00",
    );

    const { body: flujoAnio } = await api(
      "/api/transactions?from=2026-01-01&to=2026-12-31",
    );
    // 500.000,00 (septiembre) + 328.587,29 (octubre) = 828.587,29
    check(
      "el flujo del AÑO sí incluye el desembolso: 828.587,29",
      flujoAnio?.totals?.cashFlow,
      "828587.29",
    );
  }

  // EL PATRIMONIO NETO ES EL NÚMERO HONESTO
  //   100.000 (ahorros previos) + 800.000 (sueldo) − 490.000 (gastos reales)
  //   = 410.000
  check("patrimonio neto = 410.000,00", accountsData?.netWorth?.net, "410000.00");
  check("activos = 928.587,29", accountsData?.netWorth?.assets, "928587.29");
  check("deudas = 518.587,29", accountsData?.netWorth?.liabilities, "518587.29");

  check(
    "el banco quedó con 928.587,29",
    byName("Banco Galicia")?.balance,
    "928587.29",
  );
  check(
    "la tarjeta debe 50.000,00 y se muestra en POSITIVO",
    byName("Visa Santander")?.debt,
    "50000.00",
  );
  check(
    "el préstamo debe 468.587,29",
    byName("Préstamo personal")?.debt,
    "468587.29",
  );
  check(
    "el efectivo quedó en cero (los movimientos de prueba se borraron)",
    byName("Efectivo")?.balance,
    "0.00",
  );

  // ── La serie mensual del patrimonio ────────────────────────────────────────
  //
  // `netWorthSeries` es la foto al cierre de cada uno de los últimos 12 meses
  // calendario, del más viejo al más nuevo. Se verifica contra números armados
  // A MANO sobre el seed, no contra el código que los generó.
  //
  // El escenario, resumido:
  //   · Saldos iniciales: banco 100.000,00; el resto en cero.
  //   · Septiembre: el 30/09 el desembolso del préstamo mueve 500.000 del
  //     préstamo al banco → banco 600.000, deuda 500.000. El neto NO cambia.
  //   · Octubre (hasta el 31): sueldo 800.000; gastos del banco 250.000 +
  //     120.000 + 45.000 + 25.000 (interés); cuota de capital 31.412,71
  //     (banco → préstamo); compra con tarjeta 50.000 (deuda nueva).
  //
  //   Banco:     600.000 + 800.000 − 440.000 − 31.412,71 = 928.587,29
  //   Deudas:    500.000 − 31.412,71 (capital) + 50.000 (visa) = 518.587,29
  //   Neto:      928.587,29 − 518.587,29 = 410.000,00
  section("La serie mensual del patrimonio (últimos 12 meses)");

  const serie = accountsData?.netWorthSeries ?? [];
  // Cada mes arranca en el día 1 y termina con el mes del ancla: con el ancla
  // de fin de octubre, la ventana es nov 2025 → oct 2026.
  check("la serie tiene 12 meses", serie.length, 12);
  check("arranca en noviembre 2025", serie[0]?.month, "2025-11");
  check("termina en octubre 2026 (el mes del ancla)", serie[11]?.month, "2026-10");
  checkTrue(
    "los meses vienen del más viejo al más nuevo, sin repetirse",
    serie.every((p, i) => i === 0 || p.month > serie[i - 1].month),
  );

  const mes = (m) => serie.find((p) => p.month === m);

  // Un mes ANTERIOR a cualquier movimiento (2025-11 a 2026-08) muestra los
  // saldos iniciales: el banco con 100.000 y nada más. No es un cero: el saldo
  // inicial no tiene fecha propia, así que es la única foto posible.
  check("un mes sin movimientos (agosto) muestra el saldo inicial", mes("2026-08")?.assets, "100000.00");
  check("y no tiene deudas todavía", mes("2026-08")?.liabilities, "0.00");
  check("su neto es 100.000,00", mes("2026-08")?.net, "100000.00");

  // Septiembre: la lección del panel aplicada al tiempo. El neto es el MISMO
  // que en agosto (100.000), pero la composición dice lo que pasó de verdad:
  // entró un préstamo de 500.000 que subió activos y deudas por igual. Si la
  // serie mostrara sólo el neto, "septiembre" parecería un mes vacío.
  check("septiembre · activos = 600.000,00 (banco 100.000 + desembolso 500.000)", mes("2026-09")?.assets, "600000.00");
  check("septiembre · deudas = 500.000,00 (el préstamo)", mes("2026-09")?.liabilities, "500000.00");
  check("septiembre · neto = 100.000,00 — el mismo de agosto, y está bien", mes("2026-09")?.net, "100000.00");

  // El borde de mes: el desembolso es del 30/09. Tiene que estar en septiembre
  // y NO en agosto (cuya foto cierra el 31/08). Es la lección del bug B3
  // aplicada a la serie: lo de arriba lo comprueba — agosto no se movió.
  check("octubre · activos = 928.587,29", mes("2026-10")?.assets, "928587.29");
  check("octubre · deudas = 518.587,29", mes("2026-10")?.liabilities, "518587.29");
  check("octubre · neto = 410.000,00", mes("2026-10")?.net, "410000.00");

  // Coherencia interna: con el ancla a fin de mes, el último punto de la serie
  // y el patrimonio de hoy salen de la misma fórmula y TIENEN que coincidir.
  // Si divergieran, habría dos definiciones de "patrimonio" en la app.
  check("el último punto coincide con netWorth.net", serie[11]?.net, accountsData?.netWorth?.net);
  checkTrue(
    "con el ancla a fin de mes, ningún punto es parcial",
    serie.every((p) => p.partial === false),
    JSON.stringify(serie.filter((p) => p.partial).map((p) => p.month)),
  );

  // ── La serie y el mes en curso ─────────────────────────────────────────────
  //
  // Con el ancla al 02/10, el mes en curso se corta ESE día y no a fin de mes:
  // la foto incluye el sueldo del 01/10 (800.000) pero todavía no el alquiler
  // del 03/10. El banco queda en 100.000 + 500.000 + 800.000 = 1.400.000,00,
  // las deudas en 500.000,00 (la tarjeta todavía no compró) y el neto en
  // 900.000,00. El mes viaja marcado `partial: true` para que la interfaz no
  // lo presente como un mes cerrado.
  {
    const { body: aMitad } = await api(`/api/accounts?asOf=${MES}-02`);
    const serieCorta = aMitad?.netWorthSeries ?? [];
    check("sigue siendo una ventana de 12 meses", serieCorta.length, 12);
    check("el último mes es octubre", serieCorta[11]?.month, "2026-10");
    checkTrue("y está marcado como en curso (parcial)", serieCorta[11]?.partial === true);
    check("activos al 02/10 = 1.400.000,00", serieCorta[11]?.assets, "1400000.00");
    check("deudas al 02/10 = 500.000,00", serieCorta[11]?.liabilities, "500000.00");
    check("neto al 02/10 = 900.000,00", serieCorta[11]?.net, "900000.00");
    checkTrue(
      "los meses cerrados anteriores no son parciales",
      (serieCorta.slice(0, 11) ?? []).every((p) => p.partial === false),
    );
    check("septiembre no cambia: su foto sigue cerrando el 30/09", serieCorta[10]?.net, "100000.00");
  }

  // ── Burn mensualizado (ROADMAP §5.3 #9) ────────────────────────────────────
  //
  // Un gasto anual puesto entero en un mes hace que ESE mes parezca
  // catastrófico; el reporte muestra las dos vistas: el mes de caja (la plata
  // salió de una vez) y el burn mensualizado (el mismo gasto repartido en 12,
  // para comparar meses entre sí).
  //
  // El escenario se siembra en ENERO 2027 a propósito: queda fuera de todos los
  // rangos de 2026 que verifica el resto del archivo y fuera de los flujos de
  // Maestro (que sólo navegan agosto–octubre de 2026 y el año 2026). Es el
  // único lugar donde un gasto anual no pisa ningún número ya verificado.
  //
  //   Sueldo de enero        +600.000,00
  //   Alquiler de enero      −500.000,00
  //   Expensas anuales       −240.000,00   → 240.000 / 12 = 20.000 por mes
  //
  //   Mes de caja:  600.000 − 740.000 = −140.000,00
  //   Burn:         600.000 − 520.000 =  +80.000,00
  section("Burn mensualizado · el gasto anual en las dos vistas");
  {
    const anuales = [
      {
        kind: "INCOME",
        amount: "600.000",
        date: "2027-01-01",
        accountId: banco.body?.id,
        categoryName: "Sueldo",
        description: "Sueldo de enero 2027",
      },
      {
        kind: "EXPENSE",
        amount: "500.000",
        date: "2027-01-05",
        accountId: banco.body?.id,
        categoryName: "Alquiler",
        description: "Alquiler de enero 2027",
      },
      {
        // El gasto anual: la razón de ser del burn.
        kind: "EXPENSE",
        amount: "240.000",
        date: "2027-01-20",
        accountId: banco.body?.id,
        categoryName: "Expensas",
        description: "Expensas anuales 2027",
      },
    ];

    for (const movement of anuales) {
      const r = await post("/api/transactions", movement);
      if (r.status !== 201) {
        failed += 1;
        console.log(`  FALLA al crear "${movement.description}": ${r.status} ${JSON.stringify(r.body)}`);
      } else {
        passed += 1;
        console.log(`  ok    ${movement.kind.padEnd(8)} ${String(movement.amount).padStart(10)} · ${movement.description}`);
      }
    }

    const { status: eneroStatus, body: enero } = await api(
      "/api/reports?from=2027-01-01&to=2027-01-31",
    );
    check("/api/reports de enero responde 200", eneroStatus, 200);
    check("enero · ingresos = 600.000,00", enero?.totals?.income, "600000.00");
    check("enero · gastos = 740.000,00 (el anual, entero)", enero?.totals?.expenses, "740000.00");

    // El selector de burn: sólo gastos, ordenados por monto descendente.
    check("enero · dos candidatos (el sueldo no es gasto)", enero?.burnCandidates?.length, 2);
    check("y van de mayor a menor", enero?.burnCandidates?.[0]?.amount, "500000.00");
    check(
      "el gasto anual es el segundo",
      enero?.burnCandidates?.[1]?.description,
      "Expensas anuales 2027",
    );
    checkTrue("la lista no está truncada", enero?.burnCandidatesTruncated === false);
    checkTrue("sin ?burn, no hay vista de burn", enero?.burn === null);

    const expensaId = enero?.burnCandidates?.[1]?.id;
    const { body: burnEnero } = await api(
      `/api/reports?from=2027-01-01&to=2027-01-31&burn=${expensaId}`,
    );
    check("el burn reparte: 240.000 ÷ 12 = 20.000,00", burnEnero?.burn?.monthlyShare, "20000.00");
    check("gastos con el burn = 520.000,00", burnEnero?.burn?.burnExpenses, "520000.00");
    check("mes de caja: −140.000,00", burnEnero?.burn?.cashResult, "-140000.00");
    check("mes con burn: +80.000,00", burnEnero?.burn?.burnResult, "80000.00");

    // Un id viejo o inventado no rompe la pantalla: la vista no aparece.
    const { status: invalidoStatus, body: invalido } = await api(
      "/api/reports?from=2027-01-01&to=2027-01-31&burn=no-existe",
    );
    check("un burn inválido no es un error", invalidoStatus, 200);
    checkTrue("y la vista viaja en null", invalido?.burn === null);

    // ── Octubre 2026: el reparto que NO da exacto ────────────────────────────
    // 250.000 / 12 = 20.833,333… → 20.833,33. El centavo importa: es la prueba
    // de que el redondeo vive en un solo lugar (half-even, 2 decimales).
    const { body: octubreBase } = await api(
      `/api/reports?from=${MES}-01&to=${MES}-31`,
    );
    const alquilerOctubre = (octubreBase?.burnCandidates ?? []).find(
      (candidate) => candidate.description === "Alquiler de octubre",
    );
    checkTrue("el alquiler de octubre está entre los candidatos", Boolean(alquilerOctubre?.id));

    // Sin descripción, la etiqueta del selector cae a la categoría: si el
    // gasto viajara con `description: ""` (lo que guarda la base), la opción
    // quedaría sin nombre ("· $ 120.000,00 · fecha") y `??` no caería nunca.
    const sinDescripcion = (octubreBase?.burnCandidates ?? []).find(
      (candidate) => candidate.categoryName === "Supermercado",
    );
    check("un gasto sin descripción viaja con description null", sinDescripcion?.description, null);
    check("y conserva su categoría como etiqueta", sinDescripcion?.categoryName, "Supermercado");

    const { body: burnOctubre } = await api(
      `/api/reports?from=${MES}-01&to=${MES}-31&burn=${alquilerOctubre?.id}`,
    );
    check("octubre · 250.000 ÷ 12 = 20.833,33", burnOctubre?.burn?.monthlyShare, "20833.33");
    check("octubre · gastos con burn = 260.833,33", burnOctubre?.burn?.burnExpenses, "260833.33");
    check("octubre · el mes de caja queda en +310.000,00", burnOctubre?.burn?.cashResult, "310000.00");
    check("octubre · repartido queda en +539.166,67", burnOctubre?.burn?.burnResult, "539166.67");

    // ── Los filtros de pantalla no tocan la lista ni el cálculo ─────────────
    // El selector de burn no se filtra a sí mismo (igual que el de categorías)
    // y el burn se calcula contra el período completo: restarle al total un
    // gasto que el filtro dejó afuera sería restar algo que nunca sumó.
    const { body: categoriasBurn } = await api("/api/categories?kind=EXPENSE");
    const ropaBurn = (categoriasBurn?.categories ?? []).find(
      (category) => category.name === "Ropa",
    );
    const { body: conFiltro } = await api(
      `/api/reports?from=${MES}-01&to=${MES}-31&categoryId=${ropaBurn?.id}&burn=${alquilerOctubre?.id}`,
    );
    check("con filtro Ropa, la pantalla se achica", conFiltro?.totals?.expenses, "50000.00");
    check("pero la lista de candidatos no cambia", conFiltro?.burnCandidates?.length, 5);
    check("ni los gastos del burn: 490.000,00 completos", conFiltro?.burn?.expenses, "490000.00");
    check("y el resultado del burn tampoco", conFiltro?.burn?.burnResult, "539166.67");
  }

  // La ruta que usa el panel (sin `asOf`) termina en el mes ACTUAL del reloj
  // local —el mismo que ve la persona en la interfaz— y su último punto tiene
  // que coincidir con `netWorth.net` de esa misma respuesta.
  //
  // Acá arriba se sembró A PROPÓSITO un escenario con movimientos futuros
  // (enero 2027), así que este bloque es la prueba viva del corte: sin `asOf`,
  // las TRES vistas usan HOY. Si los saldos sumaran todo el historial —lo que
  // hacían antes—, el patrimonio daría 270.000,00 (410.000 − 140.000 de enero)
  // mientras el último punto de la serie corta en hoy: dos "hoy" distintos en
  // la misma respuesta, y el panel mostrando uno que su propia serie desmiente.
  {
    const { body: hoy } = await api("/api/accounts?includeArchived=false");
    const ahora = new Date();
    const mesActual = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, "0")}`;
    const ultimo = (hoy?.netWorthSeries ?? []).at(-1);
    check("sin asOf, la serie termina en el mes actual", ultimo?.month, mesActual);
    check("y su neto coincide con el patrimonio de hoy", ultimo?.net, hoy?.netWorth?.net);
    check(
      "sin asOf, el patrimonio de hoy NO cuenta los movimientos futuros",
      hoy?.netWorth?.net,
      "410000.00",
    );
  }

  // ── La reconciliación visible (ΔPatrimonio = Ahorro) ───────────────────────
  //
  // La red de seguridad del modelo, ahora con su propia ruta: compara la
  // variación del patrimonio (los SALDOS) contra el ahorro del mes (los
  // MOVIMIENTOS) y muestra la diferencia cuando no cuadra. Acá se verifica
  // contra números armados A MANO sobre el seed, igual que todo lo demás.
  //
  //   Septiembre   net(31/08) 100.000 → net(30/09) 100.000
  //                (el desembolso de 500.000 sube banco y deuda por igual)
  //                Δ 0,00 = ahorro 0,00 (la transferencia no es ingreso)
  //
  //   Octubre      net(30/09) 100.000 → net(31/10) 410.000 → Δ +310.000,00
  //                ahorro 800.000 − 490.000 = +310.000,00 → diferencia 0,00
  section("La reconciliación visible (ΔPatrimonio = Ahorro)");
  {
    const { status: recStatus, body: rec } = await api(
      `/api/reconciliation?month=${MES}&asOf=${MES}-31`,
    );
    const oct = rec?.reconciliation;

    check("/api/reconciliation responde 200", recStatus, 200);
    check(
      "octubre · netStart = 100.000,00 (cierre de septiembre)",
      oct?.netStart,
      "100000.00",
    );
    check(
      "octubre · netEnd = 410.000,00 (cierre de octubre)",
      oct?.netEnd,
      "410000.00",
    );
    check("octubre · ΔPatrimonio = +310.000,00", oct?.netDelta, "310000.00");
    check(
      "octubre · ahorro = +310.000,00 (800.000 − 490.000)",
      oct?.saving,
      "310000.00",
    );
    check("octubre · la diferencia es 0,00", oct?.difference, "0.00");
    checkTrue("octubre · cuadra al centavo", oct?.balanced === true);
    checkTrue(
      "octubre · con el asOf de fin de mes no es parcial",
      oct?.partial === false,
    );
    check("octubre · el corte es el 31/10", oct?.cutAt, `${MES}-31`);

    // Septiembre: el préstamo mueve activos y pasivos por el mismo monto, así
    // que el patrimonio NO se mueve — y el ahorro es cero porque el desembolso
    // es una transferencia. Los dos caminos dicen lo mismo: no ganaste nada.
    const { body: recSep } = await api(
      `/api/reconciliation?month=2026-09&asOf=${MES}-31`,
    );
    const sepRec = recSep?.reconciliation;

    check(
      "septiembre · netStart = 100.000,00 (cierre de agosto)",
      sepRec?.netStart,
      "100000.00",
    );
    check(
      "septiembre · netEnd = 100.000,00 (el desembolso no mueve el neto)",
      sepRec?.netEnd,
      "100000.00",
    );
    check("septiembre · ahorro 0,00 = Δ 0,00", sepRec?.difference, "0.00");
    check(
      "septiembre · ahorro = 0,00 (la transferencia no es ingreso)",
      sepRec?.saving,
      "0.00",
    );
    checkTrue("septiembre · cuadra en cero", sepRec?.balanced === true);

    // Agosto: un mes sin movimientos no es un caso especial — es la misma
    // identidad con todo en cero y las dos fotos iguales.
    const { body: recAgo } = await api(
      `/api/reconciliation?month=2026-08&asOf=${MES}-31`,
    );
    const agoRec = recAgo?.reconciliation;

    check("agosto · Δ 0,00 = ahorro 0,00 (mes sin movimientos)", agoRec?.difference, "0.00");
    check("agosto · netStart = 100.000,00 (saldo inicial)", agoRec?.netStart, "100000.00");
    check("agosto · netEnd = 100.000,00 (las dos fotos son la misma)", agoRec?.netEnd, "100000.00");
    checkTrue("agosto · cuadra", agoRec?.balanced === true);

    // El mes en curso se corta a la fecha del ancla en LOS DOS lados: al 02/10
    // entró el sueldo (800.000) y los gastos del 03/10 todavía no. Si cada lado
    // cortara distinto (por ejemplo, el ahorro a fin de mes), el control daría
    // una falsa alarma — y una alarma falsa es peor que ninguna.
    const { body: recCorto } = await api(
      `/api/reconciliation?month=${MES}&asOf=${MES}-02`,
    );
    const corto = recCorto?.reconciliation;

    check("al 02/10 · Δ = +800.000,00 (el sueldo)", corto?.netDelta, "800000.00");
    check("al 02/10 · ahorro = +800.000,00", corto?.saving, "800000.00");
    check("al 02/10 · el corte es el 02/10", corto?.cutAt, `${MES}-02`);
    checkTrue("al 02/10 · marcado en curso (parcial)", corto?.partial === true);

    // Con datos consistentes, CUALQUIER corte cuadra. Sin `asOf` la ruta usa el
    // reloj: el mes del panel tiene que dar `balanced` siempre — parcial o no.
    const { body: recHoy } = await api(`/api/reconciliation?month=${MES}`);
    checkTrue(
      "sin asOf, el mes del reloj también cuadra (datos consistentes)",
      recHoy?.reconciliation?.balanced === true,
    );

    // Un mes que no existe es una entrada inválida: 400, no un 500 ni una
    // reconciliación inventada de ceros.
    const { status: mesMalo } = await api("/api/reconciliation?month=2026-13");
    check("month=2026-13 responde 400", mesMalo, 400);
  }

  // ── Los reportes de deuda (progreso, interés y DTI) ────────────────────────
  //
  // El reporte de UN mes: deuda viva al corte, progreso del capital, interés
  // pagado, cuotas restantes y DTI — todo del servidor. Los números se arman A
  // MANO sobre el seed, como todo lo demás en este script:
  //
  //   Deuda viva al 31/10:  Visa 50.000,00 (la compra del 12/10)
  //                         Préstamo 468.587,29 (500.000 − 31.412,71)
  //   Cuota 1 del préstamo: 56.412,71 = 31.412,71 de capital + 25.000,00 de interés
  //   Progreso:             31.412,71 / 500.000 = 6,28% → 11 cuotas por pagar
  //   DTI:                  56.412,71 / 800.000 = 7,05% del ingreso del mes
  section("Los reportes de deuda (progreso, interés y DTI)");
  {
    const { status: deudaStatus, body: deudaData } = await api(
      `/api/debts?month=${MES}&asOf=${MES}-31`,
    );
    const deuda = deudaData?.debtReport;

    check("/api/debts responde 200", deudaStatus, 200);
    check("octubre · el corte es el 31/10", deuda?.cutAt, `${MES}-31`);
    checkTrue("octubre · no es un corte parcial", deuda?.partial === false);

    // Las filas: TODAS las cuentas de deuda, en el orden del panel (no
    // archivadas primero; después, por creación). Visa se creó antes que el
    // préstamo, así que va primera.
    const filas = deuda?.rows ?? [];
    check("se muestran las dos cuentas de deuda (Visa y Préstamo)", filas.length, 2);
    check("la primera fila es la Visa (orden del panel)", filas[0]?.name, "Visa Santander");

    const visa = filas.find((f) => f.name === "Visa Santander");
    const prestamo = filas.find((f) => f.name === "Préstamo personal");

    check("Visa · deuda viva 50.000,00", visa?.debt, "50000.00");
    check(
      "Visa · sin plan (el modelo no conoce planes de tarjeta): null, no un plan inventado",
      visa?.plan,
      null,
    );
    check("Préstamo · deuda viva 468.587,29", prestamo?.debt, "468587.29");
    check("Préstamo · cuota mensual del plan = 56.412,71", prestamo?.plan?.payment, "56412.71");
    check(
      "Préstamo · el principal del plan sale del cronograma (500.000,00)",
      prestamo?.plan?.principal,
      "500000.00",
    );
    check("Préstamo · 1 de 12 cuotas cubiertas", prestamo?.plan?.paidCount, 1);
    check("Préstamo · 11 cuotas restantes", prestamo?.plan?.remainingCount, 11);
    check("Préstamo · capital amortizado 31.412,71 (la transferencia al préstamo)", prestamo?.capitalPaid, "31412.71");
    check("Préstamo · interés pagado 25.000,00 (el de la cuota 1, sin estimar)", prestamo?.interestPaid, "25000.00");
    check("Préstamo · progreso 6,28%", prestamo?.progressPercent, "6.28");
    check("el total de deuda suma las dos filas", deuda?.totalDebt, "518587.29");

    check(
      "DTI · compromiso mensual = 56.412,71 (sólo planes con cuotas pendientes)",
      deuda?.dti?.monthlyCommitment,
      "56412.71",
    );
    check("DTI · ingreso del mes = 800.000,00", deuda?.dti?.income, "800000.00");
    check("DTI · 7,05% del ingreso comprometido", deuda?.dti?.percent, "7.05");
    check("DTI · un plan con cuotas pendientes", deuda?.dti?.planCount, 1);

    // Septiembre: al 30/09 la deuda es SOLO el préstamo recién desembolsado (la
    // tarjeta todavía no compró), no hay capital amortizado —y por lo tanto
    // tampoco interés— y el mes no tuvo ingresos: el DTI NO se muestra como 0%,
    // viaja `null` ("no se puede calcular"). La Visa, en cero, igual aparece:
    // una cuenta de deuda abierta se muestra aunque deba cero.
    const { body: deudaSep } = await api(
      `/api/debts?month=2026-09&asOf=${MES}-31`,
    );
    const sep = deudaSep?.debtReport;
    const visaSep = (sep?.rows ?? []).find((f) => f.name === "Visa Santander");
    const prestamoSep = (sep?.rows ?? []).find((f) => f.name === "Préstamo personal");

    check("septiembre · el corte es el 30/09", sep?.cutAt, "2026-09-30");
    check("septiembre · la Visa aparece en cero (no se esconde)", visaSep?.debt, "0.00");
    check("septiembre · deuda total 500.000,00 (sin la tarjeta todavía)", sep?.totalDebt, "500000.00");
    check("septiembre · capital amortizado 0,00", prestamoSep?.capitalPaid, "0.00");
    check("septiembre · 12 cuotas restantes", prestamoSep?.plan?.remainingCount, 12);
    check("septiembre · interés pagado 0,00 (no se estima)", prestamoSep?.interestPaid, "0.00");
    check("septiembre · ingreso del mes 0,00", sep?.dti?.income, "0.00");
    check("septiembre · sin ingreso el DTI viaja null", sep?.dti?.percent, null);

    // Un corte EN CURSO (al 02/10) tampoco rompe nada: la deuda de la Visa es
    // la de ESA fecha —la compra del 12/10 todavía no pasó— y el corte lo dice.
    const { body: deudaCorto } = await api(
      `/api/debts?month=${MES}&asOf=${MES}-02`,
    );
    const corto = deudaCorto?.debtReport;
    const visaCorta = (corto?.rows ?? []).find((f) => f.name === "Visa Santander");

    checkTrue("al 02/10 · marcado en curso (parcial)", corto?.partial === true);
    check("al 02/10 · la Visa todavía debe 0,00 (la compra del 12/10 no pasó)", visaCorta?.debt, "0.00");
    check("al 02/10 · deuda total 500.000,00 (sólo el préstamo)", corto?.totalDebt, "500000.00");

    // La ruta que usará el panel (sin `asOf`) corta con el reloj: tiene que
    // responder igual, sin que el corte se pase del fin del mes mostrado.
    const { status: deudaHoyStatus, body: deudaHoy } = await api(
      `/api/debts?month=${MES}`,
    );
    check("sin asOf también responde 200", deudaHoyStatus, 200);
    checkTrue(
      "sin asOf el corte no pasa del fin del mes",
      deudaHoy?.debtReport?.cutAt <= `${MES}-31`,
      `cutAt = ${deudaHoy?.debtReport?.cutAt}`,
    );

    // Un mes que no existe es una entrada inválida: 400, no un 500 ni un
    // reporte inventado de ceros.
    const { status: mesMaloDeudas } = await api("/api/debts?month=2026-13");
    check("month=2026-13 responde 400", mesMaloDeudas, 400);
    const { status: mesTexto } = await api("/api/debts?month=octubre");
    check("month=octubre (texto) responde 400", mesTexto, 400);
    const { status: asOfMalo } = await api(`/api/debts?month=${MES}&asOf=2026-02-31`);
    check("asOf=2026-02-31 (fecha inexistente) responde 400", asOfMalo, 400);
    const { status: asOfTexto } = await api(`/api/debts?month=${MES}&asOf=basura`);
    check("asOf=basura responde 400", asOfTexto, 400);

    // Agosto: el corte es el 31/08 y en esa fecha NO existía ningún movimiento
    // de deuda — la compra con tarjeta es del 12/10 y el desembolso, del 30/09.
    // Las dos cuentas aparecen en cero (el cero es un dato), el plan del
    // préstamo todavía no cubrió ninguna cuota y, sin ingresos en ese mes, el
    // DTI viaja null. "Deuda viva" es al corte del mes: mostrarla de HOY acá
    // sería viajar en el tiempo con el número equivocado.
    const { body: deudaAgo } = await api(
      `/api/debts?month=2026-08&asOf=${MES}-31`,
    );
    const ago = deudaAgo?.debtReport;
    const visaAgo = (ago?.rows ?? []).find((f) => f.name === "Visa Santander");
    const prestamoAgo = (ago?.rows ?? []).find((f) => f.name === "Préstamo personal");

    check("agosto · el corte es el 31/08", ago?.cutAt, "2026-08-31");
    check("agosto · la Visa debe 0,00 en ese corte (la compra es del 12/10)", visaAgo?.debt, "0.00");
    check("agosto · el préstamo debe 0,00 (el desembolso es del 30/09)", prestamoAgo?.debt, "0.00");
    check("agosto · deuda total 0,00", ago?.totalDebt, "0.00");
    check("agosto · 0 de 12 cuotas cubiertas", prestamoAgo?.plan?.paidCount, 0);
    check("agosto · sin ingreso el DTI viaja null", ago?.dti?.percent, null);

    // Un mes FUTURO se corta a fin de mes (la misma convención de `monthCut`
    // que la reconciliación): sin movimientos precargados da el mismo estado
    // que octubre, y el DTI de noviembre queda null porque ese mes no tiene
    // ingresos aún. Lo que NO puede pasar es que el corte se corra a hoy.
    const { body: deudaNov } = await api(
      `/api/debts?month=2026-11&asOf=${MES}-31`,
    );
    const nov = deudaNov?.debtReport;
    check("noviembre · mes futuro: el corte es el 30/11", nov?.cutAt, "2026-11-30");
    checkTrue("noviembre · no es parcial (la convención corta a fin de mes)", nov?.partial === false);
    check("noviembre · deuda total 518.587,29 (misma foto que octubre)", nov?.totalDebt, "518587.29");
    check("noviembre · 11 cuotas restantes", (nov?.rows ?? []).find((f) => f.name === "Préstamo personal")?.plan?.remainingCount, 11);
    check("noviembre · sin ingresos, DTI null", nov?.dti?.percent, null);
  }

  // ── Los reportes de /analisis, agregados en el SERVIDOR ────────────────────
  //
  // /analisis ya no suma la lista topeada: pide sus tres agregados —totales,
  // torta por categoría y barras por día— a /api/reports, que los calcula en la
  // base sobre el período completo. Acá se verifica la coherencia interna de la
  // respuesta y que los filtros achiquen el conjunto correcto.
  section("Reportes server-side (los agregados de /analisis)");
  {
    const { status, body: reporte } = await api(
      `/api/reports?from=${MES}-01&to=${MES}-31`,
    );
    check("/api/reports responde 200", status, 200);

    // Los mismos números que ya verificó la sección anterior, ahora por la ruta
    // que usa la pantalla de análisis.
    check("totals.income = 800.000,00", reporte?.totals?.income, "800000.00");
    check("totals.expenses = 490.000,00", reporte?.totals?.expenses, "490000.00");
    check(
      "totals.transfers = 31.412,71, informada aparte",
      reporte?.totals?.transfers,
      "31412.71",
    );

    // El flujo de caja viaja en el mismo DTO: el panel lo lee de
    // /api/transactions y /analisis de acá, y los dos tienen que ver el mismo
    // número (sale de `movementCashFlow`, una sola fórmula).
    check(
      "totals.cashFlow = 328.587,29, el mismo número que ve el panel",
      reporte?.totals?.cashFlow,
      "328587.29",
    );

    const enCentavos = (rows) =>
      rows.reduce((acc, row) => acc + Math.round(Number(row.amount) * 100), 0);

    // Coherencia interna: la suma de las porciones de la torta es exactamente
    // el total de gastos. Si la transferencia se colara en la torta, no
    // cerraría: sobrarían 31.412,71.
    check(
      "la torta suma exactamente los gastos del período",
      enCentavos(reporte?.byCategory ?? []),
      Math.round(Number(reporte?.totals?.expenses ?? 0) * 100),
    );

    // Las barras: ingresos + gastos, sin la transferencia.
    //   800.000,00 + 490.000,00 = 1.290.000,00 → 129.000.000 centavos.
    checkTrue("las barras tienen datos", (reporte?.byDate ?? []).length > 0);
    check(
      "las barras suman ingresos + gastos, sin transferencias",
      enCentavos(reporte?.byDate ?? []),
      129000000,
    );

    // El filtro de texto: "octubre" está en las descripciones del sueldo y del
    // alquiler, así que deja el ingreso intacto y achica los gastos a 250.000.
    const { body: conTexto } = await api(
      `/api/reports?from=${MES}-01&to=${MES}-31&q=octubre`,
    );
    check("q=octubre deja el sueldo: 800.000,00", conTexto?.totals?.income, "800000.00");
    check(
      "q=octubre achica los gastos a 250.000,00 (alquiler)",
      conTexto?.totals?.expenses,
      "250000.00",
    );
    checkTrue(
      "el filtro achica los totales respecto del completo",
      Math.round(Number(conTexto?.totals?.expenses ?? 0) * 100) <
        Math.round(Number(reporte?.totals?.expenses ?? 0) * 100),
    );
    // El selector NO se filtra por el texto: sigue ofreciendo "Ropa", que no
    // matchea "octubre". Si se filtrara a sí mismo, no se podría volver atrás.
    checkTrue(
      "el selector conserva todas las categorías del período",
      (conTexto?.categories ?? []).some((category) => category.name === "Ropa"),
    );

    // El filtro por categoría: "Ropa" → sólo esa porción de la torta.
    const { body: categorias } = await api("/api/categories?kind=EXPENSE");
    const ropa = (categorias?.categories ?? []).find(
      (category) => category.name === "Ropa",
    );
    const { body: soloRopa } = await api(
      `/api/reports?from=${MES}-01&to=${MES}-31&categoryId=${ropa?.id}`,
    );
    check("categoryId=Ropa devuelve una sola porción", soloRopa?.byCategory?.length, 1);
    check("y es la de Ropa, por 50.000,00", soloRopa?.byCategory?.[0]?.amount, "50000.00");
    check(
      "los gastos del subconjunto son 50.000,00",
      soloRopa?.totals?.expenses,
      "50000.00",
    );
  }

  // ── El borde del mes ───────────────────────────────────────────────────────
  section("El borde del mes (el bug B3)");
  {
    // Un movimiento del 1 de noviembre NO puede aparecer en el rango de octubre.
    const { body: octubre } = await api(
      `/api/transactions?from=${MES}-01&to=${MES}-31`,
    );
    const hayDeNoviembre = (octubre?.movements ?? []).some((m) =>
      m.date.startsWith("2026-11"),
    );
    checkTrue("octubre no se come el 1 de noviembre", !hayDeNoviembre);

    const { body: septiembre } = await api(
      "/api/transactions?from=2026-09-01&to=2026-09-30",
    );
    const desembolsos = (septiembre?.movements ?? []).filter(
      (m) => m.kind === "TRANSFER",
    );
    check("el desembolso del 30/09 aparece en septiembre", desembolsos.length, 1);
  }

  // ── Recurrencia: el generador "desde la última vez" ────────────────────────
  //
  // La recurrencia no tiene cron: el disparador es `POST /api/recurrence/run`,
  // que materializa las fechas vencidas que todavía no existen. Se prueba
  // contra el reloj REAL del servidor —la misma decisión que el resto del
  // archivo— y con DELTAS: los montos de hoy se comparan contra la foto tomada
  // al empezar este bloque, no contra constantes, porque puede correr en
  // cualquier día del mes.
  //
  // El bloque va DESPUÉS de todas las verificaciones de octubre (los movimientos
  // que postea se fechan HOY, que cae dentro del mes sembrado) y limpia todo al
  // final: la base queda con el seed y sin ninguna regla activa.
  section("Recurrencia · el generador \"desde la última vez\"");
  {
    const pad2 = (n) => String(n).padStart(2, "0");
    const ahora = new Date();
    const HOY = `${ahora.getFullYear()}-${pad2(ahora.getMonth() + 1)}-${pad2(ahora.getDate())}`;
    const mesDeHoy = HOY.slice(0, 7);
    const finDeMesDeHoy = `${mesDeHoy}-${pad2(new Date(ahora.getFullYear(), ahora.getMonth() + 1, 0).getDate())}`;
    const enDias = (dias) => {
      const d = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() + dias);
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    };

    // Los totales del mes de HOY, en centavos, para comparar por diferencia.
    const totalesDeHoy = async () =>
      (await api(`/api/transactions?from=${mesDeHoy}-01&to=${finDeMesDeHoy}`)).body?.totals;
    const centavos = (valor) => Math.round(Number(valor) * 100);
    const desdeCentavos = (valor) => (valor / 100).toFixed(2);

    // ── Punto de partida: sin reglas y con la bandeja vacía ──────────────────
    const { body: vacia } = await api("/api/recurrence");
    check("la vista de recurrencia arranca sin reglas", vacia?.rules?.length, 0);
    check("y con la bandeja vacía", vacia?.pending?.length, 0);

    const base = await totalesDeHoy();

    const corridaVacia = await post("/api/recurrence/run", {});
    check("una corrida sin reglas responde 200", corridaVacia.status, 200);
    check("y no materializa nada", corridaVacia.body?.materialized, 0);
    check(
      "el \"hoy\" de la corrida es el reloj local del servidor",
      corridaVacia.body?.today,
      HOY,
    );
    checkTrue(
      "y no avisa trabajo recortado (capped)",
      corridaVacia.body?.capped === false,
    );

    // ── Una regla NOTIFY: la ocurrencia espera en la bandeja ─────────────────
    // El ancla del día del mes es el día de HOY a propósito: la primera
    // ocurrencia cae HOY, que es la fecha que el generador tiene que materializar.
    const diaDeHoy = ahora.getDate();
    const reglaAviso = await post("/api/recurrence/rules", {
      title: "Alquiler del estudio",
      kind: "EXPENSE",
      amount: "5000",
      accountId: banco.body?.id,
      categoryName: "Comida",
      freq: "MONTHLY",
      dayOfMonth: diaDeHoy,
      startDate: HOY,
    });
    const idAviso = reglaAviso.body?.id;
    check("crea la regla NOTIFY (201)", reglaAviso.status, 201);
    check(
      "nace ACTIVE y en modo NOTIFY (el default)",
      `${reglaAviso.body?.status}/${reglaAviso.body?.postingMode}`,
      "ACTIVE/NOTIFY",
    );
    checkTrue(
      "la proyección de \"lo que viene\" arranca después de hoy",
      String(reglaAviso.body?.upcoming?.[0] ?? "") > HOY,
      JSON.stringify(reglaAviso.body?.upcoming),
    );

    const { body: sinCorrer } = await api("/api/recurrence");
    check("la regla ya se ve en la vista", sinCorrer?.rules?.length, 1);
    check("pero el GET no materializó nada (no escribe)", sinCorrer?.pending?.length, 0);

    const corridaAviso = await post("/api/recurrence/run", {});
    check("la corrida materializa la ocurrencia de HOY", corridaAviso.body?.materialized, 1);
    check("en modo NOTIFY queda pendiente (no postea sola)", corridaAviso.body?.pending, 1);
    check(
      "y una pendiente NO es plata: los gastos no se movieron",
      (await totalesDeHoy())?.expenses,
      base?.expenses,
    );

    const { body: conPendiente } = await api("/api/recurrence");
    const pendiente = conPendiente?.pending?.[0];
    check("la bandeja la muestra con la fecha de HOY", pendiente?.dueDate, HOY);
    check("con el título de la regla", pendiente?.title, "Alquiler del estudio");
    check("y el monto de la regla", pendiente?.amount, "5000.00");

    const corridaRepetida = await post("/api/recurrence/run", {});
    check("correr dos veces no materializa de nuevo", corridaRepetida.body?.materialized, 0);
    check("ni duplica la pendiente", (await api("/api/recurrence")).body?.pending?.length, 1);

    // ── Aceptar: nace el movimiento con la fecha de la OCURRENCIA ────────────
    const aceptada = await post("/api/recurrence/occurrences", {
      id: pendiente?.id,
      action: "accept",
    });
    check("aceptar responde 201", aceptada.status, 201);
    checkTrue("y avisa que creó el movimiento", aceptada.body?.created === true);
    check("la ocurrencia queda POSTED", aceptada.body?.occurrence?.status, "POSTED");
    check(
      "el movimiento se fecha HOY (la fecha de la ocurrencia)",
      aceptada.body?.occurrence?.movement?.date,
      HOY,
    );
    check(
      "con la descripción de la regla",
      aceptada.body?.occurrence?.movement?.description,
      "Alquiler del estudio",
    );
    check(
      "y el monto exacto",
      aceptada.body?.occurrence?.movement?.amount,
      "5000.00",
    );
    check(
      "recién ahí el gasto de hoy sube 5.000,00",
      (await totalesDeHoy())?.expenses,
      desdeCentavos(centavos(base?.expenses) + 500_000),
    );

    // Aceptar es idempotente: la misma ocurrencia devuelve el MISMO movimiento.
    const reAceptada = await post("/api/recurrence/occurrences", {
      id: pendiente?.id,
      action: "accept",
    });
    check("aceptar de nuevo responde 200 (ya estaba posteada)", reAceptada.status, 200);
    checkTrue("y no crea un duplicado (created: false)", reAceptada.body?.created === false);
    check(
      "sino que devuelve el mismo movimiento",
      reAceptada.body?.occurrence?.movement?.id,
      aceptada.body?.occurrence?.movement?.id,
    );
    check(
      "los totales no se movieron de nuevo",
      (await totalesDeHoy())?.expenses,
      desdeCentavos(centavos(base?.expenses) + 500_000),
    );

    // ── Saltar: la fecha queda marcada y NO se vuelve a generar ──────────────
    const reglaSaltada = await post("/api/recurrence/rules", {
      title: "Gimnasio",
      kind: "EXPENSE",
      amount: "3000",
      accountId: banco.body?.id,
      categoryName: "Comida",
      freq: "MONTHLY",
      dayOfMonth: diaDeHoy,
      startDate: HOY,
    });
    const idSaltada = reglaSaltada.body?.id;
    check("crea la segunda regla (201)", reglaSaltada.status, 201);

    await post("/api/recurrence/run", {});
    const { body: conDos } = await api("/api/recurrence");
    const gimnasio = (conDos?.pending ?? []).find((p) => p.title === "Gimnasio");
    checkTrue("su ocurrencia también espera en la bandeja", Boolean(gimnasio?.id));

    const saltada = await post("/api/recurrence/occurrences", {
      id: gimnasio?.id,
      action: "skip",
    });
    check("saltar responde 200", saltada.status, 200);
    check("y la ocurrencia queda SKIPPED", saltada.body?.occurrence?.status, "SKIPPED");

    const corridaPosterior = await post("/api/recurrence/run", {});
    check(
      "la corrida siguiente NO la vuelve a generar",
      corridaPosterior.body?.materialized,
      0,
    );
    const { body: sinGimnasio } = await api("/api/recurrence");
    checkTrue(
      "y no reaparece en la bandeja",
      !(sinGimnasio?.pending ?? []).some((p) => p.title === "Gimnasio"),
    );
    check(
      "los totales siguen sin la saltada",
      (await totalesDeHoy())?.expenses,
      desdeCentavos(centavos(base?.expenses) + 500_000),
    );

    // ── Una regla AUTO: postea sola en la corrida ────────────────────────────
    const reglaAuto = await post("/api/recurrence/rules", {
      title: "Sueldo de prueba",
      kind: "INCOME",
      amount: "2000",
      accountId: banco.body?.id,
      categoryName: "Sueldo",
      freq: "MONTHLY",
      dayOfMonth: diaDeHoy,
      startDate: HOY,
      postingMode: "AUTO",
    });
    const idAuto = reglaAuto.body?.id;
    check("crea la regla AUTO (201)", reglaAuto.status, 201);

    const corridaAuto = await post("/api/recurrence/run", {});
    check("la corrida la postea sola", corridaAuto.body?.posted, 1);
    check("y no la deja pendiente", corridaAuto.body?.pending, 0);
    check(
      "el ingreso de hoy sube 2.000,00",
      (await totalesDeHoy())?.income,
      desdeCentavos(centavos(base?.income) + 200_000),
    );

    const { body: movsRec } = await api(
      `/api/transactions?from=${mesDeHoy}-01&to=${finDeMesDeHoy}`,
    );
    const autoMov = (movsRec?.movements ?? []).find(
      (m) => m.description === "Sueldo de prueba",
    );
    check("el movimiento existe, fechado HOY", autoMov?.date, HOY);
    check("y es un INCOME", autoMov?.kind, "INCOME");

    // ── Borrar el movimiento reabre la ocurrencia (y NO se re-postea sola) ───
    const borrado = await api(`/api/transactions?id=${autoMov?.id}`, {
      method: "DELETE",
    });
    check("borrar el movimiento responde 204", borrado.status, 204);
    check(
      "y el ingreso de hoy vuelve al punto de partida",
      (await totalesDeHoy())?.income,
      base?.income,
    );

    const corridaReabierta = await post("/api/recurrence/run", {});
    check(
      "la corrida siguiente NO la re-postea (no se pelea con la persona)",
      corridaReabierta.body?.posted,
      0,
    );
    check("ni materializa nada nuevo", corridaReabierta.body?.materialized, 0);

    const { body: reabierta } = await api("/api/recurrence");
    const pendienteReabierta = (reabierta?.pending ?? []).find(
      (p) => p.title === "Sueldo de prueba",
    );
    check("la ocurrencia reabierta espera en la bandeja", pendienteReabierta?.dueDate, HOY);

    const reAceptar = await post("/api/recurrence/occurrences", {
      id: pendienteReabierta?.id,
      action: "accept",
    });
    check("aceptarla a mano la vuelve a postear (201)", reAceptar.status, 201);
    check(
      "y el ingreso queda como antes de borrarlo",
      (await totalesDeHoy())?.income,
      desdeCentavos(centavos(base?.income) + 200_000),
    );

    // ── Una regla futura: HOY no materializa, y se ve en "lo que viene" ──────
    const futuro = enDias(5);
    const reglaFutura = await post("/api/recurrence/rules", {
      title: "Curso de inglés",
      kind: "EXPENSE",
      amount: "1000",
      accountId: banco.body?.id,
      categoryName: "Comida",
      freq: "DAILY",
      startDate: futuro,
    });
    check("crea la regla futura (201)", reglaFutura.status, 201);
    check("su próxima fecha es HOY + 5 días", reglaFutura.body?.upcoming?.[0], futuro);

    const corridaFutura = await post("/api/recurrence/run", {});
    check(
      "la corrida no materializa nada de la regla futura",
      corridaFutura.body?.materialized,
      0,
    );

    const { body: conFutura } = await api("/api/recurrence");
    const futura = (conFutura?.rules ?? []).find((r) => r.title === "Curso de inglés");
    check("la proyección tampoco es plata: es una fecha", futura?.upcoming?.[0], futuro);
    checkTrue(
      "y HOY no hay nada suyo en la bandeja",
      !(conFutura?.pending ?? []).some((p) => p.title === "Curso de inglés"),
    );

    const borrarFutura = await api(`/api/recurrence/rules?id=${futura?.id}`, {
      method: "DELETE",
    });
    check("una regla vacía se borra (204)", borrarFutura.status, 204);
    const { body: sinFutura } = await api("/api/recurrence");
    checkTrue(
      "y desaparece de la vista",
      !(sinFutura?.rules ?? []).some((r) => r.title === "Curso de inglés"),
    );

    // ── Lo que la API rechaza antes de crear nada ────────────────────────────
    const reglaBase = {
      title: "Regla de prueba",
      kind: "EXPENSE",
      amount: "1000",
      accountId: banco.body?.id,
      categoryName: "Comida",
      freq: "MONTHLY",
      startDate: HOY,
    };

    const freqMala = await post("/api/recurrence/rules", {
      ...reglaBase,
      freq: "A_VECES",
    });
    check("una frecuencia inválida → 400", freqMala.status, 400);

    const domEnDiaria = await post("/api/recurrence/rules", {
      ...reglaBase,
      freq: "DAILY",
      dayOfMonth: 15,
    });
    check("un día del mes en una regla diaria → 400", domEnDiaria.status, 400);

    const sinDestino = await post("/api/recurrence/rules", {
      title: "Transferencia de prueba",
      kind: "TRANSFER",
      amount: "1000",
      accountId: banco.body?.id,
      freq: "MONTHLY",
      startDate: HOY,
    });
    check("una transferencia sin destino → 400", sinDestino.status, 400);
    checkTrue(
      "y lo explica",
      typeof sinDestino.body?.error === "string" &&
        sinDestino.body.error.includes("destino"),
      JSON.stringify(sinDestino.body),
    );

    const ingresoAPrestamo = await post("/api/recurrence/rules", {
      title: "Ingreso imposible",
      kind: "INCOME",
      amount: "1000",
      accountId: prestamo.body?.id,
      categoryName: "Sueldo",
      freq: "MONTHLY",
      startDate: HOY,
    });
    check("un ingreso hacia un préstamo → 400 (el trigger de la base)", ingresoAPrestamo.status, 400);
    checkTrue(
      "y sugiere la transferencia, igual que un movimiento",
      typeof ingresoAPrestamo.body?.error === "string" &&
        ingresoAPrestamo.body.error.includes("transferencia"),
      JSON.stringify(ingresoAPrestamo.body),
    );

    const montoCero = await post("/api/recurrence/rules", {
      ...reglaBase,
      amount: "0",
    });
    check("un monto de cero → 400", montoCero.status, 400);

    const { body: trasRechazos } = await api("/api/recurrence");
    check("ningún rechazo dejó una regla creada", trasRechazos?.rules?.length, 3);

    // ── PATCH: parcial, pero validado sobre la regla ENTERA ──────────────────
    const auto = (trasRechazos?.rules ?? []).find((r) => r.title === "Sueldo de prueba");

    const patchInvalido = await api("/api/recurrence/rules", {
      method: "PATCH",
      body: JSON.stringify({ id: auto?.id, kind: "TRANSFER" }),
    });
    check(
      "cambiar a TRANSFER sin destino → 400 (se valida lo mezclado)",
      patchInvalido.status,
      400,
    );

    const patchMonto = await api("/api/recurrence/rules", {
      method: "PATCH",
      body: JSON.stringify({ id: auto?.id, amount: "2500" }),
    });
    check("el PATCH del monto responde 200", patchMonto.status, 200);
    check("y el monto nuevo queda", patchMonto.body?.amount, "2500.00");
    check("sin tocar lo que no vino (la frecuencia sigue mensual)", patchMonto.body?.freq, "MONTHLY");

    const patchArchivar = await api("/api/recurrence/rules", {
      method: "PATCH",
      body: JSON.stringify({ id: auto?.id, status: "ARCHIVED" }),
    });
    check("archivar por PATCH responde 200", patchArchivar.status, 200);
    const { body: conArchivada } = await api("/api/recurrence");
    check("archivar es salir de la vista, no borrar", conArchivada?.rules?.length, 2);
    checkTrue(
      "la archivada ya no aparece",
      !(conArchivada?.rules ?? []).some((r) => r.title === "Sueldo de prueba"),
    );

    // ── Una regla con historia NO se borra: se archiva ───────────────────────
    const borrarConHistoria = await api(`/api/recurrence/rules?id=${idSaltada}`, {
      method: "DELETE",
    });
    check("borrar una regla con ocurrencias → 409", borrarConHistoria.status, 409);
    checkTrue(
      "y el mensaje manda a archivarla",
      typeof borrarConHistoria.body?.error === "string" &&
        borrarConHistoria.body.error.includes("Archivala"),
      JSON.stringify(borrarConHistoria.body),
    );

    // ── Una categoría que usa una regla NO se borra (409, no 500) ────────────
    // Borrarla dejaría la regla sin categoría y el CHECK `recurrence_shape_by_kind`
    // prohíbe esa forma: sin el chequeo previo, el rechazo de Postgres salía como
    // un 500 genérico que no decía nada. La salida es cambiarle la categoría a la
    // regla (o borrar la regla si todavía no generó nada).
    const crearCategoriaDeRegla = await post("/api/categories", {
      name: "Categoría de regla de prueba",
      kind: "EXPENSE",
    });
    const reglaConCategoria = await post("/api/recurrence/rules", {
      title: "Regla de categoría de prueba",
      kind: "EXPENSE",
      amount: "1000",
      accountId: banco.body?.id,
      categoryName: "Categoría de regla de prueba",
      freq: "MONTHLY",
      startDate: enDias(30),
    });

    const borrarCategoriaUsada = await api(
      `/api/categories?id=${crearCategoriaDeRegla.body?.id}`,
      { method: "DELETE" },
    );
    check("borrar una categoría usada por una regla → 409", borrarCategoriaUsada.status, 409);
    checkTrue(
      "y el mensaje manda a cambiarle la categoría a la regla",
      typeof borrarCategoriaUsada.body?.error === "string" &&
        borrarCategoriaUsada.body.error.includes("regla de recurrencia"),
      JSON.stringify(borrarCategoriaUsada.body),
    );

    // Se deshace: la regla (vacía, nunca corrió) se borra por la API y recién
    // ahí la categoría queda libre.
    const borrarReglaConCategoria = await api(
      `/api/recurrence/rules?id=${reglaConCategoria.body?.id}`,
      { method: "DELETE" },
    );
    check("la regla que la usaba se borra (vacía, 204)", borrarReglaConCategoria.status, 204);
    const borrarCategoriaLibre = await api(
      `/api/categories?id=${crearCategoriaDeRegla.body?.id}`,
      { method: "DELETE" },
    );
    check("y la categoría, ya sin regla, se borra (200)", borrarCategoriaLibre.status, 200);

    // ── Limpieza: la base queda como estaba ──────────────────────────────────
    // Por Prisma directo porque las reglas con historia NO se borran por la API
    // (eso es lo que acaba de verificar el 409). Las ocurrencias van PRIMERO:
    // borrar un movimiento posteado dispararía el `SetNull` del FK y el CHECK
    // `occurrence_shape_by_status` rechazaría el DELETE.
    const prisma = new PrismaClient();
    const idsDeEstaCorrida = [idAviso, idSaltada, idAuto].filter(Boolean);
    await prisma.recurrenceOccurrence.deleteMany({
      where: { ruleId: { in: idsDeEstaCorrida } },
    });
    await prisma.movement.deleteMany({
      where: { recurrenceRuleId: { in: idsDeEstaCorrida } },
    });
    await prisma.recurrenceRule.deleteMany({ where: { id: { in: idsDeEstaCorrida } } });
    await prisma.$disconnect();

    const { body: final } = await api("/api/recurrence");
    check("no quedan reglas", final?.rules?.length, 0);
    check("ni pendientes", final?.pending?.length, 0);
    const finDeLosTotales = await totalesDeHoy();
    check(
      "los gastos del mes volvieron al punto de partida",
      finDeLosTotales?.expenses,
      base?.expenses,
    );
    check("y también los ingresos", finDeLosTotales?.income, base?.income);

    const corridaFinal = await post("/api/recurrence/run", {});
    check("la corrida final no materializa nada", corridaFinal.body?.materialized, 0);
  }

  // ── Tarjetas y cuotas ──────────────────────────────────────────────────────
  section("Tarjetas y cuotas — compras, resúmenes y pago");
  {
    const ahora = new Date();
    const pad2 = (n) => String(n).padStart(2, "0");
    const HOY = `${ahora.getFullYear()}-${pad2(ahora.getMonth() + 1)}-${pad2(ahora.getDate())}`;
    const diaDeHoy = ahora.getDate();
    const mesDeHoy = HOY.slice(0, 7);
    const finDeMesDeHoy = `${mesDeHoy}-${pad2(new Date(ahora.getFullYear(), ahora.getMonth() + 1, 0).getDate())}`;
    const totalesDeHoy = async () =>
      (await api(`/api/transactions?from=${mesDeHoy}-01&to=${finDeMesDeHoy}`)).body?.totals;
    const centavos = (valor) => Math.round(Number(valor) * 100);
    const desdeCentavos = (valor) => (valor / 100).toFixed(2);

    const base = await totalesDeHoy();

    // ── Una tarjeta sin cierre no puede emitir resúmenes ─────────────────────
    // La Visa del escenario se creó SIN día de cierre (las tarjetas viejas del
    // modelo no lo tenían). Con una compra encima, la corrida tiene que
    // saltearla CON MOTIVO, no romperse ni inventar un cierre.
    const gastoEnVisaSuelta = await post("/api/transactions", {
      kind: "EXPENSE",
      amount: "500",
      date: HOY,
      accountId: visa.body?.id,
      categoryName: "Comida",
    });
    check("una compra directa en la Visa sin cierre (201)", gastoEnVisaSuelta.status, 201);

    const corridaSinCierre = await post("/api/cards/statements", {});
    check("la corrida responde 200 aunque haya tarjetas sin cierre", corridaSinCierre.status, 200);
    check("no procesa ninguna tarjeta con actividad", corridaSinCierre.body?.results?.length, 0);
    check("y saltea la Visa sin cierre", corridaSinCierre.body?.skipped?.length, 1);
    check("diciendo cuál es", corridaSinCierre.body?.skipped?.[0]?.cardName, "Visa Santander");
    checkTrue(
      "y por qué (falta el cierre)",
      String(corridaSinCierre.body?.skipped?.[0]?.reason ?? "").includes("cierre"),
      JSON.stringify(corridaSinCierre.body?.skipped),
    );

    await api(`/api/transactions?id=${gastoEnVisaSuelta.body?.id}`, { method: "DELETE" });
    check("la compra de prueba se borró", (await totalesDeHoy())?.expenses, base?.expenses);

    // ── La API rechaza parámetros de tarjeta incoherentes ────────────────────
    const cierreSinVencimiento = await post("/api/accounts", {
      name: "Tarjeta rara",
      kind: "CREDIT_CARD",
      closingDay: 25,
    });
    check("cierre sin vencimiento → 400", cierreSinVencimiento.status, 400);

    const diaInvalido = await post("/api/accounts", {
      name: "Tarjeta rara",
      kind: "CREDIT_CARD",
      closingDay: 25,
      dueDay: 32,
    });
    check("un día 32 → 400", diaInvalido.status, 400);

    const diasEnBanco = await post("/api/accounts", {
      name: "Banco raro",
      kind: "BANK",
      closingDay: 25,
      dueDay: 5,
    });
    check("días de tarjeta en un banco → 400", diasEnBanco.status, 400);

    // ── Tarjeta con cierre HOY: prueba viva de la regla inclusiva ────────────
    // El cierre se configura en el día de hoy. Una compra hecha HOY entra al
    // resumen que cierra HOY: si la regla del `<` en vez del `<=` estuviera mal,
    // la cuota caería al mes siguiente y todo lo que sigue lo delataría.
    const nube = await post("/api/accounts", {
      name: "Visa Nube",
      kind: "CREDIT_CARD",
      closingDay: diaDeHoy,
      dueDay: diaDeHoy,
      creditLimit: "600.000",
    });
    check("crea una tarjeta con cierre HOY (201)", nube.status, 201);
    check("y devuelve el día de cierre", nube.body?.closingDay, diaDeHoy);
    check("y el límite como string decimal", nube.body?.creditLimit, "600000.00");

    const patchDiaSuelto = await api("/api/accounts", {
      method: "PATCH",
      body: JSON.stringify({ id: nube.body?.id, dueDay: 10 }),
    });
    check("PATCH de un solo día → 400 (van juntos)", patchDiaSuelto.status, 400);

    const patchLimite = await api("/api/accounts", {
      method: "PATCH",
      body: JSON.stringify({ id: nube.body?.id, creditLimit: "900.000" }),
    });
    check("PATCH del límite responde 200", patchLimite.status, 200);
    check("y el límite nuevo queda", patchLimite.body?.creditLimit, "900000.00");

    // ── La vista previa no escribe: cuota y tasa implícita ───────────────────
    const previewCuotas = await api(
      "/api/cards/plans/preview?total=120000&installments=12&cashPrice=108000",
    );
    check("el preview responde 200", previewCuotas.status, 200);
    check("la cuota es el total repartido", previewCuotas.body?.installmentAmount, "10000.00");
    check("el sobreprecio contra el contado", previewCuotas.body?.surcharge, "12000.00");
    checkTrue(
      "la TEA implícita ronda el 21,8% del ROADMAP",
      Math.abs(Number(previewCuotas.body?.implicitRate?.teaPercent) - 21.8) < 0.5,
      JSON.stringify(previewCuotas.body?.implicitRate),
    );

    const previewMala = await api("/api/cards/plans/preview?total=120000&installments=0");
    check("0 cuotas → 400", previewMala.status, 400);

    // ── La compra en cuotas ──────────────────────────────────────────────────
    const plan = await post("/api/cards/plans", {
      cardId: nube.body?.id,
      label: "Heladera",
      totalAmount: "120.000",
      installments: 12,
      categoryName: "Hogar",
      purchaseDate: HOY,
      cashPrice: "108.000",
    });
    check("registra la compra en 12 cuotas (201)", plan.status, 201);
    check("son 12 cuotas", plan.body?.plan?.items?.length, 12);
    check("la compra es UN gasto por el total", plan.body?.plan?.movement?.amount, "120000.00");
    check("y es un EXPENSE", plan.body?.plan?.movement?.kind, "EXPENSE");
    check(
      "el gasto está a nombre de la tarjeta",
      plan.body?.plan?.movement?.account?.id,
      nube.body?.id,
    );
    check(
      "la primera cuota cae en el resumen que cierra HOY (regla inclusiva)",
      plan.body?.plan?.items?.[0]?.periodYear,
      ahora.getFullYear(),
    );
    check(
      "...es decir, este mes",
      plan.body?.plan?.items?.[0]?.periodMonth,
      ahora.getMonth() + 1,
    );
    check(
      "la segunda, el mes que viene",
      plan.body?.plan?.items?.[1]?.periodMonth,
      ((ahora.getMonth() + 1) % 12) + 1,
    );
    check(
      "la suma de las cuotas da EXACTO el total",
      (plan.body?.plan?.items ?? []).reduce(
        (total, item) => total + centavos(item.amount),
        0,
      ),
      12_000_000,
    );
    checkTrue(
      "el plan trae su tasa implícita",
      Math.abs(Number(plan.body?.plan?.implicitRate?.teaPercent) - 21.8) < 0.5,
      JSON.stringify(plan.body?.plan?.implicitRate),
    );

    const planSinCierre = await post("/api/cards/plans", {
      cardId: visa.body?.id,
      label: "Sin cierre",
      totalAmount: "1000",
      installments: 1,
      categoryName: "Comida",
    });
    check("un plan en una tarjeta sin cierre → 409", planSinCierre.status, 409);
    checkTrue(
      "y manda a configurar el cierre",
      String(planSinCierre.body?.error ?? "").includes("cierre"),
      JSON.stringify(planSinCierre.body),
    );

    // ── La vista: deuda, utilización, período en curso y compromisos ─────────
    const { body: vista } = await api("/api/cards");
    const tarjetaNube = (vista?.cards ?? []).find((card) => card.id === nube.body?.id);

    check("la vista trae la tarjeta nueva", Boolean(tarjetaNube), true);
    check("con la deuda completa de la compra", tarjetaNube?.debt, "120000.00");
    check("utilización: 120.000 sobre 900.000 ≈ 13,33%", tarjetaNube?.utilizationPercent, "13.33");
    check(
      "el período en curso es el que cierra HOY",
      tarjetaNube?.currentPeriod?.closingDate,
      HOY,
    );
    check("y proyecta la cuota del mes", tarjetaNube?.currentPeriod?.totalDue, "10000.00");
    check("con mínimo del 5%", tarjetaNube?.currentPeriod?.minimumDue, "500.00");
    check("el período ya cerró", tarjetaNube?.currentPeriod?.closed, true);
    check("todavía no está emitido como documento", tarjetaNube?.currentPeriod?.persisted, false);
    check("próximos 6 resúmenes: 6 cuotas", tarjetaNube?.commitments?.next6Months, "60000.00");
    check("próximos 12: el plan completo", tarjetaNube?.commitments?.next12Months, "120000.00");

    // ── La corrida emite el resumen del período cerrado ─────────────────────
    const corrida = await post("/api/cards/statements", { cardId: nube.body?.id });
    check("corre el cierre (200)", corrida.status, 200);
    check("emite UN resumen", corrida.body?.results?.[0]?.created, 1);

    const resumen = corrida.body?.results?.[0]?.statements?.[0];
    check("el total del resumen es la cuota del mes", resumen?.totalDue, "10000.00");
    check("el mínimo es el 5%", resumen?.minimumDue, "500.00");
    check("cierra HOY", resumen?.closingDate, HOY);

    // Vence el mismo día del mes siguiente (con el clamp de fin de mes).
    const proximoMes = new Date(ahora.getFullYear(), ahora.getMonth() + 1, 1);
    const ultimoDiaDelProximoMes = new Date(
      proximoMes.getFullYear(),
      proximoMes.getMonth() + 1,
      0,
    ).getDate();
    const vencimientoEsperado = `${proximoMes.getFullYear()}-${pad2(proximoMes.getMonth() + 1)}-${pad2(
      Math.min(diaDeHoy, ultimoDiaDelProximoMes),
    )}`;
    check("y vence el mes que viene (nunca antes del cierre)", resumen?.dueDate, vencimientoEsperado);

    const repetida = await post("/api/cards/statements", { cardId: nube.body?.id });
    check("correrla de nuevo no duplica (created 0)", repetida.body?.results?.[0]?.created, 0);
    check("ni cambia el resumen (unchanged 1)", repetida.body?.results?.[0]?.unchanged, 1);

    // ── Una compra directa después de la corrida: el resumen impago se recalcula ──
    const gastoDirecto = await post("/api/transactions", {
      kind: "EXPENSE",
      amount: "5.000",
      date: HOY,
      accountId: nube.body?.id,
      categoryName: "Comida",
    });
    check("una compra directa con la tarjeta (201)", gastoDirecto.status, 201);

    const corrida2 = await post("/api/cards/statements", { cardId: nube.body?.id });
    const resumen2 = corrida2.body?.results?.[0]?.statements?.[0];
    check("el resumen impago se recalcula (updated 1)", corrida2.body?.results?.[0]?.updated, 1);
    check("total = cuota + compra directa", resumen2?.totalDue, "15000.00");
    check("mínimo recalculado", resumen2?.minimumDue, "750.00");

    const totalesConCompras = await totalesDeHoy();
    check(
      "las compras con tarjeta son gasto UNA vez (120.000 + 5.000)",
      desdeCentavos(centavos(totalesConCompras?.expenses) - centavos(base?.expenses)),
      "125000.00",
    );

    // ── El pago es una TRANSFERENCIA (criterio 3) ────────────────────────────
    const pago = await post("/api/cards/statements/pay", {
      statementId: resumen2?.id,
      fromAccountId: banco.body?.id,
    });
    check("paga el resumen (201)", pago.status, 201);
    check("el pago es una TRANSFERENCIA", pago.body?.movement?.kind, "TRANSFER");
    check("por el total del resumen", pago.body?.movement?.amount, "15000.00");
    check("sale del banco", pago.body?.movement?.account?.id, banco.body?.id);
    check("y entra a la tarjeta", pago.body?.movement?.toAccount?.id, nube.body?.id);
    check("el resumen queda pago", pago.body?.statement?.paid, true);

    const totalesDespuesDelPago = await totalesDeHoy();
    check("pagar NO suma gastos", totalesDespuesDelPago?.expenses, totalesConCompras?.expenses);

    const pagoRepetido = await post("/api/cards/statements/pay", {
      statementId: resumen2?.id,
      fromAccountId: banco.body?.id,
    });
    check("pagar dos veces no duplica (200)", pagoRepetido.status, 200);
    check("y devuelve created:false", pagoRepetido.body?.created, false);

    const { body: vistaPaga } = await api("/api/cards");
    const nubePaga = (vistaPaga?.cards ?? []).find((card) => card.id === nube.body?.id);
    check("la deuda baja con el pago (120.000 + 5.000 − 15.000)", nubePaga?.debt, "110000.00");
    check(
      "la cuota pagada sale de los compromisos: 11 cuotas",
      nubePaga?.commitments?.next12Months,
      "110000.00",
    );
    check("los próximos 6 meses: las cuotas 2 a 6", nubePaga?.commitments?.next6Months, "50000.00");
    check("el resumen pagado se ve pago en la vista", nubePaga?.statements?.[0]?.paid, true);

    // ── Un plan con resumen pagado no se borra: el pasado no se reescribe ────
    const borrarPlanPago = await api(`/api/cards/plans?id=${plan.body?.plan?.id}`, {
      method: "DELETE",
    });
    check("un plan con resumen pagado no se borra (409)", borrarPlanPago.status, 409);
    checkTrue(
      "y lo explica",
      String(borrarPlanPago.body?.error ?? "").includes("pagado"),
      JSON.stringify(borrarPlanPago.body),
    );

    const borrarGastoDePlan = await api(
      `/api/transactions?id=${plan.body?.plan?.movement?.id}`,
      { method: "DELETE" },
    );
    check(
      "el gasto de un plan no se borra por /transactions (409, no 500)",
      borrarGastoDePlan.status,
      409,
    );
    checkTrue(
      "y manda a borrar el plan",
      String(borrarGastoDePlan.body?.error ?? "").includes("plan"),
      JSON.stringify(borrarGastoDePlan.body),
    );

    // ── Limpieza: la base queda como estaba ──────────────────────────────────
    // Por Prisma directo porque el plan ya no se puede borrar por la API (409,
    // que es justo lo que se acaba de verificar). El orden respeta los FK:
    // resúmenes → planes (items en cascada) → movimientos → categoría → cuenta.
    const prisma = new PrismaClient();
    await prisma.statement.deleteMany({ where: { accountId: nube.body?.id } });
    await prisma.cardPlan.deleteMany({ where: { accountId: nube.body?.id } });
    await prisma.movement.deleteMany({
      where: { OR: [{ accountId: nube.body?.id }, { toAccountId: nube.body?.id }] },
    });
    await prisma.category.deleteMany({ where: { normalizedName: "hogar" } });
    await prisma.account.delete({ where: { id: nube.body?.id } });
    await prisma.$disconnect();

    const totalesFinales = await totalesDeHoy();
    check("los gastos del mes volvieron al punto de partida", totalesFinales?.expenses, base?.expenses);
    check("y también los ingresos", totalesFinales?.income, base?.income);

    const { body: vistaFinal } = await api("/api/cards");
    checkTrue(
      "la tarjeta de prueba ya no está",
      !(vistaFinal?.cards ?? []).some((card) => card.id === nube.body?.id),
    );
  }

  // ── Préstamos (Fase 4): cronograma, pago y cancelación ─────────────────────
  // Todo lo de acá pasa por las rutas REALES (`/api/loans`, `/api/loans/pay`):
  // cobertura derivada del capital, patas por dirección, idempotencia del doble
  // toque y cancelación. Los escenarios de prueba usan cuentas propias que se
  // borran al final (por Prisma, como la limpieza de tarjetas): la base queda
  // como estaba y el seed sigue siendo el mismo después de correr el smoke.
  section("Préstamos — cronograma, pago y cancelación (Fase 4)");
  {
    const totalesDelMes = async () =>
      (await api(`/api/transactions?from=${MES}-01&to=${MES}-31`)).body?.totals;
    const totalesAntes = await totalesDelMes();

    // El préstamo del seed ya tiene su cronograma materializado: la vista lo
    // lee de la base y deriva la cobertura del capital real (la cuota 1 se pagó
    // a mano en «Movimientos de octubre»: transferencia + gasto).
    const { body: vista } = await api("/api/loans?asOf=2026-10-31");
    const seedLoan = (vista?.loans ?? []).find((l) => l.name === "Préstamo personal");
    checkTrue("la vista lista el préstamo del seed", seedLoan !== undefined);

    check("dirección derivada del kind: LOAN = I_OWE", seedLoan?.direction, "I_OWE");
    check("sistema del seed: FRENCH", seedLoan?.system, "FRENCH");
    check("12 cuotas materializadas", seedLoan?.installments?.length, 12);
    check("la cuota 1 vence el 15/10", seedLoan?.installments?.[0]?.dueDate, "2026-10-15");
    check("la cuota 2 vence el 15/11", seedLoan?.installments?.[1]?.dueDate, "2026-11-15");
    check("la cuota 1 está cubierta (el pago a mano)", seedLoan?.installments?.[0]?.covered, true);
    check("la cuota 2 todavía no", seedLoan?.installments?.[1]?.covered, false);
    check("1 de 12 cuotas cubiertas", seedLoan?.plan?.paidCount, 1);
    check("la próxima impaga es la cuota 2", seedLoan?.nextInstallment?.number, 2);
    check("capital pagado 31.412,71", seedLoan?.capitalPaid, "31412.71");
    check("interés pagado 25.000,00 (el de la cuota cubierta)", seedLoan?.interestPaid, "25000.00");
    check("deuda viva 468.587,29 (500.000 − capital)", seedLoan?.debt, "468587.29");
    check("un LOAN no tiene lado «a cobrar»", seedLoan?.receivable, null);
    // El desembolso del seed consta (la transferencia de septiembre): la
    // tarjeta no debe avisar nada, y `disbursed` lo prueba de punta a punta.
    check("el seed tiene el desembolso registrado", seedLoan?.disbursed, true);

    // Compromisos desde octubre: las 11 cuotas impagas caen en los 12 meses. La
    // última cuota cierra el capital al centavo (su pago es 56.412,63), así que
    // la suma de pagos reales es 620.539,73 — no 11 × 56.412,71.
    check("compromisos: octubre en cero (la cuota 1 está pagada)", seedLoan?.commitments?.months?.[0]?.amount, "0.00");
    check("compromisos: noviembre = cuota 2", seedLoan?.commitments?.months?.[1]?.amount, "56412.71");
    check("compromisos: 5 cuotas en 6 meses", seedLoan?.commitments?.next6Months, "282063.55");
    check("compromisos: 11 cuotas en 12 meses", seedLoan?.commitments?.next12Months, "620539.73");
    check("nada vencido al 31/10", seedLoan?.commitments?.overdue, "0.00");
    check("y no hay cuotas vencidas", seedLoan?.commitments?.overdueCount, 0);

    // ── El escenario de prueba: banco y préstamo propios ─────────────────────
    const bancoPrueba = await post("/api/accounts", {
      name: "Banco de prueba préstamos",
      kind: "BANK",
      openingBalance: "100.000",
    });
    check("crea el banco de prueba (201)", bancoPrueba.status, 201);

    const prestamoPrueba = await post("/api/accounts", {
      name: "Préstamo de prueba (smoke)",
      kind: "LOAN",
      principal: "500.000",
      tnaPercent: "60",
      installmentCount: 12,
      firstInstallmentDate: "2026-10-05",
    });
    check("crea el préstamo de prueba (201)", prestamoPrueba.status, 201);
    check("el sistema por defecto es FRENCH", prestamoPrueba.body?.amortizationSystem, "FRENCH");

    // `disbursed` es DERIVADO (la transferencia real, no una columna): recién
    // creado, sin desembolso, la UI debe avisar que falta.
    const { body: vistaSinDesembolso } = await api("/api/loans?asOf=2026-10-31");
    const sinDesembolso = (vistaSinDesembolso?.loans ?? []).find(
      (l) => l.id === prestamoPrueba.body?.id,
    );
    check("creado sin desembolso: disbursed false", sinDesembolso?.disbursed, false);

    // El desembolso: la plata sale del préstamo y entra al banco (igual que el
    // seed). La deuda viva del préstamo sale del SALDO de la cuenta, no del
    // cronograma: sin este movimiento los pagos dejarían la cuenta con saldo
    // positivo y la deuda negativa — plata que nunca entró.
    const desembolsoPrueba = await post("/api/transactions", {
      kind: "TRANSFER",
      amount: "500.000",
      date: "2026-10-01",
      accountId: prestamoPrueba.body?.id,
      toAccountId: bancoPrueba.body?.id,
      description: "Desembolso del préstamo de prueba (smoke)",
    });
    check("registra el desembolso del préstamo de prueba (201)", desembolsoPrueba.status, 201);

    const { body: vistaConDesembolso } = await api("/api/loans?asOf=2026-10-31");
    const conDesembolso = (vistaConDesembolso?.loans ?? []).find(
      (l) => l.id === prestamoPrueba.body?.id,
    );
    check("con el desembolso registrado: disbursed true", conDesembolso?.disbursed, true);

    // Acotado a `asOf` como el capital pagado: al 30/09 la transferencia del
    // 01/10 todavía no cuenta (y la vista debe volver a avisar).
    const { body: vistaPreviaAlPago } = await api("/api/loans?asOf=2026-09-30");
    const previaAlDesembolso = (vistaPreviaAlPago?.loans ?? []).find(
      (l) => l.id === prestamoPrueba.body?.id,
    );
    check("acotado a asOf: al 30/09 no consta el desembolso", previaAlDesembolso?.disbursed, false);

    // ── Pagar una cuota: capital por transferencia, interés por gasto ────────
    const cuota1 = await post("/api/loans/pay", {
      accountId: prestamoPrueba.body?.id,
      cashAccountId: bancoPrueba.body?.id,
      date: "2026-10-05",
      installmentNumber: 1,
    });
    check("paga la cuota 1 (201)", cuota1.status, 201);
    check("created: true (escribió)", cuota1.body?.created, true);
    check("no fue una cancelación", cuota1.body?.cancelled, false);
    check("la cuota pagada es la 1", cuota1.body?.installment?.number, 1);
    check("capital de la cuota: 31.412,71", cuota1.body?.principalPaid, "31412.71");
    check("interés de la cuota: 25.000,00", cuota1.body?.interestPaid, "25000.00");
    check("dos patas: capital + interés", cuota1.body?.movements?.length, 2);
    check("la pata del capital es una TRANSFERENCIA", cuota1.body?.movements?.[0]?.kind, "TRANSFER");
    check("por el capital de la cuota", cuota1.body?.movements?.[0]?.amount, "31412.71");
    check("sale del banco de prueba", cuota1.body?.movements?.[0]?.account?.id, bancoPrueba.body?.id);
    check("y entra al préstamo", cuota1.body?.movements?.[0]?.toAccount?.id, prestamoPrueba.body?.id);
    check("la pata del interés es un GASTO", cuota1.body?.movements?.[1]?.kind, "EXPENSE");
    check("por el interés de la cuota", cuota1.body?.movements?.[1]?.amount, "25000.00");
    check("con categoría Intereses", cuota1.body?.movements?.[1]?.category?.name, "Intereses");
    check("la vista ya cuenta 1 cuota cubierta", cuota1.body?.loan?.plan?.paidCount, 1);
    check("y la próxima es la 2", cuota1.body?.loan?.nextInstallment?.number, 2);

    // El doble toque: el MISMO pedido otra vez — idempotente, NADA se escribe.
    const dobleToque = await post("/api/loans/pay", {
      accountId: prestamoPrueba.body?.id,
      cashAccountId: bancoPrueba.body?.id,
      date: "2026-10-05",
      installmentNumber: 1,
    });
    check("el doble toque responde 200 (reintento)", dobleToque.status, 200);
    check("created: false", dobleToque.body?.created, false);
    check("sin movimientos nuevos", dobleToque.body?.movements?.length, 0);

    // Saltarse una cuota no se puede: la cobertura es un PREFIJO, no un set.
    const salteada = await post("/api/loans/pay", {
      accountId: prestamoPrueba.body?.id,
      cashAccountId: bancoPrueba.body?.id,
      date: "2026-12-05",
      installmentNumber: 4,
    });
    check("pagar la 4 con la 2 pendiente: 400", salteada.status, 400);
    checkTrue(
      "y explica el orden",
      String(salteada.body?.error ?? "").includes("en orden"),
      JSON.stringify(salteada.body),
    );

    // Cuota 2 con capital extra: el extra amortiza de más; el interés de la
    // cuota NO baja (el cronograma es el contrato y no se recalcula).
    const conExtra = await post("/api/loans/pay", {
      accountId: prestamoPrueba.body?.id,
      cashAccountId: bancoPrueba.body?.id,
      date: "2026-10-06",
      installmentNumber: 2,
      extraCapital: "50000",
    });
    check("paga la cuota 2 con extra (201)", conExtra.status, 201);
    check("capital de este pago: 32.983,35 + 50.000", conExtra.body?.principalPaid, "82983.35");
    check("interés: el de la cuota 2 (23.429,36)", conExtra.body?.interestPaid, "23429.36");
    check("la cobertura avanza a 3 (el extra cubre una más)", conExtra.body?.loan?.plan?.paidCount, 3);
    check("la próxima impaga es la 4", conExtra.body?.loan?.nextInstallment?.number, 4);

    // Pagar más capital que el saldo que queda: 400 — el resto es cancelación.
    const deMas = await post("/api/loans/pay", {
      accountId: prestamoPrueba.body?.id,
      cashAccountId: bancoPrueba.body?.id,
      date: "2026-10-06",
      installmentNumber: 4,
      extraCapital: "999999",
    });
    check("capital extra mayor al saldo: 400", deMas.status, 400);
    checkTrue(
      "y dice cuánto es el saldo",
      String(deMas.body?.error ?? "").includes("supera el saldo"),
      JSON.stringify(deMas.body),
    );

    // Parámetros imposibles: cada rechazo explica el motivo, nunca un 500.
    const sinCuenta = await post("/api/loans/pay", {});
    check("pago sin cuenta: 400", sinCuenta.status, 400);
    const numeroCero = await post("/api/loans/pay", {
      accountId: prestamoPrueba.body?.id,
      cashAccountId: bancoPrueba.body?.id,
      installmentNumber: 0,
    });
    check("cuota 0: 400", numeroCero.status, 400);
    const extraNegativo = await post("/api/loans/pay", {
      accountId: prestamoPrueba.body?.id,
      cashAccountId: bancoPrueba.body?.id,
      extraCapital: "-5",
    });
    check("capital extra negativo: 400", extraNegativo.status, 400);
    const cancelNoBooleano = await post("/api/loans/pay", {
      accountId: prestamoPrueba.body?.id,
      cashAccountId: bancoPrueba.body?.id,
      cancel: "sí",
    });
    check("cancel no booleano: 400", cancelNoBooleano.status, 400);
    const fechaImposible = await post("/api/loans/pay", {
      accountId: prestamoPrueba.body?.id,
      cashAccountId: bancoPrueba.body?.id,
      date: "2026-02-31",
    });
    check("31 de febrero en el pago: 400", fechaImposible.status, 400);
    const idHostil = await post("/api/loans/pay", {
      accountId: "'; DROP TABLE \"Account\"; --",
      cashAccountId: bancoPrueba.body?.id,
    });
    // Prisma parametriza: el id hostil no rompe nada, sólo no encuentra el
    // préstamo. La respuesta correcta es el 404 de «no existe», jamás un 500.
    check("id hostil: 404 (parametrizado, no hay 500)", idHostil.status, 404);
    checkTrue(
      "y dice que no existe, no un error del server",
      String(idHostil.body?.error ?? "").includes("no existe"),
      JSON.stringify(idHostil.body),
    );

    // ── Cancelación anticipada: el capital que queda, SIN interés ────────────
    const cancelacion = await post("/api/loans/pay", {
      accountId: prestamoPrueba.body?.id,
      cashAccountId: bancoPrueba.body?.id,
      date: "2026-10-07",
      cancel: true,
    });
    check("cancela el préstamo (201)", cancelacion.status, 201);
    check("cancelled: true", cancelacion.body?.cancelled, true);
    check("paga el capital restante 385.603,94", cancelacion.body?.principalPaid, "385603.94");
    check("sin interés en la cancelación", cancelacion.body?.interestPaid, null);
    check("una sola pata (la transferencia del capital)", cancelacion.body?.movements?.length, 1);
    check("capital completo en la vista", cancelacion.body?.loan?.capitalPaid, "500000.00");
    check("las 12 cuotas quedan cubiertas", cancelacion.body?.loan?.plan?.paidCount, 12);
    check("sin próxima cuota", cancelacion.body?.loan?.nextInstallment, null);
    check("deuda 0,00", cancelacion.body?.loan?.debt, "0.00");
    check("progreso 100,00", cancelacion.body?.loan?.progressPercent, "100.00");
    check("interés pagado: el de las cuotas cubiertas", cancelacion.body?.loan?.interestPaid, "176952.44");

    // Cancelar de nuevo no paga dos veces.
    const cancelarDosVeces = await post("/api/loans/pay", {
      accountId: prestamoPrueba.body?.id,
      cashAccountId: bancoPrueba.body?.id,
      date: "2026-10-07",
      cancel: true,
    });
    check("el doble toque de la cancelación responde 200", cancelarDosVeces.status, 200);
    check("created: false", cancelarDosVeces.body?.created, false);

    // Cancelar JUNTO con una cuota no existe: es una cosa o la otra.
    const cancelarConCuota = await post("/api/loans/pay", {
      accountId: prestamoPrueba.body?.id,
      cashAccountId: bancoPrueba.body?.id,
      date: "2026-10-07",
      installmentNumber: 5,
      cancel: true,
    });
    check("cancelación + cuota: 400", cancelarConCuota.status, 400);
    checkTrue(
      "y explica que no se combinan",
      String(cancelarConCuota.body?.error ?? "").includes("no se combina"),
      JSON.stringify(cancelarConCuota.body),
    );

    // ── Un préstamo dado (RECEIVABLE): cobra al revés y NO es deuda ──────────
    const porCobrar = await post("/api/accounts", {
      name: "Préstamo a Marce (smoke)",
      kind: "RECEIVABLE",
      principal: "100.000",
      tnaPercent: "60",
      installmentCount: 6,
      firstInstallmentDate: "2026-10-06",
    });
    check("crea el préstamo a cobrar (201)", porCobrar.status, 201);

    const { body: vistaSinPrestar } = await api("/api/loans?asOf=2026-10-31");
    const sinPrestar = (vistaSinPrestar?.loans ?? []).find(
      (l) => l.id === porCobrar.body?.id,
    );
    check("la cuenta por cobrar sin desembolso: disbursed false", sinPrestar?.disbursed, false);

    // El desembolso: la plata sale del banco y entra a la cuenta por cobrar.
    // No es un gasto: el patrimonio no cambia, cambia de forma.
    const lePresto = await post("/api/transactions", {
      kind: "TRANSFER",
      amount: "100.000",
      date: "2026-10-06",
      accountId: bancoPrueba.body?.id,
      toAccountId: porCobrar.body?.id,
      description: "Le presté a Marce (smoke)",
    });
    check("registra el desembolso (201)", lePresto.status, 201);

    const cuotaDada = (await api("/api/loans?asOf=2026-10-31")).body?.loans?.find(
      (l) => l.id === porCobrar.body?.id,
    )?.installments?.[0];
    checkTrue("la vista trae el cronograma del préstamo dado", cuotaDada !== undefined);

    const cobro = await post("/api/loans/pay", {
      accountId: porCobrar.body?.id,
      cashAccountId: bancoPrueba.body?.id,
      date: "2026-10-08",
      installmentNumber: 1,
    });
    check("cobra la cuota 1 (201)", cobro.status, 201);
    check("el capital vuelve: el de la cuota", cobro.body?.principalPaid, "14701.75");
    check("el interés es INGRESO: 100.000 × 5% = 5.000,00", cobro.body?.interestPaid, "5000.00");
    check("dos patas", cobro.body?.movements?.length, 2);
    check("el capital vuelve como TRANSFERENCIA", cobro.body?.movements?.[0]?.kind, "TRANSFER");
    check("sale de la cuenta por cobrar", cobro.body?.movements?.[0]?.account?.id, porCobrar.body?.id);
    check("y entra al banco", cobro.body?.movements?.[0]?.toAccount?.id, bancoPrueba.body?.id);
    check("el interés entra como INCOME", cobro.body?.movements?.[1]?.kind, "INCOME");
    check(
      "y entra a la cuenta de dinero, NUNCA a la cuenta por cobrar",
      cobro.body?.movements?.[1]?.account?.id,
      bancoPrueba.body?.id,
    );

    const { body: vistaDados } = await api("/api/loans?asOf=2026-10-31");
    const dado = (vistaDados?.loans ?? []).find((l) => l.id === porCobrar.body?.id);
    check("dirección: OWED_TO_ME", dado?.direction, "OWED_TO_ME");
    check("con la plata prestada: disbursed true", dado?.disbursed, true);
    check("no tiene «deuda» (es un activo)", dado?.debt, null);
    check("lo que te deben: 85.298,25", dado?.receivable, "85298.25");
    check("capital recuperado: 14.701,75", dado?.capitalPaid, "14701.75");
    check("1 de 6 cuotas cobradas", dado?.plan?.paidCount, 1);

    // El reporte de DEUDAS no lo ve: es un activo, no una deuda. Ni las filas,
    // ni el total, ni el DTI cambian por prestar plata.
    const { body: deudaDados } = await api(`/api/debts?month=${MES}&asOf=${MES}-31`);
    const filasDeuda = deudaDados?.debtReport?.rows ?? [];
    checkTrue(
      "el préstamo dado no aparece en los pasivos",
      !filasDeuda.some((f) => f.name === "Préstamo a Marce (smoke)"),
    );
    check("y el total de deuda sigue siendo el del seed", deudaDados?.debtReport?.totalDebt, "518587.29");
    check("DTI · sigue habiendo un solo plan", deudaDados?.debtReport?.dti?.planCount, 1);

    // Un INCOME directo a la cuenta por cobrar inflaría un activo sin plata: la
    // base lo prohíbe y la API lo traduce a 400 con explicación.
    const ingresoInflado = await post("/api/transactions", {
      kind: "INCOME",
      amount: "1000",
      date: "2026-10-09",
      accountId: porCobrar.body?.id,
      categoryName: "Intereses",
    });
    check("ingreso directo a la cuenta por cobrar: 400", ingresoInflado.status, 400);
    checkTrue(
      "y explica que ahí no entra un ingreso",
      String(ingresoInflado.body?.error ?? "").includes("ingreso"),
      JSON.stringify(ingresoInflado.body),
    );

    // ── El rotativo: no acepta cuotas; se cancela pagando el capital ─────────
    const rotativo = await post("/api/accounts", {
      name: "Línea rotativa (smoke)",
      kind: "LOAN",
      principal: "100.000",
      tnaPercent: "60",
      installmentCount: 12,
      firstInstallmentDate: "2026-10-07",
      amortizationSystem: "INTEREST_ONLY",
    });
    check("crea la línea rotativa (201)", rotativo.status, 201);

    // El desembolso del rotativo, igual que el préstamo de prueba: el saldo de
    // la cuenta es la deuda viva; el capital entra al banco y la línea nace
    // debiendo.
    const desembolsoRotativo = await post("/api/transactions", {
      kind: "TRANSFER",
      amount: "100.000",
      date: "2026-10-07",
      accountId: rotativo.body?.id,
      toAccountId: bancoPrueba.body?.id,
      description: "Desembolso de la línea rotativa (smoke)",
    });
    check("registra el desembolso del rotativo (201)", desembolsoRotativo.status, 201);

    const cuotaRotativa = await post("/api/loans/pay", {
      accountId: rotativo.body?.id,
      cashAccountId: bancoPrueba.body?.id,
      date: "2026-10-08",
      installmentNumber: 1,
    });
    check("el rotativo no acepta cuotas: 400", cuotaRotativa.status, 400);
    checkTrue(
      "y explica por qué (el interés no amortiza)",
      String(cuotaRotativa.body?.error ?? "").includes("solo interés"),
      JSON.stringify(cuotaRotativa.body),
    );

    const canceladoRotativo = await post("/api/loans/pay", {
      accountId: rotativo.body?.id,
      cashAccountId: bancoPrueba.body?.id,
      date: "2026-10-09",
      cancel: true,
    });
    check("el rotativo se cancela pagando el capital (201)", canceladoRotativo.status, 201);
    check("capital: 100.000,00", canceladoRotativo.body?.principalPaid, "100000.00");
    check("rotativo: interés pagado null (no se deriva del saldo)", canceladoRotativo.body?.loan?.interestPaid, null);
    check("deuda 0,00 tras cancelar", canceladoRotativo.body?.loan?.debt, "0.00");

    // ── El sistema importado: el cronograma lo dicta el banco ────────────────
    const importado = await post("/api/accounts", {
      name: "Crédito importado (smoke)",
      kind: "LOAN",
      principal: "47.500",
      amortizationSystem: "IMPORTED",
      imported: [
        { dueDate: "2026-11-15", payment: "30.000", interest: "5.000" },
        { dueDate: "2026-12-15", payment: "25.000", interest: "2.500" },
      ],
    });
    check("crea el préstamo importado sin tasa ni cuotas (201)", importado.status, 201);
    check("sistema IMPORTED", importado.body?.amortizationSystem, "IMPORTED");

    const { body: vistaImportado } = await api("/api/loans?asOf=2026-11-01");
    const credito = (vistaImportado?.loans ?? []).find((l) => l.id === importado.body?.id);
    check("la vista lo muestra IMPORTED", credito?.system, "IMPORTED");
    check("sin tasa: la composición la dicta el banco", credito?.tnaPercent, null);
    check("las 2 cuotas se derivan del cronograma", credito?.plan?.installmentCount, 2);
    check("y la primera fecha también", credito?.firstInstallmentDate, "2026-11-15");
    check("cuota 1 al 15/11", credito?.installments?.[0]?.dueDate, "2026-11-15");
    check("ninguna cubierta todavía", credito?.plan?.paidCount, 0);
    check("compromisos: las 2 cuotas (30.000 + 25.000)", credito?.commitments?.next12Months, "55000.00");
    check("nada vencido al 01/11", credito?.commitments?.overdue, "0.00");

    // Un cronograma importado que no suma el monto del préstamo no entra: la
    // diferencia sería un perdón o un cobro fantasma.
    const importadoInconsistente = await post("/api/accounts", {
      name: "Importado inconsistente (smoke)",
      kind: "LOAN",
      principal: "30.000",
      amortizationSystem: "IMPORTED",
      imported: [{ dueDate: "2026-11-15", payment: "30.000", interest: "5.000" }],
    });
    check("importado con Σ capital ≠ monto: 400", importadoInconsistente.status, 400);
    checkTrue(
      "y dice cuánto no coincide",
      String(importadoInconsistente.body?.error ?? "").includes("no coincide"),
      JSON.stringify(importadoInconsistente.body),
    );

    // Pagar una cuota del importado: la composición es la del banco, tal cual.
    const cuotaImportada = await post("/api/loans/pay", {
      accountId: importado.body?.id,
      cashAccountId: bancoPrueba.body?.id,
      date: "2026-10-09",
      installmentNumber: 1,
    });
    check("paga la cuota 1 del importado (201)", cuotaImportada.status, 201);
    check("capital: el que dictó el banco (25.000,00)", cuotaImportada.body?.principalPaid, "25000.00");
    check("interés: el que dictó el banco (5.000,00)", cuotaImportada.body?.interestPaid, "5000.00");

    // ── Los sistemas, en la vista previa (una fórmula cada uno) ──────────────
    const aleman = await api(
      "/api/loans/preview?principal=500000&tnaPercent=60&installmentCount=12&system=GERMAN&firstInstallmentDate=2026-11-15",
    );
    check("alemán: cuota 1 = capital fijo + interés", aleman.body?.schedule?.[0]?.payment, "66666.66");
    check("alemán: capital fijo 41.666,66", aleman.body?.schedule?.[0]?.principal, "41666.66");
    check("alemán: la última absorbe el resto del capital", aleman.body?.schedule?.[11]?.principal, "41666.74");
    check("alemán: el capital vuelve entero", aleman.body?.totalPrincipal, "500000.00");
    check("alemán: las fechas salen de la primera", aleman.body?.schedule?.[1]?.dueDate, "2026-12-15");

    const americano = await api(
      "/api/loans/preview?principal=500000&tnaPercent=60&installmentCount=12&system=AMERICAN",
    );
    check("americano: la cuota 1 es solo interés", americano.body?.schedule?.[0]?.payment, "25000.00");
    check("americano: sin amortización hasta el final", americano.body?.schedule?.[0]?.principal, "0.00");
    check("americano: la última paga interés + todo el capital", americano.body?.schedule?.[11]?.payment, "525000.00");

    const americanoSinTasa = await api(
      "/api/loans/preview?principal=500000&tnaPercent=0&installmentCount=12&system=AMERICAN",
    );
    check("americano con tasa 0: 400 (cuotas de $0 no son cuotas)", americanoSinTasa.status, 400);
    checkTrue(
      "y lo explica en castellano",
      String(americanoSinTasa.body?.error ?? "").includes("americano"),
      JSON.stringify(americanoSinTasa.body),
    );

    const rotativoPreview = await api(
      "/api/loans/preview?principal=500000&tnaPercent=60&installmentCount=12&system=INTEREST_ONLY",
    );
    check("rotativo: cada cuota es el interés", rotativoPreview.body?.schedule?.[0]?.payment, "25000.00");
    check("rotativo: no amortiza capital por contrato", rotativoPreview.body?.totalPrincipal, "0.00");

    const importadoPreview = await api(
      "/api/loans/preview?principal=500000&tnaPercent=60&installmentCount=12&system=IMPORTED",
    );
    check("el importado no tiene vista previa: 400", importadoPreview.status, 400);
    checkTrue(
      "y dice por qué",
      String(importadoPreview.body?.error ?? "").includes("vista previa"),
      JSON.stringify(importadoPreview.body),
    );

    // Un préstamo imposible de repartir (5 centavos en 12 cuotas) es 400: la
    // API lo rechaza ANTES de armar un cronograma de cuotas de cero.
    const minusculo = await post("/api/accounts", {
      name: "Préstamo minúsculo (smoke)",
      kind: "LOAN",
      principal: "0.05",
      tnaPercent: "60",
      installmentCount: 12,
      firstInstallmentDate: "2026-10-10",
    });
    check("5 centavos en 12 cuotas: 400", minusculo.status, 400);
    checkTrue(
      "y explica que es demasiado chico",
      String(minusculo.body?.error ?? "").includes("demasiado chico"),
      JSON.stringify(minusculo.body),
    );

    // ── Limpieza: la base queda como estaba ──────────────────────────────────
    // Los movimientos referencian las cuentas con FK `Restrict`, así que van
    // primero; las cuotas caen con su cuenta en cascada.
    const idsDePrueba = [
      bancoPrueba.body?.id,
      prestamoPrueba.body?.id,
      porCobrar.body?.id,
      rotativo.body?.id,
      importado.body?.id,
    ].filter(Boolean);
    const prisma = new PrismaClient();
    await prisma.movement.deleteMany({
      where: {
        OR: [
          { accountId: { in: idsDePrueba } },
          { toAccountId: { in: idsDePrueba } },
        ],
      },
    });
    await prisma.account.deleteMany({ where: { id: { in: idsDePrueba } } });
    await prisma.$disconnect();

    const totalesDespues = await totalesDelMes();
    check("los gastos del mes volvieron al punto de partida", totalesDespues?.expenses, totalesAntes?.expenses);
    check("y también los ingresos", totalesDespues?.income, totalesAntes?.income);

    const { body: vistaFinal } = await api("/api/loans?asOf=2026-12-31");
    checkTrue(
      "los préstamos de prueba ya no están",
      !(vistaFinal?.loans ?? []).some((l) => idsDePrueba.includes(l.id)),
    );
  }

  // ── Logout: CSRF y atributos de la cookie ──────────────────────────────────
  section("Cierre de sesión (logout)");
  {
    // El logout es una mutación: tiene que exigir el mismo origen. Un sitio
    // externo no puede desloguear al usuario por la espalda (logout CSRF).
    const ajeno = await fetch(`${BASE_URL}/api/auth/logout`, {
      method: "POST",
      headers: { Origin: "http://evil.example", Cookie: cookie },
    });
    check("logout con Origin ajeno responde 403", ajeno.status, 403);

    // Una cookie sólo se borra si el `Set-Cookie` repite los MISMOS atributos con
    // los que se creó. Sobre http (APP_URL local) el login NO marca `Secure`; si
    // el logout lo marcara, el navegador descartaría el borrado y la sesión
    // seguiría viva tras "cerrar sesión". Los dos tienen que coincidir.
    const loginSeco = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const secureLogin = /;\s*Secure/i.test(
      (loginSeco.headers.getSetCookie?.() ?? []).join(" "),
    );

    const logoutSeco = await fetch(`${BASE_URL}/api/auth/logout`, {
      method: "POST",
      headers: { Origin: BASE_URL, Cookie: cookie },
    });
    const secureLogout = /;\s*Secure/i.test(
      (logoutSeco.headers.getSetCookie?.() ?? []).join(" "),
    );
    checkTrue(
      "logout borra la cookie con los mismos atributos que el login (Secure)",
      secureLogin === secureLogout,
      `login Secure=${secureLogin}, logout Secure=${secureLogout}`,
    );
  }

  // ── Cabeceras de seguridad ─────────────────────────────────────────────────
  section("Cabeceras de seguridad");
  {
    const pagina = await fetch(`${BASE_URL}/login`);
    check(
      "X-Content-Type-Options: nosniff",
      pagina.headers.get("x-content-type-options"),
      "nosniff",
    );
    check("X-Frame-Options: DENY", pagina.headers.get("x-frame-options"), "DENY");
    check(
      "Referrer-Policy: strict-origin-when-cross-origin",
      pagina.headers.get("referrer-policy"),
      "strict-origin-when-cross-origin",
    );

    const respuestaApi = await fetch(`${BASE_URL}/api/accounts`, {
      headers: { Cookie: cookie, Origin: BASE_URL },
    });
    check(
      "la API también trae X-Content-Type-Options",
      respuestaApi.headers.get("x-content-type-options"),
      "nosniff",
    );
  }

  console.log(
    `\n${failed === 0 ? "TODO OK" : "HAY FALLAS"} — ${passed} verificaciones ok, ${failed} con falla`,
  );
}

main()
  .catch((error) => {
    console.error("\nEl smoke test se rompió:", error);
    process.exit(1);
  })
  .then(() => {
    process.exit(failed === 0 ? 0 : 1);
  });
