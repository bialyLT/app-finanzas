import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { calendarToDb, isCalendarDate, todayCalendar } from "@/lib/dates";
import { parseMoneyInput } from "@/lib/money";
import type { MovementsResponse } from "@/lib/finance";
import {
  MOVEMENTS_MAX_ROWS,
  cleanName,
  normalizeCategoryName,
} from "@/lib/finance";
import {
  describeDatabaseError,
  movementInclude,
  movementTotals,
  toMovementDTO,
} from "@/lib/queries";

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * GET /api/transactions?from=YYYY-MM-DD&to=YYYY-MM-DD&kind=...&accountId=...
 *
 * Devuelve `{ movements, truncated, totals }`.
 *
 * `totals` se calcula acá y no en el cliente. El motivo está en
 * `PeriodTotalsDTO` (lib/finance.ts), pero en una línea: la lista se topea y los
 * totales no pueden topearse, y sumar la lista topeada da números mal que se ven
 * perfectamente confiables.
 */
export async function GET(req: Request) {
  // Capa autoritativa de autenticación. El proxy ya filtró la request, pero la
  // DAL es la que realmente protege el dato (ver lib/auth/dal.ts).
  if (!(await requireApiSession())) return unauthorized();

  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const kind = searchParams.get("kind");
  const accountId = searchParams.get("accountId");

  // ── EL BUG B3, ARREGLADO ────────────────────────────────────────────────────
  // Antes: `new Date(from + "T00:00:00")` y `new Date(to + "T23:59:59")`.
  //
  // Ese rango se construía en hora LOCAL (Buenos Aires, UTC−3), así que el mes
  // de octubre quedaba como [01/10 03:00Z .. 31/10 23:59:59−03]. Dos problemas:
  //
  //   1. Un movimiento del 1 de noviembre a las 00:00 UTC caía DENTRO de la
  //      ventana de octubre. Todo el primer día hábil del mes se contaba en el
  //      balance del mes anterior.
  //   2. El `23:59:59` deja afuera el último segundo del día. Un movimiento
  //      cargado a las 23:59:59.5 no aparecía.
  //
  // Ahora la columna es `@db.Date` y la comparación es entre fechas de
  // calendario: `calendarToDb` ancla a medianoche UTC, que es exactamente el
  // valor que representa esa fecha. `lte` incluye el día entero porque la fecha
  // ES el día entero — no hay hora que pueda quedar afuera.
  const where: Prisma.MovementWhereInput = {
    ...(kind === "INCOME" || kind === "EXPENSE" || kind === "TRANSFER"
      ? { kind }
      : {}),
    ...(accountId ? { OR: [{ accountId }, { toAccountId: accountId }] } : {}),
    ...(from || to
      ? {
          date: {
            ...(from && isCalendarDate(from) ? { gte: calendarToDb(from) } : {}),
            ...(to && isCalendarDate(to) ? { lte: calendarToDb(to) } : {}),
          },
        }
      : {}),
  };

  // ── La lista y los totales: mismo `where`, distinto alcance ────────────────
  //
  // Las dos consultas comparten el filtro pero NO el `take`. La lista se topea
  // para poder mandarla al navegador; los totales se agregan en la BASE sobre el
  // conjunto completo, así que un mes de 5.000 movimientos da los mismos totales
  // que uno de 50.
  //
  // Ésta es la corrección de un bug real: los totales se sumaban en el cliente
  // filtrando la lista recibida, así que a partir del movimiento 501 los cuatro
  // números grandes del panel —Ingresos, Gastos, "Te quedó" y la tasa de
  // ahorro— quedaban subestimados, con el aviso de truncado abajo del pliegue.
  //
  // En paralelo porque no dependen entre sí y son dos viajes a la misma base.
  const [movements, totals] = await Promise.all([
    prisma.movement.findMany({
      where,
      include: movementInclude,
      // Desempate por `createdAt`: sin él, dos movimientos del mismo día pueden
      // salir en cualquier orden y la lista cambia entre recargas.
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: MOVEMENTS_MAX_ROWS + 1,
    }),
    movementTotals(prisma, where),
  ]);

  const truncated = movements.length > MOVEMENTS_MAX_ROWS;

  return NextResponse.json({
    movements: (truncated
      ? movements.slice(0, MOVEMENTS_MAX_ROWS)
      : movements
    ).map(toMovementDTO),
    truncated,
    totals,
  } satisfies MovementsResponse);
}

/**
 * POST /api/transactions
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UN SOLO ENDPOINT PARA LOS TRES TIPOS, Y POR QUÉ
 * ─────────────────────────────────────────────────────────────────────────────
 * Una transferencia no es un tipo de movimiento "parecido" a un gasto: es otra
 * cosa. Podría haber un `/api/transfers` aparte. Pero entonces habría dos
 * lugares donde se valida el monto, la fecha y la cuenta de origen, y con el
 * tiempo se desincronizan.
 *
 * La validación de cada tipo es distinta, pero el ingreso de datos es el mismo,
 * y las restricciones de la base son las que garantizan al final que cada tipo
 * tenga la forma correcta. Acá se valida ANTES para poder dar un mensaje claro
 * en vez de un error de Postgres.
 *
 * Body:
 *   {
 *     kind: "INCOME" | "EXPENSE" | "TRANSFER",
 *     amount: "1234,56",              // string, se interpreta en formato local
 *     date: "2026-10-15",             // fecha de calendario
 *     accountId: "...",               // origen (o destino, si es un ingreso)
 *     toAccountId: "...",             // SÓLO TRANSFER
 *     categoryName: "Comida",         // SÓLO INCOME y EXPENSE
 *     description: "..."              // opcional
 *   }
 */
export async function POST(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  // Segunda capa anti-CSRF, además de SameSite=Lax (ver lib/auth/csrf.ts).
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return badRequest("El cuerpo de la petición no es JSON válido.");
  }

  const kind = body.kind;
  if (kind !== "INCOME" && kind !== "EXPENSE" && kind !== "TRANSFER") {
    return badRequest("Tipo de movimiento inválido.");
  }

  // ── Monto ──────────────────────────────────────────────────────────────────
  // NUNCA `Number(body.amount)`. El monto se interpreta como texto decimal
  // exacto para que no arrastre el error binario de los `number` de JavaScript.
  //
  // Se tolera que llegue un `number` porque un cliente escrito a mano podría
  // mandarlo, pero se convierte con `toFixed(2)` — que fija la representación
  // antes de que el error se propague.
  const rawAmount =
    typeof body.amount === "number"
      ? body.amount.toFixed(2)
      : String(body.amount ?? "");
  const amount = parseMoneyInput(rawAmount);

  if (amount === null) {
    return badRequest(
      "El monto no se entiende. Escribilo como 1234,56 o 1.234,56.",
    );
  }
  if (amount.lessThanOrEqualTo(0)) {
    return badRequest("El monto tiene que ser mayor a cero.");
  }

  // ── Fecha ──────────────────────────────────────────────────────────────────
  // Se valida que sea una fecha de CALENDARIO real. `"2026-02-31"` no existe, y
  // `new Date` lo desbordaría silenciosamente al 3 de marzo.
  const rawDate = body.date === undefined || body.date === null || body.date === ""
    ? todayCalendar()
    : String(body.date);

  if (!isCalendarDate(rawDate)) {
    return badRequest(
      "La fecha no es válida. Se espera el formato AAAA-MM-DD con un día que exista.",
    );
  }

  const description =
    typeof body.description === "string"
      ? body.description.trim().slice(0, 200)
      : "";

  const accountId = typeof body.accountId === "string" ? body.accountId : "";
  if (!accountId) {
    return badRequest("Falta indicar la cuenta.");
  }

  // ── Validación por tipo ────────────────────────────────────────────────────
  let toAccountId: string | null = null;
  let categoryName: string | null = null;

  if (kind === "TRANSFER") {
    toAccountId =
      typeof body.toAccountId === "string" ? body.toAccountId : "";

    if (!toAccountId) {
      return badRequest(
        "Una transferencia necesita una cuenta de destino. Si no hay destino, no es una transferencia.",
      );
    }
    if (toAccountId === accountId) {
      return badRequest("La cuenta de destino tiene que ser distinta a la de origen.");
    }
    // Que una transferencia no lleve categoría no es una preferencia de la
    // interfaz: es una regla del modelo, y la base la hace cumplir con un CHECK.
    // Se rechaza acá para dar el mensaje antes del error de Postgres.
    if (body.categoryName) {
      return badRequest(
        "Una transferencia entre cuentas propias no lleva categoría: no es un gasto ni un ingreso.",
      );
    }
  } else {
    if (body.toAccountId) {
      return badRequest(
        kind === "INCOME"
          ? "Un ingreso no lleva cuenta de destino: la plata entra a la cuenta que indicaste."
          : "Un gasto no lleva cuenta de destino: la plata sale de la cuenta que indicaste.",
      );
    }

    const raw = typeof body.categoryName === "string" ? body.categoryName : "";
    categoryName = cleanName(raw);
    if (!categoryName) {
      return badRequest(
        kind === "INCOME"
          ? "Falta indicar de dónde viene el ingreso."
          : "Falta indicar en qué se gastó.",
      );
    }
  }

  try {
    const movement = await prisma.$transaction(async (tx) => {
      // ── La categoría se resuelve por nombre NORMALIZADO ────────────────────
      // Escribir "Comida" y después "comida" ahora reutiliza la misma categoría.
      // Antes creaba dos, y el gráfico de gastos partía el mismo concepto.
      let categoryId: string | null = null;

      if (categoryName) {
        const normalizedName = normalizeCategoryName(categoryName);
        const category = await tx.category.upsert({
          where: { normalizedName },
          // Si ya existe, se conserva el nombre ORIGINAL que había puesto la
          // persona: no queremos que escribir "COMIDA" una vez le cambie el
          // nombre a la categoría para siempre.
          update: {},
          create: {
            name: categoryName,
            normalizedName,
            kind: kind === "INCOME" ? "INCOME" : "EXPENSE",
          },
        });
        categoryId = category.id;
      }

      return tx.movement.create({
        data: {
          kind,
          amount: amount.toFixed(2),
          date: calendarToDb(rawDate),
          description,
          accountId,
          toAccountId,
          categoryId,
        },
        include: movementInclude,
      });
    });

    return NextResponse.json(toMovementDTO(movement), { status: 201 });
  } catch (error) {
    console.error(error);

    // Traduce las restricciones de la base a mensajes que se entienden.
    const described = describeDatabaseError(error);
    if (described) {
      return NextResponse.json(
        { error: described.message },
        { status: described.status },
      );
    }

    return NextResponse.json(
      { error: "No se pudo guardar el movimiento." },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/transactions?id=...
 *
 * Borrar un movimiento es reversible en el sentido de que se puede volver a
 * cargar; no hay motivo para prohibirlo. Lo que NO se permite es borrar una
 * cuenta con movimientos (ver PATCH /api/accounts), porque ahí se perdería el
 * historial de varios meses de una sola vez.
 */
export async function DELETE(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return badRequest("Falta el id del movimiento.");

  try {
    await prisma.movement.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    // P2025 = no existe. Devuelve 404 en vez de 500: no es un fallo del
    // servidor, es una petición sobre algo que ya no está (por ejemplo, dos
    // pestañas abiertas y el movimiento borrado en la otra).
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Ese movimiento ya no existe." },
        { status: 404 },
      );
    }

    console.error(error);
    return NextResponse.json(
      { error: "No se pudo borrar el movimiento." },
      { status: 500 },
    );
  }
}
