import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { describeCardError, getCardsView } from "@/lib/card-service";
import { todayCalendar } from "@/lib/dates";

/**
 * GET /api/cards?includeArchived=false
 *
 * Devuelve todas las tarjetas con TODO lo que la pantalla necesita:
 *
 *   · saldo y deuda (el saldo de una tarjeta ES la deuda, en negativo)
 *   · utilización del límite (`debt / creditLimit`), o `null` si no hay límite
 *   · el período en curso (proyección de lo que se facturaría hoy)
 *   · cuotas comprometidas de los próximos 6 y 12 meses
 *   · los resúmenes emitidos, del más nuevo al más viejo
 *   · los planes en cuotas con su tasa implícita
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ UN SOLO ENDPOINT Y NO CINCO
 * ─────────────────────────────────────────────────────────────────────────────
 * La pantalla de tarjetas es una foto: deuda, límite, próximo resumen y
 * compromisos se leen juntos o no se entienden. Cinco endpoints obligarían a la
 * interfaz a hacer cinco pedidos, mostrar cinco estados de carga y decidir qué
 * hacer si uno falla y los otros no. Una respuesta, una foto, un error posible.
 *
 * GET NO ESCRIBE: el período en curso es una proyección. Para emitir los
 * resúmenes de los períodos cerrados está `POST /api/cards/statements`.
 */
export async function GET(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const { searchParams } = new URL(req.url);
  const includeArchived = searchParams.get("includeArchived") !== "false";

  try {
    const view = await getCardsView(prisma, {
      today: todayCalendar(),
      includeArchived,
    });
    return NextResponse.json(view);
  } catch (error) {
    console.error(error);

    const described = describeCardError(error);
    if (described) {
      return NextResponse.json(
        { error: described.message },
        { status: described.status },
      );
    }

    return NextResponse.json(
      { error: "No se pudieron cargar las tarjetas." },
      { status: 500 },
    );
  }
}
