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
import {
  bucketIndex,
  formatPeriodLabel,
  periodRange,
  shiftPeriod,
  todayCalendar,
  type PeriodMode,
} from "@/lib/dates";
import type { PeriodTotalsDTO, ReportsResponse } from "@/lib/finance";
import {
  centsToString,
  formatMoney,
  formatPercent,
  toCents,
} from "@/lib/format";

/**
 * Análisis del período: tarjetas, torta por categoría y evolución por día.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ LOS AGREGADOS VIENEN DEL SERVIDOR Y NO SE SUMAN ACÁ
 * ─────────────────────────────────────────────────────────────────────────────
 * Antes esta pantalla pedía los movimientos a `/api/transactions` —topeada en
 * `MOVEMENTS_MAX_ROWS`— y sumaba esa lista en el cliente. A partir del
 * movimiento 501 las tarjetas, la torta y las barras quedaban subestimadas, y
 * un cartel de aviso no arreglaba nada: el número mal seguía grande y arriba.
 *
 * Ahora todo sale de `/api/reports`, que agrega en la base con `groupBy` sobre
 * el período COMPLETO (ver `lib/queries.ts`). El tope sigue existiendo donde
 * tiene sentido —la lista que se muestra— y ningún número depende de él.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ LOS FILTROS VIAJAN AL SERVIDOR
 * ─────────────────────────────────────────────────────────────────────────────
 * Cuando el filtro se aplicaba en el cliente, filtrar era gratis: se recorría
 * la lista que ya estaba en memoria. Con los agregados en la base, el filtro
 * tiene que llegar ANTES del `groupBy` para que los números correspondan a lo
 * que la pantalla está mostrando. De ahí que `categoryId` y `q` sean parámetros
 * del request.
 *
 * El selector de categorías es la excepción: se puebla con todas las categorías
 * con movimientos en el período, SIN los filtros de pantalla. Si se filtrara a
 * sí mismo, elegir una categoría dejaría sólo esa opción en la lista y no
 * habría forma de volver a agrandar el período.
 */

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

/**
 * Cuánto se espera antes de mandar la búsqueda de texto al servidor.
 *
 * Antes no hacía falta: la lista ya estaba en memoria y filtrarla era gratis.
 * Ahora cada búsqueda es un viaje a la base, así que sin retardo se dispararía
 * un request por tecla. 300 ms es el punto donde la mayoría de la gente ya
 * terminó de escribir la palabra y la pantalla sigue sintiéndose instantánea.
 */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Totales de un período vacío (y respaldo seguro del render).
 *
 * `stats` se calcula en cada render —los hooks no se saltean— aunque la
 * pantalla no llegue a mostrar sus números: mientras carga o si la carga
 * falló, lo que se ve es "Cargando…" o el error, nunca estas tarjetas.
 * Coincide con lo que devuelve el servidor para un período sin movimientos,
 * así que tampoco distorsiona ese caso.
 */
const EMPTY_TOTALS: PeriodTotalsDTO = {
  income: "0.00",
  expenses: "0.00",
  transfers: "0.00",
  cashFlow: "0.00",
  incomeCount: 0,
  expenseCount: 0,
  transferCount: 0,
};

export default function AnalisisPage() {
  const [mode, setMode] = useState<ViewMode>("month");

  // ── La fecha ancla ─────────────────────────────────────────────────────────
  // Antes: `new Date().toISOString().slice(0, 10)`. Después de las 21:00 en
  // Buenos Aires eso da el día SIGUIENTE, así que el análisis arrancaba en la
  // semana equivocada sin que nadie lo notara.
  const [anchor, setAnchor] = useState(() => todayCalendar());

  /**
   * La respuesta de `/api/reports`, tal cual llega.
   *
   * Es UN estado y no cuatro (totales, torta, barras, categorías) porque la
   * respuesta es atómica: guardarlos por separado permitiría renders con totales
   * de un pedido y torta de otro.
   */
  const [report, setReport] = useState<ReportsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  /**
   * El error de la última carga, si hubo ("" si no).
   *
   * Es un estado APARTE y no un `report` en null: la pantalla necesita
   * distinguir "el período no tiene movimientos" —estado vacío— de "no se pudo
   * preguntar" —error—. Si se mezclan, un problema de red se disfraza de mes
   * sin gastos, con las tarjetas en $ 0,00 como si fueran datos.
   */
  const [loadError, setLoadError] = useState("");

  // ── Los filtros ───────────────────────────────────────────────────────────
  // `categoryId` guarda el ID de la categoría, no su nombre: el nombre es texto
  // para mostrar y cambia (se puede renombrar), el ID es la identidad y es lo
  // que viaja al servidor.
  const [categoryId, setCategoryId] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // ── El rango del período ───────────────────────────────────────────────────
  // Se calcula con `periodRange`, que sabe que febrero tiene 28 o 29 días y que
  // la semana argentina empieza el lunes. La versión anterior construía los
  // límites con `toISOString()`, que convierte a UTC y corría todo un día con
  // offset negativo.
  const range = useMemo(() => periodRange(mode, anchor), [mode, anchor]);
  const label = useMemo(() => formatPeriodLabel(mode, range), [mode, range]);

  // ── El retardo de la búsqueda ──────────────────────────────────────────────
  // `search` es lo que la persona ve mientras escribe; `debouncedSearch` es lo
  // que dispara el request y sólo cambia 300 ms después de la última tecla.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  // ── La carga ───────────────────────────────────────────────────────────────
  //
  // ─────────────────────────────────────────────────────────────────────────────
  // LA CARRERA QUE HAY QUE EVITAR
  // ─────────────────────────────────────────────────────────────────────────────
  // Con cada tecla y cada cambio de período hay un request en vuelo. Dos
  // respuestas pueden llegar DESORDENADAS: la de una búsqueda vieja después de
  // la nueva. Sin protección, la vieja pisaría a la nueva y la pantalla
  // mostraría resultados que no corresponden a lo escrito — un bug que aparece
  // justo cuando la red es lenta.
  //
  // El `AbortController` de cada efecto cancela el request anterior cuando los
  // filtros cambian, así que la respuesta vieja ni siquiera llega. Los chequeos
  // de `signal.aborted` cubren los bordes: un fetch abortado rechaza con
  // AbortError (no es un error que haya que mostrar) y `finally` no tiene que
  // apagar el `loading` del efecto que ya quedó atrás.
  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setLoading(true);
      setLoadError("");
      try {
        const params = new URLSearchParams({ from: range.from, to: range.to });
        if (categoryId) params.set("categoryId", categoryId);
        const query = debouncedSearch.trim();
        if (query) params.set("q", query);

        const response = await fetch(`/api/reports?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`La API de reportes respondió ${response.status}.`);
        }

        setReport((await response.json()) as ReportsResponse);
      } catch {
        if (controller.signal.aborted) return;
        // Error de red o del servidor: la pantalla muestra un error propio.
        //
        // Antes esto caía en el estado vacío, y el estado vacío miente en dos
        // formas: las tarjetas quedan en $ 0,00 —un número que nadie calculó—
        // y "No hay gastos en este período" le echa la culpa al período de un
        // problema que es de conexión. Un cero mostrado donde no hubo
        // respuesta no es un dato: es un invento.
        setReport(null);
        setLoadError(
          "No se pudieron cargar los datos del período. Revisá que la base esté levantada y recargá.",
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    load();
    return () => controller.abort();
  }, [range.from, range.to, categoryId, debouncedSearch]);

  function shift(direction: number) {
    setAnchor(shiftPeriod(mode, anchor, direction));
  }

  // ── Estadísticas ───────────────────────────────────────────────────────────
  // Acá ya no se suma ningún movimiento: todo llega agregado. Lo que queda es
  // presentación — porcentajes, orden y buckets — que es lo único que depende
  // de la pantalla.
  const stats = useMemo(() => {
    const totals = report?.totals ?? EMPTY_TOTALS;
    const byCategory = report?.byCategory ?? [];
    const byDate = report?.byDate ?? [];

    // Las transferencias no entran acá desde ningún ángulo: `totals` las
    // informa por separado, el servidor ya las excluyó de la torta y de las
    // barras. Mezclarlas en ingresos o gastos desarmaría todo el análisis:
    // pagar la tarjeta inflaría los "gastos" del mes con plata que ya se había
    // contado cuando se compró.
    const incomeCents = toCents(totals.income);
    const expenseCents = toCents(totals.expenses);
    const resultCents = incomeCents - expenseCents;

    // ── La torta ─────────────────────────────────────────────────────────────
    // El porcentaje se calcula acá y no en el servidor porque depende del total
    // que se está mostrando. Se hace con centavos ENTEROS: dividir los strings
    // decimales como `number` acumularía error binario y la suma de las
    // porciones podría dar 100,01 %.
    const pie = byCategory
      .map((row) => {
        const cents = toCents(row.amount);
        return {
          name: row.name,
          value: Number(centsToString(cents)),
          sharePercent:
            expenseCents === 0 ? "0.00" : ((cents / expenseCents) * 100).toFixed(2),
        };
      })
      .sort((a, b) => b.value - a.value);

    // ── Las barras del gráfico ───────────────────────────────────────────────
    // El servidor entrega los días con INCOME y EXPENSE por separado; acá se
    // reparte cada día en su bucket con `bucketIndex`, que compara FECHAS DE
    // CALENDARIO.
    //
    // La versión anterior hacía `new Date(m.date).getDate()` sobre un instante
    // UTC. Con offset −3, un gasto del 1 de noviembre daba `getDate() === 31` y
    // caía en la barra del 31 de octubre — una barra que debería estar vacía, en
    // un gráfico donde no debería aparecer.
    const bucketCount =
      mode === "week" ? 7 : mode === "month" ? Number(range.to.slice(8, 10)) : 12;

    const incomeBuckets = new Array<number>(bucketCount).fill(0);
    const expenseBuckets = new Array<number>(bucketCount).fill(0);

    for (const row of byDate) {
      const index = bucketIndex(mode, range, row.date);
      // Fuera del rango: no se inventa una barra para meterlo.
      if (index === null || index < 0 || index >= bucketCount) continue;

      if (row.kind === "INCOME") {
        incomeBuckets[index] += toCents(row.amount);
      } else {
        expenseBuckets[index] += toCents(row.amount);
      }
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
      incomeTotal: totals.income,
      expenseTotal: totals.expenses,
      result: centsToString(resultCents),
      savingRate:
        incomeCents === 0 ? null : ((resultCents / incomeCents) * 100).toFixed(2),
      positive: resultCents >= 0,
      pie,
      bars,
      incomeCount: totals.incomeCount,
      expenseCount: totals.expenseCount,
      transferCount: totals.transferCount,
      transferTotal: totals.transfers,
    };
  }, [report, mode, range]);

  const categories = report?.categories ?? [];
  const hasFilters = categoryId !== "" || search !== "";

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
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          aria-label="Filtrar por categoría"
          className="flex-1 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 px-3 py-2 text-sm outline-none [&>option]:bg-white [&>option]:text-zinc-900 dark:[&>option]:bg-zinc-800 dark:[&>option]:text-zinc-100"
        >
          <option value="">Todas las categorías</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>

        {/*
          El `id` y el `aria-label` cierran un hueco de accesibilidad: lo único
          que identificaba al campo era el placeholder, y un placeholder no es
          un rótulo —desaparece al escribir y los lectores de pantalla no lo
          anuncian—. El `id` además es el ancla estable de los tests
          (`flows/06` lo toca por id, no por texto).
        */}
        <input
          id="analisis-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar…"
          aria-label="Buscar movimientos"
          className="flex-1 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500"
        />

        {hasFilters && (
          <button
            onClick={() => {
              setCategoryId("");
              setSearch("");
            }}
            className="text-sm px-3 py-2 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500"
          >
            Limpiar ✕
          </button>
        )}
      </div>

      {loading && <p className="text-center text-zinc-500 py-8">Cargando…</p>}

      {/* ── Error de carga ───────────────────────────────────────────────── */}
      {/* Reemplaza tarjetas, torta y barras: mostrar los ceros de un fetch
          fallido sería mostrar números inventados, y el estado vacío le echaría
          la culpa al período. Un error de conexión tiene que parecer un error
          de conexión. */}
      {!loading && loadError && (
        <div className="bg-white dark:bg-zinc-900 rounded-2xl p-8 shadow-sm text-center text-rose-600 dark:text-rose-400">
          <p className="text-3xl mb-2">⚠️</p>
          <p role="alert">{loadError}</p>
        </div>
      )}

      {!loading && !loadError && (
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
          ) : hasFilters ? (
            // El período sí tiene datos: el subconjunto lo vaciaron los
            // filtros. Decir "No hay gastos en este período" sería culpar al
            // período —y mandar a cargar un gasto que existe—. Un estado vacío
            // honesto habla de los filtros y ofrece la salida.
            <div className="bg-white dark:bg-zinc-900 rounded-2xl p-8 shadow-sm text-center text-zinc-500">
              <p className="text-3xl mb-2">🔍</p>
              <p className="font-medium">No hay gastos con esos filtros</p>
              <button
                onClick={() => {
                  setCategoryId("");
                  setSearch("");
                }}
                className="text-sm mt-2 underline text-emerald-600"
              >
                Limpiar filtros
              </button>
            </div>
          ) : (
            <div className="bg-white dark:bg-zinc-900 rounded-2xl p-8 shadow-sm text-center text-zinc-500">
              <p className="text-3xl mb-2">📊</p>
              <p className="font-medium">No hay gastos en este período</p>
              <p className="text-sm mt-1">
                Cargá un gasto para ver el desglose por categoría.
              </p>
            </div>
          )}
        </>
      )}
    </main>
  );
}
