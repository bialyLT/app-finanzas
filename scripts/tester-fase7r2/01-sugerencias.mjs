#!/usr/bin/env node
/**
 * 01 · SUGERENCIAS DE DESCRIPCIÓN — ataque API a `/api/transactions/suggestions`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA (brief r2, ataque A: autocompletado de descripción)
 * ─────────────────────────────────────────────────────────────────────────────
 * La promesa del dev: al escribir ≥2 caracteres en la nota, el servidor sugiere
 * descripciones usadas antes con categoría, cuenta y MONTO TÍPICO (mediana), y
 * la sugerencia se puede aceptar para precargar el formulario.
 *
 * Esta batería ataca el endpoint SOLO (la UI tiene su propia batería):
 *
 *   1. AUTENTICACIÓN: sin cookie → 401.
 *   2. PARÁMETROS HOSTILES: `kind` ausente/inválido → 400; `q` > 80 → 400;
 *      `limit` 0 / negativo / decimal / > 12 / no numérico → 400; el borde
 *      (12) es válido. Nada de esto puede ser 500.
 *   3. LA MEDIANA, CALCULADA A MANO EN LOS COMENTARIOS:
 *        · impar: 1.00, 1.50, 100.00 → 1.50 (el outlier de 100 no la mueve);
 *        · par con suma IMPAR de centavos → half-even:
 *            10.01+10.02 = 2003¢ → 1001.5 → 1002 (sube al par) = 10.02
 *            10.00+10.01 = 2001¢ → 1000.5 → 1000 (baja al par) = 10.00
 *            10.02+10.03 = 2005¢ → 1002.5 → 1002 (baja al par) = 10.02
 *          (un promedio común daría 10.015→10.02, 10.005→10.01, 10.025→10.03:
 *           los tres difieren del half-even en al menos un caso)
 *   4. AGRUPACIÓN POR NORMALIZACIÓN: "Café con leche" / "CAFE CON LECHE" son
 *      el mismo grupo; se muestra la variante más repetida; la búsqueda no
 *      distingue mayúsculas ni acentos.
 *   5. SEPARACIÓN POR TIPO: la misma descripción como gasto y como ingreso no
 *      se mezcla: la categoría de un ingreso no puede precargar un gasto.
 *   6. CATEGORÍA Y CUENTA "MÁS FRECUENTE" (empate → la más reciente) y
 *      categoría null cuando el grupo no tiene.
 *   7. CUENTAS ARCHIVADAS EXCLUIDAS (origen y destino de transferencia).
 *   8. ORDEN: match (prefijo > palabra > subcadena) → frecuencia → recencia →
 *      nombre; y el `limit` efectivo.
 *   9. LA VENTANA DE 400 FILAS: 400 rellenos fechados en 2035 llenan la
 *      ventana; una aguja de 2036 (más nueva que todos) aparece y una de 2034
 *      (más vieja que los 400 rellenos) NO aparece. La ventana es una ventana:
 *      ni "sin límite" ni "no encuentra nada".
 *
 * Todo el dataset es propio (prefijo T_T7R2_SUG) y se crea por Prisma directo
 * con fechas de 2027/2034/2035/2036 — lejos de los totales de octubre que
 * miran los flows. La batería limpia por prefijo antes y después.
 */

import {
  check,
  checkIncluye,
  checkSin500,
  checkTrue,
  get,
  login,
  runScript,
  section,
  BASE_URL,
} from "./lib.mjs";

const TAG = "T_T7R2_SUG";

/** `YYYY-MM-DD` → Date para la columna @db.Date (UTC midnight, día exacto). */
const d = (date) => new Date(`${date}T00:00:00.000Z`);

runScript({
  tag: TAG,
  main: async (prisma) => {
    const cuentas = {};
    const cats = {};

    section("Preparación — cuentas propias y categorías");
    cuentas.c1 = await prisma.account.create({
      data: { name: `${TAG} Cuenta1`, kind: "BANK" },
    });
    cuentas.c2 = await prisma.account.create({
      data: { name: `${TAG} Cuenta2`, kind: "CASH" },
    });
    cuentas.arch = await prisma.account.create({
      data: { name: `${TAG} Archivada`, kind: "BANK", archived: true },
    });
    cats.a = await prisma.category.create({
      data: { name: `${TAG} CatA`, normalizedName: `${TAG} cata`, kind: "EXPENSE" },
    });
    cats.b = await prisma.category.create({
      data: { name: `${TAG} CatB`, normalizedName: `${TAG} catb`, kind: "EXPENSE" },
    });
    cats.inc = await prisma.category.create({
      data: { name: `${TAG} CatIngreso`, normalizedName: `${TAG} catingreso`, kind: "INCOME" },
    });
    console.log(`  · cuentas y categorías propias creadas`);

    const mov = (body) =>
      prisma.movement.create({
        data: {
          kind: body.kind ?? "EXPENSE",
          amount: body.amount,
          date: d(body.date),
          description: body.description,
          accountId: body.accountId ?? cuentas.c1.id,
          toAccountId: body.toAccountId ?? null,
          categoryId: body.categoryId ?? null,
        },
      });

    /* ── 1. Autenticación ───────────────────────────────────────────────── */
    section("1 · Autenticación");
    {
      const sinSesion = await fetch(
        `${BASE_URL}/api/transactions/suggestions?kind=EXPENSE&q=cafe`,
      );
      check("sin cookie de sesión → 401", sinSesion.status, 401);
    }
    await login();

    /* ── 2. Parámetros hostiles ─────────────────────────────────────────── */
    section("2 · Parámetros hostiles (nunca 500)");
    {
      const respuestas = [];
      const st = async (label, path) => {
        const r = await get(path);
        respuestas.push(r);
        return r;
      };
      let r = await st("kind ausente", `/api/transactions/suggestions?q=cafe`);
      check("kind ausente → 400", r.status, 400);
      r = await st("kind inválido", `/api/transactions/suggestions?kind=HACK&q=cafe`);
      check("kind inválido → 400", r.status, 400);
      r = await st(
        "q de 81 caracteres",
        `/api/transactions/suggestions?kind=EXPENSE&q=${"x".repeat(81)}`,
      );
      check("q > 80 → 400", r.status, 400);
      checkIncluye("el error de q explica el tope", r.body?.error, "80");
      r = await st("curiosidad: q de 80 exactos", `/api/transactions/suggestions?kind=EXPENSE&q=${"x".repeat(80)}`);
      check("q = 80 → 200 (borde aceptado)", r.status, 200);
      r = await st("limit=0", `/api/transactions/suggestions?kind=EXPENSE&limit=0`);
      check("limit 0 → 400", r.status, 400);
      r = await st("limit=-1", `/api/transactions/suggestions?kind=EXPENSE&limit=-1`);
      check("limit negativo → 400", r.status, 400);
      r = await st("limit=1.5", `/api/transactions/suggestions?kind=EXPENSE&limit=1.5`);
      check("limit decimal → 400", r.status, 400);
      r = await st("limit=13", `/api/transactions/suggestions?kind=EXPENSE&limit=13`);
      check("limit > 12 → 400", r.status, 400);
      r = await st("limit=abc", `/api/transactions/suggestions?kind=EXPENSE&limit=abc`);
      check("limit no numérico → 400", r.status, 400);
      r = await st("limit=12 (borde)", `/api/transactions/suggestions?kind=EXPENSE&limit=12`);
      check("limit = 12 → 200 (borde aceptado)", r.status, 200);
      checkSin500("ninguna variante hostil devolvió 5xx", respuestas);
    }

    /* ── 3. La mediana, calculada a mano ────────────────────────────────── */
    section("3 · Mediana (mano en el comentario)");
    await mov({ amount: "1.00", date: "2027-03-01", description: `${TAG} mediana impar` });
    await mov({ amount: "1.50", date: "2027-03-02", description: `${TAG} mediana impar` });
    await mov({ amount: "100.00", date: "2027-03-03", description: `${TAG} mediana impar` });
    // 10.01 + 10.02 = 2003¢ → mitad exacta 1001.5 → half-even → 1002 (par) = 10.02
    await mov({ amount: "10.01", date: "2027-03-01", description: `${TAG} mediana par sube` });
    await mov({ amount: "10.02", date: "2027-03-02", description: `${TAG} mediana par sube` });
    // 10.00 + 10.01 = 2001¢ → mitad 1000.5 → half-even → 1000 (par) = 10.00
    await mov({ amount: "10.00", date: "2027-03-01", description: `${TAG} mediana par baja` });
    await mov({ amount: "10.01", date: "2027-03-02", description: `${TAG} mediana par baja` });
    // 10.02 + 10.03 = 2005¢ → mitad 1002.5 → half-even → 1002 (par) = 10.02
    await mov({ amount: "10.02", date: "2027-03-01", description: `${TAG} mediana par queda` });
    await mov({ amount: "10.03", date: "2027-03-02", description: `${TAG} mediana par queda` });
    {
      const r = await get(
        `/api/transactions/suggestions?kind=EXPENSE&q=${encodeURIComponent("mediana")}&limit=12`,
      );
      check("la búsqueda de medianas responde 200", r.status, 200);
      const porNombre = new Map(
        (r.body?.suggestions ?? []).map((s) => [s.description, s]),
      );
      check(
        "impar: 1.00, 1.50, 100.00 → 1.50 (el outlier no mueve)",
        porNombre.get(`${TAG} mediana impar`)?.amount,
        "1.50",
      );
      check(
        "par half-even sube: (10.01+10.02)/2 = 10.015 → 10.02 (al par)",
        porNombre.get(`${TAG} mediana par sube`)?.amount,
        "10.02",
      );
      check(
        "par half-even baja: (10.00+10.01)/2 = 10.005 → 10.00 (al par)",
        porNombre.get(`${TAG} mediana par baja`)?.amount,
        "10.00",
      );
      check(
        "par half-even queda: (10.02+10.03)/2 = 10.025 → 10.02 (al par)",
        porNombre.get(`${TAG} mediana par queda`)?.amount,
        "10.02",
      );
      check(
        "la frecuencia del grupo impar es 3",
        porNombre.get(`${TAG} mediana impar`)?.frequency,
        3,
      );
    }

    /* ── 4. Normalización y variante mostrada ───────────────────────────── */
    section("4 · Normalización (mayúsculas, acentos, espacios)");
    await mov({ amount: "900.00", date: "2027-03-04", description: `${TAG} Café con leche` });
    await mov({ amount: "900.00", date: "2027-03-05", description: `${TAG} Café con leche` });
    await mov({ amount: "800.00", date: "2027-03-06", description: `${TAG} CAFE CON LECHE` });
    {
      const r = await get(
        `/api/transactions/suggestions?kind=EXPENSE&q=${encodeURIComponent("cafe")}&limit=12`,
      );
      const grupo = (r.body?.suggestions ?? []).find((s) =>
        s.description.toUpperCase().includes("CAF"),
      );
      checkTrue("la búsqueda sin acentos encuentra el grupo", Boolean(grupo), JSON.stringify(r.body?.suggestions));
      check("el grupo tiene frecuencia 3 (2 variantes crudas + 1)", grupo?.frequency, 3);
      check(
        "se muestra la variante más repetida",
        grupo?.description,
        `${TAG} Café con leche`,
      );
      const r2 = await get(
        `/api/transactions/suggestions?kind=EXPENSE&q=${encodeURIComponent("CAFÉ   CON   LECHE")}&limit=12`,
      );
      check(
        "la query con espacios de más y mayúsculas encuentra el mismo grupo",
        (r2.body?.suggestions ?? [])[0]?.description,
        `${TAG} Café con leche`,
      );
    }

    /* ── 5. Separación por tipo y categoría del tipo ────────────────────── */
    section("5 · Separación por tipo (EXPENSE vs INCOME)");
    await mov({
      amount: "111.00",
      date: "2027-03-07",
      description: `${TAG} separadas`,
      categoryId: cats.a.id,
    });
    await mov({
      kind: "INCOME",
      amount: "222.00",
      date: "2027-03-08",
      description: `${TAG} separadas`,
      categoryId: cats.inc.id,
    });
    // Este gasto apunta a una categoría de INGRESO: no debe contarse como la
    // categoría del grupo (la base no lo impide; el agrupador sí debe ignorarla).
    await mov({
      amount: "333.00",
      date: "2027-03-09",
      description: `${TAG} cat cruzada`,
      categoryId: cats.inc.id,
    });
    {
      const exp = await get(
        `/api/transactions/suggestions?kind=EXPENSE&q=${encodeURIComponent("separadas")}`,
      );
      const inc = await get(
        `/api/transactions/suggestions?kind=INCOME&q=${encodeURIComponent("separadas")}`,
      );
      check("EXPENSE ve su propio grupo (111.00)", exp.body?.suggestions?.[0]?.amount, "111.00");
      check("EXPENSE ve kind EXPENSE", exp.body?.suggestions?.[0]?.kind, "EXPENSE");
      check("INCOME ve su propio grupo (222.00)", inc.body?.suggestions?.[0]?.amount, "222.00");
      check("INCOME ve kind INCOME", inc.body?.suggestions?.[0]?.kind, "INCOME");
      check(
        "la categoría de un ingreso no se cuela en el grupo de gasto",
        exp.body?.suggestions?.[0]?.category?.name,
        `${TAG} CatA`,
      );
      const cruzada = await get(
        `/api/transactions/suggestions?kind=EXPENSE&q=${encodeURIComponent("cat cruzada")}`,
      );
      check(
        "un grupo de gasto sin categoría de gasto devuelve category null",
        cruzada.body?.suggestions?.[0]?.category,
        null,
      );
    }

    /* ── 6. Categoría y cuenta más frecuentes (empate → reciente) ───────── */
    section("6 · Categoría y cuenta más frecuentes");
    await mov({ amount: "50.00", date: "2027-03-01", description: `${TAG} cat mix`, categoryId: cats.a.id });
    await mov({ amount: "50.00", date: "2027-03-02", description: `${TAG} cat mix`, categoryId: cats.a.id });
    await mov({ amount: "50.00", date: "2027-03-06", description: `${TAG} cat mix`, categoryId: cats.b.id });
    await mov({ amount: "70.00", date: "2027-03-01", description: `${TAG} cuenta mix`, accountId: cuentas.c1.id });
    await mov({ amount: "70.00", date: "2027-03-02", description: `${TAG} cuenta mix`, accountId: cuentas.c1.id });
    await mov({ amount: "70.00", date: "2027-03-06", description: `${TAG} cuenta mix`, accountId: cuentas.c2.id });
    // Empate 1-1: gana la usada MÁS RECIENTEMENTE (c2, 2027-03-09).
    await mov({ amount: "60.00", date: "2027-03-01", description: `${TAG} cuenta empate`, accountId: cuentas.c1.id });
    await mov({ amount: "60.00", date: "2027-03-09", description: `${TAG} cuenta empate`, accountId: cuentas.c2.id });
    {
      const r = await get(
        `/api/transactions/suggestions?kind=EXPENSE&q=${encodeURIComponent("cat mix")}`,
      );
      check("categoría más frecuente: CatA (2 de 3)", r.body?.suggestions?.[0]?.category?.name, `${TAG} CatA`);
      const rc = await get(
        `/api/transactions/suggestions?kind=EXPENSE&q=${encodeURIComponent("cuenta mix")}`,
      );
      check("cuenta más frecuente: Cuenta1 (2 de 3)", rc.body?.suggestions?.[0]?.account?.name, `${TAG} Cuenta1`);
      const re = await get(
        `/api/transactions/suggestions?kind=EXPENSE&q=${encodeURIComponent("cuenta empate")}`,
      );
      check(
        "empate de cuentas 1-1 → la más reciente (Cuenta2)",
        re.body?.suggestions?.[0]?.account?.name,
        `${TAG} Cuenta2`,
      );
      const rs = await get(
        `/api/transactions/suggestions?kind=EXPENSE&q=${encodeURIComponent("cuenta mix")}`,
      );
      const s = rs.body?.suggestions?.[0];
      checkTrue("la sugerencia trae id de cuenta", typeof s?.account?.id === "string" && s.account.id.length > 0, JSON.stringify(s?.account));
      checkTrue("el monto es decimal de dos cifras", /^\d+\.\d{2}$/.test(String(s?.amount)), String(s?.amount));
    }

    /* ── 7. Transferencias y cuentas archivadas ─────────────────────────── */
    section("7 · Transferencia (destino) y cuentas archivadas");
    await mov({
      kind: "TRANSFER",
      amount: "500.00",
      date: "2027-03-10",
      description: `${TAG} trans`,
      accountId: cuentas.c1.id,
      toAccountId: cuentas.c2.id,
    });
    await mov({
      amount: "999.00",
      date: "2027-03-11",
      description: `${TAG} archivada`,
      accountId: cuentas.arch.id,
    });
    await mov({
      kind: "TRANSFER",
      amount: "444.00",
      date: "2027-03-12",
      description: `${TAG} trans a archivada`,
      accountId: cuentas.c1.id,
      toAccountId: cuentas.arch.id,
    });
    {
      const rt = await get(
        `/api/transactions/suggestions?kind=TRANSFER&q=${encodeURIComponent("t_t7r2_sug trans")}&limit=12`,
      );
      const trans = (rt.body?.suggestions ?? []).find((s) => s.description === `${TAG} trans`);
      checkTrue("la transferencia aparece como sugerencia", Boolean(trans), JSON.stringify(rt.body?.suggestions));
      check("la transferencia no lleva categoría", trans?.category, null);
      check("la transferencia precarga el destino", trans?.toAccount?.name, `${TAG} Cuenta2`);
      const ra = await get(
        `/api/transactions/suggestions?kind=EXPENSE&q=${encodeURIComponent("archivada")}&limit=12`,
      );
      check(
        "un gasto en cuenta archivada no se sugiere",
        (ra.body?.suggestions ?? []).filter((s) => s.description === `${TAG} archivada`).length,
        0,
      );
      const rta = await get(
        `/api/transactions/suggestions?kind=TRANSFER&q=${encodeURIComponent("trans a archivada")}&limit=12`,
      );
      check(
        "una transferencia con destino archivado no se sugiere",
        (rta.body?.suggestions ?? []).length,
        0,
      );
    }

    /* ── 7b. TRANSFER: el destino nunca es la cuenta de origen ──────────── */
    section("7b · TRANSFER: el par origen/destino sugerido es siempre usable");
    {
      // Tres patas reales del MISMO grupo con pares distintos:
      //   Cuenta1→Cuenta2 (vieja) · Cuenta1→Cuenta3 (media) · Cuenta3→Cuenta1 (nueva)
      // Sin exclusión, el origen más frecuente (Cuenta1, 2 usos) y el destino
      // más frecuente por desempate de recencia (Cuenta1, la fila nueva) dan
      // Cuenta1→Cuenta1: una transferencia a la misma cuenta, imposible en el
      // formulario (el cliente cae al destino por defecto y pierde la precarga).
      const c3 = await prisma.account.create({
        data: { name: `${TAG} Cuenta3`, kind: "BANK" },
      });
      const desc = `${TAG} circular`;
      await mov({
        kind: "TRANSFER",
        amount: "100.00",
        date: "2027-04-01",
        description: desc,
        accountId: cuentas.c1.id,
        toAccountId: cuentas.c2.id,
      });
      await mov({
        kind: "TRANSFER",
        amount: "200.00",
        date: "2027-04-02",
        description: desc,
        accountId: cuentas.c1.id,
        toAccountId: c3.id,
      });
      await mov({
        kind: "TRANSFER",
        amount: "300.00",
        date: "2027-04-03",
        description: desc,
        accountId: c3.id,
        toAccountId: cuentas.c1.id,
      });
      const rc = await get(
        `/api/transactions/suggestions?kind=TRANSFER&q=${encodeURIComponent("t_t7r2_sug circular")}&limit=12`,
      );
      const circ = (rc.body?.suggestions ?? []).find((s) => s.description === desc);
      checkTrue("el grupo circular aparece", Boolean(circ), JSON.stringify(rc.body?.suggestions));
      check("origen = la cuenta más usada (Cuenta1)", circ?.account?.name, `${TAG} Cuenta1`);
      checkTrue(
        "el destino sugerido NUNCA es la cuenta de origen (par imposible)",
        Boolean(circ?.toAccount) && circ.toAccount.id !== circ.account.id,
        JSON.stringify(circ?.toAccount),
      );
      check(
        "descartado el par imposible gana la siguiente real (Cuenta3)",
        circ?.toAccount?.name,
        `${TAG} Cuenta3`,
      );
      check("la mediana del grupo circular es la del medio", circ?.amount, "200.00");
    }

    /* ── 8. Orden y límite efectivo ─────────────────────────────────────── */
    section("8 · Orden (match → frecuencia → recencia) y límite");
    await mov({ amount: "10.00", date: "2027-03-01", description: `${TAG} orden prefijo` });
    await mov({ amount: "10.00", date: "2027-03-01", description: `${TAG} tenencia ordinal` });
    await mov({ amount: "10.00", date: "2027-03-01", description: `${TAG} desorden` });
    // Prefijo con MAYOR frecuencia que "orden prefijo": debe ir primero.
    await mov({ amount: "10.00", date: "2027-03-01", description: `${TAG} orden repetido` });
    await mov({ amount: "10.00", date: "2027-03-02", description: `${TAG} orden repetido` });
    {
      // Primera pasada: la query con el tag completo sólo puede matchear por
      // PREFIJO (la escala "palabra" busca la query entera después de un
      // espacio). Entre dos prefijos gana el más frecuente.
      const r = await get(
        `/api/transactions/suggestions?kind=EXPENSE&q=${encodeURIComponent("t_t7r2_sug ord")}&limit=12`,
      );
      const desc = (r.body?.suggestions ?? []).map((s) => s.description);
      check(
        "prefijo frecuente antes que prefijo raro",
        JSON.stringify(desc),
        JSON.stringify([`${TAG} orden repetido`, `${TAG} orden prefijo`]),
      );
      // Segunda pasada: query corta "ord" para los TRES niveles de match.
      //   "t_t7r2_sug orden repetido"  → contiene " ord" → palabra (1), freq 2
      //   "t_t7r2_sug orden prefijo"   → palabra (1), freq 1
      //   "t_t7r2_sug tenencia ordinal"→ palabra (1), freq 1 (desempate: nombre)
      //   "t_t7r2_sug desorden"        → subcadena (0)
      const r2 = await get(
        `/api/transactions/suggestions?kind=EXPENSE&q=ord&limit=12`,
      );
      const mias = (r2.body?.suggestions ?? [])
        .map((s) => s.description)
        .filter((name) => name.startsWith(TAG));
      check(
        "palabra (frecuencia) → palabra → palabra (nombre) → subcadena",
        JSON.stringify(mias),
        JSON.stringify([
          `${TAG} orden repetido`,
          `${TAG} orden prefijo`,
          `${TAG} tenencia ordinal`,
          `${TAG} desorden`,
        ]),
      );
    }
    // Cuatro grupos que matchean "lim": el límite tiene que cortar de verdad.
    for (const i of [1, 2, 3, 4]) {
      await mov({ amount: "5.00", date: `2027-03-0${i}`, description: `${TAG} lim ${i}` });
    }
    {
      const r2 = await get(
        `/api/transactions/suggestions?kind=EXPENSE&q=${encodeURIComponent("t_t7r2_sug lim")}&limit=2`,
      );
      check("limit=2 devuelve 2 de 4", (r2.body?.suggestions ?? []).length, 2);
      const r12 = await get(
        `/api/transactions/suggestions?kind=EXPENSE&q=${encodeURIComponent("t_t7r2_sug lim")}&limit=12`,
      );
      check("limit=12 devuelve los 4", (r12.body?.suggestions ?? []).length, 4);
      const sinLimit = await get(
        `/api/transactions/suggestions?kind=EXPENSE&q=${encodeURIComponent("t_t7r2_sug lim")}`,
      );
      check("sin limit, el defecto es 6", (sinLimit.body?.suggestions ?? []).length, 4);
    }
    {
      // Ocho grupos que matchean "muchos": el defecto (6) corta.
      for (const i of [1, 2, 3, 4, 5, 6, 7, 8]) {
        await mov({ amount: "5.00", date: `2027-03-1${i}`, description: `${TAG} muchos ${i}` });
      }
      const r = await get(
        `/api/transactions/suggestions?kind=EXPENSE&q=${encodeURIComponent("t_t7r2_sug muchos")}`,
      );
      check("sin limit y 8 grupos → devuelve 6 (el defecto)", (r.body?.suggestions ?? []).length, 6);
      const vacia = await get(`/api/transactions/suggestions?kind=EXPENSE&q=%20`);
      check("q solo espacios → 200 (se trata como vacía)", vacia.status, 200);
      const todas = await get(`/api/transactions/suggestions?kind=EXPENSE`);
      check("sin q → 200", todas.status, 200);
      const itemTodas = (todas.body?.suggestions ?? [])[0];
      checkTrue(
        "sin q cada sugerencia tiene forma completa (descripción, monto, cuenta)",
        Boolean(itemTodas?.description) &&
          /^\d+\.\d{2}$/.test(String(itemTodas?.amount)) &&
          Boolean(itemTodas?.account?.id),
        JSON.stringify(itemTodas),
      );
    }

    /* ── 9. La ventana de 400 filas ─────────────────────────────────────── */
    section("9 · Ventana de 400 filas (rellenos 2035, agujas 2036/2034)");
    {
      // 400 rellenos fechados 2035-12-31 llenan la ventana completa.
      const rellenos = Array.from({ length: 400 }, (_, i) => ({
        kind: "EXPENSE",
        amount: "1.00",
        date: d("2035-12-31"),
        description: `${TAG} relleno ${String(i).padStart(3, "0")}`,
        accountId: cuentas.c1.id,
      }));
      await prisma.movement.createMany({ data: rellenos });
      // Aguja NUEVA (2036): más nueva que los 400 rellenos → entra segura.
      await mov({ amount: "7.00", date: "2036-01-05", description: `${TAG} aguja nueva` });
      // Aguja VIEJA (2034): más vieja que los 400 rellenos → fuera de la ventana.
      await mov({ amount: "7.00", date: "2034-06-01", description: `${TAG} aguja vieja` });

      const nueva = await get(
        `/api/transactions/suggestions?kind=EXPENSE&q=${encodeURIComponent("AGUJA NUEVA")}`,
      );
      check(
        "con la ventana llena, una descripción más NUEVA que los 400 aparece",
        nueva.body?.suggestions?.[0]?.description,
        `${TAG} aguja nueva`,
      );
      const vieja = await get(
        `/api/transactions/suggestions?kind=EXPENSE&q=${encodeURIComponent("aguja vieja")}`,
      );
      check(
        "una descripción más VIEJA que los 400 rellenos queda fuera (¿ventana sin tope?)",
        (vieja.body?.suggestions ?? []).length,
        0,
      );
      const relleno = await get(
        `/api/transactions/suggestions?kind=EXPENSE&q=${encodeURIComponent("relleno 399")}`,
      );
      check(
        "los rellenos de la ventana SÍ se sugieren (la ventana no está vacía)",
        relleno.body?.suggestions?.[0]?.description,
        `${TAG} relleno 399`,
      );
      const total = await prisma.movement.count({ where: { description: { startsWith: TAG } } });
      console.log(`  · filas propias vivas durante la prueba de ventana: ${total}`);
    }
  },
});
