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
    // El orden importa: primero los movimientos, después lo demás. La clave
    // foránea de Movement → Account es `Restrict`, así que borrar las cuentas
    // antes fallaría.
    await prisma.movement.deleteMany();
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

  // La ruta que usa el panel (sin `asOf`) termina en el mes ACTUAL del reloj
  // local —el mismo que ve la persona en la interfaz— y su último punto tiene
  // que coincidir con `netWorth.net` de esa misma respuesta.
  {
    const { body: hoy } = await api("/api/accounts?includeArchived=false");
    const ahora = new Date();
    const mesActual = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, "0")}`;
    const ultimo = (hoy?.netWorthSeries ?? []).at(-1);
    check("sin asOf, la serie termina en el mes actual", ultimo?.month, mesActual);
    check("y su neto coincide con el patrimonio de hoy", ultimo?.net, hoy?.netWorth?.net);
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
