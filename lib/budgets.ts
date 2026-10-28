/**
 * ═════════════════════════════════════════════════════════════════════════════
 * DOMINIO DE PRESUPUESTOS (FASE 8)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Un presupuesto fija un límite objetivo de gasto mensual sobre una categoría.
 * La ejecución se calcula contrastando la suma de gastos reales (EXPENSE) del
 * mes contra el presupuesto asignado.
 *
 * Estados de alerta:
 *  - "ok": gasto <= 80% del presupuesto.
 *  - "warning": gasto > 80% y <= 100% (zona de precaución).
 *  - "exceeded": gasto > 100% (desvío negativo / sobreconsumo).
 */

export interface BudgetExecutionItem {
  id: string;
  categoryId: string;
  categoryName: string;
  month: string; // "YYYY-MM"
  budgetedAmount: number;
  spentAmount: number;
  remainingAmount: number;
  percentageUsed: number;
  status: "ok" | "warning" | "exceeded";
}

/**
 * Calcula el estado de ejecución de un presupuesto.
 *
 * @param budgeted Monto presupuestado (> 0).
 * @param spent Monto gastado real (>= 0).
 */
export function calculateBudgetStatus(
  budgeted: number,
  spent: number,
): {
  remaining: number;
  percentage: number;
  status: "ok" | "warning" | "exceeded";
} {
  const safeBudgeted = Math.max(0, budgeted);
  const safeSpent = Math.max(0, spent);

  const remaining = safeBudgeted - safeSpent;
  const percentage =
    safeBudgeted > 0 ? (safeSpent / safeBudgeted) * 100 : 0;

  let status: "ok" | "warning" | "exceeded" = "ok";
  if (percentage > 100) {
    status = "exceeded";
  } else if (percentage >= 80) {
    status = "warning";
  }

  return {
    remaining,
    percentage: Math.round(percentage * 100) / 100,
    status,
  };
}

/**
 * Normaliza un identificador de mes ("YYYY-MM" o fecha ISO) al primer día del mes como Date UTC.
 */
export function parseBudgetMonth(monthStr: string): Date {
  const match = monthStr.match(/^(\d{4})-(\d{2})/);
  if (!match) {
    throw new Error(`Mes inválido: "${monthStr}". Se espera formato YYYY-MM.`);
  }
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  if (month < 1 || month > 12) {
    throw new Error(`Mes fuera de rango: ${month}`);
  }
  return new Date(Date.UTC(year, month - 1, 1));
}
