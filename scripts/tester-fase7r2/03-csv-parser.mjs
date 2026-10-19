#!/usr/bin/env node
/**
 * 03 · PARSER CSV + PREVIEW — ataque API a `POST /api/import/csv/preview`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ VERIFICA (brief r2, ataque C: importación CSV)
 * ─────────────────────────────────────────────────────────────────────────────
 * La promesa del dev (docs/import-csv.md): se pega un CSV y el servidor dice
 * exactamente qué filas entran, cuáles no y por qué, SIN ESCRIBIR NADA.
 *
 *   1. AUTENTICACIÓN: sin cookie → 401.
 *   2. ERRORES DE ARCHIVO (400/413/422, nunca 500): sin columnas requeridas,
 *      columna duplicada, NUL, comillas sin cerrar, texto tras la comilla de
 *      cierre, comilla suelta, > 256 KB (413), 501 filas (422). 500 filas al
 *      borde se aceptan.
 *   3. FORMATO: BOM, CRLF y finales mezclados; líneas vacías antes del
 *      encabezado y entre filas; comas y comillas dobladas adentro de campos
 *      entre comillas; saltos de línea adentro de comillas (se colapsan a
 *      espacio al mostrar); alias de encabezado; columnas desconocidas CON
 *      encabezado se ignoran; celdas de más SIN encabezado invalidan la fila.
 *   4. MONTOS: "1e5" y "-5" y 3 decimales y "0" → inválidos; "1.234,56",
 *      "$ 1.500,50" → válidos; "1234.567" → 3 decimales → inválido. (El parser
 *      del CSV es MÁS estricto que el de la app: sin letras, sin signo.)
 *   5. FECHAS: "2026-02-29" no existe; "29/02/2024" sí; formatos que no se
 *      entienden; DD/MM/AAAA.
 *   6. TIPOS: ingreso/gasto/transferencia y sinónimos; "pago" no.
 *   7. REFERENCIAS: cuenta inexistente, archivada, ambigua por mayúsculas
 *      ("Banco"/"banco"), INCOME a tarjeta, TRANSFER sin destino / mismo
 *      destino / con categoría, EXPENSE con destino.
 *   8. CATEGORÍAS: nueva se PLANIFICA (categoriesToCreate) y NO se crea al
 *      previsualizar; una fila inválida no reserva nombres; categoría de otro
 *      tipo inválida; el mismo nombre nuevo como ingreso y gasto inválida la
 *      segunda.
 *   9. DUPLICADOS: contra el mismo archivo y contra la base (clave completa,
 *      descripción normalizada).
 *  10. TOTALES: Σ por tipo al centavo con 4 filas de tres tipos.
 *  11. NEUTRALIDAD: ninguna de las ~30 previsualizaciones escribe una fila.
 *
 * Datos propios (prefijo T_T7R2_CSV). Las cuentas/categorías se crean por
 * Prisma; los movimientos de la prueba de duplicados también. Nada de fechas
 * de hoy.
 */

import {
  BASE_URL,
  check,
  checkIncluye,
  checkSin500,
  checkTrue,
  login,
  post,
  runScript,
  section,
} from "./lib.mjs";

const TAG = "T_T7R2_CSV";
const BANCO = `${TAG} Banco`;
const EFECTIVO = `${TAG} Efectivo`;
const TARJETA = `${TAG} Tarjeta`;
const H = "fecha,tipo,monto,cuenta";

/**
 * Clave de deduplicación de categorías, calcada de `normalizeCategoryName`
 * (lib/finance.ts): trim, colapso de espacios, minúsculas y sin diacríticos.
 * La app resuelve por `Category.normalizedName`; sembrar otro valor hace que
 * la categoría existente no se encuentre (y la batería mentiría).
 */
const clave = (name) =>
  name
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
const H5 = `${H},cuenta_destino`;
const H6 = `${H5},categoria`;
const H7 = `${H6},descripcion`;

/** Un CSV desde líneas de datos. */
const csv = (...lineas) => [H, ...lineas].join("\n");
/** Un CSV con encabezado explícito (columnas opcionales incluidas). */
const csvH = (header, ...lineas) => [header, ...lineas].join("\n");
/** Cita una celda cuando trae coma, comilla o salto (CSV bien formado). */
const celda = (v) => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
/** Una línea canónica + columnas opcionales al final. */
const fila = (fecha, tipo, monto, cuenta = BANCO, ...extra) =>
  [fecha, tipo, monto, cuenta, ...extra].map(celda).join(",");

const preview = (text) => post("/api/import/csv/preview", { text });
const filaDe = (r, line) => (r.body?.rows ?? []).find((f) => f.line === line);
const erroresDe = (r, line) => (filaDe(r, line)?.errors ?? []).join(" | ");

runScript({
  tag: TAG,
  main: async (prisma) => {
    section("Preparación — cuentas y categorías propias");
    const banco = await prisma.account.create({
      data: { name: BANCO, kind: "BANK" },
    });
    await prisma.account.create({ data: { name: EFECTIVO, kind: "CASH" } });
    await prisma.account.create({
      data: { name: TARJETA, kind: "CREDIT_CARD", closingDay: 25, dueDay: 5 },
    });
    await prisma.account.create({
      data: { name: `${TAG} Archivada`, kind: "BANK", archived: true },
    });
    await prisma.category.create({
      data: { name: `${TAG} CatIngreso`, normalizedName: clave(`${TAG} CatIngreso`), kind: "INCOME" },
    });
    await prisma.category.create({
      data: { name: `${TAG} CatGasto`, normalizedName: clave(`${TAG} CatGasto`), kind: "EXPENSE" },
    });
    const categoriasAntes = await prisma.category.count({
      where: { name: { startsWith: TAG } },
    });

    /* ── 1. Autenticación ───────────────────────────────────────────────── */
    section("1 · Autenticación");
    {
      const sinSesion = await fetch(`${BASE_URL}/api/import/csv/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: csv(fila("2027-01-05", "gasto", "10")) }),
      });
      check("sin cookie de sesión → 401", sinSesion.status, 401);
    }
    await login();

    /* ── 2. Errores de archivo ──────────────────────────────────────────── */
    section("2 · Errores de archivo (400/413/422, nunca 500)");
    const deArchivo = [];
    {
      let r = await preview("");
      deArchivo.push(r);
      check("texto vacío → 400", r.status, 400);

      r = await preview(`${H}\n`);
      deArchivo.push(r);
      check("sólo encabezado → 200 con 0 filas", r.status, 200);
      check("totalRows 0", r.body?.totalRows, 0);
      check("rows vacío", (r.body?.rows ?? []).length, 0);

      r = await preview("fecha,tipo,cuenta\n2027-01-05,gasto,T_T7R2_CSV Banco");
      deArchivo.push(r);
      check("falta la columna monto → 400", r.status, 400);
      checkIncluye("nombra la columna que falta", r.body?.error, "monto");

      r = await preview(`${H},importe\n`);
      deArchivo.push(r);
      check("monto e importe a la vez → 400", r.status, 400);
      checkIncluye("explica la columna duplicada", r.body?.error, "más de una columna");

      r = await preview(`${H}\n${fila("2027-01-05", "gasto", "10")}\n\u0000`);
      deArchivo.push(r);
      check("NUL → 400", r.status, 400);

      r = await preview(`${H}\n2027-01-05,gasto,10,"${BANCO}`);
      deArchivo.push(r);
      check("comilla sin cerrar → 400", r.status, 400);
      checkIncluye("dice comillas sin cerrar", r.body?.error, "sin cerrar");

      r = await preview(`${H}\n2027-01-05,gasto,10,"${BANCO}"x`);
      deArchivo.push(r);
      check("texto tras la comilla de cierre → 400", r.status, 400);
      checkIncluye("dice texto después de la comilla", r.body?.error, "después de una comilla");

      r = await preview(`${H}\n2027-01-05,gasto,10,${TAG} "Banco`);
      deArchivo.push(r);
      check("comilla suelta en medio de un campo → 400", r.status, 400);
      checkIncluye("dice comillas mal ubicadas", r.body?.error, "comillas mal ubicadas");

      r = await preview(`${H}\n${fila("2027-01-05", "gasto", "10", BANCO, "x".repeat(300 * 1024))}`);
      deArchivo.push(r);
      check("> 256 KB → 413", r.status, 413);

      const quinientasUna = Array.from({ length: 501 }, (_, i) =>
        fila("2027-05-01", "gasto", `${i + 1}.00`),
      );
      r = await preview([H, ...quinientasUna].join("\n"));
      deArchivo.push(r);
      check("501 filas → 422", r.status, 422);
      checkIncluye("dice el máximo", r.body?.error, "500");

      const quinientas = Array.from({ length: 500 }, (_, i) =>
        fila("2027-05-01", "gasto", `${i + 1}.00`),
      );
      r = await preview([H, ...quinientas].join("\n"));
      deArchivo.push(r);
      check("500 filas (borde) → 200", r.status, 200);
      check("las 500 son importables", r.body?.importableRows, 500);
      // Σ 1..500 = 125250 centavos exactos.
      check("la Σ de las 500 filas cierra al centavo", r.body?.totals?.expenses, "125250.00");
      checkSin500("ningún error de archivo fue 500", deArchivo);
    }

    /* ── 3. Formato ─────────────────────────────────────────────────────── */
    section("3 · Formato (BOM, CRLF, comillas, multilínea, alias)");
    {
      let r = await preview(
        `\uFEFF${H}\r\n${fila("2027-01-05", "gasto", "10")}\r\n${fila("2027-01-06", "gasto", "11")}\n` +
          `${fila("2027-01-07", "gasto", "12")}\r\n`,
      );
      check("BOM + CRLF + LF mezclados → 200 con 3 filas", r.status, 200);
      check("las 3 importables", r.body?.importableRows, 3);

      r = await preview(`\n\n${H}\n\n${fila("2027-01-05", "gasto", "10")}\n${fila("2027-01-06", "gasto", "11")}`);
      check("líneas vacías antes del encabezado y entre filas → 200", r.status, 200);
      check("la primera fila es la línea 5 (dos vacías + encabezado + una)", filaDe(r, 5)?.status, "VALID");
      check("la segunda fila es la línea 6", filaDe(r, 6)?.status, "VALID");

      r = await preview(`,,,\n${H}\n,,,`);
      check("fila de puras comas → EMPTY (se informa, no se pierde)", filaDe(r, 3)?.status, "EMPTY");
      check("emptyRows cuenta esa fila", r.body?.emptyRows, 1);

      r = await preview(
        `${H},categoria,descripcion\n${fila("2027-01-05", "gasto", "10", BANCO, "", `Café, dijo "hola"`)}`,
      );
      check("coma y comillas dobladas dentro de comillas → 200", r.status, 200);
      check("el campo se interpreta exacto", filaDe(r, 2)?.description, `Café, dijo "hola"`);

      r = await preview(`${H},descripcion\n${fila("2027-01-05", "gasto", "10", BANCO, `linea1\nlinea2`)}\n${fila("2027-01-06", "gasto", "11")}`);
      check("salto de línea dentro de comillas → 200", r.status, 200);
      check("se muestra en una línea (espacios colapsados)", filaDe(r, 2)?.description, "linea1 linea2");
      check("la fila siguiente es la línea 4 (la multilínea ocupa 2 y 3)", filaDe(r, 4)?.status, "VALID");

      r = await preview(
        ["Fecha,Importe,Tipo,Cuenta,Cuenta Destino,Rubro,Detalle", `2027-01-05,10,transferencia,${BANCO},${EFECTIVO},,prueba`].join("\n"),
      );
      check("alias de encabezados → 200", r.status, 200);
      check("la transferencia queda importable", filaDe(r, 2)?.status, "VALID");
      check("el destino llegó por alias", filaDe(r, 2)?.toAccount, EFECTIVO);

      r = await preview([`${H},Comentario`, fila("2027-01-05", "gasto", "10", BANCO, "hola")].join("\n"));
      check("columna extra CON encabezado → se ignora (fila válida)", filaDe(r, 2)?.status, "VALID");

      r = await preview([H, fila("2027-01-05", "gasto", "10", BANCO, "sobra")].join("\n"));
      check("celda de más SIN encabezado → fila inválida", filaDe(r, 2)?.status, "INVALID");
      checkIncluye("dice que sobran columnas", erroresDe(r, 2), "más columnas");
    }

    /* ── 4. Montos ──────────────────────────────────────────────────────── */
    section("4 · Montos");
    {
      const invalidar = async (valor, needle) => {
        const r = await preview(csv(fila("2027-01-05", "gasto", valor)));
        check(`monto "${valor}" → inválido`, filaDe(r, 2)?.status, "INVALID");
        if (needle) checkIncluye(`y explica ("${needle}")`, erroresDe(r, 2), needle);
        return r;
      };
      await invalidar("1e5", "no es un número positivo");
      await invalidar("-5", "mayor a cero");
      await invalidar("1234,567", "dos decimales");
      await invalidar("1234.567", "dos decimales");
      await invalidar("0", "mayor a cero");

      const r1 = await preview(csv(fila("2027-01-05", "gasto", "1.234,56")));
      check("1.234,56 (AR completa) → válido", filaDe(r1, 2)?.status, "VALID");
      check("normaliza a 1234.56", filaDe(r1, 2)?.amount, "1234.56");
      const r2 = await preview(csv(fila("2027-01-05", "gasto", "$ 1.500,50")));
      check("$ 1.500,50 → válido", filaDe(r2, 2)?.status, "VALID");
      check("normaliza a 1500.50", filaDe(r2, 2)?.amount, "1500.50");
    }

    /* ── 5. Fechas ──────────────────────────────────────────────────────── */
    section("5 · Fechas");
    {
      let r = await preview(csv(fila("2026-02-29", "gasto", "10")));
      check("2026-02-29 (2026 no es bisiesto) → inválido", filaDe(r, 2)?.status, "INVALID");
      checkIncluye("dice que no existe en el calendario", erroresDe(r, 2), "no existe en el calendario");

      r = await preview(csv(fila("29/02/2024", "gasto", "10")));
      check("29/02/2024 (2024 sí es bisiesto) → válido", filaDe(r, 2)?.status, "VALID");
      check("normaliza a 2024-02-29", filaDe(r, 2)?.date, "2024-02-29");

      r = await preview(csv(fila("15-01-2026", "gasto", "10")));
      check("15-01-2026 → inválido (formato)", filaDe(r, 2)?.status, "INVALID");
      checkIncluye("sugiere los formatos aceptados", erroresDe(r, 2), "AAAA-MM-DD");

      r = await preview(csv(fila("31/12/2026", "gasto", "10")));
      check("31/12/2026 → válido", filaDe(r, 2)?.status, "VALID");
      check("normaliza a 2026-12-31", filaDe(r, 2)?.date, "2026-12-31");

      r = await preview(csv(fila("2030-01-01", "gasto", "10")));
      check("fecha futura → válida (es una fecha, no un error)", filaDe(r, 2)?.status, "VALID");
    }

    /* ── 6. Tipos ───────────────────────────────────────────────────────── */
    section("6 · Tipos");
    {
      let r = await preview(csv(fila("2027-01-05", "INGRESO", "10", EFECTIVO)));
      check("INGRESO → kind INCOME", filaDe(r, 2)?.kind, "INCOME");
      r = await preview(csv(fila("2027-01-05", "egreso", "10")));
      check("egreso → EXPENSE", filaDe(r, 2)?.kind, "EXPENSE");
      r = await preview(csvH(H5, fila("2027-01-05", "transferencia", "10", BANCO, EFECTIVO)));
      check("transferencia → TRANSFER", filaDe(r, 2)?.kind, "TRANSFER");
      check("y la transferencia es válida", filaDe(r, 2)?.status, "VALID");
      r = await preview(csv(fila("2027-01-05", "pago", "10")));
      check("tipo desconocido → inválido", filaDe(r, 2)?.status, "INVALID");
      checkIncluye("sugiere ingreso/gasto/transferencia", erroresDe(r, 2), "ingreso");
    }

    /* ── 7. Referencias ─────────────────────────────────────────────────── */
    section("7 · Referencias (cuentas)");
    {
      let r = await preview(csvH(H6, fila("2027-01-05", "gasto", "10", `${TAG} NoExiste`)));
      check("cuenta inexistente → inválida", filaDe(r, 2)?.status, "INVALID");
      checkIncluye("dice que no existe", erroresDe(r, 2), "no existe");

      r = await preview(csvH(H6, fila("2027-01-05", "gasto", "10", `${TAG} Archivada`)));
      check("cuenta archivada → inválida", filaDe(r, 2)?.status, "INVALID");
      checkIncluye("dice archivada", erroresDe(r, 2), "archivada");

      r = await preview(csvH(H6, fila("2027-01-05", "ingreso", "10", TARJETA)));
      check("INGRESO a tarjeta de crédito → inválido", filaDe(r, 2)?.status, "INVALID");
      checkIncluye("dice cuenta de dinero", erroresDe(r, 2), "dinero");

      r = await preview(csvH(H6, fila("2027-01-05", "transferencia", "10", BANCO)));
      check("TRANSFER sin destino → inválida", filaDe(r, 2)?.status, "INVALID");
      checkIncluye("pide cuenta_destino", erroresDe(r, 2), "cuenta_destino");

      r = await preview(csvH(H6, fila("2027-01-05", "transferencia", "10", BANCO, BANCO)));
      check("TRANSFER con destino = origen → inválida", filaDe(r, 2)?.status, "INVALID");
      checkIncluye("dice distinta", erroresDe(r, 2), "distinta");

      r = await preview(
        [H6, fila("2027-01-05", "transferencia", "10", BANCO, EFECTIVO, `${TAG} CatGasto`)].join("\n"),
      );
      check("TRANSFER con categoría → inválida", filaDe(r, 2)?.status, "INVALID");
      checkIncluye("dice que no lleva categoría", erroresDe(r, 2), "no lleva categoría");

      r = await preview(csvH(H6, fila("2027-01-05", "gasto", "10", BANCO, EFECTIVO)));
      check("EXPENSE con destino → inválido", filaDe(r, 2)?.status, "INVALID");
      checkIncluye("dice que no lleva cuenta_destino", erroresDe(r, 2), "no lleva cuenta_destino");
    }

    /* ── 8. Categorías (planificar ≠ crear) ─────────────────────────────── */
    section("8 · Categorías: planificar sin crear");
    {
      let r = await preview(
        [H6, fila("2027-01-05", "gasto", "10", BANCO, "", `${TAG} CatNueva`)].join("\n"),
      );
      check("fila con categoría nueva → 200", r.status, 200);
      check("se planifica en categoriesToCreate", JSON.stringify(r.body?.categoriesToCreate), JSON.stringify([{ name: `${TAG} CatNueva`, kind: "EXPENSE" }]));
      const enBase = await prisma.category.findFirst({ where: { name: `${TAG} CatNueva` } });
      check("pero NO se creó en la base (preview no escribe)", enBase, null);

      r = await preview(
        [H6, fila("2027-01-05", "gasto", "10", `${TAG} NoExiste`, "", `${TAG} CatFantasma`)].join("\n"),
      );
      check("fila inválida no reserva categoría", (r.body?.categoriesToCreate ?? []).length, 0);
      const fantasma = await prisma.category.findFirst({ where: { name: `${TAG} CatFantasma` } });
      check("la categoría fantasma no existe", fantasma, null);

      r = await preview(
        [H6, fila("2027-01-05", "gasto", "10", BANCO, "", `${TAG} CatIngreso`)].join("\n"),
      );
      check("categoría de ingreso en fila de gasto → inválida", filaDe(r, 2)?.status, "INVALID");
      checkIncluye("explica los tipos", erroresDe(r, 2), "es de ingreso");

      r = await preview(
        [H6, fila("2027-01-05", "gasto", "10", BANCO, "", `${TAG} CatGasto`)].join("\n"),
      );
      check("categoría existente del tipo correcto → reutiliza", filaDe(r, 2)?.status, "VALID");
      check("no planifica nada", (r.body?.categoriesToCreate ?? []).length, 0);

      r = await preview(
        [
          H6,
          fila("2027-01-05", "gasto", "10", BANCO, "", `${TAG} CatDoble`),
          fila("2027-01-06", "ingreso", "10", EFECTIVO, "", `${TAG} CatDoble`),
        ].join("\n"),
      );
      check("mismo nombre nuevo como gasto (válido)", filaDe(r, 2)?.status, "VALID");
      check("y como ingreso en otra fila → inválida", filaDe(r, 3)?.status, "INVALID");
      checkIncluye("dice que ya aparece como gasto", erroresDe(r, 3), "ya aparece como gasto");
      check("se planifica una sola categoría", (r.body?.categoriesToCreate ?? []).length, 1);
    }

    /* ── 9. Duplicados ──────────────────────────────────────────────────── */
    section("9 · Duplicados (en el archivo y contra la base)");
    {
      let r = await preview(
        csvH(H7, fila("2027-01-05", "gasto", "10", BANCO, "", "", "café doble"), fila("2027-01-05", "gasto", "10", BANCO, "", "", "café doble")),
      );
      check("la primera fila idéntica es válida", filaDe(r, 2)?.status, "VALID");
      check("la segunda idéntica → DUPLICATE (se avisa)", filaDe(r, 3)?.status, "DUPLICATE");
      check("totales cuentan sólo la importable", r.body?.totals?.count, 1);

      await prisma.movement.create({
        data: {
          kind: "EXPENSE",
          amount: "5.00",
          date: new Date("2027-04-01T00:00:00.000Z"),
          description: `${TAG} café dup`,
          accountId: banco.id,
        },
      });
      r = await preview(csvH(H7, fila("2027-04-01", "gasto", "5", BANCO, "", "", "T_T7R2_CSV CAFÉ DUP")));
      check("fila que ya está en la base (clave completa) → DUPLICATE", filaDe(r, 2)?.status, "DUPLICATE");
      check("no queda nada importable", r.body?.importableRows, 0);

      r = await preview(csvH(H7, fila("2027-01-05", "gasto", "10", BANCO, "", "", "d".repeat(201))));
      check("descripción > 200 → inválida", filaDe(r, 2)?.status, "INVALID");
      checkIncluye("dice el máximo de la descripción", erroresDe(r, 2), "supera los 200 caracteres");
      r = await preview(csvH(H6, fila("2027-01-05", "gasto", "10", BANCO, "", "c".repeat(41))));
      check("categoría > 40 → inválida", filaDe(r, 2)?.status, "INVALID");
      checkIncluye("dice el máximo de la categoría", erroresDe(r, 2), "supera los 40 caracteres");
    }

    /* ── 10. Totales al centavo ─────────────────────────────────────────── */
    section("10 · Totales por tipo (Σ al centavo)");
    {
      const r = await preview(
        [
          H5,
          fila("2027-01-05", "ingreso", "1", EFECTIVO),
          fila("2027-01-05", "gasto", "100,10"),
          fila("2027-01-06", "gasto", "0,05"),
          fila("2027-01-07", "transferencia", "5,50", BANCO, EFECTIVO),
        ].join("\n"),
      );
      // Σ: ingresos 1,00 · gastos 100,10 + 0,05 = 100,15 · transferencias 5,50
      check("4 importables, 0 inválidas", r.body?.importableRows, 4);
      check("income", r.body?.totals?.income, "1.00");
      check("expenses", r.body?.totals?.expenses, "100.15");
      check("transfers", r.body?.totals?.transfers, "5.50");
      check("count", r.body?.totals?.count, 4);
      check("encabezados tal como vinieron", JSON.stringify(r.body?.headers), JSON.stringify(["fecha", "tipo", "monto", "cuenta", "cuenta_destino"]));
    }

    /* ── 11. Neutralidad del preview ────────────────────────────────────── */
    section("11 · El preview no escribe NADA");
    {
      const conTag = await prisma.movement.count({
        where: { description: { startsWith: TAG } },
      });
      check("sólo existe el movimiento de la prueba de duplicados", conTag, 1);
      const categoriasDespues = await prisma.category.count({
        where: { name: { startsWith: TAG } },
      });
      check("ninguna categoría del archivo nació (ni CatNueva ni CatDoble)", categoriasDespues, categoriasAntes);
    }

    /* ── FIN: la ambigüedad se prueba al final (marca toda cuenta homónima) ─ */
    section("Cierre · Cuenta ambigua por mayúsculas (al final, contamina)");
    {
      await prisma.account.create({ data: { name: `${TAG} banco`, kind: "BANK" } });
      const r = await preview(csv(fila("2027-01-05", "gasto", "10", `${TAG} BANCO`)));
      check("con 'Banco' y 'banco' en la base, 'BANCO' es ambigua → inválida", filaDe(r, 2)?.status, "INVALID");
      checkIncluye("pide desambiguar", erroresDe(r, 2), "más de una cuenta");
    }
  },
});
