import { NextResponse } from "next/server";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { dbToCalendar } from "@/lib/dates";
import {
  DESCRIPTION_SUGGESTION_LIMIT,
  DESCRIPTION_SUGGESTION_SCAN,
  buildDescriptionSuggestions,
} from "@/lib/description-suggestions";
import { prisma } from "@/lib/prisma";

/** Tope de resultados que un cliente puede pedir. */
const LIMIT_MAX = 12;

/**
 * GET /api/transactions/suggestions?kind=EXPENSE&q=cafe&limit=6
 *
 * Devuelve descripciones usadas antes, con la categoría, la cuenta y el monto
 * típico (mediana) del grupo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ EL TRABAJO VIVE EN EL SERVIDOR
 * ─────────────────────────────────────────────────────────────────────────────
 * El cliente no puede recibir "todo el histórico": sería lento, crecería sin
 * límite y expondría movimientos que la pantalla no está mostrando. Acá se
 * consulta una ventana acotada (`DESCRIPTION_SUGGESTION_SCAN`), se agrupa por
 * descripción normalizada y se devuelven como máximo 12 sugerencias.
 *
 * `kind` es obligatorio: la categoría y la cuenta de un gasto no sirven para
 * precargar un ingreso, y una transferencia tiene otra forma (destino, sin
 * categoría). Mezclar tipos en un mismo grupo produciría precargas imposibles.
 */
export async function GET(req: Request) {
  // La autenticación es la capa autoritativa; el proxy no alcanza.
  if (!(await requireApiSession())) return unauthorized();

  const { searchParams } = new URL(req.url);
  const kind = searchParams.get("kind");
  if (kind !== "INCOME" && kind !== "EXPENSE" && kind !== "TRANSFER") {
    return NextResponse.json(
      { error: "El tipo es obligatorio y tiene que ser INCOME, EXPENSE o TRANSFER." },
      { status: 400 },
    );
  }

  const rawQuery = searchParams.get("q") ?? "";
  if (rawQuery.length > 80) {
    return NextResponse.json(
      { error: "La búsqueda no puede superar los 80 caracteres." },
      { status: 400 },
    );
  }

  const rawLimit = searchParams.get("limit");
  const parsedLimit = rawLimit === null ? DESCRIPTION_SUGGESTION_LIMIT : Number(rawLimit);
  if (
    !Number.isInteger(parsedLimit) ||
    parsedLimit < 1 ||
    parsedLimit > LIMIT_MAX
  ) {
    return NextResponse.json(
      { error: `El límite tiene que ser un entero entre 1 y ${LIMIT_MAX}.` },
      { status: 400 },
    );
  }

  try {
    const movements = await prisma.movement.findMany({
      where: {
        kind,
        description: { not: "" },
        // Las cuentas archivadas no se pueden elegir en el formulario: una
        // sugerencia que las precargue dejaría el select en un estado inválido.
        account: { archived: false },
        ...(kind === "TRANSFER"
          ? { toAccount: { archived: false } }
          : {}),
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: DESCRIPTION_SUGGESTION_SCAN,
      select: {
        kind: true,
        amount: true,
        date: true,
        description: true,
        account: { select: { id: true, name: true, archived: true } },
        toAccount: { select: { id: true, name: true, archived: true } },
        category: { select: { id: true, name: true, kind: true } },
      },
    });

    const suggestions = buildDescriptionSuggestions(
      movements.map((movement) => ({
        kind: movement.kind,
        // String exacto: el cliente no necesita un `number` de plata.
        amount: movement.amount.toFixed(2),
        date: dbToCalendar(movement.date),
        description: movement.description,
        account: movement.account,
        toAccount: movement.toAccount,
        category: movement.category,
      })),
      rawQuery,
      parsedLimit,
    );

    return NextResponse.json({ suggestions });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "No se pudieron buscar sugerencias en este momento." },
      { status: 503 },
    );
  }
}
