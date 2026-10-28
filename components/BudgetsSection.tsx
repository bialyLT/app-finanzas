"use client";

import { useEffect, useState, useCallback } from "react";
import { formatMoney } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Trash2, AlertCircle, CheckCircle2 } from "lucide-react";

interface BudgetViewItem {
  id: string;
  categoryId: string;
  categoryName: string;
  month: string;
  budgetedAmount: number;
  spentAmount: number;
  remainingAmount: number;
  percentageUsed: number;
  status: "ok" | "warning" | "exceeded";
}

interface CategoryOption {
  id: string;
  name: string;
}

export function BudgetsSection({ month }: { month: string }) {
  const [budgets, setBudgets] = useState<BudgetViewItem[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Formulario nuevo / edición
  const [selectedCategory, setSelectedCategory] = useState("");
  const [amountStr, setAmountStr] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [resBudgets, resCategories] = await Promise.all([
        fetch(`/api/budgets?month=${encodeURIComponent(month)}`),
        fetch("/api/categories?kind=EXPENSE"),
      ]);

      if (!resBudgets.ok) {
        throw new Error("No se pudieron cargar los presupuestos.");
      }
      const dataBudgets = await resBudgets.json();
      setBudgets(dataBudgets.budgets || []);

      if (resCategories.ok) {
        const dataCats = await resCategories.json();
        setCategories(
          (dataCats || []).map((c: { id: string; name: string }) => ({
            id: c.id,
            name: c.name,
          })),
        );
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Error al cargar presupuestos");
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCategory || !amountStr) return;
    const numAmount = parseFloat(amountStr.replace(/,/g, "."));
    if (isNaN(numAmount) || numAmount <= 0) return;

    setSubmitting(true);
    try {
      const res = await fetch("/api/budgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryId: selectedCategory,
          month,
          amount: numAmount,
        }),
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || "No se pudo guardar el presupuesto.");
      }
      setAmountStr("");
      setSelectedCategory("");
      await loadData();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Error al guardar");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("¿Eliminar este presupuesto mensual?")) return;
    try {
      const res = await fetch(`/api/budgets?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Error al eliminar");
      await loadData();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Error al eliminar");
    }
  };

  return (
    <div className="rounded-lg border border-line bg-surface-2 p-5 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-fg">
            Presupuestos mensuales ({month})
          </h2>
          <p className="text-xs text-fg-muted">
            Límites objetivos de gasto por categoría con control de desvío y remanente.
          </p>
        </div>
      </div>

      {/* Formulario de fijación rápida */}
      <form onSubmit={handleSave} className="flex flex-wrap items-center gap-2">
        <select
          value={selectedCategory}
          onChange={(e) => setSelectedCategory(e.target.value)}
          aria-label="Elegir categoría para presupuestar"
          className="rounded-md border border-line bg-surface-3 px-3 py-2 text-sm text-fg outline-none"
        >
          <option value="">Seleccionar categoría…</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <Input
          type="number"
          step="any"
          placeholder="Monto presupuestado"
          value={amountStr}
          onChange={(e) => setAmountStr(e.target.value)}
          className="w-44 text-sm"
        />

        <Button
          type="submit"
          disabled={submitting || !selectedCategory || !amountStr}
          className="text-xs flex items-center gap-1.5"
        >
          <Plus className="w-3.5 h-3.5" />
          Fijar presupuesto
        </Button>
      </form>

      {loading && (
        <p className="text-xs text-fg-muted animate-pulse">
          Cargando presupuestos del período…
        </p>
      )}

      {error && (
        <p className="text-xs text-brand-error">
          {error}
        </p>
      )}

      {!loading && budgets.length === 0 && (
        <p className="text-sm text-fg-muted italic">
          No hay presupuestos fijados para este mes. Elegí una categoría arriba para empezar a monitorear gastos.
        </p>
      )}

      {/* Lista de presupuestos con barra de ejecución */}
      {!loading && budgets.length > 0 && (
        <div className="space-y-4">
          {budgets.map((b) => {
            const isExceeded = b.status === "exceeded";
            const isWarning = b.status === "warning";
            const barWidth = Math.min(100, Math.max(0, b.percentageUsed));

            return (
              <div
                key={b.id}
                className="rounded-lg border border-line bg-surface-1 p-4 space-y-2"
              >
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2 font-medium text-fg">
                    {b.categoryName}
                    {isExceeded && (
                      <span className="flex items-center gap-1 text-xs text-brand-error font-normal">
                        <AlertCircle className="w-3.5 h-3.5" />
                        Desvío: sobreconsumo de {formatMoney(Math.abs(b.remainingAmount))}
                      </span>
                    )}
                    {isWarning && (
                      <span className="flex items-center gap-1 text-xs text-brand-warning font-normal">
                        <AlertCircle className="w-3.5 h-3.5" />
                        Alerta: consumo superior al 80%
                      </span>
                    )}
                    {!isExceeded && !isWarning && (
                      <span className="flex items-center gap-1 text-xs text-brand-ok font-normal">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Dentro del límite
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-3">
                    <span className="text-xs font-mono text-fg-muted">
                      {b.percentageUsed.toFixed(1)}%
                    </span>
                    <button
                      type="button"
                      onClick={() => handleDelete(b.id)}
                      title="Eliminar presupuesto"
                      className="text-fg-muted hover:text-brand-error transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Barra de progreso */}
                <div className="w-full h-2 rounded-full bg-surface-3 overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${
                      isExceeded
                        ? "bg-brand-error"
                        : isWarning
                        ? "bg-brand-warning"
                        : "bg-brand-ok"
                    }`}
                    style={{ width: `${barWidth}%` }}
                  />
                </div>

                {/* Métricas: Presupuestado vs Gastado vs Restante */}
                <div className="flex flex-wrap items-center justify-between text-xs text-fg-muted pt-1">
                  <span>
                    Gastado:{" "}
                    <strong className="text-fg">{formatMoney(b.spentAmount)}</strong>
                  </span>
                  <span>
                    Presupuesto:{" "}
                    <strong className="text-fg">{formatMoney(b.budgetedAmount)}</strong>
                  </span>
                  <span>
                    {b.remainingAmount >= 0 ? "Disponible:" : "Excedido:"}{" "}
                    <strong
                      className={
                        b.remainingAmount < 0 ? "text-brand-error" : "text-fg"
                      }
                    >
                      {formatMoney(Math.abs(b.remainingAmount))}
                    </strong>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
