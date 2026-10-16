import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getAccountBalances, getNetWorth } from "@/lib/balance";
import { isCalendarDate } from "@/lib/dates";
import { cleanName } from "@/lib/finance";
import { parseMoneyInput } from "@/lib/money";
import { describeDatabaseError, toAccountDTO } from "@/lib/queries";

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
 */
export async function GET(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const { searchParams } = new URL(req.url);
  const asOf = searchParams.get("asOf");
  const includeArchived = searchParams.get("includeArchived") !== "false";

  if (asOf && !isCalendarDate(asOf)) {
    return badRequest("`asOf` tiene que ser una fecha AAAA-MM-DD válida.");
  }

  const [balances, netWorth] = await Promise.all([
    getAccountBalances(prisma, { asOf: asOf ?? undefined, includeArchived }),
    getNetWorth(prisma, { asOf: asOf ?? undefined }),
  ]);

  return NextResponse.json({
    accounts: balances.map((balance) => ({
      ...toAccountDTO({
        id: balance.id,
        name: balance.name,
        kind: balance.kind,
        archived: balance.archived,
        openingBalance: balance.opening,
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
 * Body: `{ id, name?, archived? }`
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

  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return badRequest("Falta el id de la cuenta.");

  const data: { name?: string; archived?: boolean } = {};

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
