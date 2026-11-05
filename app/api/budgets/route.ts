import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { calculateBudgetStatus, parseBudgetMonth } from "@/lib/budgets";
import { parseCurrencyParam } from "@/lib/currency";
import { Prisma } from "@prisma/client";

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * GET /api/budgets?month=YYYY-MM&currency=ARS|USD
 * Devuelve todos los presupuestos asignados para el mes consultado,
 * calculando el gasto real acumulado por categoría en dicho mes y el estado (ok, warning, exceeded).
 *
 * `currency` es OPCIONAL y su default es ARS (el comportamiento histórico).
 * El presupuesto y los gastos que se comparan contra él tienen que estar en la
 * MISMA moneda: sumar pesos y dólares contra un límite en una sola moneda da
 * un porcentaje que no significa nada.
 */
export async function GET(request: Request) {
  const session = await requireApiSession();
  if (!session) return unauthorized();

  const { searchParams } = new URL(request.url);
  const monthParam = searchParams.get("month");

  if (!monthParam) {
    return badRequest("El parámetro 'month' (YYYY-MM) es requerido.");
  }

  let monthDate: Date;
  try {
    monthDate = parseBudgetMonth(monthParam);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Mes inválido";
    return badRequest(msg);
  }

  // La moneda del presupuesto y de los gastos que se le comparan. Sin
  // parámetro, ARS; un valor que no existe es 400, nunca un default silencioso
  // (mentiría sobre la unidad de los porcentajes).
  const parsedCurrency = parseCurrencyParam(searchParams.get("currency"));
  if (!parsedCurrency.ok) {
    return badRequest(parsedCurrency.error);
  }
  const currency = parsedCurrency.currency;

  // Rango del mes para sumar movimientos EXPENSE
  const year = monthDate.getUTCFullYear();
  const month = monthDate.getUTCMonth();
  const nextMonthDate = new Date(Date.UTC(year, month + 1, 1));

  // Traer presupuestos del mes y los gastos reales por categoría.
  //
  // La moneda se filtra en las DOS consultas: el presupuesto que se muestra y
  // los gastos que se le comparan. Filtrar sólo una compararía pesos con
  // dólares y el porcentaje de consumo sería un número inventado.
  const [budgets, expensesByCategory] = await Promise.all([
    prisma.budget.findMany({
      where: { month: monthDate, currency },
      include: { category: true },
      orderBy: { category: { name: "asc" } },
    }),
    prisma.movement.groupBy({
      by: ["categoryId"],
      where: {
        kind: "EXPENSE",
        date: {
          gte: monthDate,
          lt: nextMonthDate,
        },
        categoryId: { not: null },
        account: { currency },
      },
      _sum: {
        amount: true,
      },
    }),
  ]);

  const spentMap = new Map<string, number>();
  for (const exp of expensesByCategory) {
    if (exp.categoryId && exp._sum.amount) {
      spentMap.set(exp.categoryId, exp._sum.amount.toNumber());
    }
  }

  const items = budgets.map((b) => {
    const budgeted = b.amount.toNumber();
    const spent = spentMap.get(b.categoryId) ?? 0;
    const calc = calculateBudgetStatus(budgeted, spent);

    return {
      id: b.id,
      categoryId: b.categoryId,
      categoryName: b.category.name,
      month: monthParam.slice(0, 7),
      currency: b.currency,
      budgetedAmount: budgeted,
      spentAmount: spent,
      remainingAmount: calc.remaining,
      percentageUsed: calc.percentage,
      status: calc.status,
    };
  });

  return NextResponse.json({
    month: monthParam.slice(0, 7),
    currency,
    budgets: items,
  });
}

/**
 * POST /api/budgets?currency=ARS|USD
 * Crea o actualiza el presupuesto mensual de una categoría.
 * Body: { categoryId: string, month: string (YYYY-MM), amount: number }
 *
 * El `upsert` es por `(categoryId, month, currency)`: el mismo límite en pesos
 * y en dólares son dos presupuestos distintos, no una actualización del otro.
 */
export async function POST(request: Request) {
  const session = await requireApiSession();
  if (!session) return unauthorized();
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const parsedCurrency = parseCurrencyParam(
    new URL(request.url).searchParams.get("currency"),
  );
  if (!parsedCurrency.ok) {
    return badRequest(parsedCurrency.error);
  }
  const currency = parsedCurrency.currency;

  let body: { categoryId?: unknown; month?: unknown; amount?: unknown };
  try {
    body = await request.json();
  } catch {
    return badRequest("Cuerpo JSON inválido.");
  }

  const { categoryId, month, amount } = body;

  if (typeof categoryId !== "string" || !categoryId.trim()) {
    return badRequest("La categoría es requerida.");
  }

  if (typeof month !== "string" || !month.trim()) {
    return badRequest("El mes (YYYY-MM) es requerido.");
  }

  // `typeof` estricto: `Number(["100"])` es 100 y `Number(true)` es 1. Un
  // array o un booleano no son montos, y aceptarlos sería guardar un número
  // que nadie escribió. El tope es el de la columna (`DECIMAL(18,2)`): un
  // monto de 20 dígitos desborda la base y sin este chequeo salía como 500.
  if (typeof amount !== "number" && typeof amount !== "string") {
    return badRequest("El monto debe ser un número positivo.");
  }
  const numAmount = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(numAmount) || numAmount <= 0 || numAmount >= 1e16) {
    return badRequest("El monto debe ser un número positivo.");
  }

  let monthDate: Date;
  try {
    monthDate = parseBudgetMonth(month);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Mes inválido";
    return badRequest(msg);
  }

  // Verificar que la categoría sea de tipo EXPENSE
  const category = await prisma.category.findUnique({
    where: { id: categoryId },
  });

  if (!category) {
    return badRequest("La categoría no existe.");
  }

  if (category.kind !== "EXPENSE") {
    return badRequest("Sólo se pueden presupuestar categorías de gasto.");
  }

  const decimalAmount = new Prisma.Decimal(numAmount.toFixed(2));

  const budget = await prisma.budget.upsert({
    where: {
      // El presupuesto es por categoría, mes Y moneda: el mismo límite en pesos
      // y en dólares son dos presupuestos distintos.
      categoryId_month_currency: {
        categoryId,
        month: monthDate,
        currency,
      },
    },
    update: {
      amount: decimalAmount,
    },
    create: {
      categoryId,
      month: monthDate,
      amount: decimalAmount,
      currency,
    },
    include: {
      category: true,
    },
  });

  return NextResponse.json({
    id: budget.id,
    categoryId: budget.categoryId,
    categoryName: budget.category.name,
    month: month.slice(0, 7),
    currency: budget.currency,
    budgetedAmount: budget.amount.toNumber(),
  });
}

/**
 * DELETE /api/budgets?id=...
 * Elimina un presupuesto mensual.
 */
export async function DELETE(request: Request) {
  const session = await requireApiSession();
  if (!session) return unauthorized();
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return badRequest("El ID del presupuesto es requerido.");
  }

  try {
    await prisma.budget.delete({
      where: { id },
    });
    return NextResponse.json({ ok: true });
  } catch {
    return badRequest("No se encontró el presupuesto a eliminar.");
  }
}
