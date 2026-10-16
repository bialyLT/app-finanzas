"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import {
  bucketIndex,
  formatPeriodLabel,
  periodRange,
  shiftPeriod,
  todayCalendar,
  type PeriodMode,
} from "@/lib/dates";
import { MOVEMENTS_MAX_ROWS, type MovementDTO, type MovementKindDTO } from "@/lib/finance";
import {
  centsToString,
  formatMoney,
  formatPercent,
  sumAmounts,
  toCents,
} from "@/lib/format";

type ViewMode = PeriodMode;

const PIE_COLORS = [
  "#10b981", "#f43f5e", "#6366f1", "#f59e0b", "#0ea5e9",
  "#a855f7", "#84cc16", "#ef4444", "#14b8a6", "#eab308",
];

const MODE_LABEL: Record<ViewMode, string> = {
  week: "Semana",
  month: "Mes",
  year: "Año",
};

export default function AnalisisPage() {
  const [mode, setMode] = useState<ViewMode>("month");

  // ── La fecha ancla ─────────────────────────────────────────────────────────
  // Antes: `new Date().toISOString().slice(0, 10)`. Después de las 21:00 en
  // Buenos Aires eso da el día SIGUIENTE, así que el análisis arrancaba en la
  // semana equivocada sin que nadie lo notara.
  const [anchor, setAnchor] = useState(() => todayCalendar());

  const [movements, setMovements] = useState<MovementDTO[]>([]);

  /**
   * `true` si el período tiene más movimientos que el tope de la consulta.
   *
   * Esta pantalla importa mucho más que el panel: acá TODO se calcula sobre la
   * lista —los totales, el gráfico de torta y las barras—, así que con la lista
   * truncada los tres están incompletos. El panel, en cambio, recibe los totales
   * ya sumados en la base y el truncado sólo afecta a la lista.
   *
   * Por eso el aviso acá es obligatorio y va ARRIBA de los números, no abajo.
   */
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [search, setSearch] = useState("");

  // ── El rango del período ───────────────────────────────────────────────────
  // Se calcula con `periodRange`, que sabe que febrero tiene 28 o 29 días y que
  // la semana argentina empieza el lunes. La versión anterior construía los
  // límites con `toISOString()`, que convierte a UTC y corría todo un día con
  // offset negativo.
  const range = useMemo(() => periodRange(mode, anchor), [mode, anchor]);
  const label = useMemo(() => formatPeriodLabel(mode, range), [mode, range]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Sin `kind`: la página necesita TODOS los movimientos para poder mostrar
      // las transferencias y para que los totales de ingresos y gastos convivan
      // con la realidad del mes.
      const response = await fetch(
        `/api/transactions?from=${range.from}&to=${range.to}`,
      );
      const data = (await response.json()) as {
        movements?: MovementDTO[];
        truncated?: boolean;
      };
      setMovements(data.movements ?? []);
      setTruncated(data.truncated ?? false);
    } catch {
      setMovements([]);
      setTruncated(false);
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => {
    load();
  }, [load]);

  function shift(direction: number) {
    setAnchor(shiftPeriod(mode, anchor, direction));
  }

  // ── Las categorías que aparecen en el período ─────────────────────────────
  const allCategories = useMemo(() => {
    const map = new Map<string, MovementKindDTO>();
    for (const movement of movements) {
      if (movement.category && !map.has(movement.category.name)) {
        map.set(movement.category.name, movement.kind);
      }
    }
    return [...map.entries()]
      .map(([name, kind]) => ({ name, kind }))
      .sort((a, b) => a.name.localeCompare(b.name, "es"));
  }, [movements]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return movements.filter((movement) => {
      if (categoryFilter && movement.category?.name !== categoryFilter) return false;
      if (query) {
        const haystack = [
          movement.category?.name ?? "",
          movement.description,
          movement.account.name,
          movement.toAccount?.name ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [movements, categoryFilter, search]);

  // ── Estadísticas ───────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    // Las transferencias se separan del cálculo desde el principio. No son
    // ingreso ni gasto, y mezclarlas en cualquiera de los dos totales desarma
    // todo el análisis: pagar la tarjeta inflaría los "gastos" del mes con plata
    // que ya se había contado cuando se compró.
    const income = filtered.filter((m) => m.kind === "INCOME");
    const expenses = filtered.filter((m) => m.kind === "EXPENSE");
    const transfers = filtered.filter((m) => m.kind === "TRANSFER");

    const incomeTotal = sumAmounts(income.map((m) => m.amount));
    const expenseTotal = sumAmounts(expenses.map((m) => m.amount));

    const incomeCents = toCents(incomeTotal);
    const expenseCents = toCents(expenseTotal);
    const resultCents = incomeCents - expenseCents;

    const byCategory = new Map<string, number>();
    for (const movement of expenses) {
      byCategory.set(
        movement.category?.name ?? "Sin categoría",
        (byCategory.get(movement.category?.name ?? "Sin categoría") ?? 0) +
          toCents(movement.amount),
      );
    }

    const pie = [...byCategory.entries()]
      .map(([name, cents]) => ({
        name,
        value: Number(centsToString(cents)),
        sharePercent:
          expenseCents === 0 ? "0.00" : ((cents / expenseCents) * 100).toFixed(2),
      }))
      .sort((a, b) => b.value - a.value);

    // ── Las barras del gráfico ───────────────────────────────────────────────
    // El índice de cada movimiento se resuelve con `bucketIndex`, que compara
    // FECHAS DE CALENDARIO.
    //
    // La versión anterior hacía `new Date(m.date).getDate()` sobre un instante
    // UTC. Con offset −3, un gasto del 1 de noviembre daba `getDate() === 31` y
    // caía en la barra del 31 de octubre — una barra que debería estar vacía, en
    // un gráfico donde no debería aparecer.
    const bucketCount =
      mode === "week" ? 7 : mode === "month" ? Number(range.to.slice(8, 10)) : 12;

    const incomeBuckets = new Array<number>(bucketCount).fill(0);
    const expenseBuckets = new Array<number>(bucketCount).fill(0);

    for (const movement of filtered) {
      const index = bucketIndex(mode, range, movement.date);
      // Fuera del rango: no se inventa una barra para meterlo.
      if (index === null || index < 0 || index >= bucketCount) continue;

      if (movement.kind === "INCOME") {
        incomeBuckets[index] += toCents(movement.amount);
      } else if (movement.kind === "EXPENSE") {
        expenseBuckets[index] += toCents(movement.amount);
      }
      // Las transferencias no entran en ninguna barra: no son ni una cosa ni la
      // otra. Si se sumaran a los gastos, el gráfico mostraría un pico que no
      // corresponde a ninguna pérdida de plata.
    }

    const bars = Array.from({ length: bucketCount }, (_, index) => {
      let bucketLabel: string;

      if (mode === "week") {
        // Los 7 días de la semana, con su nombre.
        const dayNumber = Number(range.from.slice(8, 10)) + index;
        const [year, month] = range.from.split("-").map(Number);
        // `new Date(y, m - 1, d)` con componentes sueltos: la fecha se construye
        // en hora local y no se corre un día. `new Date("...-01")` la
        // interpretaría como UTC y podría mostrar el día anterior.
        const dayDate = new Date(year, month - 1, dayNumber);
        bucketLabel = new Intl.DateTimeFormat("es-AR", { weekday: "short" }).format(
          dayDate,
        );
      } else if (mode === "month") {
        // En modo mes cada barra es un día: se rotula con el número del día.
        bucketLabel = String(index + 1);
      } else {
        // En modo año cada barra es un mes.
        bucketLabel = new Intl.DateTimeFormat("es-AR", { month: "short" }).format(
          new Date(Number(range.from.slice(0, 4)), index, 1),
        );
      }

      return {
        label: bucketLabel,
        Ingresos: Number(centsToString(incomeBuckets[index])),
        Gastos: Number(centsToString(expenseBuckets[index])),
      };
    });

    return {
      incomeTotal,
      expenseTotal,
      result: centsToString(resultCents),
      savingRate:
        incomeCents === 0 ? null : ((resultCents / incomeCents) * 100).toFixed(2),
      positive: resultCents >= 0,
      pie,
      bars,
      incomeCount: income.length,
      expenseCount: expenses.length,
      transferCount: transfers.length,
      transferTotal: sumAmounts(transfers.map((m) => m.amount)),
    };
  }, [filtered, mode, range]);

  const hasFilters = categoryFilter !== "" || search !== "";

  return (
    <main className="mx-auto max-w-5xl px-4 py-6 flex flex-col gap-5">
      {/* ── Selector de período ──────────────────────────────────────────── */}
      <div className="bg-white dark:bg-zinc-900 rounded-2xl p-4 shadow-sm flex flex-col gap-3">
        <div className="flex gap-1 text-sm">
          {(["week", "month", "year"] as const).map((option) => (
            <button
              key={option}
              onClick={() => setMode(option)}
              className={`px-3 py-1.5 rounded-full ${
                mode === option
                  ? "bg-zinc-900 text-white dark:bg-white dark:text-black"
                  : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
              }`}
            >
              {MODE_LABEL[option]}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between">
          <button
            onClick={() => shift(-1)}
            className="px-3 py-1.5 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 text-lg"
            aria-label="Período anterior"
          >
            ←
          </button>
          <div className="text-center">
            {/* `first-letter:uppercase` y NO `capitalize`: `capitalize` pondría
                "Octubre De 2026", que en español está mal escrito. */}
            <p className="font-bold first-letter:uppercase">{label}</p>
            <p className="text-xs text-zinc-500">
              {range.from} → {range.to}
            </p>
          </div>
          <button
            onClick={() => shift(1)}
            className="px-3 py-1.5 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 text-lg"
            aria-label="Período siguiente"
          >
            →
          </button>
        </div>
      </div>

      {/* ── Filtros ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row gap-2">
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          aria-label="Filtrar por categoría"
          className="flex-1 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 px-3 py-2 text-sm outline-none [&>option]:bg-white [&>option]:text-zinc-900 dark:[&>option]:bg-zinc-800 dark:[&>option]:text-zinc-100"
        >
          <option value="">Todas las categorías</option>
          {allCategories.map((category) => (
            <option key={category.name} value={category.name}>
              {category.name}
            </option>
          ))}
        </select>

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar…"
          className="flex-1 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500"
        />

        {hasFilters && (
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

      {/* ── Aviso de truncado ────────────────────────────────────────────── */}
      {truncated && (
        <p
          role="alert"
          className="rounded-xl border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950 px-4 py-3 text-sm text-amber-900 dark:text-amber-100"
        >
          Este período tiene más de {MOVEMENTS_MAX_ROWS} movimientos y la pantalla
          carga sólo los primeros {MOVEMENTS_MAX_ROWS}. Los totales, el gráfico de
          torta y las barras están calculados sobre <strong>esa parte</strong>, así
          que están subestimados. Filtrá por categoría o por texto para achicar el
          período y que los números sean completos.
        </p>
      )}

      {loading && <p className="text-center text-zinc-500 py-8">Cargando…</p>}

      {!loading && (
        <>
          {/* ── Resumen ─────────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-emerald-600 text-white rounded-2xl p-4">
              <p className="text-xs uppercase opacity-80">Ingresos</p>
              <p className="text-xl font-extrabold">
                {formatMoney(stats.incomeTotal)}
              </p>
              <p className="text-[11px] opacity-80">
                {stats.incomeCount}{" "}
                {stats.incomeCount === 1 ? "movimiento" : "movimientos"}
              </p>
            </div>

            <div className="bg-rose-600 text-white rounded-2xl p-4">
              <p className="text-xs uppercase opacity-80">Gastos</p>
              <p className="text-xl font-extrabold">
                {formatMoney(stats.expenseTotal)}
              </p>
              <p className="text-[11px] opacity-80">
                {stats.expenseCount}{" "}
                {stats.expenseCount === 1 ? "movimiento" : "movimientos"}
              </p>
            </div>

            <div
              className={`rounded-2xl p-4 ${
                stats.positive
                  ? "bg-zinc-900 text-white dark:bg-white dark:text-black"
                  : "bg-amber-500 text-black"
              }`}
            >
              <p className="text-xs uppercase opacity-80">Te quedó</p>
              <p className="text-xl font-extrabold">
                {formatMoney(stats.result, { withSign: true })}
              </p>
              <p className="text-[11px] opacity-80">
                {stats.savingRate !== null
                  ? `${formatPercent(stats.savingRate)} de lo que ganaste`
                  : "Sin ingresos"}
              </p>
            </div>

            {/* Las transferencias se muestran aparte, y eso es informativo: deja
                claro que ese dinero se movió sin ser ganancia ni pérdida. */}
            <div className="bg-sky-600 text-white rounded-2xl p-4">
              <p className="text-xs uppercase opacity-80">Transferencias</p>
              <p className="text-xl font-extrabold">
                {formatMoney(stats.transferTotal)}
              </p>
              <p className="text-[11px] opacity-80">
                {stats.transferCount}{" "}
                {stats.transferCount === 1 ? "movimiento" : "movimientos"} entre
                tus cuentas
              </p>
            </div>
          </div>

          {/* ── Evolución ───────────────────────────────────────────────── */}
          <div className="bg-white dark:bg-zinc-900 rounded-2xl p-4 shadow-sm">
            <h2 className="font-bold mb-3">Evolución</h2>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.bars}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="label" fontSize={12} />
                  <YAxis fontSize={12} width={70} />
                  <Tooltip
                    formatter={(value) => formatMoney(String(value ?? 0))}
                  />
                  <Legend />
                  <Bar dataKey="Ingresos" fill="#10b981" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Gastos" fill="#f43f5e" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* ── Gastos por categoría ─────────────────────────────────────── */}
          {stats.pie.length > 0 ? (
            <div className="bg-white dark:bg-zinc-900 rounded-2xl p-4 shadow-sm">
              <h2 className="font-bold mb-3">En qué se fue</h2>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={stats.pie}
                      dataKey="value"
                      nameKey="name"
                      outerRadius="80%"
                      label={(entry: { name?: string }) => entry.name ?? ""}
                    >
                      {stats.pie.map((entry, index) => (
                        <Cell
                          key={entry.name}
                          fill={PIE_COLORS[index % PIE_COLORS.length]}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value) => formatMoney(String(value ?? 0))}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>

              {/* La lista con porcentajes es más útil que el gráfico solo:
                  el gráfico muestra la forma, la lista dice los números. */}
              <ul className="mt-3 flex flex-col gap-1.5">
                {stats.pie.map((entry, index) => (
                  <li
                    key={entry.name}
                    className="flex items-center gap-2 text-sm"
                  >
                    <span
                      className="w-3 h-3 rounded-full shrink-0"
                      style={{
                        backgroundColor: PIE_COLORS[index % PIE_COLORS.length],
                      }}
                    />
                    <span className="flex-1 truncate">{entry.name}</span>
                    <span className="text-zinc-500 text-xs">
                      {formatPercent(entry.sharePercent)}
                    </span>
                    <span className="font-semibold whitespace-nowrap">
                      {formatMoney(String(entry.value))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            !loading && (
              <div className="bg-white dark:bg-zinc-900 rounded-2xl p-8 shadow-sm text-center text-zinc-500">
                <p className="text-3xl mb-2">📊</p>
                <p className="font-medium">
                  No hay gastos en este período
                </p>
                <p className="text-sm mt-1">
                  Cargá un gasto para ver el desglose por categoría.
                </p>
              </div>
            )
          )}
        </>
      )}
    </main>
  );
}
