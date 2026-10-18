import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { isCalendarDate, todayCalendar } from "@/lib/dates";
import { cleanName } from "@/lib/finance";
import { describeLoanError, payLoanInstallment } from "@/lib/loan-service";
import { parseMoneyInput, type Money } from "@/lib/money";
import { describeDatabaseError } from "@/lib/queries";

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * POST /api/loans/pay
 *
 * Body:
 *   {
 *     accountId: "...",           // el préstamo (LOAN o RECEIVABLE)
 *     cashAccountId: "...",       // de dónde sale (I_OWE) o adónde entra (OWED_TO_ME)
 *     date: "2026-10-15",         // opcional; por defecto, hoy
 *     installmentNumber: 3,       // opcional; por defecto, la próxima impaga YA VENCIDA a `date`
 *     extraCapital: "50000",      // opcional; capital de más sobre la cuota
 *     cancel: false,              // true = cancelación anticipada (sin interés)
 *     categoryName: "Intereses"   // opcional; categoría del interés
 *   }
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL CONTRATO (lo que la ruta acepta y lo que devuelve)
 * ─────────────────────────────────────────────────────────────────────────────
 * · Paga LA PRÓXIMA cuota impaga, o cancela el préstamo entero (nunca las
 *   dos cosas juntas). `created: false` es la respuesta IDEMPOTENTE: la cuota
 *   ya estaba cubierta (doble toque, reintento) y NADA se escribió — pero la
 *   vista del préstamo viaja igual para que la pantalla muestre el estado real.
 * · Las patas son las del contrato: TRANSFER por el capital (jamás gasto ni
 *   ingreso) + EXPENSE/INCOME por el interés, que es el único costo real. Ver
 *   `payLoanInstallment` para la tabla completa por dirección.
 * · Sin `installmentNumber` se paga la próxima impaga SÓLO si ya venció
 *   (vencimiento ≤ `date`): un reintento de la misma petición nunca adelanta la
 *   cuota siguiente, responde `created: false`. Para adelantar una cuota
 *   futura, se manda su número.
 * · Un rotativo (`INTEREST_ONLY`) NO acepta pagos de cuota por esta ruta: su
 *   interés va como gasto y el capital se cancela con `cancel`. En un
 *   `AMERICAN`, las cuotas de sólo interés tampoco (mismo motivo: el interés
 *   no toca el saldo) y la única cuota que la ruta acepta es el cierre.
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
  // `null` es JSON válido pero no es un objeto: sin este chequeo, `body.x`
  // explotaba con un TypeError fuera del try de arriba y la respuesta era un
  // 500 sin explicación. Un cuerpo rechazable es un 400, no un error del server.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return badRequest("El cuerpo de la petición tiene que ser un objeto JSON.");
  }

  const accountId =
    typeof body.accountId === "string" ? body.accountId.trim() : "";
  if (!accountId) return badRequest("Falta el préstamo que se quiere pagar.");

  const cashAccountId =
    typeof body.cashAccountId === "string" ? body.cashAccountId.trim() : "";
  if (!cashAccountId) {
    return badRequest(
      "Falta la cuenta de dinero: de dónde sale el pago (o adónde entra, si te deben).",
    );
  }

  let date = todayCalendar();
  if (body.date !== undefined && body.date !== null && body.date !== "") {
    // Sólo un string: `String(["2029-01-10"])` también es una fecha válida,
    // así que la conversión laxa dejaba pagar con un array de un elemento.
    if (typeof body.date !== "string" || !isCalendarDate(body.date)) {
      return badRequest("La fecha del pago no es una fecha válida.");
    }
    date = body.date;
  }

  let installmentNumber: number | null = null;
  if (
    body.installmentNumber !== undefined &&
    body.installmentNumber !== null &&
    body.installmentNumber !== ""
  ) {
    // Estricto a propósito: `Number(true)` es 1 y `Number([2])` es 2, así que
    // la coerción laxa dejaba pagar mandando un booleano o un array en la
    // ruta de plata. Un número de cuota es un number entero o su forma
    // escrita: nada más.
    const raw = body.installmentNumber;
    const parsed =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && /^\d+$/.test(raw.trim())
          ? Number(raw.trim())
          : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < 1) {
      return badRequest("El número de cuota tiene que ser un entero desde 1.");
    }
    installmentNumber = parsed;
  }

  let extraCapital: Money | null = null;
  if (
    body.extraCapital !== undefined &&
    body.extraCapital !== null &&
    body.extraCapital !== ""
  ) {
    // Igual que la cuota: sólo string o number. `String([500])` es "500" y
    // `parseMoneyInput` lo aceptaba como monto.
    if (
      typeof body.extraCapital !== "string" &&
      typeof body.extraCapital !== "number"
    ) {
      return badRequest(
        "El capital extra tiene que ser un monto mayor o igual a cero.",
      );
    }
    const parsed = parseMoneyInput(String(body.extraCapital));
    if (parsed === null || parsed.isNegative()) {
      return badRequest(
        "El capital extra tiene que ser un monto mayor o igual a cero.",
      );
    }
    extraCapital = parsed;
  }

  let cancel = false;
  if (body.cancel !== undefined) {
    if (typeof body.cancel !== "boolean") {
      return badRequest("`cancel` tiene que ser verdadero o falso.");
    }
    cancel = body.cancel;
  }

  const rawCategory =
    typeof body.categoryName === "string" ? cleanName(body.categoryName) : "";
  const categoryName = rawCategory || null;

  try {
    const result = await payLoanInstallment(prisma, {
      accountId,
      cashAccountId,
      date,
      installmentNumber,
      extraCapital,
      cancel,
      categoryName,
    });

    // 201 cuando ESTE llamado escribió; 200 cuando fue un reintento idempotente.
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
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
      { error: "No se pudo registrar el pago del préstamo." },
      { status: 500 },
    );
  }
}
