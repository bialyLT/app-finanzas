import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { describeCardError, payStatement } from "@/lib/card-service";
import { todayCalendar } from "@/lib/dates";
import { describeDatabaseError } from "@/lib/queries";

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * POST /api/cards/statements/pay
 *
 * Body: `{ statementId, fromAccountId, amount? }`
 *
 * Paga un resumen: crea UNA TRANSFERENCIA desde la cuenta elegida hacia la
 * tarjeta por el total del resumen, y deja el resumen enlazado a ese pago.
 *
 * `amount` es lo que SALE de la cuenta de origen y sólo se acepta cuando la
 * cuenta y la tarjeta están en monedas distintas (ahí es obligatorio: el total
 * del resumen está en la moneda de la tarjeta y no es lo que se debita del
 * banco). Con la misma moneda, mandarlo es un 400: se paga el total del
 * documento.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ NO ES UN GASTO
 * ─────────────────────────────────────────────────────────────────────────────
 * El gasto ya existe: es la compra que originó la deuda (una sola vez, al
 * comprar). Pagar el resumen mueve plata del banco a la tarjeta y baja la deuda;
 * si fuera un EXPENSE, el mismo gasto contaría dos veces y el mes del pago
 * parecería catastrófico.
 *
 * Idempotente: si el resumen ya está pago, devuelve el pago existente con
 * `created: false` en vez de duplicar la transferencia.
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
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return badRequest("El cuerpo de la petición tiene que ser un objeto JSON.");
  }

  const statementId =
    typeof body.statementId === "string" ? body.statementId.trim() : "";
  if (!statementId) return badRequest("Falta el resumen que se quiere pagar.");

  const fromAccountId =
    typeof body.fromAccountId === "string" ? body.fromAccountId.trim() : "";
  if (!fromAccountId) {
    return badRequest("Falta la cuenta desde la que se paga.");
  }

  // ── Lo que sale de la cuenta (F4.7) ───────────────────────────────────────
  //
  // Sólo la FORMA se valida acá: si corresponde o no depende de las monedas,
  // que las conoce el servicio junto con las cuentas. Un objeto, un array o un
  // booleano no son un monto y se rechazan antes de llegar a Prisma.
  let amount: string | null = null;

  if (body.amount !== undefined && body.amount !== null && body.amount !== "") {
    if (typeof body.amount !== "string" && typeof body.amount !== "number") {
      return badRequest(
        "El monto que sale de la cuenta no se entiende. Escribilo como 1234,56 o 1.234,56.",
      );
    }
    if (typeof body.amount === "number" && !Number.isFinite(body.amount)) {
      return badRequest(
        "El monto que sale de la cuenta no se entiende. Escribilo como 1234,56 o 1.234,56.",
      );
    }

    amount =
      typeof body.amount === "number"
        ? body.amount.toFixed(2)
        : body.amount;
  }

  try {
    const result = await payStatement(
      prisma,
      { statementId, fromAccountId, amount },
      { today: todayCalendar() },
    );
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    console.error(error);

    const described =
      describeCardError(error) ?? describeDatabaseError(error);
    if (described) {
      return NextResponse.json(
        { error: described.message },
        { status: described.status },
      );
    }

    return NextResponse.json(
      { error: "No se pudo pagar el resumen." },
      { status: 500 },
    );
  }
}
