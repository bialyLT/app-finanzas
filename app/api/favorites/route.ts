import { NextResponse } from "next/server";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { assertSameOrigin } from "@/lib/auth/csrf";
import {
  FAVORITES_MAX,
  FavoriteError,
  createFavorite,
  deleteFavorite,
  listFavorites,
  parseFavoriteInput,
} from "@/lib/favorites";
import type { FavoritesResponse } from "@/lib/finance";
import { prisma } from "@/lib/prisma";

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/** El único índice único de la tabla es el nombre normalizado. */
function isDuplicateName(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "P2002"
  );
}

/**
 * GET /api/favorites
 *
 * Lista las plantillas: último usado primero y, entre las nunca usadas, las
 * más nuevas. `max` viaja en la respuesta para que el cliente no tenga que
 * duplicar el tope en una constante.
 */
export async function GET() {
  if (!(await requireApiSession())) return unauthorized();

  try {
    const favorites = await listFavorites(prisma);
    return NextResponse.json({
      favorites,
      max: FAVORITES_MAX,
    } satisfies FavoritesResponse);
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "No se pudieron cargar las plantillas." },
      { status: 503 },
    );
  }
}

/**
 * POST /api/favorites
 *
 * Crea una plantilla. La validación de forma vive en `parseFavoriteInput`; la
 * de referencias (cuenta existente/no archivada, categoría del tipo correcto,
 * tope de 24) en `createFavorite`.
 *
 * No existe PATCH a propósito: editar una plantilla usada no reescribe nada,
 * así que borrar + recrear cubre el caso con una ruta menos y sin decidir qué
 * hacer con `lastUsedAt`.
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

  try {
    const input = parseFavoriteInput(body);
    const favorite = await createFavorite(prisma, input);
    return NextResponse.json(favorite, { status: 201 });
  } catch (error) {
    if (error instanceof FavoriteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (isDuplicateName(error)) {
      return NextResponse.json(
        { error: "Ya existe una plantilla con ese nombre. Elegí otro o borrá la anterior." },
        { status: 409 },
      );
    }

    console.error(error);
    return NextResponse.json(
      { error: "No se pudo guardar la plantilla." },
      { status: 503 },
    );
  }
}

/**
 * DELETE /api/favorites?id=...
 *
 * Borra la plantilla, no los movimientos que se cargaron con ella: esos son
 * historia y no dependen de que la plantilla siga existiendo.
 */
export async function DELETE(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return badRequest("Falta el id de la plantilla.");

  try {
    await deleteFavorite(prisma, id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof FavoriteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error(error);
    return NextResponse.json(
      { error: "No se pudo borrar la plantilla." },
      { status: 503 },
    );
  }
}
