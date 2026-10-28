import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { todayCalendar } from "@/lib/dates";
import { prisma } from "@/lib/prisma";
import { getAiProvider } from "@/lib/voice-capture/provider";
import { parseRateLimiter } from "@/lib/voice-capture/rate-limit";
import { resolveBatch } from "@/lib/voice-capture/resolve";

export async function POST(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  // Rate limiting por IP
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const { allowed } = parseRateLimiter.check(ip);
  if (!allowed) {
    return NextResponse.json(
      {
        error:
          "Se superó el límite de interpretaciones por minuto. Esperá unos segundos y volvé a intentar.",
      },
      { status: 429 },
    );
  }

  let body: unknown;
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
      { error: "Se espera un objeto JSON en el cuerpo de la petición." },
      { status: 400 },
    );
  }

  const record = body as Record<string, unknown>;
  const rawText = record.text;

  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    return NextResponse.json(
      { error: "El texto a interpretar no puede estar vacío." },
      { status: 400 },
    );
  }

  const text = rawText.trim();
  if (text.length > 4000) {
    return NextResponse.json(
      { error: "El texto a interpretar no puede superar los 4000 caracteres." },
      { status: 400 },
    );
  }

  try {
    const [accounts, categories] = await Promise.all([
      prisma.account.findMany({
        select: { id: true, name: true, kind: true },
        orderBy: { name: "asc" },
      }),
      prisma.category.findMany({
        select: { id: true, name: true, kind: true },
        orderBy: { name: "asc" },
      }),
    ]);

    const today = todayCalendar();
    const provider = getAiProvider();

    const rawResult = await provider.parseMovements({
      text,
      today,
      accounts,
      categories,
    });

    const resolvedBatch = resolveBatch(rawResult, {
      today,
      accounts,
      categories,
    });

    return NextResponse.json(resolvedBatch, { status: 200 });
  } catch (error: unknown) {
    console.error("[api/parse] Error al interpretar movimientos:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Ocurrió un error inesperado al procesar la solicitud con IA.";

    return NextResponse.json(
      { error: message },
      { status: 500 },
    );
  }
}
