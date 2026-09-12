"use client";

import { useState } from "react";
import type { CategoryDTO, MovementKind } from "@/lib/finance";

interface Props {
  kind: MovementKind;
  categories: CategoryDTO[];
  onClose: () => void;
  onSaved: () => void;
}

export default function TransactionForm({ kind, categories, onClose, onSaved }: Props) {
  const [amount, setAmount] = useState("");
  const [categoryName, setCategoryName] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [isFixed, setIsFixed] = useState(false);
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const isIncome = kind === "INCOME";
  const suggestions = categories
    .filter((c) => c.name.toLowerCase().includes(categoryName.trim().toLowerCase()))
    .slice(0, 6);
  const exactExists =
    categories.some((c) => c.name.toLowerCase() === categoryName.trim().toLowerCase());

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!amount || Number(amount) <= 0) {
      setError("Ingresa un monto válido mayor a 0.");
      return;
    }
    if (!categoryName.trim()) {
      setError("Elige o escribe un tipo (ej: Sueldo, Alquiler, Comida).");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          amount: Number(amount),
          categoryName: categoryName.trim(),
          date,
          isFixed,
          description,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error al guardar");
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al guardar");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" onClick={onClose}>
      <div
        className="w-full sm:max-w-md bg-white dark:bg-zinc-900 rounded-t-3xl sm:rounded-3xl p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className={`text-xl font-bold ${isIncome ? "text-emerald-600" : "text-rose-600"}`}>
            {isIncome ? "＋ Nuevo ingreso" : "－ Nuevo gasto"}
          </h2>
          <button onClick={onClose} className="text-2xl leading-none text-zinc-400 hover:text-zinc-700 px-2">×</button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="text-sm font-medium">Monto *</label>
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              autoFocus
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="mt-1 w-full text-2xl font-bold rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-4 py-3 outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          <div>
            <label className="text-sm font-medium">
              Tipo * <span className="font-normal text-zinc-500">(se guarda y no se repite)</span>
            </label>
            <input
              value={categoryName}
              onChange={(e) => setCategoryName(e.target.value)}
              placeholder={isIncome ? "Ej: Sueldo, Freelance, Ventas…" : "Ej: Comida, Alquiler, Transporte…"}
              list={`cats-${kind}`}
              className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-4 py-3 outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <datalist id={`cats-${kind}`}>
              {categories.map((c) => (
                <option key={c.id} value={c.name} />
              ))}
            </datalist>
            {categoryName.trim() !== "" && (
              <p className="mt-1 text-xs text-zinc-500">
                {exactExists ? (
                  <>✓ Se usará el tipo existente <b>“{categoryName.trim()}”</b></>
                ) : (
                  <>＋ Se creará el nuevo tipo <b>“{categoryName.trim()}”</b> para futuros registros</>
                )}
              </p>
            )}
            {suggestions.length > 0 && categoryName.trim() !== "" && (
              <div className="mt-2 flex flex-wrap gap-2">
                {suggestions.map((s) => (
                  <button
                    type="button"
                    key={s.id}
                    onClick={() => setCategoryName(s.name)}
                    className="text-xs px-3 py-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 hover:bg-emerald-100 dark:hover:bg-emerald-900"
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">Fecha *</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2.5 outline-none"
              />
            </div>
            <label className="flex items-center gap-3 mt-6 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={isFixed}
                onChange={(e) => setIsFixed(e.target.checked)}
                className="w-5 h-5 accent-emerald-600"
              />
              <span className="text-sm">
                <b>{isIncome ? "Ingreso fijo" : "Gasto fijo"}</b>
                <br />
                <span className="text-zinc-500 text-xs">{isFixed ? "Se repite cada mes" : "Es puntual / variable"}</span>
              </span>
            </label>
          </div>

          <div>
            <label className="text-sm font-medium">Nota <span className="font-normal text-zinc-500">(opcional)</span></label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Detalle…"
              maxLength={200}
              className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-4 py-2.5 outline-none"
            />
          </div>

          {error && <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-lg px-3 py-2">{error}</p>}

          <div className="flex gap-3 mt-1">
            <button type="button" onClick={onClose} className="flex-1 rounded-xl border border-zinc-300 dark:border-zinc-700 py-3 font-medium">
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className={`flex-1 rounded-xl py-3 font-bold text-white disabled:opacity-50 ${isIncome ? "bg-emerald-600 hover:bg-emerald-700" : "bg-rose-600 hover:bg-rose-700"}`}
            >
              {saving ? "Guardando…" : "Guardar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
