import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

function normalize(name: string) {
  return name.trim().replace(/\s+/g, " ");
}

// GET /api/transactions?from=YYYY-MM-DD&to=YYYY-MM-DD&kind=INCOME|EXPENSE
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const kind = searchParams.get("kind");

  const movements = await prisma.movement.findMany({
    where: {
      ...(kind === "INCOME" || kind === "EXPENSE" ? { kind } : {}),
      ...(from || to
        ? {
            date: {
              ...(from ? { gte: new Date(from + "T00:00:00") } : {}),
              ...(to ? { lte: new Date(to + "T23:59:59") } : {}),
            },
          }
        : {}),
    },
    include: { category: true },
    orderBy: { date: "desc" },
    take: 2000,
  });
  return NextResponse.json(movements);
}

// POST /api/transactions { kind, amount, date, categoryName, isFixed, description }
// categoryName: si el tipo ya existe se reutiliza, si no se crea (nunca se repiten tipos)
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const kind = body.kind;
    const amount = Number(body.amount);
    const categoryName = normalize(String(body.categoryName ?? ""));
    const isFixed = Boolean(body.isFixed);
    const description = body.description ? String(body.description).trim().slice(0, 200) : null;
    const date = body.date ? new Date(body.date) : new Date();

    if (kind !== "INCOME" && kind !== "EXPENSE") {
      return NextResponse.json({ error: "Tipo de movimiento inválido" }, { status: 400 });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: "El monto debe ser mayor a 0" }, { status: 400 });
    }
    if (!categoryName) {
      return NextResponse.json({ error: "El tipo/categoría es obligatorio" }, { status: 400 });
    }
    if (isNaN(date.getTime())) {
      return NextResponse.json({ error: "Fecha inválida" }, { status: 400 });
    }

    const category = await prisma.category.upsert({
      where: { name_kind: { name: categoryName, kind } },
      update: {},
      create: { name: categoryName, kind },
    });

    const movement = await prisma.movement.create({
      data: { kind, amount, date, isFixed, description, categoryId: category.id },
      include: { category: true },
    });
    return NextResponse.json(movement, { status: 201 });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "No se pudo guardar el movimiento" }, { status: 500 });
  }
}
