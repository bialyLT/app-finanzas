import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getAccountBalances, getNetWorth } from "@/lib/balance";
import { isCalendarDate, todayCalendar } from "@/lib/dates";
import { cleanName } from "@/lib/finance";
import { parseMoneyInput } from "@/lib/money";
import {
  describeDatabaseError,
  getNetWorthSeries,
  toAccountDTO,
} from "@/lib/queries";

const ACCOUNT_KINDS = ["CASH", "BANK", "CREDIT_CARD", "LOAN"] as const;
type AccountKind = (typeof ACCOUNT_KINDS)[number];

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function isAccountKind(value: unknown): value is AccountKind {
  return (
    typeof value === "string" &&
    (ACCOUNT_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Interpreta un "día del mes" de la tarjeta (1..31).
 *
 * Devuelve `null` si no vino (vacío, `null` o `undefined`), o la cadena
 * `"invalid"` si vino algo que no es un entero en rango. Tres estados y no dos
 * porque "no lo mandaron" y "lo mandaron mal" no son el mismo caso: el primero
 * se ignora, el segundo es un 400 con mensaje.
 */
function parseDayOfMonth(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 31) return "invalid";
  return parsed;
}

/**
 * GET /api/accounts
 *
 * Devuelve las cuentas con su saldo calculado y el patrimonio neto.
 *
 * El saldo NO se guarda como columna: se calcula a partir de los movimientos.
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ EL SALDO NO ES UNA COLUMNA
 * ─────────────────────────────────────────────────────────────────────────────
 * Guardar el saldo es la optimización obvia (evita sumar en cada consulta) y es
 * la fuente de bugs más clásica de cualquier sistema con movimientos: apenas hay
 * dos caminos que escriben, los saldos guardados y la suma real de los
 * movimientos empiezan a divergir. Y no fallan ruidosamente: el saldo se ve
 * perfectamente creíble mientras está mal.
 *
 * La cuenta correcta importa más que la performance cuando hay plata de por
 * medio. Si algún día hace falta velocidad, la respuesta es una vista
 * materializada o una caché con invalidación explícita — no una columna que se
 * actualiza a mano en cada endpoint.
 *
 * `asOf` permite pedir el saldo a una fecha pasada:
 *     GET /api/accounts?asOf=2026-09-30
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `netWorthSeries`: LA EVOLUCIÓN DEL PATRIMONIO
 * ─────────────────────────────────────────────────────────────────────────────
 * La respuesta incluye la foto al cierre de los últimos 12 meses calendario
 * (ver `getNetWorthSeries`). `asOf` gobierna las TRES vistas a la vez —saldos,
 * patrimonio y serie—: con `asOf`, la serie termina en el mes de esa fecha y la
 * última foto se corta ese día. Así no hay dos "hoy" distintos dentro de la
 * misma respuesta, que es la clase de detalle que después confunde a un test o
 * a una pantalla sin que nadie entienda por qué.
 *
 * Sin `asOf`, las tres vistas usan HOY (`todayCalendar()`): los saldos cortan
 * en hoy y la serie termina en el mes en curso. Antes los saldos sumaban TODO
 * —incluidos los movimientos con fecha futura— mientras la serie cortaba en
 * hoy: dos definiciones de "patrimonio" que coincidían sólo mientras no hubiera
 * movimientos futuros. Un gasto anual precargado para enero alcanzaba para que
 * el panel mostrara un patrimonio distinto del último punto de su propia serie.
 */
export async function GET(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const { searchParams } = new URL(req.url);
  const asOf = searchParams.get("asOf");
  const includeArchived = searchParams.get("includeArchived") !== "false";

  if (asOf && !isCalendarDate(asOf)) {
    return badRequest("`asOf` tiene que ser una fecha AAAA-MM-DD válida.");
  }

  // El "hoy" que comparten las tres vistas cuando no se pide `asOf`. Es la
  // MISMA fecha que el ancla de la serie: un solo corte para toda la respuesta.
  const cutoff = asOf ?? todayCalendar();

  const [balances, netWorth, netWorthSeries] = await Promise.all([
    getAccountBalances(prisma, { asOf: cutoff, includeArchived }),
    getNetWorth(prisma, { asOf: cutoff }),
    getNetWorthSeries(prisma, { anchor: cutoff }),
  ]);

  return NextResponse.json({
    accounts: balances.map((balance) => ({
      ...toAccountDTO({
        id: balance.id,
        name: balance.name,
        kind: balance.kind,
        archived: balance.archived,
        openingBalance: balance.opening,
        closingDay: balance.closingDay,
        dueDay: balance.dueDay,
        creditLimit: balance.creditLimit,
      }),
      /** Saldo contable. Negativo en las cuentas de deuda. */
      balance: balance.balance.toFixed(2),
      /** Deuda en positivo, SÓLO en cuentas de pasivo. `null` en el resto. */
      debt: balance.debt ? balance.debt.toFixed(2) : null,
      isLiability: balance.isLiability,
      inflow: balance.inflow.toFixed(2),
      outflow: balance.outflow.toFixed(2),
    })),
    netWorth: {
      assets: netWorth.assets.toFixed(2),
      liabilities: netWorth.liabilities.toFixed(2),
      net: netWorth.net.toFixed(2),
    },
    netWorthSeries,
  });
}

/**
 * POST /api/accounts
 *
 * Body:
 *   {
 *     name: "Banco Galicia",
 *     kind: "CASH" | "BANK" | "CREDIT_CARD" | "LOAN",
 *     openingBalance: "100000",       // opcional, por defecto "0"
 *
 *     // Sólo si kind = LOAN:
 *     principal: "500000",
 *     tnaPercent: "60",               // 60 = 60% TNA
 *     installmentCount: 12,
 *     firstInstallmentDate: "2026-11-15"   // opcional
 *
 *     // Sólo si kind = CREDIT_CARD:
 *     closingDay: 25,                 // día de cierre del resumen (1..31)
 *     dueDay: 5,                      // día de vencimiento (1..31)
 *     creditLimit: "1500000"          // opcional
 *   }
 */
export async function POST(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return badRequest("El cuerpo de la petición no es JSON válido.");
  }
  // `null` es JSON válido pero no es un objeto: sin este chequeo, `body.name`
  // explotaba con un TypeError fuera del try de arriba y la respuesta era un
  // 500 sin explicación. Un cuerpo rechazable es un 400, no un error del server.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return badRequest("El cuerpo de la petición tiene que ser un objeto JSON.");
  }

  const name = cleanName(typeof body.name === "string" ? body.name : "");
  if (!name) return badRequest("La cuenta necesita un nombre.");
  if (name.length > 60) {
    return badRequest("El nombre de la cuenta no puede superar los 60 caracteres.");
  }

  if (!isAccountKind(body.kind)) {
    return badRequest(
      "Tipo de cuenta inválido. Tiene que ser CASH, BANK, CREDIT_CARD o LOAN.",
    );
  }

  const openingBalance = parseMoneyInput(String(body.openingBalance ?? "0"));
  if (openingBalance === null) {
    return badRequest("El saldo inicial no se entiende como un monto.");
  }

  // ── Parámetros de préstamo ─────────────────────────────────────────────────
  // Se juntan SÓLO los que vinieron con valor. Un formulario que manda todos los
  // campos con "" no debería contar como "cargó parámetros de préstamo".
  const loanInput: {
    principal?: string;
    tnaPercent?: string;
    installmentCount?: number;
    firstInstallmentDate?: string;
  } = {};

  if (body.principal !== undefined && body.principal !== "" && body.principal !== null) {
    const parsed = parseMoneyInput(String(body.principal));
    if (parsed === null || parsed.lessThanOrEqualTo(0)) {
      return badRequest("El monto del préstamo tiene que ser mayor a cero.");
    }
    loanInput.principal = parsed.toFixed(2);
  }

  if (body.tnaPercent !== undefined && body.tnaPercent !== "" && body.tnaPercent !== null) {
    const parsed = parseMoneyInput(String(body.tnaPercent));
    if (parsed === null || parsed.isNegative()) {
      return badRequest("La tasa (TNA) no puede ser negativa.");
    }
    loanInput.tnaPercent = parsed.toFixed(4);
  }

  if (
    body.installmentCount !== undefined &&
    body.installmentCount !== "" &&
    body.installmentCount !== null
  ) {
    const parsed = Number(body.installmentCount);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 600) {
      return badRequest(
        "La cantidad de cuotas tiene que ser un número entero entre 1 y 600.",
      );
    }
    loanInput.installmentCount = parsed;
  }

  if (
    body.firstInstallmentDate !== undefined &&
    body.firstInstallmentDate !== "" &&
    body.firstInstallmentDate !== null
  ) {
    const parsed = String(body.firstInstallmentDate);
    if (!isCalendarDate(parsed)) {
      return badRequest("La fecha de la primera cuota no es una fecha válida.");
    }
    loanInput.firstInstallmentDate = parsed;
  }

  const hasLoanParams = Object.keys(loanInput).length > 0;

  if (body.kind === "LOAN") {
    // Se avisa TODO lo que falta de una vez en vez de campo por campo. Si falta
    // la tasa y la cantidad de cuotas, descubrirlo de a uno obliga a recargar el
    // formulario dos veces.
    const missing: string[] = [];
    if (!loanInput.principal) missing.push("el monto prestado");
    if (!loanInput.tnaPercent) missing.push("la tasa (TNA)");
    if (!loanInput.installmentCount) missing.push("la cantidad de cuotas");

    if (missing.length > 0) {
      return badRequest(
        `Un préstamo necesita ${missing.join(", ")}. Sin esos datos no se puede calcular cuánto de cada cuota es interés — y sin eso, la app vuelve a contar la cuota entera como gasto.`,
      );
    }
  } else if (hasLoanParams) {
    return badRequest(
      "Los datos de préstamo (monto, tasa, cuotas) sólo se cargan en cuentas de tipo préstamo.",
    );
  }

  // ── Parámetros de tarjeta ──────────────────────────────────────────────────
  // Cierre y vencimiento van JUNTOS o no van: un resumen sin fecha de
  // vencimiento no se puede pagar, y la base lo hace cumplir con
  // `account_card_days_range`. El límite sí puede venir solo.
  const closingDay = parseDayOfMonth(body.closingDay);
  const dueDay = parseDayOfMonth(body.dueDay);

  if (closingDay === "invalid" || dueDay === "invalid") {
    return badRequest(
      "El día de cierre y el de vencimiento tienen que ser números enteros entre 1 y 31.",
    );
  }
  if ((closingDay === null) !== (dueDay === null)) {
    return badRequest(
      "El día de cierre y el de vencimiento van juntos: cargá los dos (o ninguno de los dos).",
    );
  }

  let creditLimit: string | null = null;
  if (
    body.creditLimit !== undefined &&
    body.creditLimit !== null &&
    body.creditLimit !== ""
  ) {
    const parsed = parseMoneyInput(String(body.creditLimit));
    if (parsed === null || parsed.lessThanOrEqualTo(0)) {
      return badRequest("El límite de la tarjeta tiene que ser un monto mayor a cero.");
    }
    creditLimit = parsed.toFixed(2);
  }

  const hasCardParams = closingDay !== null || creditLimit !== null;
  if (body.kind !== "CREDIT_CARD" && hasCardParams) {
    return badRequest(
      "Los datos de tarjeta (cierre, vencimiento, límite) sólo se cargan en cuentas de tipo tarjeta de crédito.",
    );
  }

  try {
    const account = await prisma.account.create({
      data: {
        name,
        kind: body.kind,
        openingBalance: openingBalance.toFixed(2),
        principal: loanInput.principal ?? null,
        tnaPercent: loanInput.tnaPercent ?? null,
        installmentCount: loanInput.installmentCount ?? null,
        firstInstallmentDate: loanInput.firstInstallmentDate
          ? new Date(`${loanInput.firstInstallmentDate}T00:00:00.000Z`)
          : null,
        closingDay,
        dueDay,
        creditLimit,
      },
    });

    return NextResponse.json(
      {
        ...toAccountDTO(account),
        balance: account.openingBalance.toFixed(2),
        debt: null,
        isLiability: account.kind === "LOAN" || account.kind === "CREDIT_CARD",
        inflow: "0.00",
        outflow: "0.00",
      },
      { status: 201 },
    );
  } catch (error) {
    console.error(error);

    const described = describeDatabaseError(error);
    if (described) {
      return NextResponse.json(
        { error: described.message },
        { status: described.status },
      );
    }

    return NextResponse.json(
      { error: "No se pudo crear la cuenta." },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/accounts
 *
 * Body: `{ id, name?, archived?, closingDay?, dueDay?, creditLimit? }`
 *
 * Los tres campos de tarjeta se editan juntos cuando se trata de los días
 * (`closingDay` + `dueDay`, o los dos en `null` para limpiarlos) y sueltos
 * cuando es el límite (`creditLimit`, o `null` para limpiarlo).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ SE ARCHIVA EN VEZ DE BORRAR
 * ─────────────────────────────────────────────────────────────────────────────
 * Borrar una cuenta con movimientos dejaría esos movimientos sin cuenta, y con
 * ellos se iría la explicación de cómo llegaste a tu patrimonio actual. La base
 * lo impide con `onDelete: Restrict` — no por capricho, sino porque un balance
 * sin la cuenta que lo originó es un número que no se puede auditar.
 *
 * Archivar consigue lo que la persona realmente quiere (que la cuenta deje de
 * aparecer al cargar movimientos) sin destruir nada. El historial sigue sumando
 * al patrimonio, que es lo correcto: la plata que tenías en esa cuenta era tuya.
 */
export async function PATCH(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return badRequest("El cuerpo de la petición no es JSON válido.");
  }
  // `null` es JSON válido pero no es un objeto: sin este chequeo, `body.id`
  // explotaba con un TypeError fuera del try de arriba y la respuesta era un
  // 500 sin explicación. Un cuerpo rechazable es un 400, no un error del server.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return badRequest("El cuerpo de la petición tiene que ser un objeto JSON.");
  }

  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return badRequest("Falta el id de la cuenta.");

  // Los parámetros de tarjeta sólo se editan en una tarjeta. Se lee el `kind`
  // ANTES de validar los días: si la cuenta es de efectivo, el mensaje correcto
  // es "esto no es una tarjeta", no "el día 25 no existe".
  const touchesCardFields =
    body.closingDay !== undefined ||
    body.dueDay !== undefined ||
    body.creditLimit !== undefined;

  let target: { kind: string; closingDay: number | null } | null = null;

  if (touchesCardFields) {
    target = await prisma.account.findUnique({
      where: { id },
      select: { kind: true, closingDay: true },
    });
    if (!target) {
      return NextResponse.json({ error: "Esa cuenta no existe." }, { status: 404 });
    }
    if (target.kind !== "CREDIT_CARD") {
      return badRequest(
        "Los datos de tarjeta (cierre, vencimiento, límite) sólo se editan en cuentas de tipo tarjeta de crédito.",
      );
    }
  }

  const data: {
    name?: string;
    archived?: boolean;
    closingDay?: number | null;
    dueDay?: number | null;
    creditLimit?: string | null;
  } = {};

  if (body.name !== undefined) {
    const name = cleanName(typeof body.name === "string" ? body.name : "");
    if (!name) return badRequest("El nombre no puede quedar vacío.");
    if (name.length > 60) {
      return badRequest("El nombre no puede superar los 60 caracteres.");
    }
    data.name = name;
  }

  if (body.archived !== undefined) {
    if (typeof body.archived !== "boolean") {
      return badRequest("`archived` tiene que ser verdadero o falso.");
    }
    data.archived = body.archived;
  }

  if (body.closingDay !== undefined || body.dueDay !== undefined) {
    const closingDay = parseDayOfMonth(body.closingDay);
    const dueDay = parseDayOfMonth(body.dueDay);

    if (closingDay === "invalid" || dueDay === "invalid") {
      return badRequest(
        "El día de cierre y el de vencimiento tienen que ser números enteros entre 1 y 31.",
      );
    }
    if ((closingDay === null) !== (dueDay === null)) {
      return badRequest(
        "Mandá el día de cierre y el de vencimiento juntos (o los dos en null para limpiarlos).",
      );
    }

    data.closingDay = closingDay;
    data.dueDay = dueDay;
  }

  if (body.creditLimit !== undefined) {
    if (body.creditLimit === null || body.creditLimit === "") {
      data.creditLimit = null;
    } else {
      const parsed = parseMoneyInput(String(body.creditLimit));
      if (parsed === null || parsed.lessThanOrEqualTo(0)) {
        return badRequest("El límite de la tarjeta tiene que ser un monto mayor a cero.");
      }
      data.creditLimit = parsed.toFixed(2);
    }
  }

  // ── B2: cambiar el cierre con resúmenes pagados reescribe el pasado ───────
  // Los resúmenes pagados son documentos congelados; el día de cierre nuevo
  // re-reparte las compras DIRECTAS por fecha y las que ya estaban incluidas en
  // un resumen pagado volverían a facturarse en otro período: el mismo gasto
  // aparecería dos veces y el pago doble bajaría la deuda de más. Mientras no
  // haya resúmenes pagados, el cambio es seguro (los impagos se recalculan).
  // El camino de salida es explícito: borrar el pago reabre el resumen.
  if (
    target !== null &&
    data.closingDay !== undefined &&
    data.closingDay !== target.closingDay
  ) {
    const paidStatements = await prisma.statement.count({
      where: { accountId: id, paidMovementId: { not: null } },
    });

    if (paidStatements > 0) {
      return NextResponse.json(
        {
          error:
            paidStatements === 1
              ? "La tarjeta ya tiene un resumen pagado: cambiar el día de cierre volvería a facturar compras que ya están incluidas en ese resumen. Borrá primero el pago (eso reabre el resumen) y volvé a intentar."
              : `La tarjeta ya tiene ${paidStatements} resúmenes pagados: cambiar el día de cierre volvería a facturar compras que ya están incluidas en esos resúmenes. Borrá primero los pagos (eso reabre los resúmenes) y volvé a intentar.`,
        },
        { status: 409 },
      );
    }
  }

  if (Object.keys(data).length === 0) {
    return badRequest("No hay nada que actualizar.");
  }

  try {
    const account = await prisma.account.update({ where: { id }, data });
    return NextResponse.json(toAccountDTO(account));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Esa cuenta no existe." },
        { status: 404 },
      );
    }

    console.error(error);

    const described = describeDatabaseError(error);
    if (described) {
      return NextResponse.json(
        { error: described.message },
        { status: described.status },
      );
    }

    return NextResponse.json(
      { error: "No se pudo actualizar la cuenta." },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/accounts?id=...
 *
 * Sólo funciona si la cuenta NO tiene movimientos. Si los tiene, la base lo
 * rechaza (`onDelete: Restrict`) y la respuesta explica que hay que archivarla.
 *
 * Que el rechazo venga de la base y no sólo de este chequeo es deliberado: eso
 * significa que ni un script, ni `db push`, ni una consola SQL pueden borrar el
 * historial por accidente.
 */
export async function DELETE(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return badRequest("Falta el id de la cuenta.");

  try {
    await prisma.account.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Esa cuenta no existe." },
        { status: 404 },
      );
    }

    console.error(error);

    const described = describeDatabaseError(error);
    if (described) {
      return NextResponse.json(
        { error: described.message },
        { status: described.status },
      );
    }

    return NextResponse.json(
      { error: "No se pudo borrar la cuenta." },
      { status: 500 },
    );
  }
}
