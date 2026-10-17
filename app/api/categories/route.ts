import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { cleanName, normalizeCategoryName } from "@/lib/finance";
import { describeDatabaseError, toCategoryDTO } from "@/lib/queries";

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * GET /api/categories?kind=INCOME|EXPENSE
 *
 * Sólo hay dos categorías posibles y eso es una decisión del modelo: no existe
 * una categoría de tipo TRANSFER, porque una transferencia entre bolsillos
 * propios no es ni un ingreso ni un gasto. El enum `CategoryKind` lo hace
 * imposible de expresar en el tipo, así que acá no hay que defenderse de eso.
 */
export async function GET(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const { searchParams } = new URL(req.url);
  const kind = searchParams.get("kind");

  const categories = await prisma.category.findMany({
    where: kind === "INCOME" || kind === "EXPENSE" ? { kind } : undefined,
    // Se ordena por nombre normalizado y no por el nombre crudo: sin esto, en
    // Postgres las mayúsculas se ordenan antes que las minúsculas y "Comida"
    // aparecería separada de "comida" en la lista — el mismo bug de duplicación,
    // pero en el orden.
    orderBy: { normalizedName: "asc" },
  });

  return NextResponse.json({ categories: categories.map(toCategoryDTO) });
}

/**
 * POST /api/categories
 *
 * Body: `{ name, kind }`
 *
 * Idempotente: si ya existe una categoría con el mismo nombre normalizado, la
 * devuelve con 200 en vez de crear otra con 201. Eso es lo que permite que el
 * formulario mande el nombre que el usuario escribió sin tener que consultar
 * antes si existe.
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
  // `null` es JSON válido pero no es un objeto: sin este chequeo, `body.kind`
  // explotaba con un TypeError fuera del try de arriba y la respuesta era un
  // 500 sin explicación. Un cuerpo rechazable es un 400, no un error del server.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return badRequest("El cuerpo de la petición tiene que ser un objeto JSON.");
  }

  const kind = body.kind;
  if (kind !== "INCOME" && kind !== "EXPENSE") {
    return badRequest("El tipo de categoría tiene que ser INCOME o EXPENSE.");
  }

  const name = cleanName(typeof body.name === "string" ? body.name : "");
  if (!name) return badRequest("La categoría necesita un nombre.");
  if (name.length > 40) {
    return badRequest("El nombre de la categoría no puede superar los 40 caracteres.");
  }

  const normalizedName = normalizeCategoryName(name);

  try {
    // Primero se averigua si ya existía, para poder distinguir 200 de 201.
    //
    // ─────────────────────────────────────────────────────────────────────────
    // POR QUÉ NO SE COMPARAN `createdAt` CON `updatedAt`
    // ─────────────────────────────────────────────────────────────────────────
    // La primera versión de esta ruta hacía el upsert y deducía si la categoría
    // era nueva comparando sus dos timestamps. Es una heurística que "casi
    // siempre" funciona y falla en el peor momento: con `@updatedAt`, un upsert
    // que ACTUALIZA toca `updatedAt`, así que una categoría vieja recién
    // actualizada se reportaba como recién creada. Y el día que Prisma escriba
    // los dos campos con la misma marca de tiempo, una categoría nueva se
    // reportaría como existente.
    //
    // La consulta extra es un precio chico por un resultado que no miente.
    // ─────────────────────────────────────────────────────────────────────────
    const existing = await prisma.category.findUnique({
      where: { normalizedName },
      select: { id: true },
    });

    // Upsert igual, y no `create`: entre la consulta de arriba y esta escritura
    // hay una ventana en la que otra petición puede crear la misma categoría.
    // El upsert resuelve esa carrera; el `existing` sólo decide el código HTTP.
    const category = await prisma.category.upsert({
      where: { normalizedName },
      update: {},
      create: { name, normalizedName, kind },
    });

    return NextResponse.json(toCategoryDTO(category), {
      status: existing ? 200 : 201,
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
      { error: "No se pudo crear la categoría." },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/categories?id=...
 *
 * La relación con `Movement` es `onDelete: SetNull`, así que borrar una
 * categoría NO borra los movimientos: les queda la categoría vacía. El gasto
 * existió aunque ya no te interese cómo lo agrupaste — el monto, la fecha y la
 * cuenta siguen ahí y el patrimonio sigue cerrando.
 *
 * Aun así, se avisa cuántos movimientos van a quedar sin categoría, para que
 * borrar sea una decisión informada y no una sorpresa.
 */
export async function DELETE(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return badRequest("Falta el id de la categoría.");

  try {
    // ────────────────────────────────────────────────────────────────────────
    // LAS REGLAS DE RECURRENCIA BLOQUEAN EL BORRADO, Y SE AVISA ANTES
    // ────────────────────────────────────────────────────────────────────────
    // `RecurrenceRule.categoryId` es `ON DELETE SET NULL`, pero una regla de
    // INCOME/EXPENSE SIN categoría viola su CHECK (`recurrence_shape_by_kind`):
    // Postgres aborta el borrado entero con un error de integridad que, sin este
    // chequeo, salía como un 500 genérico que no decía nada.
    //
    // Archivar la regla NO alcanza (el FK no mira el status): la salida real es
    // cambiarle la categoría a la regla, o borrarla si todavía no generó nada.
    const reglasQueLaUsan = await prisma.recurrenceRule.count({
      where: { categoryId: id },
    });
    if (reglasQueLaUsan > 0) {
      return NextResponse.json(
        {
          error:
            reglasQueLaUsan === 1
              ? "Esa categoría la usa una regla de recurrencia. Cambiale la categoría a esa regla (o borrala, si todavía no generó nada) antes de borrar la categoría."
              : `Esa categoría la usan ${reglasQueLaUsan} reglas de recurrencia. Cambiales la categoría (o borralas, si todavía no generaron nada) antes de borrar la categoría.`,
        },
        { status: 409 },
      );
    }

    const affected = await prisma.movement.count({ where: { categoryId: id } });
    await prisma.category.delete({ where: { id } });

    return NextResponse.json({ deleted: true, movementsAffected: affected });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Esa categoría no existe." },
        { status: 404 },
      );
    }

    // Red de seguridad: si una regla se creó entre el chequeo de arriba y el
    // borrado, el error sigue siendo el mismo conflicto de dominio y merece la
    // misma respuesta (409 explicativo), no un 500.
    if (
      typeof error === "object" &&
      error !== null &&
      String((error as { message?: unknown }).message ?? "").includes(
        "recurrence_shape_by_kind",
      )
    ) {
      return NextResponse.json(
        {
          error:
            "Esa categoría la usa una regla de recurrencia. Cambiale la categoría a esa regla (o borrala, si todavía no generó nada) antes de borrar la categoría.",
        },
        { status: 409 },
      );
    }

    console.error(error);
    return NextResponse.json(
      { error: "No se pudo borrar la categoría." },
      { status: 500 },
    );
  }
}
