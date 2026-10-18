import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { RecurrenceError, deleteMovement } from "@/lib/recurring";
import { describeDatabaseError } from "@/lib/queries";

// DELETE /api/transactions/:id
//
// Misma semántica que la colección (`DELETE /api/transactions?id=...`): pasa
// por `deleteMovement` para reabrir la ocurrencia de una regla y traduce los
// errores de integridad. Antes borraba con `prisma.movement.delete` y cualquier
// fallo se convertía en un 404 "No encontrado": el gasto protegido de un plan
// en cuotas decía no existir cuando en realidad existía y había que borrar el
// plan. Un error accionable es parte del contrato, no un detalle de la UI.
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await requireApiSession())) return unauthorized();

  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const { id } = await params;

  try {
    await deleteMovement(prisma, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof RecurrenceError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }

    console.error(error);

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
