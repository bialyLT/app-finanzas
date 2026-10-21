import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { assertSameOrigin } from "@/lib/auth/csrf";
import {
  CategoryKindError,
  categoryKindConflicts,
  categoryKindMessage,
} from "@/lib/category-kind";
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
  periodTotals,
  toMovementDTO,
} from "@/lib/queries";
import { touchFavorite } from "@/lib/favorites";
import { RecurrenceError, deleteMovement } from "@/lib/recurring";

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
    // Los totales del PERÍODO: los movimientos más la plata declarada como
    // ingreso de ese mes (la banderita de las cuentas). `periodTotals` resuelve
    // las dos fuentes en un solo lugar, así que ningún cliente puede olvidarse
    // de la segunda.
    periodTotals(prisma, where, {
      from: from && isCalendarDate(from) ? from : null,
      to: to && isCalendarDate(to) ? to : null,
    }),
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
 *     categoryName: "Comida",         // OPCIONAL en INCOME y EXPENSE; prohibida en TRANSFER
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
  // `null` es JSON válido pero no es un objeto: sin este chequeo, `body.kind`
  // explotaba con un TypeError fuera del try de arriba y la respuesta era un
  // 500 sin explicación. Un cuerpo rechazable es un 400, no un error del server.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return badRequest("El cuerpo de la petición tiene que ser un objeto JSON.");
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

  // `favoriteId` es opcional y sólo marca `lastUsedAt`: no cambia el
  // movimiento. Si la plantilla se borró en otra pestaña, `updateMany` no
  // falla y el movimiento se guarda igual (la historia no depende de la
  // plantilla).
  if (
    body.favoriteId !== undefined &&
    body.favoriteId !== null &&
    typeof body.favoriteId !== "string"
  ) {
    return badRequest("El id de la plantilla, si viene, tiene que ser texto.");
  }
  const favoriteId =
    typeof body.favoriteId === "string" ? body.favoriteId.trim() : "";

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

    // ── La categoría es OPCIONAL (Fase 7) ──────────────────────────────────
    //
    // Antes era obligatoria y este era el campo que hacía lenta la carga más
    // frecuente: registrar la compra del kiosco exigía inventar una categoría
    // primero. Un movimiento sin clasificar es un dato válido —los reportes lo
    // agrupan bajo "Sin categoría"—, así que un nombre ausente o vacío ya no es
    // un error.
    //
    // Lo que SÍ sigue siendo un error es mandar algo que no sea texto: un
    // número o un objeto acá es un cliente roto, y un 400 que lo dice es mejor
    // que guardar un movimiento sin la categoría que el cliente creía mandar.
    if (
      body.categoryName !== undefined &&
      body.categoryName !== null &&
      typeof body.categoryName !== "string"
    ) {
      return badRequest("La categoría, si viene, tiene que ser un texto.");
    }

    const raw = typeof body.categoryName === "string" ? body.categoryName : "";
    // `cleanName("   ")` da "" — y "" en un campo opcional significa "sin
    // categoría": se normaliza a `null` acá, en el borde, para que el resto del
    // camino no tenga que distinguir "vacío" de "ausente".
    categoryName = cleanName(raw) || null;
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

        // ── EL TIPO DE LA CATEGORÍA Y EL DEL MOVIMIENTO TIENEN QUE SER EL MISMO ──
        //
        // El `upsert` de arriba conserva el tipo de la categoría que ya existía
        // (`update: {}`): si "Alquiler" es un Gasto y el movimiento es un
        // Ingreso, el movimiento queda clasificado con una categoría del otro
        // tipo — un dato que se contradice a sí mismo.
        //
        // La base lo rechaza con el trigger `movement_category_kind_check` (por
        // eso el error nunca es un 500), pero acá se corta antes, con un
        // mensaje que dice qué se pidió y qué hacer.
        if (categoryKindConflicts(kind, category.kind)) {
          throw new CategoryKindError(
            400,
            categoryKindMessage(category.name, kind, category.kind),
          );
        }

        categoryId = category.id;
      }

      const created = await tx.movement.create({
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

      // Dentro de la misma transacción: si el movimiento no se guarda, la
      // plantilla tampoco se marca como usada.
      if (favoriteId) await touchFavorite(tx, favoriteId);

      return created;
    });

    return NextResponse.json(toMovementDTO(movement), { status: 201 });
  } catch (error) {
    // El invariante de la categoría: un movimiento cuyo tipo contradice el de
    // su categoría. Es un error de DOMINIO (la petición), no del servidor: 400
    // con el mensaje que dice qué hacer.
    if (error instanceof CategoryKindError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }

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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SI EL MOVIMIENTO VINO DE UNA REGLA, LA OCURRENCIA SE REABRE
 * ─────────────────────────────────────────────────────────────────────────────
 * El borrado pasa por `deleteMovement` (lib/recurring.ts), que en la misma
 * transacción devuelve la ocurrencia a PENDING antes de borrar el movimiento.
 * Podría parecer que el `SetNull` del FK alcanza, pero no: la ocurrencia
 * quedaría en POSTED sin movimiento, y el CHECK `occurrence_shape_by_status`
 * exige que una POSTED TENGA uno — el delete fallaría con un error de
 * integridad que no explica nada.
 *
 * Consecuencia deliberada: si la regla es AUTO, la ocurrencia reabierta NO se
 * re-postea sola — queda esperando en la bandeja (decisión D5, documentada en
 * `lib/recurring.ts`). Borrar el movimiento significa "esto no pasó";
 * recrearlo solos en la próxima corrida sería pelearse con la persona (la plata
 * "reaparecería" después de borrarla). Para que la promesa deje de regir, se
 * pausa o se archiva la regla.
 */
export async function DELETE(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return badRequest("Falta el id del movimiento.");

  try {
    await deleteMovement(prisma, id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    // El 404 llega del servicio: no es un fallo del servidor, es una petición
    // sobre algo que ya no está (por ejemplo, dos pestañas abiertas y el
    // movimiento borrado en la otra).
    if (error instanceof RecurrenceError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }

    console.error(error);

    // Un movimiento también puede ser intocable por una relación que la fase de
    // tarjetas agregó: el gasto de una compra en cuotas (`CardPlan_movementId_fkey`,
    // Restrict). Sin esta traducción, ese caso salía como 500 genérico y la
    // persona no tenía forma de saber que había que borrar el plan.
    const described = describeDatabaseError(error);
    if (described) {
      return NextResponse.json(
        { error: described.message },
        { status: described.status },
      );
    }

    return NextResponse.json(
      { error: "No se pudo borrar el movimiento." },
      { status: 500 },
    );
  }
}
