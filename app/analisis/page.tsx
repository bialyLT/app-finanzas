"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatMoney, type MovementDTO } from "@/lib/finance";

type ViewMode = "week" | "month" | "year";

const PIE_COLORS = ["#10b981", "#f43f5e", "#6366f1", "#f59e0b", "#0ea5e9", "#a855f7", "#84cc16", "#ef4444", "#14b8a6", "#eab308"];

function startOfWeek(d: Date) {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7; // lunes = 0
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
}

function fmtDay(d: Date) {
  return d.toLocaleDateString("es-ES", { day: "numeric", month: "short" });
}

export default function AnalisisPage() {
  const [mode, setMode] = useState<ViewMode>("month");
  const [anchor, setAnchor] = useState(() => new Date().toISOString().slice(0, 10));
  const [movements, setMovements] = useState<MovementDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [catFilter, setCatFilter] = useState("");
  const [search, setSearch] = useState("");

  const range = useMemo(() => {
    const a = new Date(anchor + "T12:00:00");
    if (mode === "week") {
      const s = startOfWeek(a);
      const e = new Date(s);
      e.setDate(e.getDate() + 6);
      return { from: s, to: e };
    }
    if (mode === "month") {
      return { from: new Date(a.getFullYear(), a.getMonth(), 1), to: new Date(a.getFullYear(), a.getMonth() + 1, 0) };
    }
    return { from: new Date(a.getFullYear(), 0, 1), to: new Date(a.getFullYear(), 11, 31) };
  }, [mode, anchor]);

  const fromStr = range.from.toISOString().slice(0, 10);
  const toStr = range.to.toISOString().slice(0, 10);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/transactions?from=${fromStr}&to=${toStr}`)
      .then((r) => r.json())
      .then((d) => setMovements(Array.isArray(d) ? d : []))
      .finally(() => setLoading(false));
  }, [fromStr, toStr]);

  const label = useMemo(() => {
    if (mode === "week") return `Semana ${fmtDay(range.from)} → ${fmtDay(range.to)}`;
    if (mode === "month")
      return range.from.toLocaleDateString("es-ES", { month: "long", year: "numeric" });
    return `Año ${range.from.getFullYear()}`;
  }, [mode, range]);

  function shift(dir: number) {
    const a = new Date(anchor + "T12:00:00");
    if (mode === "week") a.setDate(a.getDate() + dir * 7);
    else if (mode === "month") a.setMonth(a.getMonth() + dir);
    else a.setFullYear(a.getFullYear() + dir);
    setAnchor(a.toISOString().slice(0, 10));
  }

  const allCats = useMemo(() => {
    const set = new Map<string, MovementDTO["kind"]>();
    for (const m of movements) {
      if (!set.has(m.category.name)) set.set(m.category.name, m.kind);
    }
    return [...set.entries()]
      .map(([name, kind]) => ({ name, kind }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [movements]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return movements.filter((m) => {
      if (catFilter && m.category.name !== catFilter) return false;
      if (q && !`${m.category.name} ${m.description ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [movements, catFilter, search]);

  const stats = useMemo(() => {
    let income = 0;
    let expense = 0;
    let fixedIncome = 0;
    let fixedExpense = 0;
    const byCatIncome = new Map<string, number>();
    const byCatExpense = new Map<string, number>();

    // buckets para barras
    type Bucket = { label: string; ingresos: number; gastos: number };
    let buckets: Bucket[] = [];

    if (mode === "week") {
      const days = [...Array(7)].map((_, i) => {
        const d = new Date(range.from);
        d.setDate(d.getDate() + i);
        return d;
      });
      buckets = days.map((d) => ({
        label: d.toLocaleDateString("es-ES", { weekday: "short" }),
        ingresos: 0,
        gastos: 0,
      }));
    } else if (mode === "month") {
      const n = range.to.getDate();
      buckets = [...Array(n)].map((_, i) => ({ label: String(i + 1), ingresos: 0, gastos: 0 }));
    } else {
      const months = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
      buckets = months.map((label) => ({ label, ingresos: 0, gastos: 0 }));
    }

    for (const m of filtered) {
      const d = new Date(m.date);
      if (m.kind === "INCOME") {
        income += m.amount;
        if (m.isFixed) fixedIncome += m.amount;
        byCatIncome.set(m.category.name, (byCatIncome.get(m.category.name) ?? 0) + m.amount);
      } else {
        expense += m.amount;
        if (m.isFixed) fixedExpense += m.amount;
        byCatExpense.set(m.category.name, (byCatExpense.get(m.category.name) ?? 0) + m.amount);
      }
      let idx = -1;
      if (mode === "week") {
        idx = Math.round((new Date(d.toDateString()).getTime() - new Date(range.from.toDateString()).getTime()) / 86400000);
      } else if (mode === "month") {
        idx = d.getDate() - 1;
      } else {
        idx = d.getMonth();
      }
      if (idx >= 0 && idx < buckets.length) {
        if (m.kind === "INCOME") buckets[idx].ingresos += m.amount;
        else buckets[idx].gastos += m.amount;
      }
    }

    const pieIncome = [...byCatIncome.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
    const pieExpense = [...byCatExpense.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);

    return { income, expense, balance: income - expense, fixedIncome, fixedExpense, buckets, pieIncome, pieExpense };
  }, [filtered, mode, range]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-6 flex flex-col gap-5">
      {/* Controles */}
      <div className="bg-white dark:bg-zinc-900 rounded-2xl p-4 shadow-sm flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
        <div className="flex gap-1 bg-zinc-100 dark:bg-zinc-800 rounded-full p-1 w-fit">
          {(["week", "month", "year"] as ViewMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-4 py-2 rounded-full text-sm font-medium ${mode === m ? "bg-white dark:bg-black shadow" : "text-zinc-500"}`}
            >
              {m === "week" ? "Semana" : m === "month" ? "Mes" : "Año"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => shift(-1)} className="px-3 py-1.5 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 text-lg">←</button>
          <p className="font-bold capitalize min-w-40 text-center">{label}</p>
          <button onClick={() => shift(1)} className="px-3 py-1.5 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 text-lg">→</button>
        </div>
      </div>

      {/* Filtros por tipo y notas */}
      <div className="bg-white dark:bg-zinc-900 rounded-2xl p-4 shadow-sm flex flex-col sm:flex-row gap-2">
        <select
          value={catFilter}
          onChange={(e) => setCatFilter(e.target.value)}
          className="flex-1 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 [&>option]:bg-white [&>option]:text-zinc-900 dark:[&>option]:bg-zinc-800 dark:[&>option]:text-zinc-100 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500"
        >
          <option value="">Todos los tipos</option>
          {allCats.map((c) => (
            <option key={c.name} value={c.name}>
              {c.kind === "INCOME" ? "💵 " : "🧾 "}{c.name}
            </option>
          ))}
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍 Buscar en notas o tipos… (ej: qué compraste en el kiosco)"
          className="flex-1 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500"
        />
        {(catFilter !== "" || search !== "") && (
          <button
            onClick={() => {
              setCatFilter("");
              setSearch("");
            }}
            className="text-sm px-3 py-2 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 whitespace-nowrap"
          >
            Limpiar ✕
          </button>
        )}
      </div>
      {(catFilter !== "" || search.trim() !== "") && (
        <p className="text-sm text-zinc-500 -mt-2 px-1">
          Mostrando {filtered.length} de {movements.length} movimientos
          {catFilter && <> · tipo <b>“{catFilter}”</b></>}
          {search.trim() && <> · búsqueda <b>“{search.trim()}”</b></>}
        </p>
      )}

      {loading ? (
        <p className="text-center text-zinc-500 py-16">Analizando datos…</p>
      ) : (
        <>
          {/* Resumen */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-emerald-600 text-white rounded-2xl p-4">
              <p className="text-xs uppercase opacity-80">Ingresos</p>
              <p className="text-xl font-extrabold">{formatMoney(stats.income)}</p>
            </div>
            <div className="bg-rose-600 text-white rounded-2xl p-4">
              <p className="text-xs uppercase opacity-80">Gastos</p>
              <p className="text-xl font-extrabold">{formatMoney(stats.expense)}</p>
            </div>
            <div className="bg-zinc-900 text-white dark:bg-white dark:text-black rounded-2xl p-4">
              <p className="text-xs uppercase opacity-80">Balance</p>
              <p className="text-xl font-extrabold">{formatMoney(stats.balance)}</p>
            </div>
            <div className="bg-amber-400 text-black rounded-2xl p-4">
              <p className="text-xs uppercase opacity-80">Fijos netos</p>
              <p className="text-xl font-extrabold">{formatMoney(stats.fixedIncome - stats.fixedExpense)}</p>
              <p className="text-[11px] opacity-70">+{formatMoney(stats.fixedIncome)} / −{formatMoney(stats.fixedExpense)}</p>
            </div>
          </div>

          {/* Barras */}
          <div className="bg-white dark:bg-zinc-900 rounded-2xl p-4 shadow-sm">
            <h2 className="font-bold mb-1">Ingresos vs Gastos</h2>
            <p className="text-xs text-zinc-500 mb-3">
              {mode === "week" ? "Por día de la semana" : mode === "month" ? "Por día del mes" : "Por mes del año"}
            </p>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.buckets}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis dataKey="label" fontSize={11} interval={mode === "month" ? 2 : 0} />
                  <YAxis fontSize={11} />
                  <Tooltip formatter={(value) => formatMoney(Number(value ?? 0))} />
                  <Legend />
                  <Bar dataKey="ingresos" fill="#059669" radius={[4, 4, 0, 0]} name="Ingresos" />
                  <Bar dataKey="gastos" fill="#e11d48" radius={[4, 4, 0, 0]} name="Gastos" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Tortas por tipo */}
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="bg-white dark:bg-zinc-900 rounded-2xl p-4 shadow-sm">
              <h2 className="font-bold">Gastos por tipo</h2>
              <p className="text-xs text-zinc-500 mb-2">Toca una porción para filtrar por ese tipo</p>
              {stats.pieExpense.length === 0 ? (
                <p className="text-sm text-zinc-500 py-8 text-center">Sin gastos en este periodo</p>
              ) : (
                <div className="h-60">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={stats.pieExpense}
                        dataKey="value"
                        nameKey="name"
                        outerRadius={85}
                        label={{ fontSize: 11 }}
                        style={{ cursor: "pointer" }}
                        onClick={(_data, index) => {
                          const name = stats.pieExpense[index]?.name;
                          if (name) setCatFilter((cur) => (cur === name ? "" : name));
                        }}
                      >
                        {stats.pieExpense.map((_, i) => (
                          <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} opacity={catFilter === "" || catFilter === stats.pieExpense[i].name ? 1 : 0.35} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value) => formatMoney(Number(value ?? 0))} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
            <div className="bg-white dark:bg-zinc-900 rounded-2xl p-4 shadow-sm">
              <h2 className="font-bold">Ingresos por tipo</h2>
              <p className="text-xs text-zinc-500 mb-2">Toca una porción para filtrar por ese tipo</p>
              {stats.pieIncome.length === 0 ? (
                <p className="text-sm text-zinc-500 py-8 text-center">Sin ingresos en este periodo</p>
              ) : (
                <div className="h-60">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={stats.pieIncome}
                        dataKey="value"
                        nameKey="name"
                        outerRadius={85}
                        label={{ fontSize: 11 }}
                        style={{ cursor: "pointer" }}
                        onClick={(_data, index) => {
                          const name = stats.pieIncome[index]?.name;
                          if (name) setCatFilter((cur) => (cur === name ? "" : name));
                        }}
                      >
                        {stats.pieIncome.map((_, i) => (
                          <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} opacity={catFilter === "" || catFilter === stats.pieIncome[i].name ? 1 : 0.35} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value) => formatMoney(Number(value ?? 0))} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </div>

          {/* Detalle */}
          <div className="bg-white dark:bg-zinc-900 rounded-2xl p-4 shadow-sm">
            <h2 className="font-bold mb-3">Detalle de movimientos ({filtered.length})</h2>
            <div className="flex flex-col gap-2 max-h-96 overflow-auto">
              {filtered.map((m) => (
                <div key={m.id} className="flex items-start justify-between gap-3 text-sm border-b border-zinc-100 dark:border-zinc-800 pb-2">
                  <span className="min-w-0">
                    <b>{m.category.name}</b> {m.isFixed && <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">FIJO</span>}
                    <span className="text-zinc-500"> · {new Date(m.date).toLocaleDateString("es-ES")}</span>
                    {m.description ? (
                      <span className="block mt-1 text-sm leading-snug whitespace-pre-wrap break-words bg-zinc-50 dark:bg-zinc-800/60 rounded-lg px-2.5 py-1.5">
                        📝 {m.description}
                      </span>
                    ) : (
                      <span className="block mt-0.5 text-xs italic text-zinc-400">Sin nota</span>
                    )}
                  </span>
                  <span className={`font-bold shrink-0 ${m.kind === "INCOME" ? "text-emerald-600" : "text-rose-600"}`}>
                    {m.kind === "INCOME" ? "+" : "−"}{formatMoney(m.amount)}
                  </span>
                </div>
              ))}
              {filtered.length === 0 && <p className="text-sm text-zinc-500">No hay datos con esos filtros en este periodo.</p>}
            </div>
          </div>
        </>
      )}
    </main>
  );
}
