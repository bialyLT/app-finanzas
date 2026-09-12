import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

function normalize(name: string) {
  return name.trim().replace(/\s+/g, " ");
}

// GET /api/categories?kind=INCOME|EXPENSE
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const kind = searchParams.get("kind");
  const categories = await prisma.category.findMany({
    where: kind === "INCOME" || kind === "EXPENSE" ? { kind: kind as "INCOME" | "EXPENSE" } : undefined,
    orderBy: { name: "asc" },
  });
  return NextResponse.json(categories);
}

// POST /api/categories { name, kind } -> crea si no existe, si existe la devuelve (evita repetidos)
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const kind = body.kind;
    const name = normalize(String(body.name ?? ""));
    if ((kind !== "INCOME" && kind !== "EXPENSE") || !name) {
      return NextResponse.json({ error: "Nombre y tipo válidos requeridos" }, { status: 400 });
    }
    const existing = await prisma.category.findUnique({
      where: { name_kind: { name, kind } },
    });
    if (existing) return NextResponse.json(existing, { status: 200 });
    const created = await prisma.category.create({ data: { name, kind } });
    return NextResponse.json(created, { status: 201 });
  } catch {
    return NextResponse.json({ error: "No se pudo crear el tipo" }, { status: 500 });
  }
}
