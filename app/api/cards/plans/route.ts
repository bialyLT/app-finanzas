import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { CARD_PLAN_MAX_INSTALLMENTS } from "@/lib/cards";
import {
  createCardPlan,
  deleteCardPlan,
  describeCardError,
} from "@/lib/card-service";
import { isCalendarDate, todayCalendar } from "@/lib/dates";
import { cleanName } from "@/lib/finance";
import { parseMoneyInput } from "@/lib/money";
import { describeDatabaseError } from "@/lib/queries";

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * POST /api/cards/plans
 *
 * Body:
 *   {
 *     cardId: "clx...",
 *     label: "Heladera",
 *     totalAmount: "1200000",
 *     installments: 12,
 *     categoryName: "Tecnología",
 *     purchaseDate: "2026-10-17",   // opcional, por defecto hoy
 *     cashPrice: "1080000"          // opcional: precio de contado
 *   }
 *
 * Registra la compra como UN GASTO por el total (la deuda nace completa) y
 * reparte las cuotas entre los resúmenes según el día de cierre de la tarjeta.
 * La respuesta incluye la tasa implícita cuando hay precio de contado: "12
 * cuotas sin interés" con descuento al contado tiene un costo escondido, y la
 * app lo dice con un número en vez de repetir el cartel.
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

  const cardId = typeof body.cardId === "string" ? body.cardId.trim() : "";
  if (!cardId) return badRequest("Falta la tarjeta de la compra.");

  const label = cleanName(typeof body.label === "string" ? body.label : "");
  if (!label) return badRequest("La compra necesita una descripción.");
  if (label.length > 200) {
    return badRequest("La descripción no puede superar los 200 caracteres.");
  }

  const categoryName = cleanName(
    typeof body.categoryName === "string" ? body.categoryName : "",
  );
  if (!categoryName) {
    return badRequest(
      "La compra necesita una categoría de gasto para poder contarla en los reportes.",
    );
  }
  if (categoryName.length > 60) {
    return badRequest("La categoría no puede superar los 60 caracteres.");
  }

  const totalAmount = parseMoneyInput(String(body.totalAmount ?? ""));
  if (totalAmount === null || totalAmount.lessThanOrEqualTo(0)) {
    return badRequest("El total de la compra tiene que ser un monto mayor a cero.");
  }

  const installments = Number(body.installments);
  if (
    !Number.isInteger(installments) ||
    installments < 1 ||
    installments > CARD_PLAN_MAX_INSTALLMENTS
  ) {
    return badRequest(
      `La cantidad de cuotas tiene que ser un número entero entre 1 y ${CARD_PLAN_MAX_INSTALLMENTS}.`,
    );
  }

  let purchaseDate: string | undefined;
  if (
    body.purchaseDate !== undefined &&
    body.purchaseDate !== null &&
    body.purchaseDate !== ""
  ) {
    const parsed = String(body.purchaseDate);
    if (!isCalendarDate(parsed)) {
      return badRequest("La fecha de la compra no es una fecha válida.");
    }
    purchaseDate = parsed;
  }

  let cashPrice: string | null = null;
  if (
    body.cashPrice !== undefined &&
    body.cashPrice !== null &&
    body.cashPrice !== ""
  ) {
    const parsed = parseMoneyInput(String(body.cashPrice));
    if (parsed === null || parsed.lessThanOrEqualTo(0)) {
      return badRequest(
        "El precio de contado tiene que ser un monto mayor a cero (o no mandarse).",
      );
    }
    cashPrice = parsed.toFixed(2);
  }

  try {
    const plan = await createCardPlan(
      prisma,
      {
        cardId,
        label,
        totalAmount: totalAmount.toFixed(2),
        installments,
        purchaseDate,
        cashPrice,
        categoryName,
      },
      { today: todayCalendar() },
    );

    return NextResponse.json({ plan }, { status: 201 });
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
      { error: "No se pudo registrar la compra en cuotas." },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/cards/plans?id=...
 *
 * Deshace una compra en cuotas: borra el plan, sus cuotas y el gasto.
 * Rechaza (409) si ya hay un resumen pagado que facturó alguna de sus cuotas:
 * el pasado no se reescribe.
 */
export async function DELETE(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return badRequest("Falta el id del plan en cuotas.");

  try {
    await deleteCardPlan(prisma, id);
    return new NextResponse(null, { status: 204 });
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
      { error: "No se pudo borrar el plan en cuotas." },
      { status: 500 },
    );
  }
}
