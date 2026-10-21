import type { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getAccountBalances, getNetWorth } from "@/lib/balance";
import { calendarToDb, isCalendarDate, todayCalendar } from "@/lib/dates";
import { cleanName } from "@/lib/finance";
import {
  createLoanAccount,
  describeLoanError,
  LoanError,
} from "@/lib/loan-service";
import {
  isAmortizationSystem,
  type AmortizationSystem,
  type ImportedInstallmentInput,
} from "@/lib/loans";
import { money, parseMoneyInput } from "@/lib/money";
import {
  canDeclareIncome,
  parseIncomeMonth,
} from "@/lib/declared-income";
import {
  describeDatabaseError,
  getNetWorthSeries,
  toAccountDTO,
} from "@/lib/queries";

const ACCOUNT_KINDS = [
  "CASH",
  "BANK",
  "CREDIT_CARD",
  "LOAN",
  "RECEIVABLE",
] as const;
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
 * Interpreta el cronograma de un préstamo importado: la lista de cuotas tal
 * como la dictó el banco.
 *
 * Acá sólo se valida la FORMA (que sea una lista de objetos con fecha, pago e
 * interés numéricos). La COHERENCIA del cronograma —fechas crecientes, pago ≥
 * interés, Σ capital = monto— la valida `importedSchedule` en `lib/loans.ts`,
 * que es la misma función que usan los tests y la vista previa: una sola
 * definición de "cronograma importado válido".
 */
function parseImportedSchedule(
  value: unknown,
): { ok: true; items: ImportedInstallmentInput[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      error: "El cronograma importado tiene que ser una lista de cuotas.",
    };
  }
  if (value.length === 0) {
    return {
      ok: false,
      error: "El cronograma importado necesita al menos una cuota.",
    };
  }
  if (value.length > 600) {
    return {
      ok: false,
      error: "El cronograma importado no puede tener más de 600 cuotas.",
    };
  }

  const items: ImportedInstallmentInput[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, error: `La cuota ${index + 1} del cronograma importado no es un objeto.` };
    }

    const item = raw as Record<string, unknown>;
    const dueDate = typeof item.dueDate === "string" ? item.dueDate : "";
    if (!isCalendarDate(dueDate)) {
      return {
        ok: false,
        error: `La fecha de la cuota ${index + 1} del cronograma importado no es una fecha válida.`,
      };
    }

    const payment = parseMoneyInput(String(item.payment ?? ""));
    if (payment === null || payment.lessThanOrEqualTo(0)) {
      return {
        ok: false,
        error: `El pago de la cuota ${index + 1} del cronograma importado tiene que ser un monto mayor a cero.`,
      };
    }

    const interest = parseMoneyInput(String(item.interest ?? "0"));
    if (interest === null || interest.isNegative()) {
      return {
        ok: false,
        error: `El interés de la cuota ${index + 1} del cronograma importado no puede ser negativo.`,
      };
    }

    items.push({ dueDate, payment, interest });
  }

  return { ok: true, items };
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

  // La tormenta también llega a las LECTURAS: si el pool se agota, Prisma tira
  // P2024 y sin este try/catch la respuesta era un 500 que manda a revisar una
  // pantalla que está bien. El mapa P2024/P2028 → 503 con copy de reintento es
  // el mismo de las rutas de escritura (`describeDatabaseError`).
  try {
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
          amortizationSystem: balance.amortizationSystem,
          // La banderita: el mes en el que el saldo inicial cuenta como ingreso
          // (`"2026-10"`), o `null` si está apagada (el comportamiento de
          // siempre).
          openingIncomeMonth: balance.openingIncomeMonth,
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
      { error: "No se pudieron cargar las cuentas." },
      { status: 500 },
    );
  }
}

/**
 * POST /api/accounts
 *
 * Body:
 *   {
 *     name: "Banco Galicia",
 *     kind: "CASH" | "BANK" | "CREDIT_CARD" | "LOAN" | "RECEIVABLE",
 *     openingBalance: "100000",       // opcional, por defecto "0"
 *
 *     // Sólo si kind = LOAN (debés) o RECEIVABLE (te deben):
 *     principal: "500000",
 *     tnaPercent: "60",               // 60 = 60% TNA (opcional en IMPORTED)
 *     installmentCount: 12,
 *     firstInstallmentDate: "2026-11-15",   // obligatoria (arma el cronograma)
 *     amortizationSystem: "FRENCH",   // opcional; por defecto FRENCH
 *     imported: [                     // sólo con amortizationSystem IMPORTED
 *       { dueDate: "2026-11-15", payment: "56412.71", interest: "25000.00" }
 *     ]
 *
 *     // Sólo si kind = CREDIT_CARD:
 *     closingDay: 25,                 // día de cierre del resumen (1..31)
 *     dueDay: 5,                      // día de vencimiento (1..31)
 *     creditLimit: "1500000"          // opcional
 *   }
 *
 * Un préstamo (LOAN o RECEIVABLE) nace CON su cronograma materializado: la
 * cuenta y sus cuotas se escriben en una sola transacción (ver `createLoanAccount`)
 * o no se escribe nada.
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
      "Tipo de cuenta inválido. Tiene que ser CASH, BANK, CREDIT_CARD, LOAN o RECEIVABLE.",
    );
  }
  const kind: AccountKind = body.kind;

  const openingBalance = parseMoneyInput(String(body.openingBalance ?? "0"));
  if (openingBalance === null) {
    return badRequest("El saldo inicial no se entiende como un monto.");
  }

  // ── Parámetros de préstamo (LOAN y RECEIVABLE) ─────────────────────────────
  // Se juntan SÓLO los que vinieron con valor. Un formulario que manda todos los
  // campos con "" no debería contar como "cargó parámetros de préstamo".
  const isLoanKind = kind === "LOAN" || kind === "RECEIVABLE";

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

  // ── El sistema de amortización y el cronograma importado ───────────────────
  // El sistema es OPCIONAL (ausente = FRENCH, el de siempre): así el flujo que
  // no manda el campo sigue funcionando igual. Mandarlo con un valor que no
  // existe SÍ es un 400: adivinar el sistema sería elegir las cuotas por la
  // persona.
  const rawSystem = body.amortizationSystem;
  const systemProvided =
    rawSystem !== undefined && rawSystem !== null && rawSystem !== "";
  if (systemProvided && !isAmortizationSystem(rawSystem)) {
    return badRequest(
      "El sistema de amortización no es válido. Tiene que ser FRENCH, GERMAN, AMERICAN, INTEREST_ONLY o IMPORTED.",
    );
  }
  const system: AmortizationSystem = isAmortizationSystem(rawSystem)
    ? rawSystem
    : "FRENCH";

  let imported: ImportedInstallmentInput[] | null = null;
  if (body.imported !== undefined && body.imported !== null) {
    const parsed = parseImportedSchedule(body.imported);
    if (!parsed.ok) return badRequest(parsed.error);
    imported = parsed.items;
  }

  const hasLoanParams =
    Object.keys(loanInput).length > 0 || systemProvided || imported !== null;

  if (isLoanKind) {
    // Se avisa TODO lo que falta de una vez en vez de campo por campo. Si
    // faltan dos datos, descubrirlo de a uno obliga a recargar el formulario
    // dos veces.
    const missing: string[] = [];
    if (!loanInput.principal) missing.push("el monto");

    // El importado es la excepción estructural: su cantidad de cuotas y su
    // primera fecha SE DERIVAN del cronograma del banco (el largo de la lista y
    // su primera fila). Pedírselos al cliente sería pedirle datos que el
    // servidor ignora.
    if (system === "IMPORTED") {
      if (imported === null) {
        missing.push("el cronograma del banco (las cuotas importadas)");
      }
    } else {
      if (!loanInput.installmentCount) missing.push("la cantidad de cuotas");
      if (!loanInput.firstInstallmentDate) {
        missing.push("la fecha de la primera cuota");
      }
      // La tasa es obligatoria salvo en el importado: ahí la composición la
      // dicta el cronograma del banco y no hay tasa de la que derivar nada.
      if (!loanInput.tnaPercent) missing.push("la tasa (TNA)");
    }

    if (missing.length > 0) {
      return badRequest(
        `Un préstamo necesita ${missing.join(", ")}. Sin esos datos no se puede armar el cronograma de cuotas.`,
      );
    }

    if (system !== "IMPORTED" && imported !== null) {
      return badRequest(
        "El cronograma importado sólo se usa con el sistema IMPORTED.",
      );
    }
  } else if (hasLoanParams) {
    return badRequest(
      "Los datos de préstamo (monto, tasa, cuotas, sistema) sólo se cargan en cuentas de tipo préstamo.",
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

  // ── La banderita: «esta plata cuenta como ingreso de este mes» ────────────
  //
  // El MES (no un día): la persona dice "de este mes". `null` (o ausente) es la
  // bandera apagada, que es el estado de todas las cuentas que ya existían.
  const parsedIncomeMonth = parseIncomeMonth(body.openingIncomeMonth);
  if (!parsedIncomeMonth.ok) {
    return badRequest(parsedIncomeMonth.error);
  }
  const incomeMonth = parsedIncomeMonth.month;

  if (incomeMonth !== null) {
    // Las reglas (sólo dinero, sólo saldo positivo) las valida la app para
    // poder EXPLICAR el error, y las hace cumplir un CHECK en la base: si
    // alguien escribe la columna por afuera de la app, la fila no entra.
    const canDeclare = canDeclareIncome(kind, openingBalance);
    if (!canDeclare.ok) {
      return badRequest(canDeclare.error);
    }
  }

  try {
    let account: Prisma.AccountGetPayload<object>;

    if (kind === "LOAN" || kind === "RECEIVABLE") {
      // Los chequeos de arriba ya exigieron estos datos; este guard existe para
      // que TypeScript estreche los tipos, no para fallar en la práctica.
      if (
        loanInput.principal === undefined ||
        (system === "IMPORTED"
          ? imported === null
          : loanInput.installmentCount === undefined ||
            loanInput.firstInstallmentDate === undefined ||
            loanInput.tnaPercent === undefined)
      ) {
        throw new LoanError(400, "Faltan datos del préstamo.");
      }

      // La cuenta y su cronograma, en UNA transacción: un préstamo sin cuotas
      // materializadas no puede quedar guardado ni por un instante.
      account = await createLoanAccount(prisma, {
        name,
        kind,
        openingBalance: openingBalance.toFixed(2),
        system,
        principal: money(loanInput.principal),
        tnaPercent: loanInput.tnaPercent ? money(loanInput.tnaPercent) : null,
        installmentCount: loanInput.installmentCount ?? null,
        firstInstallmentDate: loanInput.firstInstallmentDate ?? null,
        imported,
      });
    } else {
      account = await prisma.account.create({
        data: {
          name,
          kind,
          openingBalance: openingBalance.toFixed(2),
          closingDay,
          dueDay,
          creditLimit,
          // El mes declarado, en el primer día del mes (calendario). `null` es
          // la bandera apagada: no se escribe el campo y queda como estaba.
          ...(incomeMonth
            ? { openingIncomeMonth: calendarToDb(`${incomeMonth}-01`) }
            : {}),
        },
      });
    }

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

    const described = describeLoanError(error) ?? describeDatabaseError(error);
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
    openingIncomeMonth?: Date | null;
  } = {};

  // ── La banderita: activarla o apagarla desde la tarjeta de la cuenta ─────
  //
  // Las reglas (sólo dinero, sólo saldo positivo) necesitan el `kind` y el
  // saldo de la cuenta, así que hay que leerla antes de decidir. Si la cuenta
  // no existe, 404; si no puede declarar, 400 con el motivo.
  if (body.openingIncomeMonth !== undefined) {
    const parsed = parseIncomeMonth(body.openingIncomeMonth);
    if (!parsed.ok) {
      return badRequest(parsed.error);
    }

    const account = await prisma.account.findUnique({
      where: { id },
      select: { kind: true, openingBalance: true },
    });
    if (!account) {
      return NextResponse.json({ error: "Esa cuenta no existe." }, { status: 404 });
    }

    if (parsed.month !== null) {
      const canDeclare = canDeclareIncome(
        account.kind,
        money(account.openingBalance),
      );
      if (!canDeclare.ok) {
        return badRequest(canDeclare.error);
      }
    }

    // `null` apaga la bandera: la cuenta vuelve al comportamiento de siempre
    // (su saldo inicial es plata anterior, no ingreso de ningún mes).
    data.openingIncomeMonth = parsed.month
      ? calendarToDb(`${parsed.month}-01`)
      : null;
  }

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
