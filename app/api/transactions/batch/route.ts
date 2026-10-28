import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { prisma } from "@/lib/prisma";
import {
  saveMovementBatch,
  type BatchSaveMovementInput,
} from "@/lib/voice-capture/batch-service";

export async function POST(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "El cuerpo de la petición no es JSON válido." },
      { status: 400 },
    );
  }

  if (typeof body !== "object" || body === null || !("movements" in body)) {
    return NextResponse.json(
      { error: "Se espera un objeto con la propiedad 'movements'." },
      { status: 400 },
    );
  }

  const { movements } = body as { movements: unknown };
  if (!Array.isArray(movements) || movements.length === 0) {
    return NextResponse.json(
      { error: "La lista de movimientos no puede estar vacía." },
      { status: 400 },
    );
  }

  try {
    const result = await saveMovementBatch(
      prisma,
      movements as BatchSaveMovementInput[],
    );
    return NextResponse.json(result, { status: 201 });
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Error inesperado al guardar el lote de movimientos.";

    return NextResponse.json({ error: message }, { status: 400 });
  }
}
