"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
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
  factorMonto,
  formatMoney,
  formatPercent,
  toCents,
} from "@/lib/format";
import { TriangleAlert, Search, ChartColumn, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";

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

/**
 * Los colores de la torta: LOS TOKENS del design system, no la paleta de
 * fábrica.
 *
 * Antes eran diez hexes escritos a mano (la paleta 500 de Tailwind) y el
 * `#ccc` de la grilla: en el esquema «Noche» mostraban una paleta DISTINTA
 * de la del resto de la app, y un color sin nombre no se puede cambiar ni
 * auditar (el gate de estilo los prohíbe).
 *
 * Con cinco tokens cromáticos hay cinco colores distintos; para las
 * categorías que excedan los cinco, el mismo token con menos opacidad (sobre
 * la tarjeta, menos opacidad = más apagado).
 */
const PIE_TOKENS = ["success", "danger", "transfer", "warning", "primary"] as const;

/** El color (un token del design system) y la opacidad del sector `index`. */
function pieSector(index: number): { fill: string; fillOpacity: number } {
  const token = PIE_TOKENS[index % PIE_TOKENS.length];
  const vuelta = Math.floor(index / PIE_TOKENS.length);
  return {
    fill: `var(--${token})`,
    fillOpacity: Math.max(0.35, 1 - vuelta * 0.22),
  };
}

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
  declaredIncome: "0.00",
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

  // ── El burn mensualizado ───────────────────────────────────────────────────
  // El id del gasto elegido para verlo repartido en 12 (ROADMAP §5.3 #9). Es
  // estado EFÍMERO: no viaja a la URL ni se persiste en ningún lado — la
  // selección existe mientras la pantalla está abierta, y nada más.
  const [burnId, setBurnId] = useState("");

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
        // El burn viaja por id. El servidor responde `burn: null` si el gasto
        // no es un EXPENSE del período o ya no existe, así que un id viejo no
        // rompe la pantalla: simplemente no hay tarjeta de burn que mostrar.
        if (burnId) params.set("burn", burnId);

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
  }, [range.from, range.to, categoryId, debouncedSearch, burnId]);

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
      /**
       * La parte del ingreso que NO viene de un movimiento: la plata que la
       * persona declaró como ingreso de este mes (la banderita de la cuenta).
       * Viaja APARTE para que la pantalla diga de dónde sale el número (y para
       * no llamarlo «ganado»: esa plata ya estaba).
       */
      declared: totals.declaredIncome,
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

  // ── El burn mensualizado ───────────────────────────────────────────────────
  // La selección se valida contra los candidatos del período que el servidor
  // acaba de mandar. Un gasto elegido en otro mes deja de aplicar solo: el
  // select vuelve al estado inicial y los números no aparecen — en vez de
  // quedar un control mostrando una opción que ya no existe en la lista.
  // (El servidor hace la misma validación y devuelve `burn: null`; acá se
  // espeja para que la interfaz nunca muestre una selección fantasma.)
  const burnCandidates = report?.burnCandidates ?? [];
  const burnSelected = burnCandidates.some(
    (candidate) => candidate.id === burnId,
  );
  const burn = burnSelected ? report?.burn ?? null : null;
  const selectedCandidate = burnCandidates.find(
    (candidate) => candidate.id === burnId,
  );

  return (
    <main className="mx-auto max-w-5xl px-4 py-6 flex flex-col gap-5">
      {/* ── Selector de período ──────────────────────────────────────────── */}
      <Card>
        <CardContent className="flex flex-col gap-3">
          <div className="flex gap-1 text-sm">
            {(["week", "month", "year"] as const).map((option) => (
              <Button
                key={option}
                variant={mode === option ? "default" : "ghost"}
                size="sm"
                className="rounded-full"
                onClick={() => setMode(option)}
              >
                {MODE_LABEL[option]}
              </Button>
            ))}
          </div>

          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => shift(-1)}
              aria-label="Período anterior"
            >
              ←
            </Button>
            <div className="text-center">
              {/* `first-letter:uppercase` y NO `capitalize`: `capitalize` pondría
                  "Octubre De 2026", que en español está mal escrito. */}
              <p className="font-bold first-letter:uppercase">{label}</p>
              <p className="text-xs text-fg-muted">
                {range.from} → {range.to}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => shift(1)}
              aria-label="Período siguiente"
            >
              →
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Filtros ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row gap-2">
        <select
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          aria-label="Filtrar por categoría"
          className="flex-1 rounded-md border border-border bg-secondary px-3 py-2 text-sm outline-none [&>option]:bg-card [&>option]:text-fg [&>option]:bg-secondary "
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
        <Input
          id="analisis-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar…"
          aria-label="Buscar movimientos"
          className="flex-1 border-border bg-transparent"
        />

        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setCategoryId("");
              setSearch("");
            }}
            className="text-sm text-muted-foreground"
          >
            Limpiar
            <X className="size-4 inline-block align-[-2px] ml-1" aria-hidden />
          </Button>
        )}
      </div>

      {loading && <p className="text-center text-fg-muted py-8">Cargando…</p>}

      {/* ── Error de carga ───────────────────────────────────────────────── */}
      {/* Reemplaza tarjetas, torta y barras: mostrar los ceros de un fetch
          fallido sería mostrar números inventados, y el estado vacío le echaría
          la culpa al período. Un error de conexión tiene que parecer un error
          de conexión. */}
      {!loading && loadError && (
        <div className="rounded-lg border bg-card text-card-foreground shadow-sm p-8 text-center text-danger ">
          <p className="mb-2"><TriangleAlert className="size-8 inline-block" aria-hidden /></p>
          <p role="alert">{loadError}</p>
        </div>
      )}

      {!loading && !loadError && (
        <>
          {/* ── Resumen ─────────────────────────────────────────────────── */}
          {/* Las cuatro tarjetas del resumen: la fila de cuatro recién entra en
              940 px, porque el monto es una palabra sola y a 20 px mide 153 px
              (el mismo cálculo que en el panel: 4×(153+32)+68 = 812 px, y se
              deja margen). Antes entraban en 640 px y el monto se salía de la
              tarjeta. A 384 px entran dos columnas; por debajo, una. */}
          <div className="grid grid-cols-1 min-[384px]:grid-cols-2 min-[940px]:grid-cols-4 gap-3">
            <div className="@container min-w-0 rounded-lg border bg-card text-card-foreground shadow-sm p-4">
              <p className="text-xs uppercase text-fg-muted">Ingresos</p>
              <p
                className="monto-tarjeta monto-tarjeta--analisis font-extrabold text-success"
                style={{ "--k": factorMonto(formatMoney(stats.incomeTotal)) } as CSSProperties}
              >
                {formatMoney(stats.incomeTotal)}
              </p>
              <p className="text-xs opacity-80">
                {stats.incomeCount}{" "}
                {stats.incomeCount === 1 ? "movimiento" : "movimientos"}
              </p>
              {/* La plata declarada (la banderita de la cuenta) NO es un
                  movimiento: es ingreso del mes sin que entre por la puerta de
                  los movimientos. Sin esta línea, el total de ingresos sería un
                  número sin explicación (y la torta no lo muestra: la plata
                  declarada no tiene categoría). */}
              {stats.declared !== "0.00" && (
                <p className="text-xs opacity-80">
                  + {formatMoney(stats.declared)} declarados
                </p>
              )}
            </div>

            <div className="@container min-w-0 rounded-lg border bg-card text-card-foreground shadow-sm p-4">
              <p className="text-xs uppercase text-fg-muted">Gastos</p>
              <p
                className="monto-tarjeta monto-tarjeta--analisis font-extrabold text-danger"
                style={{ "--k": factorMonto(formatMoney(stats.expenseTotal)) } as CSSProperties}
              >
                {formatMoney(stats.expenseTotal)}
              </p>
              <p className="text-xs opacity-80">
                {stats.expenseCount}{" "}
                {stats.expenseCount === 1 ? "movimiento" : "movimientos"}
              </p>
            </div>

            <div
              className="@container min-w-0 bg-surface-2 rounded-md p-4"
            >
              <p className="text-xs uppercase text-fg-muted">Te quedó</p>
              <p
                className={`monto-tarjeta monto-tarjeta--analisis font-extrabold ${stats.positive ? "text-success" : "text-danger"}`}
                style={
                  { "--k": factorMonto(formatMoney(stats.result, { withSign: true })) } as CSSProperties
                }
              >
                {formatMoney(stats.result, { withSign: true })}
              </p>
              <p className="text-xs opacity-80">
                {stats.savingRate !== null
                  ? // La plata declarada (la banderita) entra en el ingreso del
                    // mes, pero nadie la ganó: ya la tenías. Decir «de lo que
                    // ganaste» sobre ese número sería mentir, igual que en el
                    // panel. Con la banderita apagada el texto es el de siempre.
                    `${formatPercent(stats.savingRate)} de lo que ${
                      stats.declared !== "0.00" ? "entró" : "ganaste"
                    }${stats.declared !== "0.00" ? " este mes" : ""}`
                  : "Sin ingresos"}
              </p>
            </div>

            {/* Las transferencias se muestran aparte, y eso es informativo: deja
                claro que ese dinero se movió sin ser ganancia ni pérdida. */}
            <div className="@container min-w-0 rounded-lg border bg-card text-card-foreground shadow-sm p-4">
              <p className="text-xs uppercase text-fg-muted">Transferencias</p>
              <p
                className="monto-tarjeta monto-tarjeta--analisis font-extrabold text-transfer"
                style={{ "--k": factorMonto(formatMoney(stats.transferTotal)) } as CSSProperties}
              >
                {formatMoney(stats.transferTotal)}
              </p>
              <p className="text-xs opacity-80">
                {stats.transferCount}{" "}
                {stats.transferCount === 1 ? "movimiento" : "movimientos"} entre
                tus cuentas
              </p>
            </div>
          </div>

          {/* ── Evolución ───────────────────────────────────────────────── */}
          <div className="rounded-lg border bg-card text-card-foreground shadow-sm p-4">
            <h2 className="font-bold mb-3">Evolución</h2>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.bars}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" opacity={0.6} />
                  <XAxis dataKey="label" fontSize={12} tick={{ fill: "var(--fg-muted)" }} />
                  <YAxis fontSize={12} width={70} tick={{ fill: "var(--fg-muted)" }} />
                  <Tooltip
                    formatter={(value) => formatMoney(String(value ?? 0))}
                    contentStyle={{
                      backgroundColor: "var(--surface-2)",
                      border: "1px solid var(--line-strong)",
                      borderRadius: 6,
                      color: "var(--fg)",
                    }}
                    labelStyle={{ color: "var(--fg)" }}
                    itemStyle={{ color: "var(--fg-muted)" }}
                  />
                  <Legend />
                  <Bar dataKey="Ingresos" fill="var(--success)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Gastos" fill="var(--danger)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* ── Gastos por categoría ─────────────────────────────────────── */}
          {stats.pie.length > 0 ? (
            <div className="rounded-lg border bg-card text-card-foreground shadow-sm p-4">
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
                          fill={pieSector(index).fill}
                          fillOpacity={pieSector(index).fillOpacity}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value) => formatMoney(String(value ?? 0))}
                      contentStyle={{
                        backgroundColor: "var(--surface-2)",
                        border: "1px solid var(--line-strong)",
                        borderRadius: 6,
                        color: "var(--fg)",
                      }}
                      labelStyle={{ color: "var(--fg)" }}
                      itemStyle={{ color: "var(--fg-muted)" }}
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
                        backgroundColor: pieSector(index).fill,
                        opacity: pieSector(index).fillOpacity,
                      }}
                    />
                    <span className="flex-1 truncate">{entry.name}</span>
                    <span className="text-fg-muted text-xs">
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
            <div className="rounded-lg border bg-card text-card-foreground shadow-sm p-8 text-center text-fg-muted">
              <p className="mb-2"><Search className="size-8 inline-block" aria-hidden /></p>
              <p className="font-medium">No hay gastos con esos filtros</p>
              <button
                onClick={() => {
                  setCategoryId("");
                  setSearch("");
                }}
                className="text-sm mt-2 underline text-success"
              >
                Limpiar filtros
              </button>
            </div>
          ) : (
            <div className="rounded-lg border bg-card text-card-foreground shadow-sm p-8 text-center text-fg-muted">
              <p className="mb-2"><ChartColumn className="size-8 inline-block" aria-hidden /></p>
              <p className="font-medium">No hay gastos en este período</p>
              <p className="text-sm mt-1">
                Cargá un gasto para ver el desglose por categoría.
              </p>
            </div>
          )}

          {/* ── Burn mensualizado (ROADMAP §5.3 #9) ──────────────────────── */}
          {/*
            La tarjeta sólo existe si el período TIENE gastos: sin candidatos
            no hay nada que elegir y un control vacío sería ruido. La lista de
            candidatos ignora los filtros de pantalla a propósito (igual que
            el selector de categorías): un selector no se filtra a sí mismo.
          */}
          {burnCandidates.length > 0 && (
            <div className="rounded-lg border bg-card text-card-foreground shadow-sm p-4 flex flex-col gap-3">
              <div>
                <h2 className="font-bold">Burn mensualizado</h2>
                <p className="text-sm text-fg-muted">
                  Un gasto anual, dividido por 12, para comparar meses entre
                  sí. Elegí un gasto del período para verlo entero al lado de
                  su versión repartida: las dos vistas del mismo número.
                </p>
              </div>

              <select
                id="analisis-burn"
                value={burnSelected ? burnId : ""}
                onChange={(event) => setBurnId(event.target.value)}
                aria-label="Elegir un gasto para el burn mensualizado"
                className="rounded-md border border-line-strong bg-surface-3 px-3 py-2 text-sm outline-none [&>option]:bg-surface-2 [&>option]:text-fg [&>option]:bg-surface-3 "
              >
                <option value="">Elegí un gasto…</option>
                {burnCandidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.description ?? candidate.categoryName ?? "Gasto"}{" "}
                    · {formatMoney(candidate.amount)} · {candidate.date}
                  </option>
                ))}
              </select>

              {report?.burnCandidatesTruncated && (
                <p className="text-xs text-fg-muted">
                  Hay más gastos en el período: la lista muestra los 500 más
                  grandes. El cálculo del burn no se recorta.
                </p>
              )}

              {hasFilters && (
                <p className="text-xs text-fg-muted">
                  La lista y el cálculo usan el período completo: los filtros
                  de arriba no los cambian.
                </p>
              )}

              {burn && selectedCandidate && (
                <>
                  <p className="text-sm">
                    <span className="text-fg-muted">Gasto elegido:</span>{" "}
                    <strong>
                      {selectedCandidate.description ??
                        selectedCandidate.categoryName ??
                        "Gasto"}
                    </strong>{" "}
                    — {formatMoney(burn.amount)} ÷ 12 ={" "}
                    <strong>{formatMoney(burn.monthlyShare)}</strong> por mes
                  </p>

                  {/* Las dos vistas, una al lado de la otra: la de caja es un
                      hecho (la plata salió de una vez) y la mensualizada es la
                      misma plata repartida para poder comparar meses. */}
                  <div className="grid sm:grid-cols-2 gap-3">
                    <div className="rounded-md border border-line border-line-strong p-3">
                      <p className="text-xs uppercase text-fg-muted">
                        Mes de caja
                      </p>
                      <p className="text-sm mt-1">
                        Gastos:{" "}
                        <span className="font-semibold">
                          {formatMoney(burn.expenses)}
                        </span>
                      </p>
                      <p className="text-lg font-extrabold mt-1">
                        {formatMoney(burn.cashResult, { withSign: true })}
                      </p>
                      <p className="text-xs text-fg-muted">
                        Te quedó con el gasto entero en su mes
                      </p>
                    </div>

                    <div className="rounded-md border border-line border-line-strong p-3">
                      <p className="text-xs uppercase text-fg-muted">
                        Burn mensualizado
                      </p>
                      <p className="text-sm mt-1">
                        Gastos:{" "}
                        <span className="font-semibold">
                          {formatMoney(burn.burnExpenses)}
                        </span>
                      </p>
                      <p
                        className={`text-lg font-extrabold mt-1 ${
                          toCents(burn.burnResult) >= 0
                            ? "text-success "
                            : "text-danger "
                        }`}
                      >
                        {formatMoney(burn.burnResult, { withSign: true })}
                      </p>
                      <p className="text-xs text-fg-muted">
                        Te quedó repartiendo el gasto en 12
                      </p>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </main>
  );
}
