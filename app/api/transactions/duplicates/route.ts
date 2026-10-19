import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { isCalendarDate } from "@/lib/dates";
import { parseMoneyInput } from "@/lib/money";
import {
  describeDatabaseError,
  findDuplicateCandidates,
} from "@/lib/queries";

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * GET /api/transactions/duplicates?kind=…&accountId=…&amount=…&date=…
 *
 * Responde `{ duplicates: MovementDTO[] }` con los movimientos que comparten
 * `(kind, cuenta, monto, día)` con el que se está por cargar.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTA RUTA EXISTE Y QUÉ NO ES
 * ─────────────────────────────────────────────────────────────────────────────
 * Es una PREGUNTA, no una regla: la base acepta dos movimientos idénticos a
 * propósito (dos cafés el mismo día son dos cafés). Lo que la ruta evita es el
 * error humano más caro de una app de plata: el doble toque, el "¿ya lo había
 * anotado?", la carga duplicada que infla los gastos del mes sin que nadie la
 * vea. El formulario consulta acá antes de guardar (best-effort: si esta ruta
 * falla, se guarda igual) y —si hay candidatos— muestra "Guardar igual" /
 * "Volver". Quien conoce el contexto es la persona; la consulta sólo aporta la
 * evidencia.
 *
 * La lógica vive en `findDuplicateCandidates` (lib/queries.ts) para que los
 * tests de integración la ejerzan contra la base real sin pasar por HTTP.
 *
 * `amount` se interpreta con `parseMoneyInput` —el MISMO parser del POST—, así
 * que "12345,67", "12.345,67" y "12345.67" llegan al mismo decimal exacto. Si
 * acá hubiera un parser propio, un día divergirían y el chequeo compararía
 * contra un número que no es el que se va a guardar.
 *
 * Nombre de ruta: `duplicates` es un segmento ESTÁTICO dentro de
 * `/api/transactions/`, donde también vive `[id]`. Next resuelve primero el
 * estático, así que esta ruta gana — y ante la duda, el smoke y los flows la
 * recorren de verdad.
 */
export async function GET(req: Request) {
  // Misma capa autoritativa que el resto de la API (ver lib/auth/dal.ts). Es
  // una lectura: no exige CSRF, igual que los demás GET.
  if (!(await requireApiSession())) return unauthorized();

  const { searchParams } = new URL(req.url);
  const kind = searchParams.get("kind");
  if (kind !== "INCOME" && kind !== "EXPENSE" && kind !== "TRANSFER") {
    return badRequest("Tipo de movimiento inválido.");
  }

  const accountId = searchParams.get("accountId") ?? "";
  if (!accountId) return badRequest("Falta indicar la cuenta.");

  const rawAmount = searchParams.get("amount") ?? "";
  const amount = parseMoneyInput(rawAmount);
  if (amount === null) {
    return badRequest(
      "El monto no se entiende. Escribilo como 1234,56 o 1.234,56.",
    );
  }

  const date = searchParams.get("date") ?? "";
  if (!isCalendarDate(date)) {
    return badRequest(
      "La fecha no es válida. Se espera el formato AAAA-MM-DD con un día que exista.",
    );
  }

  try {
    const duplicates = await findDuplicateCandidates(prisma, {
      kind,
      accountId,
      amount: amount.toFixed(2),
      date,
    });

    return NextResponse.json({ duplicates });
  } catch (error) {
    console.error(error);

    // ── Un fallo acá no puede disfrazarse de "no hay duplicados" ─────────────
    // Es una lectura con efecto sobre una escritura: si el chequeo se cayera en
    // silencio, el formulario mostraría "guardado" sin haber preguntado nada.
    // El cliente igual guarda (es best-effort por contrato), pero el estado real
    // del servidor se dice con un código que no miente.
    //
    // Los errores de infraestructura se traducen a 4xx/503 —nunca a un 500
    // genérico—: es la lección de la Fase 4 ronda 2 aplicada a una ruta de
    // lectura que nació después de ella.
    const described = describeDatabaseError(error);
    if (described) {
      return NextResponse.json(
        { error: described.message },
        { status: described.status },
      );
    }

    return NextResponse.json(
      {
        error:
          "No se pudo verificar si hay movimientos repetidos. Probá de nuevo en unos segundos.",
      },
      { status: 503 },
    );
  }
}
