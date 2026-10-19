import { NextResponse } from "next/server";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { CSV_MAX_BYTES, CsvError } from "@/lib/csv";
import { buildCsvPreview } from "@/lib/csv-import";
import { prisma } from "@/lib/prisma";

/**
 * POST /api/import/csv/preview
 *
 * Body: `{ text: "fecha,tipo,monto,cuenta\n..." }`.
 *
 * Es una lectura, pero viaja por POST porque el CSV puede ser grande y no
 * queremos meterlo en una query string. No exige `Origin`: no muta nada. La
 * autenticación sí es obligatoria.
 */
export async function POST(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  // Chequeo temprano por Content-Length: si el cuerpo ya declara ser enorme,
  // no tiene sentido parsear el JSON para después rechazarlo.
  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > CSV_MAX_BYTES + 64 * 1024) {
    return NextResponse.json(
      { error: `El CSV supera el máximo de ${Math.floor(CSV_MAX_BYTES / 1024)} KB.` },
      { status: 413 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "El cuerpo de la petición no es JSON válido." },
      { status: 400 },
    );
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json(
      { error: "El cuerpo de la petición tiene que ser un objeto JSON." },
      { status: 400 },
    );
  }

  const text = body.text;
  if (typeof text !== "string") {
    return NextResponse.json(
      { error: "Falta el texto del CSV." },
      { status: 400 },
    );
  }
  if (text.trim() === "") {
    return NextResponse.json(
      { error: "Pegá el texto del CSV antes de previsualizar." },
      { status: 400 },
    );
  }
  if (text.includes("\u0000")) {
    return NextResponse.json(
      { error: "El CSV contiene bytes NUL. Guardalo como texto UTF-8 y volvé a intentar." },
      { status: 400 },
    );
  }

  try {
    const preview = await buildCsvPreview(prisma, text);
    return NextResponse.json(preview);
  } catch (error) {
    if (error instanceof CsvError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error(error);
    return NextResponse.json(
      { error: "No se pudo leer el CSV en este momento. No se guardó nada." },
      { status: 503 },
    );
  }
}
