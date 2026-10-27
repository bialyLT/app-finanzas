import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { calendarToDb, isCalendarDate } from "@/lib/dates";
import { movementInclude, toMovementDTO } from "@/lib/queries";
import { exportMovementsToCsv } from "@/lib/export";
import type { Prisma } from "@prisma/client";

/**
 * GET /api/export?format=csv|json&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Exporta todos los movimientos del usuario en el período indicado (o todos si no se especifican fechas).
 * No aplica tope de filas para permitir resguardo completo de los datos.
 */
export async function GET(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const { searchParams } = new URL(req.url);
  const format = (searchParams.get("format") ?? "json").toLowerCase();
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  const where: Prisma.MovementWhereInput = {};
  if (from && isCalendarDate(from)) {
    where.date = { ...(where.date as Prisma.DateTimeFilter), gte: calendarToDb(from) };
  }
  if (to && isCalendarDate(to)) {
    where.date = { ...(where.date as Prisma.DateTimeFilter), lte: calendarToDb(to) };
  }

  const rawMovements = await prisma.movement.findMany({
    where,
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    include: movementInclude,
  });

  const movements = rawMovements.map(toMovementDTO);

  if (format === "csv") {
    const csvContent = exportMovementsToCsv(movements);
    return new NextResponse(csvContent, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="movimientos.csv"',
      },
    });
  }

  return NextResponse.json(
    {
      exportedAt: new Date().toISOString(),
      count: movements.length,
      movements,
    },
    {
      headers: {
        "Content-Disposition": 'attachment; filename="movimientos.json"',
      },
    },
  );
}
