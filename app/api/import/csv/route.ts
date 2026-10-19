import { NextResponse } from "next/server";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { CSV_MAX_BYTES, CsvError } from "@/lib/csv";
import { CsvImportError, importCsv, parseCsvExpected } from "@/lib/csv-import";
import { prisma } from "@/lib/prisma";

/**
 * POST /api/import/csv
 *
 * Body: `{ text, expected: { count, income, expenses, transfers } }`.
 *
 * `expected` es el resumen que la persona vio en el preview. El servidor lo
 * compara con un recálculo antes de escribir: si el archivo o la base
 * cambiaron, responde 409 en vez de importar algo distinto de lo aprobado.
 *
 * La importación es TODO O NADA: una transacción, conciliación al centavo y
 * rollback ante cualquier diferencia (ver lib/csv-import.ts).
 */
export async function POST(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  // Segunda capa anti-CSRF: esta ruta SÍ escribe.
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

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
    return NextResponse.json({ error: "Falta el texto del CSV." }, { status: 400 });
  }
  if (text.trim() === "") {
    return NextResponse.json(
      { error: "No hay nada para importar: el CSV está vacío." },
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
    const expected = parseCsvExpected(body.expected);
    const result = await importCsv(prisma, text, expected);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof CsvError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof CsvImportError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    // Nunca un 500 sin explicación: el contrato de esta ruta es que la persona
    // sepa que NO se guardó nada y pueda reintentar.
    console.error(error);
    return NextResponse.json(
      {
        error:
          "No se pudo completar la importación. No se guardó nada. Probá de nuevo en unos segundos.",
      },
      { status: 503 },
    );
  }
}
