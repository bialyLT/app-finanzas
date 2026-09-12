"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import TransactionForm from "@/components/TransactionForm";
import { formatMoney, type CategoryDTO, type MovementDTO, type MovementKind } from "@/lib/finance";

export default function Home() {
  const [movements, setMovements] = useState<MovementDTO[]>([]);
  const [incomeCats, setIncomeCats] = useState<CategoryDTO[]>([]);
  const [expenseCats, setExpenseCats] = useState<CategoryDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalKind, setModalKind] = useState<MovementKind | null>(null);
  const [filter, setFilter] = useState<"ALL" | MovementKind>("ALL");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [search, setSearch] = useState("");
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });

  const [year, monthNum] = month.split("-").map(Number);
  const from = `${month}-01`;
  const to = `${month}-${String(new Date(year, monthNum, 0).getDate()).padStart(2, "0")}`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [txRes, inRes, exRes] = await Promise.all([
        fetch(`/api/transactions?from=${from}&to=${to}`),
        fetch("/api/categories?kind=INCOME"),
        fetch("/api/categories?kind=EXPENSE"),
      ]);
      const [tx, inc, exp] = await Promise.all([txRes.json(), inRes.json(), exRes.json()]);
      setMovements(Array.isArray(tx) ? tx : []);
      setIncomeCats(Array.isArray(inc) ? inc : []);
      setExpenseCats(Array.isArray(exp) ? exp : []);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  const totals = useMemo(() => {
    let income = 0;
    let expense = 0;
    let fixedIncome = 0;
    let fixedExpense = 0;
    for (const m of movements) {
      if (m.kind === "INCOME") {
        income += m.amount;
        if (m.isFixed) fixedIncome += m.amount;
      } else {
        expense += m.amount;
        if (m.isFixed) fixedExpense += m.amount;
      }
    }
    return { income, expense, balance: income - expense, fixedIncome, fixedExpense };
  }, [movements]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return movements.filter((m) => {
      if (filter !== "ALL" && m.kind !== filter) return false;
      if (categoryFilter && m.category.name !== categoryFilter) return false;
      if (q && !`${m.category.name} ${m.description ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [movements, filter, categoryFilter, search]);

  const availableCats = useMemo(() => {
    const list =
      filter === "INCOME" ? incomeCats : filter === "EXPENSE" ? expenseCats : [...incomeCats, ...expenseCats];
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [filter, incomeCats, expenseCats]);

  function clearFilters() {
    setFilter("ALL");
    setCategoryFilter("");
    setSearch("");
  }

  async function remove(id: string) {
    if (!confirm("¿Eliminar este movimiento?")) return;
    await fetch(`/api/transactions/${id}`, { method: "DELETE" });
    load();
  }

  function shiftMonth(delta: number) {
    const d = new Date(year, monthNum - 1 + delta, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }

  const monthLabel = new Date(year, monthNum - 1, 1).toLocaleDateString("es-ES", {
    month: "long",
    year: "numeric",
  });

  return (
    <main className="mx-auto max-w-5xl px-4 py-6 flex flex-col gap-6">
      {/* Selector de mes */}
      <div className="flex items-center justify-between bg-white dark:bg-zinc-900 rounded-2xl px-4 py-3 shadow-sm">
        <button onClick={() => shiftMonth(-1)} className="px-3 py-1.5 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 text-lg">←</button>
        <div className="text-center">
          <p className="font-bold capitalize">{monthLabel}</p>
          <p className="text-xs text-zinc-500">{movements.length} movimientos</p>
        </div>
        <button onClick={() => shiftMonth(1)} className="px-3 py-1.5 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 text-lg">→</button>
      </div>

      {/* Balance */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-emerald-600 text-white rounded-2xl p-4 shadow">
          <p className="text-xs uppercase opacity-80">Ingresos</p>
          <p className="text-lg sm:text-2xl font-extrabold">{formatMoney(totals.income)}</p>
          <p className="text-[11px] opacity-80 mt-1">Fijos: {formatMoney(totals.fixedIncome)}</p>
        </div>
        <div className="bg-rose-600 text-white rounded-2xl p-4 shadow">
          <p className="text-xs uppercase opacity-80">Gastos</p>
          <p className="text-lg sm:text-2xl font-extrabold">{formatMoney(totals.expense)}</p>
          <p className="text-[11px] opacity-80 mt-1">Fijos: {formatMoney(totals.fixedExpense)}</p>
        </div>
        <div className={`rounded-2xl p-4 shadow ${totals.balance >= 0 ? "bg-zinc-900 text-white dark:bg-white dark:text-black" : "bg-amber-500 text-black"}`}>
          <p className="text-xs uppercase opacity-80">Balance</p>
          <p className="text-lg sm:text-2xl font-extrabold">{formatMoney(totals.balance)}</p>
          <Link href="/analisis" className="text-[11px] underline opacity-80">Ver análisis →</Link>
        </div>
      </div>

      {/* Botones principales */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => setModalKind("INCOME")}
          className="rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white text-xl font-bold py-6 shadow-lg active:scale-[0.98] transition"
        >
          ＋ Ingreso
          <span className="block text-xs font-normal opacity-80 mt-1">Sueldo, ventas, freelance…</span>
        </button>
        <button
          onClick={() => setModalKind("EXPENSE")}
          className="rounded-2xl bg-rose-600 hover:bg-rose-700 text-white text-xl font-bold py-6 shadow-lg active:scale-[0.98] transition"
        >
          － Gasto
          <span className="block text-xs font-normal opacity-80 mt-1">Comida, alquiler, transporte…</span>
        </button>
      </div>

      {/* Filtros + lista */}
      <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-4 pt-4">
          <h2 className="font-bold">Movimientos del mes</h2>
          <div className="flex gap-1 text-sm">
            {(["ALL", "INCOME", "EXPENSE"] as const).map((f) => (
              <button
                key={f}
                onClick={() => {
                  setFilter(f);
                  setCategoryFilter("");
                }}
                className={`px-3 py-1.5 rounded-full ${filter === f ? "bg-zinc-900 text-white dark:bg-white dark:text-black" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}
              >
                {f === "ALL" ? "Todos" : f === "INCOME" ? "Ingresos" : "Gastos"}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-2 px-4 pt-3">
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="flex-1 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 [&>option]:bg-white [&>option]:text-zinc-900 dark:[&>option]:bg-zinc-800 dark:[&>option]:text-zinc-100 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500"
          >
            <option value="">Todos los tipos</option>
            {availableCats.map((c) => (
              <option key={c.id} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 Buscar en notas o tipos…"
            className="flex-1 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500"
          />
          {(categoryFilter !== "" || search !== "") && (
            <button
              onClick={() => {
                setCategoryFilter("");
                setSearch("");
              }}
              className="text-sm px-3 py-2 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500"
            >
              Limpiar ✕
            </button>
          )}
        </div>

        <div className="p-4 flex flex-col gap-2">
          {loading && <p className="text-center text-zinc-500 py-8">Cargando…</p>}
          {!loading && visible.length === 0 && movements.length === 0 && (
            <div className="text-center py-10 text-zinc-500">
              <p className="text-4xl mb-2">🪙</p>
              <p className="font-medium">Sin movimientos este mes</p>
              <p className="text-sm">Toca <b className="text-emerald-600">＋ Ingreso</b> o <b className="text-rose-600">－ Gasto</b> para empezar.</p>
            </div>
          )}
          {!loading && visible.length === 0 && movements.length > 0 && (
            <div className="text-center py-10 text-zinc-500">
              <p className="text-4xl mb-2">🔍</p>
              <p className="font-medium">Sin movimientos con esos filtros</p>
              <button onClick={clearFilters} className="text-sm mt-2 underline text-emerald-600">
                Limpiar filtros
              </button>
            </div>
          )}
          {visible.map((m) => (
            <div key={m.id} className="flex items-start gap-3 border border-zinc-100 dark:border-zinc-800 rounded-xl px-3 py-2.5">
              <div className={`w-10 h-10 shrink-0 rounded-full flex items-center justify-center text-lg ${m.kind === "INCOME" ? "bg-emerald-100 dark:bg-emerald-950" : "bg-rose-100 dark:bg-rose-950"}`}>
                {m.kind === "INCOME" ? "💵" : "🧾"}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold">
                  {m.category.name}
                  {m.isFixed && <span className="ml-2 text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200 align-middle">FIJO</span>}
                </p>
                <p className="text-xs text-zinc-500">
                  {new Date(m.date).toLocaleDateString("es-ES", { day: "numeric", month: "short" })}
                </p>
                {m.description ? (
                  <p className="mt-1 text-sm leading-snug whitespace-pre-wrap break-words bg-zinc-50 dark:bg-zinc-800/60 rounded-lg px-2.5 py-1.5">
                    📝 {m.description}
                  </p>
                ) : (
                  <p className="mt-1 text-xs italic text-zinc-400">Sin nota</p>
                )}
              </div>
              <p className={`font-extrabold whitespace-nowrap pt-1 ${m.kind === "INCOME" ? "text-emerald-600" : "text-rose-600"}`}>
                {m.kind === "INCOME" ? "+" : "−"}{formatMoney(m.amount)}
              </p>
              <button onClick={() => remove(m.id)} title="Eliminar" className="text-zinc-400 hover:text-rose-600 px-1 pt-1">🗑</button>
            </div>
          ))}
        </div>
      </div>

      {modalKind && (
        <TransactionForm
          kind={modalKind}
          categories={modalKind === "INCOME" ? incomeCats : expenseCats}
          onClose={() => setModalKind(null)}
          onSaved={load}
        />
      )}
    </main>
  );
}
