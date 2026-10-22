"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import AccountForm from "@/components/AccountForm";
import CommandPalette from "@/components/CommandPalette";
import CsvImportModal from "@/components/CsvImportModal";
import TransactionForm from "@/components/TransactionForm";
import {
  formatCalendar,
  formatPeriodLabel,
  periodRange,
  shiftPeriod,
  todayCalendar,
} from "@/lib/dates";
import {
  MOVEMENTS_MAX_ROWS,
  MOVEMENT_KIND_LABEL,
  type AccountBalanceDTO,
  type CategoryDTO,
  type DebtReportDTO,
  type FavoriteDTO,
  type FavoritesResponse,
  type MovementDTO,
  type MovementKindDTO,
  type MovementsResponse,
  type NetWorthDTO,
  type NetWorthPointDTO,
  type PeriodTotalsDTO,
  type ReconciliationDTO,
} from "@/lib/finance";
import {
  LOCALE,
  centsToString,
  factorMonto,
  factorMontoFicha,
  formatDayLabel,
  formatLiability,
  formatMoney,
  formatPercent,
  montoLargo,
  toCents,
} from "@/lib/format";
import { shortcutMovementKind } from "@/lib/quick-entry";
import { isPaletteShortcut } from "@/lib/command-palette";
import { Banknote, Receipt, ArrowLeftRight, RefreshCw, Import, Coins, Search, StickyNote, Trash, Check, X, type LucideIcon } from "lucide-react";

/** Lo que se abre en el modal. */
type Modal = MovementKindDTO | "ACCOUNT" | null;

/**
 * Totales en cero: el estado inicial, y lo que se ve mientras carga.
 *
 * Existe para que el panel no tenga que distinguir "todavía no llegaron los
 * datos" de "no hubo movimientos". Las dos cosas se muestran igual —todo en
 * $ 0,00— y está bien que así sea.
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

/**
 * Cómo se ve cada tipo en la lista.
 *
 * Las transferencias tienen su propio color y su propio ícono porque NO son
 * plata que entra ni plata que sale. Pintarlas de verde o de rojo comunicaría lo
 * contrario de lo que significan.
 */
const KIND_ROW_STYLE: Record<
  MovementKindDTO,
  { icon: LucideIcon; bubble: string; amount: string }
> = {
  INCOME: {
    icon: Banknote,
    bubble: "bg-success/10 ",
    amount: "text-success",
  },
  EXPENSE: {
    icon: Receipt,
    bubble: "bg-danger/10 ",
    amount: "text-danger",
  },
  TRANSFER: {
    icon: ArrowLeftRight,
    bubble: "bg-transfer/10 ",
    amount: "text-transfer",
  },
};

/**
 * Clases extra para un monto que NO entra en su caja.
 *
 * Un monto de 18+ caracteres («+$ 1.234.567.890,12») es más ancho que las
 * cajas angostas de la app (la ficha de un mes, una fila de movimiento, una
 * celda de reconciliación) y las empuja: el número empuja al documento y la
 * página se va de ancho (medido a 320 px: 337 px de contenido en un device de
 * 320).
 *
 * Cuando el monto es largo, la caja tiene que poder partirlo
 * (`break-all`) y tiene que poder encogerse (`min-w-0`). Para los montos de
 * todos los días la respuesta es «no» y no se agrega ninguna clase: la
 * pantalla se ve EXACTAMENTE igual.
 */
function claseMontoLargo(texto: string): string {
  return montoLargo(texto) ? " min-w-0 break-all" : "";
}

export default function Home() {
  const [month, setMonth] = useState(() => todayCalendar().slice(0, 7));

  const [movements, setMovements] = useState<MovementDTO[]>([]);
  const [accounts, setAccounts] = useState<AccountBalanceDTO[]>([]);
  const [netWorth, setNetWorth] = useState<NetWorthDTO | null>(null);
  /**
   * La evolución del patrimonio: foto al cierre de cada uno de los últimos 12
   * meses, del más viejo al más nuevo. Llega calculada del servidor junto con
   * la foto de hoy — es su serie, no otra cosa.
   */
  const [netWorthSeries, setNetWorthSeries] = useState<NetWorthPointDTO[]>([]);
  /**
   * La reconciliación del mes MOSTRADO (no del mes de hoy): compara la
   * variación del patrimonio contra el ahorro del mes. Llega del servidor con
   * la comparación ya hecha — acá no se resta nada para decidir si cuadra. Ver
   * `ReconciliationDTO` y `getMonthReconciliation`.
   */
  const [reconciliation, setReconciliation] = useState<ReconciliationDTO | null>(null);
  /**
   * El reporte de deudas del mes MOSTRADO (no del mes de hoy): deuda viva al
   * corte, progreso del capital de cada préstamo, interés pagado, cuotas
   * restantes y DTI. Todo llega resuelto del servidor (ver `DebtReportDTO` y
   * `getDebtReport` en lib/queries.ts) — acá sólo se eligen las palabras.
   */
  const [debtReport, setDebtReport] = useState<DebtReportDTO | null>(null);
  const [categories, setCategories] = useState<CategoryDTO[]>([]);
  const [truncated, setTruncated] = useState(false);

  /**
   * Totales del período, calculados en el SERVIDOR.
   *
   * No se derivan de `movements`, aunque dé la tentación: esa lista viene
   * topeada a 500 filas y estos números tienen que ser exactos igual. Un mes con
   * más movimientos que el tope mostraría totales subestimados que se ven
   * idénticos a los correctos. Ver `PeriodTotalsDTO` en lib/finance.ts.
   */
  const [serverTotals, setServerTotals] = useState<PeriodTotalsDTO>(EMPTY_TOTALS);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [modal, setModal] = useState<Modal>(null);

  /**
   * La plantilla con la que se abrió el formulario, si vino de un favorito.
   * Se limpia al cerrar: abrir un movimiento normal no debe heredar la anterior.
   */
  const [favoriteForForm, setFavoriteForForm] = useState<FavoriteDTO | null>(null);
  const [favorites, setFavorites] = useState<FavoriteDTO[]>([]);
  const [favoritesMax, setFavoritesMax] = useState(24);

  /** Paleta `Ctrl+K` e importación CSV: dos overlays que no conviven con el form. */
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [csvOpen, setCsvOpen] = useState(false);

  /**
   * Borrado de plantillas en DOS pasos inline, como el resto de la app: el
   * driver de Maestro no puede contestar `window.confirm`.
   */
  const [confirmFavoriteDeleteId, setConfirmFavoriteDeleteId] = useState<
    string | null
  >(null);
  const [favoriteDeleteBusyId, setFavoriteDeleteBusyId] = useState<string | null>(
    null,
  );
  const [favoriteDeleteNotice, setFavoriteDeleteNotice] = useState("");

  /**
   * Aviso del generador de recurrencia.
   *
   * La corrida corre ANTES de cargar el panel (ver `load`), y si falla se
   * muestra acá sin romper el panel: lo que no se pudo materializar simplemente
   * no está en los números de abajo, y eso hay que decirlo en vez de mostrarlo
   * como si estuviera completo.
   */
  const [recurrenceRunError, setRecurrenceRunError] = useState("");

  /**
   * Cuántas ocurrencias de reglas están esperando confirmación en la bandeja.
   *
   * Sólo alimenta el banner hacia /recurrencia: el número NO entra en ningún
   * total (un pendiente no es plata — criterio de aceptación 4). Llega de un
   * pedido EXTRA a `/api/recurrence` que puede fallar sin consecuencias; si no
   * llega, el banner simplemente no aparece.
   */
  const [pendingCount, setPendingCount] = useState(0);

  const [filter, setFilter] = useState<"ALL" | MovementKindDTO>("ALL");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [search, setSearch] = useState("");

  /**
   * Borrado en dos pasos: sin diálogo nativo (`window.confirm`).
   *
   * El navegador del web driver de Maestro no puede contestar diálogos nativos
   * —se queda esperando una respuesta que nunca llega—, así que el borrado se
   * confirma en la fila, igual que en /recurrencia y /tarjetas.
   */
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null);
  const [deleteNotice, setDeleteNotice] = useState<{ id: string; message: string } | null>(
    null,
  );

  /**
   * La banderita de cada cuenta: «contar este saldo como ingreso de este mes».
   *
   * El error va en una franja INLINE (nunca en un `window.alert`: el driver de
   * Maestro no puede contestarlo y el hilo de JS se queda bloqueado).
   */
  const [incomeToggleBusyId, setIncomeToggleBusyId] = useState<string | null>(null);
  const [incomeToggleNotice, setIncomeToggleNotice] = useState<{
    id: string;
    message: string;
  } | null>(null);

  /**
   * El aviso de "Deshacer" posterior a un guardado, con el movimiento recién
   * creado.
   *
   * Es PERSISTENTE a propósito: no se auto-oculta. Un aviso que desaparece solo
   * a los segundos es imposible de testear —el flow que lo verifica llegaría
   * tarde o temprano— y, peor, puede desaparecer justo cuando la persona por
   * fin levantó la vista para deshacer. Se va cuando se lo usa, cuando se lo
   * descarta con la ×, o cuando el próximo guardado lo reemplaza (ver Fase 7,
   * criterio de "carga rápida").
   */
  const [undoToast, setUndoToast] = useState<{
    movement: MovementDTO;
    error: string;
    busy: boolean;
  } | null>(null);

  // ── El rango del mes ───────────────────────────────────────────────────────
  // Se calcula con `periodRange`, que conoce los meses de 28, 29, 30 y 31 días.
  //
  // Antes esto se armaba a mano con `new Date(year, monthNum, 0).getDate()`,
  // que "casi siempre" acierta. Pero además el rango se mandaba como fechas
  // locales, y el servidor las reinterpretaba — el bug que hacía que el 1 de
  // noviembre cayera en octubre. Ahora la fecha es un string de calendario en
  // todo el camino y no hay nada que reinterpretar.
  const range = useMemo(() => periodRange("month", `${month}-01`), [month]);
  const monthLabel = useMemo(
    () => formatPeriodLabel("month", range),
    [range],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      // ── El generador de recurrencia corre PRIMERO ─────────────────────────
      //
      // Materializa las fechas vencidas desde la última corrida; las reglas
      // AUTO postean sus movimientos ahí. Tiene que ir ANTES de los pedidos de
      // abajo: si corriera después, los totales del panel (que se suman en la
      // base) no incluirían lo recién materializado y el panel mostraría
      // números viejos con cara de nuevos.
      //
      // Su fallo NO bloquea el panel: un generador caído no puede dejar sin
      // ver tus movimientos. Se avisa y se sigue.
      try {
        const runRes = await fetch("/api/recurrence/run", { method: "POST" });
        if (runRes.ok) {
          setRecurrenceRunError("");
        } else {
          const data = (await runRes.json().catch(() => ({}))) as { error?: string };
          setRecurrenceRunError(
            data.error ?? "No se pudo correr el generador de recurrencia.",
          );
        }
      } catch {
        setRecurrenceRunError("No se pudo correr el generador de recurrencia.");
      }

      // El mes de los reportes (reconciliación y deudas) sale del rango que se
      // está pidiendo y no del estado `month` directo, así la URL siempre
      // describe el MISMO mes que la lista y los totales de esta carga.
      const shownMonth = range.from.slice(0, 7);
      const [
        movementsRes,
        categoriesRes,
        accountsRes,
        reconciliationRes,
        debtRes,
        recurrenceRes,
        favoritesRes,
      ] = await Promise.all([
        fetch(`/api/transactions?from=${range.from}&to=${range.to}`),
        fetch("/api/categories"),
        fetch("/api/accounts?includeArchived=false"),
        fetch(`/api/reconciliation?month=${shownMonth}`),
        fetch(`/api/debts?month=${shownMonth}`),
        // Sólo para el banner de pendientes. Con `catch` propio: un fallo de
        // ESTE pedido no puede tumbar un panel que por lo demás cargó bien.
        fetch("/api/recurrence").catch(() => null),
        // Las plantillas tampoco son críticas para el panel: si fallan, la
        // pantalla sigue mostrando movimientos y el formulario normal.
        fetch("/api/favorites").catch(() => null),
      ]);

      if (
        !movementsRes.ok ||
        !categoriesRes.ok ||
        !accountsRes.ok ||
        !reconciliationRes.ok ||
        !debtRes.ok
      ) {
        throw new Error("Alguno de los pedidos falló.");
      }

      const movementsData = (await movementsRes.json()) as MovementsResponse;
      const categoriesData = (await categoriesRes.json()) as {
        categories: CategoryDTO[];
      };
      const accountsData = (await accountsRes.json()) as {
        accounts: AccountBalanceDTO[];
        netWorth: NetWorthDTO;
        netWorthSeries: NetWorthPointDTO[];
      };
      const reconciliationData = (await reconciliationRes.json()) as {
        reconciliation: ReconciliationDTO;
      };
      const debtData = (await debtRes.json()) as {
        debtReport: DebtReportDTO;
      };
      const recurrenceData =
        recurrenceRes && recurrenceRes.ok
          ? ((await recurrenceRes.json()) as { pending: unknown[] })
          : null;
      const favoritesData =
        favoritesRes && favoritesRes.ok
          ? ((await favoritesRes.json()) as FavoritesResponse)
          : null;

      setMovements(movementsData.movements);
      setTruncated(movementsData.truncated);
      setServerTotals(movementsData.totals);
      setCategories(categoriesData.categories);
      setAccounts(accountsData.accounts);
      setNetWorth(accountsData.netWorth);
      setNetWorthSeries(accountsData.netWorthSeries);
      setReconciliation(reconciliationData.reconciliation);
      setDebtReport(debtData.debtReport);
      setPendingCount(recurrenceData?.pending.length ?? 0);
      if (favoritesData) {
        setFavorites(favoritesData.favorites);
        setFavoritesMax(favoritesData.max);
      }
    } catch {
      setLoadError(
        "No se pudieron cargar los datos. Revisá que la base esté levantada y recargá.",
      );
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Abre el formulario, opcionalmente precargado con una plantilla.
   *
   * Un solo camino para los tres botones, la paleta y los chips: si cada uno
   * armara su propio estado, cerrar el modal dejaría la plantilla anterior
   * pegada al próximo "Nuevo gasto".
   */
  function openMovement(kind: MovementKindDTO, favorite: FavoriteDTO | null = null) {
    setFavoriteForForm(favorite);
    setModal(kind);
  }

  /** Cierra el form y descarta la plantilla de origen (no queda pegada al próximo). */
  function closeMovement() {
    setModal(null);
    setFavoriteForForm(null);
  }

  /** Recarga sólo las plantillas (guardar una nueva no exige recargar el panel). */
  const refreshFavorites = useCallback(async () => {
    try {
      const response = await fetch("/api/favorites");
      if (!response.ok) return;
      const data = (await response.json()) as FavoritesResponse;
      setFavorites(data.favorites);
      setFavoritesMax(data.max);
    } catch {
      // Best-effort: el panel sigue funcionando sin la lista de plantillas.
    }
  }, []);

  async function deleteFavorite(id: string) {
    if (favoriteDeleteBusyId) return;
    setFavoriteDeleteBusyId(id);
    setFavoriteDeleteNotice("");
    try {
      const response = await fetch(
        `/api/favorites?id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (response.ok || response.status === 404) {
        // 404 también es final feliz: la plantilla ya no está.
        setFavorites((current) => current.filter((item) => item.id !== id));
        setConfirmFavoriteDeleteId(null);
        return;
      }
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      setFavoriteDeleteNotice(data.error ?? "No se pudo borrar la plantilla.");
      setConfirmFavoriteDeleteId(null);
    } catch {
      setFavoriteDeleteNotice("No se pudo borrar la plantilla.");
      setConfirmFavoriteDeleteId(null);
    } finally {
      setFavoriteDeleteBusyId(null);
    }
  }

  /** Orden de la lista de plantillas: último usado, después las más nuevas. */
  const orderedFavorites = useMemo(
    () =>
      [...favorites].sort((a, b) => {
        if (a.lastUsedAt && b.lastUsedAt) {
          return b.lastUsedAt.localeCompare(a.lastUsedAt);
        }
        if (a.lastUsedAt) return -1;
        if (b.lastUsedAt) return 1;
        return 0;
      }),
    [favorites],
  );

  /**
   * Atajos de teclado: T abre gasto, I abre ingreso.
   *
   * Las guardas —no disparar con un modal abierto, no disparar escribiendo en
   * un campo de texto, no robarse Ctrl/Alt/Meta— viven en
   * `shortcutMovementKind` (lib/quick-entry.ts), que es pura y está testeada:
   * acá sólo se traduce el evento del DOM y se abre el modal que la función
   * devuelva. Sin esa separación, "tipear tomate en una nota no puede abrir el
   * modal de gasto" sólo se podría verificar con un navegador.
   */
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const next = shortcutMovementKind(
        {
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          target:
            event.target instanceof HTMLElement
              ? {
                  tagName: event.target.tagName,
                  isContentEditable: event.target.isContentEditable,
                }
              : null,
        },
        { modalOpen: modal !== null || paletteOpen || csvOpen },
      );
      if (!next) return;
      event.preventDefault();
      setModal(next);
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [modal, paletteOpen, csvOpen]);

  /**
   * `Ctrl+K` / `Cmd+K`: abre la paleta. Con un formulario o el importador
   * abierto NO se dispara: abrir la paleta encima perdería de vista (o
   * descartaría) lo que la persona ya cargó. Segundo `Ctrl+K` la cierra.
   */
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const shortcut = isPaletteShortcut({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        isComposing: event.isComposing,
      });
      if (!shortcut) return;

      if (modal !== null || csvOpen) return;

      event.preventDefault();
      setPaletteOpen((current) => !current);
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [modal, csvOpen]);

  /**
   * Deshace el último guardado: reutiliza el DELETE de movimientos que ya
   * existe (sin ruta nueva) y muestra el error del servidor si falla — jamás
   * falla en silencio.
   *
   * Un movimiento protegido (el gasto de una compra en cuotas, por ejemplo) no
   * se puede borrar: en ese caso el aviso se queda con el mensaje y la persona
   * entiende por qué. Un 404, en cambio, también es un final feliz: el
   * movimiento ya no está, que es lo que "Deshacer" buscaba.
   */
  async function undoLastSave() {
    if (!undoToast || undoToast.busy) return;
    setUndoToast({ ...undoToast, busy: true, error: "" });
    try {
      const response = await fetch(
        `/api/transactions?id=${encodeURIComponent(undoToast.movement.id)}`,
        { method: "DELETE" },
      );

      if (response.ok || response.status === 404) {
        setUndoToast(null);
        load();
        return;
      }

      const data = (await response.json().catch(() => ({}))) as { error?: string };
      setUndoToast({
        ...undoToast,
        busy: false,
        error: data.error ?? "No se pudo deshacer.",
      });
    } catch {
      setUndoToast({
        ...undoToast,
        busy: false,
        error: "No se pudo deshacer.",
      });
    }
  }

  // ── Totales del mes ────────────────────────────────────────────────────────
  //
  // Los montos NO se suman acá: llegan ya sumados en la base, sobre el período
  // completo. Acá sólo se derivan las dos cifras de presentación —el resultado y
  // la tasa de ahorro—, que sí son aritmética de la interfaz.
  //
  // Ésta es la corrección de un bug real: antes esto filtraba y sumaba
  // `movements`, que viene topeado a 500 filas. A partir del movimiento 501 los
  // cuatro números grandes del panel quedaban subestimados, y el aviso de
  // truncado aparecía abajo del pliegue, fuera de la vista. Por eso `movements`
  // no figura en las dependencias de este `useMemo`.
  //
  // La aritmética es en CENTAVOS ENTEROS, igual que antes y por el mismo motivo
  // (ver lib/format.ts): los enteros son exactos, los decimales binarios no, y
  // el error se acumula operación por operación.
  const totals = useMemo(() => {
    const incomeCents = toCents(serverTotals.income);
    const expenseCents = toCents(serverTotals.expenses);
    const resultCents = incomeCents - expenseCents;

    // El resultado y la tasa de ahorro AHORA significan algo.
    //
    // En el modelo viejo, cobrar un préstamo entraba como ingreso y la cuota
    // entera como gasto, así que la app reportaba un 49% de ahorro donde el real
    // era 22%. Con las transferencias fuera del cálculo, los dos números que
    // quedan son los verdaderos: la plata que entró de afuera y la que salió.
    const savingRate =
      incomeCents === 0
        ? null
        : ((resultCents / incomeCents) * 100).toFixed(2);

    return {
      income: serverTotals.income,
      /**
       * La parte del ingreso que NO viene de un movimiento: la plata que la
       * persona declaró como ingreso de este mes (la banderita de la cuenta).
       *
       * Viaja APARTE porque la pantalla tiene que poder decir de dónde sale el
       * número: un ingreso que nadie ganó no se puede presentar como "lo que
       * ganaste".
       */
      declared: serverTotals.declaredIncome,
      expenses: serverTotals.expenses,
      result: centsToString(resultCents),
      savingRate,
      incomeCount: serverTotals.incomeCount,
      expenseCount: serverTotals.expenseCount,
      transferTotal: serverTotals.transfers,
      transferCount: serverTotals.transferCount,
      // El flujo de caja viaja TAL CUAL viene del servidor. Derivarlo acá con
      // "ingresos − gastos" mostraría el ahorro con la etiqueta equivocada: el
      // desembolso del préstamo y las cuotas lo mueven sin ser ingreso ni gasto,
      // y la compra con tarjeta es gasto sin moverlo. La fórmula vive en
      // `movementCashFlow` (lib/queries.ts).
      cashFlow: serverTotals.cashFlow,
      positive: resultCents >= 0,
    };
  }, [serverTotals]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return movements.filter((movement) => {
      if (filter !== "ALL" && movement.kind !== filter) return false;

      if (categoryFilter && movement.category?.name !== categoryFilter) {
        return false;
      }

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
  }, [movements, filter, categoryFilter, search]);

  const visibleCategories = useMemo(() => {
    // Sólo las categorías que REALMENTE aparecen este mes. Un filtro con 40
    // opciones donde 35 no tienen resultados es ruido.
    const present = new Set(
      movements.map((m) => m.category?.name).filter((name): name is string => !!name),
    );
    return [...present].sort((a, b) => a.localeCompare(b, "es"));
  }, [movements]);

  const hasFilters = categoryFilter !== "" || search !== "";

  async function remove(id: string) {
    if (deleteBusyId) return;
    setDeleteBusyId(id);
    setDeleteNotice(null);
    try {
      const response = await fetch(`/api/transactions?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });

      if (response.ok || response.status === 404) {
        setConfirmDeleteId(null);
        load();
        return;
      }

      const data = (await response.json().catch(() => ({}))) as { error?: string };
      setConfirmDeleteId(null);
      setDeleteNotice({ id, message: data.error ?? "No se pudo eliminar." });
    } catch {
      setConfirmDeleteId(null);
      setDeleteNotice({ id, message: "No se pudo eliminar." });
    } finally {
      setDeleteBusyId(null);
    }
  }

  /**
   * Activa o desactiva la banderita de una cuenta, sin entrar a editarla.
   *
   * Encenderla declara el saldo inicial como ingreso DEL MES EN CURSO (el
   * "de este mes" de la persona); apagarla lo deja como estaba: plata anterior,
   * que no entra en los ingresos de ningún mes.
   *
   * El doble toque está blindado con `incomeToggleBusyId`: dos PATCH seguidos
   * dejarían la cuenta en un estado que la persona no pidió.
   */
  async function toggleDeclaredIncome(account: AccountBalanceDTO) {
    if (incomeToggleBusyId) return;
    setIncomeToggleBusyId(account.id);
    setIncomeToggleNotice(null);

    try {
      const response = await fetch("/api/accounts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: account.id,
          openingIncomeMonth: account.openingIncomeMonth
            ? null
            : todayCalendar().slice(0, 7),
        }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        setIncomeToggleNotice({
          id: account.id,
          message: data.error ?? "No se pudo cambiar la cuenta.",
        });
        return;
      }

      await load();
    } catch {
      setIncomeToggleNotice({
        id: account.id,
        message: "No se pudo cambiar la cuenta.",
      });
    } finally {
      setIncomeToggleBusyId(null);
    }
  }

  function shiftMonth(delta: number) {    // `shiftPeriod` devuelve el primer día del mes desplazado; el mes es el
    // prefijo. Se usa la función del módulo de fechas y no aritmética de `Date`
    // suelta, que es donde viven los bugs de fin de mes.
    setMonth(shiftPeriod("month", `${month}-01`, delta).slice(0, 7));
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-6 flex flex-col gap-5">
      {/* ── Selector de mes ───────────────────────────────────────────────── */}
      <div className="flex items-center justify-between bg-surface-2 rounded-md px-4 py-3 shadow-sm">
        <button
          id="btn-prev-month"
          onClick={() => shiftMonth(-1)}
          className="px-3 py-1.5 rounded-full hover:bg-surface-3 text-lg"
          aria-label="Mes anterior"
        >
          ←
        </button>
        <div className="text-center">
          {/*
            `first-letter:uppercase` y NO `capitalize`.

            `capitalize` aplica mayúscula a CADA palabra, así que el texto
            "octubre de 2026" se mostraba como "Octubre De 2026". En español los
            meses y el "de" van en minúscula: la preposición capitalizada no es
            un detalle estético, es una falta de ortografía que la app cometía en
            la pantalla principal.
          */}
          <p className="font-bold first-letter:uppercase">{monthLabel}</p>
          <p className="text-xs text-fg-muted">
            {/* Sólo la cantidad total de movimientos. El detalle de
                transferencias vive ahora en la tarjeta de "Flujo de caja":
                repetirlo en los dos lugares sería el mismo número dos veces. */}
            {movements.length}{" "}
            {movements.length === 1 ? "movimiento" : "movimientos"}
          </p>
        </div>
        <button
          id="btn-next-month"
          onClick={() => shiftMonth(1)}
          className="px-3 py-1.5 rounded-full hover:bg-surface-3 text-lg"
          aria-label="Mes siguiente"
        >
          →
        </button>
      </div>

      {/* ── Aviso del generador de recurrencia ───────────────────────────── */}
      {recurrenceRunError && (
        <p
          id="rec-panel-run-error"
          role="alert"
          className="text-xs rounded-md bg-danger/10 text-danger px-4 py-3"
        >
          No se pudo correr el generador de recurrencia: {recurrenceRunError} Los
          números de abajo pueden no incluir vencimientos de hoy.
        </p>
      )}

      {/* ── Bandeja de recurrencia ───────────────────────────────────────── */}
      {/* Un pendiente NO es plata: este aviso no muestra ningún monto, sólo
          la cantidad de promesas esperando decisión. Los montos viven en
          /recurrencia, donde se aceptan o se saltean. */}
      {pendingCount > 0 && (
        <Link
          id="rec-pending-banner"
          href="/recurrencia"
          className="flex items-center justify-between gap-3 bg-warning/10 text-warning rounded-md px-4 py-3 text-sm shadow-sm hover:bg-warning/15 "
        >
          <span>
            <RefreshCw className="size-4" aria-hidden /> {pendingCount}{" "}
            {pendingCount === 1
              ? "ocurrencia de tus reglas espera confirmación"
              : "ocurrencias de tus reglas esperan confirmación"}
            .
          </span>
          <span className="font-bold whitespace-nowrap underline">
            Revisarlas →
          </span>
        </Link>
      )}

      {/* ── Balance del mes ──────────────────────────────────────────────── */}
      {/* Las cuatro tarjetas del mes.

          La fila de cuatro recién entra en 940 px, y no por gusto: el monto
          («+$ 310.000,00») es UNA palabra —no tiene dónde partirse— y a
          30 px de tipografía mide 184 px. Con cuatro tarjetas, tres huecos y
          los 32 px de padding de la página, hace falta 4×(184+32)+68 = 940 px
          para que el monto entre en su tarjeta. Antes entraba en 640 px
          (sm) y el monto se salía de la tarjeta: a 640 la tarjeta mide 143 px
          y el texto se veía cortado.

          A 384 px entran dos columnas (la tarjeta mide 138 px y el monto
          entra justo); por debajo, una sola columna. */}
      <div className="grid grid-cols-1 min-[384px]:grid-cols-2 min-[940px]:grid-cols-4">
        <div className="@container min-w-0 bg-surface-2 rounded-md p-4">
          <p className="text-xs uppercase text-fg-muted">Ingresos</p>
          <p
            className="monto-tarjeta font-extrabold text-success"
            style={{ "--k": factorMonto(formatMoney(totals.income)) } as CSSProperties}
          >
            {formatMoney(totals.income)}
          </p>
          <p className="text-[11px] opacity-80 mt-1">
            {totals.incomeCount}{" "}
            {totals.incomeCount === 1 ? "movimiento" : "movimientos"}
            {totals.declared !== "0.00" && (
              <>
                {" · "}
                <b>{formatMoney(totals.declared)}</b> declarados
              </>
            )}
          </p>
        </div>

        <div className="@container min-w-0 bg-surface-2 rounded-md p-4">
          <p className="text-xs uppercase text-fg-muted">Gastos</p>
          <p
            className="monto-tarjeta font-extrabold text-danger"
            style={{ "--k": factorMonto(formatMoney(totals.expenses)) } as CSSProperties}
          >
            {formatMoney(totals.expenses)}
          </p>
          <p className="text-[11px] opacity-80 mt-1">
            {totals.expenseCount}{" "}
            {totals.expenseCount === 1 ? "movimiento" : "movimientos"}
          </p>
        </div>

        <div
          className="@container min-w-0 bg-surface-2 rounded-md p-4"
        >
          <p className="text-xs uppercase text-fg-muted">Te quedó</p>
          <p
            className={`monto-tarjeta font-extrabold ${totals.positive ? "text-success" : "text-danger"}`}
            style={
              { "--k": factorMonto(formatMoney(totals.result, { withSign: true })) } as CSSProperties
            }
          >
            {formatMoney(totals.result, { withSign: true })}
          </p>
          {/*
            ─────────────────────────────────────────────────────────────────────
            EL TEXTO DE ESTA TARJETA ES LO QUE EVITA EL MALENTENDIDO MÁS CARO
            ─────────────────────────────────────────────────────────────────────
            "Ahorraste −$6.400" se lee como "la app me está descontando el saldo
            inicial de 7.000". No es eso: el ahorro es el FLUJO DEL MES (lo que
            entró menos lo que salió ESTE MES), y el saldo inicial de una cuenta
            es un STOCK que ya existía antes: sólo aparece en el patrimonio.

            Por eso el subtítulo dice las dos cosas: que el número es de este
            mes, y que el saldo inicial no cuenta como ganancia.
          */}
          <p className="text-[11px] opacity-80 mt-1">
            {totals.savingRate !== null ? (
              <>
                {/* La etiqueta cambia con la banderita: la plata declarada
                    cuenta como ingreso del mes, pero nadie la ganó (ya la
                    tenías). Decir "de lo que ganaste" sobre un número que
                    incluye plata declarada sería mentir. */}
                {totals.declared !== "0.00"
                  ? `Ahorraste ${formatPercent(totals.savingRate)} de lo que entró este mes`
                  : `Ahorraste ${formatPercent(totals.savingRate)} de lo que ganaste este mes`}
              </>
            ) : (
              "Sin ingresos este mes"
            )}
          </p>
          <p className="text-[11px] opacity-70 mt-0.5">
            {totals.declared !== "0.00" ? (
              <>
                Incluye <b>{formatMoney(totals.declared)}</b> que declaraste
                como ingreso (ya los tenías).
              </>
            ) : (
              "Es el flujo del mes. El saldo inicial no cuenta como ganancia."
            )}
          </p>
        </div>

        {/*
          ── Flujo de caja ────────────────────────────────────────────────
          La etiqueta es "Flujo de caja" y NUNCA "ahorro": son números
          distintos. Éste es la plata que entró y salió de las cuentas de
          dinero —incluye el desembolso del préstamo y el capital de las
          cuotas, y NO incluye las compras con tarjeta—, y vive acá al lado
          de "Te quedó" para que la diferencia entre liquidez y ahorro se
          vea de un vistazo.

          El detalle muestra la cantidad de transferencias del mes: es la
          información que antes vivía en la línea del encabezado y la que
          explica por qué este número se separa de "Te quedó" (pagar la
          tarjeta, cobrar un préstamo, mover plata entre bolsillos).
        */}
        <div className="@container min-w-0 bg-surface-2 rounded-md p-4">
          <p className="text-xs uppercase text-fg-muted">Flujo de caja</p>
          <p
            className="monto-tarjeta font-extrabold text-transfer"
            style={
              { "--k": factorMonto(formatMoney(totals.cashFlow, { withSign: true })) } as CSSProperties
            }
          >
            {formatMoney(totals.cashFlow, { withSign: true })}
          </p>
          <p className="text-[11px] opacity-80 mt-1">
            {totals.transferCount === 0
              ? "Sin transferencias este mes"
              : `${totals.transferCount} ${
                  totals.transferCount === 1 ? "transferencia" : "transferencias"
                } entre tus cuentas`}
          </p>
          {/* El mismo criterio que en "Te quedó": los dos números son del MES.
              La diferencia entre liquidez y ahorro se ve de un vistazo, pero
              sólo si los dos dicen que son de este mes. */}
          <p className="text-[11px] opacity-70 mt-0.5">
            La plata que entró y salió de tus cuentas este mes.
          </p>
          {/* ─────────────────────────────────────────────────────────────────
              LA NOTA DE LA PLATA DECLARADA (la coherencia de las dos tarjetas)

              Con la banderita encendida, "Te quedó" da +$ 600,00 y "Flujo de
              caja" da -$ 6.400,00. Los dos números son ciertos y NO se
              contradicen: el flujo de caja es el MOVIMIENTO del dinero (325.000
              entraron y 331.400 salieron) y la plata declarada no es un
              movimiento: ya estaba en las cuentas.

              Pero al lado de la otra tarjeta, un -$ 6.400,00 al lado de un
              +$ 600,00 parece un error. La diferencia es exactamente la plata
              declarada, y por eso la nota la dice: NO cambia la fórmula del
              flujo (es el movimiento del dinero), sólo explica por qué el flujo
              no coincide con el ahorro.
              ───────────────────────────────────────────────────────────────── */}
          {totals.declared !== "0.00" && (
            <p className="text-[11px] opacity-70 mt-0.5">
              No cuenta {formatMoney(totals.declared)} que declaraste: esa
              plata ya estaba en tus cuentas.
            </p>
          )}
        </div>
      </div>

      {/* ── Patrimonio neto ──────────────────────────────────────────────── */}
      {netWorth && (
        <div className="bg-surface-2 rounded-md px-4 py-4 shadow-sm">
          <div className="flex items-baseline justify-between flex-wrap gap-2">
            <div>
              <p className="text-xs uppercase text-fg-muted tracking-wide">
                Patrimonio neto
              </p>
              <p
                className={`text-2xl font-extrabold ${
                  Number(netWorth.net) < 0 ? "text-warning" : ""
                }`}
              >
                {formatMoney(netWorth.net)}
              </p>
            </div>
            <div className="text-right text-sm">
              <p className="text-fg-muted">
                Tenés <b className="text-success">{formatMoney(netWorth.assets)}</b>
              </p>
              <p className="text-fg-muted">
                Debés <b className="text-danger">{formatMoney(netWorth.liabilities)}</b>
              </p>
            </div>
          </div>

          {/*
            ── Las cuentas: la tarjeta de cada una ──────────────────────────
            Cada cuenta es una ficha con su nombre, su saldo y —si es una
            cuenta de DINERO con plata— la banderita: «contar este saldo como
            ingreso de este mes». La banderita está ACÁ (y no sólo en el
            formulario de alta) para poder activarla sin entrar a editar.

            La banderita sólo se ofrece donde tiene sentido: una tarjeta o un
            préstamo NO pueden declarar su saldo como ingreso (su saldo
            negativo es una deuda). La API también lo rechaza, con el mismo
            criterio.
          */}
          {accounts.length > 0 && (
            <div
              id="account-cards"
              className="mt-3 pt-3 border-t border-line grid grid-cols-1 min-[420px]:grid-cols-2 gap-2"
            >
              {accounts.map((account) => {
                const declarada = account.openingIncomeMonth !== null;
                const puedeDeclarar =
                  (account.kind === "CASH" || account.kind === "BANK") &&
                  toCents(account.openingBalance) > 0;

                return (
                  <div
                    key={account.id}
                    className="@container min-w-0 rounded-md bg-surface bg-surface-3/60 px-3 py-2 flex flex-col gap-1"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[11px] text-fg-muted truncate">
                          {account.name}
                          {declarada && (
                            <span className="text-transfer ">
                              {" "}
                              · ingreso de{" "}
                              {formatCalendar(
                                `${account.openingIncomeMonth}-01`,
                                LOCALE,
                                { month: "short", year: "numeric" },
                              )}
                            </span>
                          )}
                        </p>
                        <p
                          className={`monto-ficha font-bold ${
                            account.isLiability ? "text-danger" : ""
                          }${claseMontoLargo(
                            formatMoney(
                              account.isLiability
                                ? account.debt ?? "0.00"
                                : account.balance,
                            ),
                          )}`}
                        >
                          {account.isLiability
                            ? formatLiability(account.debt ?? "0.00")
                            : formatMoney(account.balance)}
                        </p>
                      </div>

                      {puedeDeclarar && (
                        <button
                          type="button"
                          id={`acc-income-toggle-${account.id}`}
                          role="checkbox"
                          aria-checked={declarada}
                          aria-label={
                            declarada
                              ? `Dejar de contar el saldo de ${account.name} como ingreso`
                              : `Contar el saldo de ${account.name} como ingreso de este mes`
                          }
                          title={
                            declarada
                              ? "Dejar de contarlo como ingreso"
                              : "Contarlo como ingreso de este mes"
                          }
                          onClick={() => toggleDeclaredIncome(account)}
                          disabled={incomeToggleBusyId !== null}
                          className={`grid h-11 w-11 shrink-0 place-items-center rounded-lg border-2 transition-colors ${
                            declarada
                              ? "border-transfer bg-transfer text-primary-fg"
                              : "border-line-strong text-fg-subtle"
                          } disabled:opacity-50`}
                        >
                          <Check className="size-5" aria-hidden />
                        </button>
                      )}
                    </div>

                    {incomeToggleNotice?.id === account.id && (
                      <p
                        role="alert"
                        className="text-[11px] text-danger "
                      >
                        {incomeToggleNotice.message}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/*
            ── Evolución del patrimonio ─────────────────────────────────────
            La serie del número de arriba: de dónde viene el patrimonio de hoy.

            Una grilla de números y no un gráfico por dos razones concretas:
            en la pantalla de 1024×600 los 12 meses entran en dos filas sin
            empujar "Movimientos" media pantalla hacia abajo, y cada mes queda
            como TEXTO real — un test puede afirmar un monto exacto de un mes
            puntual contra su `id`, cosa que no se puede hacer leyendo los
            `text` de un SVG. El gráfico de líneas lo va a pedir /analisis el
            día que haga falta la forma, no el número.

            El último mes es el actual y llega marcado `partial`: su foto es
            "a hoy", no a fin de mes, así que se etiqueta "en curso" en vez de
            mostrarse como un mes cerrado igual a los demás. La variación
            contra el mes anterior es aritmética de presentación entre dos
            valores que ya vienen calculados del servidor (en centavos
            enteros, como todo lo que se resta en el cliente).
          */}
          {netWorthSeries.length > 0 && (
            <div className="mt-3 pt-3 border-t border-line ">
              <p className="text-xs uppercase text-fg-muted tracking-wide">
                Evolución · últimos {netWorthSeries.length} meses
              </p>

              <div
                id="networth-series"
                className="mt-2 grid grid-cols-3 md:grid-cols-6 gap-2"
              >
                {netWorthSeries.map((point, index) => {
                  const previous = index > 0 ? netWorthSeries[index - 1] : null;
                  const deltaCents = previous
                    ? toCents(point.net) - toCents(previous.net)
                    : 0;

                  return (
                    <div
                      key={point.month}
                      id={`networth-month-${point.month}`}
                      className="@container rounded-md bg-surface bg-surface-3/60 px-2 py-1.5"
                    >
                      <p className="text-[11px] text-fg-muted">
                        {formatCalendar(`${point.month}-01`, LOCALE, {
                          month: "short",
                          year: "numeric",
                        })}
                        {point.partial && (
                          <span className="text-fg-subtle"> · en curso</span>
                        )}
                      </p>
                      {/*
                        El monto de la ficha tiene que ENTRAR en la ficha: a
                        320 px la caja mide 64 y «$ 100.000,00» mide 82 con
                        cuerpo de 14. El cuerpo de letra acompaña al ancho de
                        la FICHA (una container query, el mismo mecanismo de
                        las tarjetas grandes) y no al del device: el monto se
                        achica lo JUSTO para entrar y, en un teléfono de 480
                        px o más, se ve EXACTAMENTE como antes. Los montos
                        largos (13+ caracteres) además se pueden partir.
                      */}
                      <p
                        className={`monto-ficha font-bold ${
                          toCents(point.net) < 0 ? "text-warning" : ""
                        }${claseMontoLargo(formatMoney(point.net))}`}
                        style={
                          {
                            "--k": factorMontoFicha(formatMoney(point.net)),
                          } as CSSProperties
                        }
                      >
                        {formatMoney(point.net)}
                      </p>
                      {previous && (
                        <p
                          className={`monto-ficha--chico ${
                            deltaCents > 0
                              ? "text-success"
                              : deltaCents < 0
                                ? "text-danger"
                                : "text-fg-subtle"
                          }`}
                          style={
                            {
                              "--k": factorMontoFicha(
                                formatMoney(centsToString(deltaCents), {
                                  withSign: true,
                                }),
                              ),
                            } as CSSProperties
                          }
                        >
                          {formatMoney(centsToString(deltaCents), { withSign: true })}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              <p className="mt-2 text-[11px] text-fg-subtle">
                Fotos al cierre de cada mes; el mes en curso, a hoy. La
                variación es contra el mes anterior.
              </p>
            </div>
          )}

          {/*
            ── Reconciliación del mes: ΔPatrimonio = Ahorro ──────────────────
            El control de integridad del mes MOSTRADO (no del mes de hoy): la
            variación del patrimonio contra el ahorro del mes, los dos caminos
            al mismo número.

            Los tres valores llegan calculados del servidor; acá sólo se
            eligen las palabras y el color. Cuando NO cuadra, la diferencia se
            muestra igual de visible que cuando cuadra —es un control, no un
            adorno—: el sub de la celda dice "cuadra al centavo" o "no cuadra"
            sin matices, y hay un aviso aparte con el número exacto.

            La ventana que se compara es la misma de los dos lados (si el mes
            está en curso, las dos fotos se cortan a hoy), y el texto lo dice:
            comparar una variación parcial contra un ahorro de mes completo
            daría una falsa alarma.
          */}
          {reconciliation && (
            <div
              id="reconciliation"
              className="mt-3 pt-3 border-t border-line "
            >
              <p className="text-xs uppercase text-fg-muted tracking-wide">
                Reconciliación ·{" "}
                {formatCalendar(`${reconciliation.month}-01`, LOCALE, {
                  month: "long",
                  year: "numeric",
                })}
                {reconciliation.partial && (
                  <span className="text-fg-subtle"> · en curso</span>
                )}
              </p>

              <div className="mt-2 grid grid-cols-3 gap-2">
                <div className="@container rounded-md bg-surface bg-surface-3/60 px-2 py-1.5">
                  <p className="text-[11px] text-fg-muted">Δ Patrimonio</p>
                  <p
                    id="reconciliation-delta"
                    className={`monto-ficha font-bold ${
                      toCents(reconciliation.netDelta) < 0 ? "text-warning" : ""
                    }${claseMontoLargo(formatMoney(reconciliation.netDelta, { withSign: true }))}`}
                    style={
                      {
                        "--k": factorMontoFicha(
                          formatMoney(reconciliation.netDelta, { withSign: true }),
                        ),
                      } as CSSProperties
                    }
                  >
                    {formatMoney(reconciliation.netDelta, { withSign: true })}
                  </p>
                  <p
                    className={`text-[11px] text-fg-subtle${claseMontoLargo(
                      `${formatMoney(reconciliation.netStart)}${formatMoney(reconciliation.netEnd)}`,
                    )}`}
                  >
                    de {formatMoney(reconciliation.netStart)} a{" "}
                    {formatMoney(reconciliation.netEnd)}
                  </p>
                </div>

                <div className="@container rounded-md bg-surface bg-surface-3/60 px-2 py-1.5">
                  <p className="text-[11px] text-fg-muted">Ahorro del mes</p>
                  <p
                    id="reconciliation-saving"
                    className={`monto-ficha font-bold ${
                      toCents(reconciliation.saving) < 0 ? "text-warning" : ""
                    }${claseMontoLargo(formatMoney(reconciliation.saving, { withSign: true }))}`}
                    style={
                      {
                        "--k": factorMontoFicha(
                          formatMoney(reconciliation.saving, { withSign: true }),
                        ),
                      } as CSSProperties
                    }
                  >
                    {formatMoney(reconciliation.saving, { withSign: true })}
                  </p>
                  <p className="text-[11px] text-fg-subtle">
                    {reconciliation.declaredIncome !== "0.00"
                      ? "ingresos del mes − gastos del mes"
                      : "ingresos ganados − gastos consumidos"}
                  </p>
                </div>

                <div className="@container rounded-md bg-surface bg-surface-3/60 px-2 py-1.5">
                  <p className="text-[11px] text-fg-muted">Diferencia</p>
                  <p
                    id="reconciliation-difference"
                    className={`monto-ficha font-bold ${
                      reconciliation.balanced ? "text-success" : "text-danger"
                    }`}
                    style={
                      {
                        "--k": factorMontoFicha(
                          formatMoney(reconciliation.difference, {
                            withSign: !reconciliation.balanced,
                          }),
                        ),
                      } as CSSProperties
                    }
                  >
                    {/* Con signo sólo cuando NO cuadra: "+$ 0,00" en un cero
                        que cuadra es ruido, y en cambio el signo de una
                        diferencia real es parte de lo que hay que ver. */}
                    {formatMoney(reconciliation.difference, {
                      withSign: !reconciliation.balanced,
                    })}
                  </p>
                  <p
                    className={`text-[11px] ${
                      reconciliation.balanced ? "text-success" : "text-danger"
                    }`}
                  >
                    {reconciliation.balanced
                      ? reconciliation.declaredIncome !== "0.00"
                        ? `cuadra con ${formatMoney(reconciliation.declaredIncome)} declarados`
                        : "cuadra al centavo"
                      : "no cuadra"}
                  </p>
                </div>
              </div>

              {/*
                ── La plata declarada: la diferencia que NO es un error ───────
                Declarar $ 7.000 que ya tenías hace que el patrimonio del mes
                baje 6.400 (los gastos) y que el ahorro del mes sea +600. Los
                dos números son ciertos: la plata declarada YA estaba en el
                patrimonio, y ahora además cuenta como ingreso del mes. Por
                eso la app lo EXPLICA: sin esta nota, la persona vería un
                "cuadra" que no entiende.
              */}
              {reconciliation.declaredIncome !== "0.00" && (
                <p
                  id="reconciliation-declared"
                  className="mt-2 text-xs rounded-lg bg-transfer/10 text-transfer px-3 py-2"
                >
                  Declaraste <b>{formatMoney(reconciliation.declaredIncome)}</b>{" "}
                  que ya tenías: esa plata entra como ingreso de este mes, pero
                  ya estaba en tu patrimonio. Por eso el patrimonio Bajó{" "}
                  {formatMoney(reconciliation.netDelta, { withSign: true })} y el
                  ahorro del mes es {formatMoney(reconciliation.saving, { withSign: true })}.
                </p>
              )}

              {!reconciliation.balanced && (
                <p
                  role="alert"
                  className="mt-2 text-xs rounded-lg bg-danger/10 text-danger px-3 py-2"
                >
                  <b>No cuadra</b>: los dos caminos difieren en{" "}
                  {formatMoney(reconciliation.difference, { withSign: true })}. Algo
                  movió los saldos sin pasar por los movimientos, o los movimientos
                  sin mover los saldos. Revisalo: este control existe para que un
                  error no pase en silencio.
                </p>
              )}

              <p className="mt-2 text-[11px] text-fg-subtle">
                Dos caminos independientes al mismo número: los saldos y los
                movimientos.
                {reconciliation.partial
                  ? ` El mes está en curso: las dos fotos se cortan al ${formatCalendar(
                      reconciliation.cutAt,
                    )}, no a fin de mes.`
                  : ""}
              </p>
            </div>
          )}

          <button
            id="btn-add-account"
            onClick={() => setModal("ACCOUNT")}
            className="mt-3 text-xs underline text-fg-muted hover:text-fg hover:text-fg-muted"
          >
            + Agregar cuenta
          </button>
        </div>
      )}

      {/* ── Deudas ───────────────────────────────────────────────────────── */}
      {/*
        Deudas del mes MOSTRADO: deuda viva al corte, progreso del capital,
        interés pagado, cuotas restantes y DTI. Los números llegan calculados
        del servidor (`DebtReportDTO`); acá sólo se eligen las palabras.

        Dos casos que la interfaz cuenta sin disfrazarlos:
          · Una tarjeta no tiene plan de cuotas (`plan: null`): dice "sin
            plan" en vez de inventarle cuotas que nadie pactó.
          · Sin ingresos no hay DTI (`percent: null`): "no se puede calcular",
            no un 0% que afirmaría algo falso.
      */}
      {debtReport && debtReport.rows.length > 0 && (
        <div className="bg-surface-2 rounded-md px-4 py-4 shadow-sm">
          <div className="flex items-baseline justify-between flex-wrap gap-2">
            <div>
              <p className="text-xs uppercase text-fg-muted tracking-wide">
                Deudas ·{" "}
                {formatCalendar(`${debtReport.month}-01`, LOCALE, {
                  month: "long",
                  year: "numeric",
                })}
                {debtReport.partial && (
                  <span className="text-fg-subtle"> · en curso</span>
                )}
              </p>
              <p className="text-2xl font-extrabold text-danger">
                {formatMoney(debtReport.totalDebt)}
              </p>
            </div>
            <p className="text-[11px] text-fg-subtle text-right">
              deuda viva al {formatCalendar(debtReport.cutAt)}
              {debtReport.partial ? " · el mes sigue" : ""}
            </p>
          </div>

          <div
            id="debt-report"
            className="mt-3 pt-3 border-t border-line divide-y divide-line "
          >
            {debtReport.rows.map((row) => (
              <div
                key={row.accountId}
                id={`debt-${row.accountId}`}
                className="py-2.5"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-sm">
                    {row.name}
                    {row.archived && (
                      <span className="text-[11px] text-fg-subtle">
                        {" "}
                        · archivada
                      </span>
                    )}
                  </p>
                  {/* `formatLiability` elige la palabra según el lado: "debe
                      $ 50.000,00" o "a favor $ 50.000,00" — nunca un monto con
                      signo que se lea como un error. Sin `withSign`: un "+$" en
                      esta tarjeta es ruido. */}
                  <p className="text-sm font-bold text-danger">
                    {formatLiability(row.debt)}
                  </p>
                </div>

                {row.plan ? (
                  <div className="mt-1.5">
                    <div className="h-1.5 rounded-full bg-surface-3 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-danger"
                        style={{ width: `${row.progressPercent}%` }}
                      />
                    </div>
                    <p className="mt-1 text-[11px] text-fg-muted">
                      cuota {formatMoney(row.plan.payment)} · {row.plan.paidCount}{" "}
                      de {row.plan.installmentCount} cubiertas ·{" "}
                      {row.plan.remainingCount === 0
                        ? "sin cuotas pendientes"
                        : `faltan ${row.plan.remainingCount}`}
                    </p>
                    <p className="text-[11px] text-fg-subtle">
                      capital devuelto {formatMoney(row.capitalPaid ?? "0.00")} (
                      {row.progressPercent}%) · interés pagado{" "}
                      {formatMoney(row.interestPaid ?? "0.00")}
                    </p>
                  </div>
                ) : (
                  <p className="mt-1 text-[11px] text-fg-subtle">
                    sin plan de cuotas: la tarjeta no pacta una cuota fija
                  </p>
                )}
              </div>
            ))}
          </div>

          {/*
            El DTI: la cuota mensual de los planes con cuotas pendientes sobre
            el ingreso del mes. Es un indicador, describe —no dictamina—, y
            cuando el mes no tuvo ingresos llega `null`: la frase lo dice en vez
            de mostrar un número que no existe.
          */}
          <div
            id="debt-dti"
            className="mt-3 pt-3 border-t border-line "
          >
            <div className="flex items-baseline justify-between flex-wrap gap-1">
              <p className="text-xs uppercase text-fg-muted tracking-wide">
                DTI · ingresos comprometidos
              </p>
              <p className="text-sm font-bold">
                {debtReport.dti.percent === null ? (
                  <span className="text-fg-subtle">no se puede calcular</span>
                ) : (
                  <span className="text-danger">
                    {formatPercent(debtReport.dti.percent)}
                  </span>
                )}
              </p>
            </div>
            <p className="text-[11px] text-fg-muted">
              {debtReport.dti.percent === null
                ? "No hubo ingresos este mes: sin ingreso, el DTI no se puede calcular."
                : `Cuotas por ${formatMoney(debtReport.dti.monthlyCommitment)} sobre ${formatMoney(debtReport.dti.income)} de ingresos.`}
            </p>
            <p className="text-[11px] text-fg-subtle">
              {debtReport.dti.planCount === 0
                ? "Ningún plan con cuotas pendientes."
                : `${debtReport.dti.planCount} ${
                    debtReport.dti.planCount === 1 ? "plan" : "planes"
                  } con cuotas pendientes.`}{" "}
              {/* El denominador del DTI es el ingreso DEL MES, que con la
                  banderita encendida incluye la plata declarada: esa plata
                  nadie la ganó, así que decir «ingresos ganados» sería
                  mentir. Con la banderita apagada el texto es el de siempre. */}
              {totals.declared !== "0.00"
                ? "Cuota mensual de los planes ÷ ingresos del mes."
                : "Cuota mensual de los planes ÷ ingresos ganados del mes."}
            </p>
          </div>
        </div>
      )}

      {/* ── Botones principales ──────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-3">
        <button
          id="btn-income"
          onClick={() => openMovement("INCOME")}
          className="rounded-md bg-success hover:bg-success/90 text-primary-fg font-bold py-5 shadow-lg active:scale-[0.98] transition"
        >
          ＋ Ingreso
          <span className="block text-[11px] font-normal opacity-80 mt-1">
            Sueldo, ventas…
          </span>
        </button>
        <button
          id="btn-expense"
          onClick={() => openMovement("EXPENSE")}
          className="rounded-md bg-danger hover:bg-danger/90 text-primary-fg font-bold py-5 shadow-lg active:scale-[0.98] transition"
        >
          － Gasto
          <span className="block text-[11px] font-normal opacity-80 mt-1">
            Comida, alquiler…
          </span>
        </button>
        <button
          id="btn-transfer"
          onClick={() => openMovement("TRANSFER")}
          className="rounded-md bg-transfer hover:bg-transfer/90 text-primary-fg font-bold py-5 shadow-lg active:scale-[0.98] transition"
        >
          ⇄ Transferir
          <span className="block text-[11px] font-normal opacity-80 mt-1">
            Entre tus cuentas
          </span>
        </button>
      </div>

      {/* ── Plantillas y entrada a la carga inteligente ──────────────────── */}
      {/* No entran en el formulario de carga rápida: son un punto de entrada
          propio. Una plantilla no es un movimiento y un CSV no es una carga
          manual; mezclarlos haría más lento el camino típico. */}
      <div
        id="quick-extras"
        className="bg-surface-2 rounded-md px-4 py-4 shadow-sm"
      >
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <h2 className="font-bold">Plantillas</h2>
            <p className="text-[11px] text-fg-muted">
              {orderedFavorites.length} de {favoritesMax} · un toque para
              precargar el formulario
            </p>
          </div>
          <div className="flex gap-2">
            <button
              id="btn-import-csv"
              type="button"
              onClick={() => setCsvOpen(true)}
              className="rounded-md border border-line-strong px-3 py-1.5 text-xs font-medium hover:bg-surface-3 "
            >
              <Import className="size-4" aria-hidden /> Importar CSV
            </button>
            <button
              id="btn-palette"
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="rounded-lg bg-primary text-primary-fg px-3 py-1.5 text-xs font-bold"
            >
              ⌘ Buscar
            </button>
          </div>
        </div>

        {favoriteDeleteNotice && (
          <p
            id="favorite-delete-notice"
            role="alert"
            className="mt-2 text-xs rounded-lg bg-warning/10 text-warning px-3 py-2"
          >
            {favoriteDeleteNotice}
          </p>
        )}

        {orderedFavorites.length === 0 ? (
          <p id="favorites-empty" className="mt-3 text-xs text-fg-muted">
            Todavía no hay plantillas. Abrí un movimiento y usá “Guardar como
            plantilla” para guardar el formulario completo.
          </p>
        ) : (
          <div id="favorites-list" className="mt-3 flex flex-wrap gap-2">
            {orderedFavorites.map((favorite) => {
              const blocked =
                favorite.account.archived ||
                (favorite.kind === "TRANSFER" &&
                  (favorite.toAccount?.archived ?? true));

              if (confirmFavoriteDeleteId === favorite.id) {
                return (
                  <div
                    key={favorite.id}
                    id={`favorite-delete-panel-${favorite.id}`}
                    className="flex items-center gap-2 rounded-full bg-warning/10 text-warning px-3 py-1.5 text-xs"
                  >
                    <span>¿Borrar “{favorite.name}”?</span>
                    <button
                      id={`favorite-delete-confirm-${favorite.id}`}
                      type="button"
                      onClick={() => void deleteFavorite(favorite.id)}
                      disabled={favoriteDeleteBusyId !== null}
                      className="rounded-full bg-danger hover:bg-danger/90 text-primary-fg px-2 py-0.5 font-bold disabled:opacity-50"
                    >
                      {favoriteDeleteBusyId === favorite.id ? "…" : "Sí"}
                    </button>
                    <button
                      id={`favorite-delete-cancel-${favorite.id}`}
                      type="button"
                      onClick={() => setConfirmFavoriteDeleteId(null)}
                      disabled={favoriteDeleteBusyId !== null}
                      className="rounded-full border border-warning/40 px-2 py-0.5 font-medium disabled:opacity-50"
                    >
                      No
                    </button>
                  </div>
                );
              }

              return (
                <div
                  key={favorite.id}
                  className={`flex items-stretch rounded-full border border-line border-line-strong overflow-hidden ${
                    blocked ? "opacity-50" : ""
                  }`}
                >
                  <button
                    id={`favorite-${favorite.id}`}
                    type="button"
                    disabled={blocked}
                    onClick={() => openMovement(favorite.kind, favorite)}
                    title={
                      blocked
                        ? "La cuenta de esta plantilla está archivada"
                        : `Usar plantilla ${favorite.name}`
                    }
                    className="px-3 py-1.5 text-left hover:bg-surface-3 disabled:cursor-not-allowed"
                  >
                    <span className="block text-xs font-semibold">
                      {favorite.name}
                    </span>
                    <span className="block text-[10px] text-fg-muted">
                      {MOVEMENT_KIND_LABEL[favorite.kind]}
                      {favorite.amount ? ` · ${formatMoney(favorite.amount)}` : ""}
                      {blocked ? " · cuenta archivada" : ""}
                    </span>
                  </button>
                  <button
                    id={`favorite-delete-${favorite.id}`}
                    type="button"
                    onClick={() => {
                      setConfirmFavoriteDeleteId(favorite.id);
                      setFavoriteDeleteNotice("");
                    }}
                    aria-label={`Borrar plantilla ${favorite.name}`}
                    className="px-2 text-fg-subtle hover:text-danger hover:bg-danger/10 "
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Los atajos se anuncian acá para que existan para quien no los conoce;
          las guardas (no disparar escribiendo, ni con un modal abierto) viven
          en lib/quick-entry.ts, testeadas. */}
      <p className="-mt-3 text-center text-[11px] text-fg-subtle">
        Atajos:{" "}
        <kbd className="rounded-md border border-line-strong px-1">
          T
        </kbd>{" "}
        gasto ·{" "}
        <kbd className="rounded-md border border-line-strong px-1">
          I
        </kbd>{" "}
        ingreso ·{" "}
        <kbd className="rounded-md border border-line-strong px-1">
          Ctrl
        </kbd>{" "}
        +{" "}
        <kbd className="rounded-md border border-line-strong px-1">
          K
        </kbd>{" "}
        buscar
      </p>

      {/* ── Lista de movimientos ─────────────────────────────────────────── */}
      <div className="bg-surface-2 rounded-md shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-4 pt-4 flex-wrap gap-2">
          <h2 className="font-bold">Movimientos del mes</h2>
          {/* Los filtros envuelven: en 320 px los cuatro botones miden 315 px
              y no entran en la tarjeta (288 px), así que el último quedaba
              cortado. */}
          <div className="flex flex-wrap gap-1 text-sm">
            {(["ALL", "INCOME", "EXPENSE", "TRANSFER"] as const).map((option) => (
              <button
                key={option}
                id={`filter-${option}`}
                onClick={() => {
                  setFilter(option);
                  setCategoryFilter("");
                }}
                className={`px-3 py-1.5 rounded-full ${
                  filter === option
                    ? "bg-primary text-primary-fg "
                    : "hover:bg-surface-3 "
                }`}
              >
                {option === "ALL" ? "Todos" : MOVEMENT_KIND_LABEL[option]}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-2 px-4 pt-3">
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            aria-label="Filtrar por categoría"
            className="flex-1 rounded-md border border-line-strong bg-surface-3 px-3 py-2 text-sm outline-none [&>option]:bg-surface-2 [&>option]:text-fg [&>option]:bg-surface-3 "
          >
            <option value="">Todas las categorías</option>
            {visibleCategories.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>

          <input
            id="mov-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar en notas, categorías o cuentas…"
            className="flex-1 rounded-md border border-line-strong bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-focus"
          />

          {hasFilters && (
            <button
              onClick={() => {
                setCategoryFilter("");
                setSearch("");
              }}
              className="text-sm px-3 py-2 rounded-md hover:bg-surface-3 text-fg-muted"
            >
              Limpiar
              <X className="size-4 inline-block align-[-2px] ml-1" aria-hidden />
            </button>
          )}
        </div>

        {truncated && (
          <p
            role="alert"
            className="mx-4 mt-3 text-xs rounded-lg bg-warning/10 text-warning px-3 py-2"
          >
            Este mes tiene más de {MOVEMENTS_MAX_ROWS} movimientos, así que la
            lista muestra sólo los primeros {MOVEMENTS_MAX_ROWS}. Los totales de
            arriba <strong>sí</strong> son del mes completo —se suman en la base,
            no en el navegador—, así que el único número incompleto es esta lista.
          </p>
        )}

        <div className="p-4 flex flex-col gap-2">
          {loading && (
            <p className="text-center text-fg-muted py-8">Cargando…</p>
          )}

          {!loading && loadError && (
            <p
              role="alert"
              className="text-center text-danger py-8 px-4"
            >
              {loadError}
            </p>
          )}

          {!loading && !loadError && visible.length === 0 && movements.length === 0 && (
            <div className="text-center py-10 text-fg-muted">
              <p className="mb-2"><Coins className="size-10 inline-block" aria-hidden /></p>
              <p className="font-medium">Sin movimientos este mes</p>
              <p className="text-sm mt-1">
                {accounts.length === 0 ? (
                  <>
                    Empezá creando una cuenta con{" "}
                    <b className="text-transfer">+ Agregar cuenta</b>.
                  </>
                ) : (
                  <>
                    Tocá <b className="text-success">＋ Ingreso</b>,{" "}
                    <b className="text-danger">－ Gasto</b> o{" "}
                    <b className="text-transfer">⇄ Transferir</b>.
                  </>
                )}
              </p>
            </div>
          )}

          {!loading && visible.length === 0 && movements.length > 0 && (
            <div className="text-center py-10 text-fg-muted">
              <p className="mb-2"><Search className="size-10 inline-block" aria-hidden /></p>
              <p className="font-medium">Sin movimientos con esos filtros</p>
              <button
                onClick={() => {
                  setFilter("ALL");
                  setCategoryFilter("");
                  setSearch("");
                }}
                className="text-sm mt-2 underline text-success"
              >
                Limpiar filtros
              </button>
            </div>
          )}

          {visible.map((movement) => {
            const style = KIND_ROW_STYLE[movement.kind];
            const isTransfer = movement.kind === "TRANSFER";
            const notice = deleteNotice?.id === movement.id ? deleteNotice : null;

            return (
              <div
                key={movement.id}
                className="@container border border-line rounded-md px-3 py-2.5"
              >
                {/* La fila se parte cuando la TARJETA es angosta: la variante
                    `angosta:` es una container query (el corte es por el ancho
                    de la tarjeta, no por el del device) y el 24 rem vive en un
                    solo lugar, en el `@custom-variant` del CSS global.

                    `mov-fila`, `mov-texto`, `mov-derecha`, `mov-monto` y
                    `mov-borrar` son MARCAS, no clases de estilo: NO tienen
                    CSS (el estilo va entero en las utilidades de Tailwind) y
                    están para que las pruebas puedan apuntar a la fila
                    (`scripts/tester-responsive/14-filas-y-fichas.mjs`).

                    POR QUÉ NO SON CLASES: una clase sin CSS es una clase
                    fantasma: en el markup parece que hay un estilo que
                    alguien va a escribir después, y ese «alguien» lo
                    escribiría en el CSS global — que es justo lo que la
                    ronda «cero CSS suelto» vino a eliminar. Si alguna vez
                    estas filas necesitan estilo, el estilo va en utilidades
                    de Tailwind (una clase sin CSS que no haga nada no se
                    distingue de una clase con CSS, y ésa es la trampa).

                    Y si alguien intenta escribirlo en el CSS global, el
                    candado lo rechaza: `npm run check:css` falla con
                    «selector de clase dentro de @layer base» o «selector
                    suelto». */}
                <div className="mov-fila flex items-start gap-3 angosta:flex-wrap">
                  <div
                    className={`w-10 h-10 shrink-0 rounded-full flex items-center justify-center text-lg ${style.bubble}`}
                  >
                    <style.icon className="size-4" aria-hidden />
                  </div>

                  <div className="mov-texto flex-1 min-w-0 angosta:min-w-32">
                    <p className="font-semibold truncate">
                      {isTransfer ? (
                        <>
                          {movement.account.name}
                          <span className="mx-1.5 text-transfer">→</span>
                          {movement.toAccount?.name ?? "?"}
                        </>
                      ) : (
                        movement.category?.name ?? "Sin categoría"
                      )}
                      {/* Marca de origen: esto lo posteó una regla, no se cargó
                          a mano (`recurrenceRuleId != null` ⇔ regla, la
                          equivalencia que documenta el esquema). Es identidad,
                          no plata: no cambia ningún número. */}
                      {movement.recurrenceRuleId && (
                        <span className="ml-2 align-middle text-[10px] uppercase font-bold rounded-full bg-warning/10 text-warning px-1.5 py-0.5">
                          <RefreshCw className="size-4" aria-hidden /> regla
                        </span>
                      )}
                    </p>

                    <p className="text-xs text-fg-muted break-words">
                      {/* `formatDayLabel` parsea el string de calendario con
                          componentes locales. Usar `new Date(...)` sobre el string
                          mostraría el día anterior. */}
                      {formatDayLabel(movement.date)}
                      {!isTransfer && <> · {movement.account.name}</>}
                    </p>

                    {movement.description && (
                      <p className="mt-1 text-sm leading-snug whitespace-pre-wrap break-words bg-surface bg-surface-3/60 rounded-lg px-2.5 py-1.5">
                        <StickyNote className="size-4" aria-hidden /> {movement.description}
                      </p>
                    )}
                  </div>

                  {/*
                    El monto y la papelera van JUNTOS en su propio grupo
                    (`.mov-derecha`): sueltos, el reparto de líneas puede
                    meterlos en la misma línea que el texto (que queda con su
                    ancho MÍNIMO y se estruja: medido, 53 px a 375 px de
                    device) o dejar la papelera sola en una tercera línea.
                    Como grupo, bajan juntos a su línea cuando la tarjeta
                    es angosta y quedan como estaban cuando hay lugar.

                    `angosta:flex-1 angosta:basis-full` es el `flex: 1 1 100%`
                    de antes (que los baja a su propia línea) y
                    `angosta:justify-end` los alinea a la derecha.
                  */}
                  <div className="mov-derecha flex items-start gap-3 shrink-0 angosta:flex-1 angosta:basis-full angosta:justify-end">
                  <p
                    className={`mov-monto font-extrabold pt-1 ${style.amount}${
                      montoLargo(
                        `${movement.kind === "INCOME" ? "+" : movement.kind === "EXPENSE" ? "−" : ""}${formatMoney(movement.amount)}`,
                      )
                        ? " min-w-0 break-all"
                        : " whitespace-nowrap"
                    }`}
                  >
                    {movement.kind === "INCOME" ? "+" : movement.kind === "EXPENSE" ? "−" : ""}
                    {formatMoney(movement.amount)}
                  </p>

                  {confirmDeleteId === movement.id ? (
                    <div className="flex flex-col items-end gap-1 pt-1">
                      <span className="text-xs text-fg-muted whitespace-nowrap">
                        ¿Eliminar?
                      </span>
                      <div className="flex gap-1">
                        <button
                          id={`mov-delete-confirm-${movement.id}`}
                          onClick={() => remove(movement.id)}
                          disabled={deleteBusyId !== null}
                          className="rounded-lg bg-danger hover:bg-danger/90 text-primary-fg px-2.5 py-1 text-xs font-bold disabled:opacity-50"
                        >
                          {deleteBusyId === movement.id ? "Eliminando…" : "Sí, borrar"}
                        </button>
                        <button
                          id={`mov-delete-cancel-${movement.id}`}
                          onClick={() => setConfirmDeleteId(null)}
                          disabled={deleteBusyId !== null}
                          className="rounded-lg border border-line-strong px-2.5 py-1 text-xs font-medium hover:bg-surface-3 disabled:opacity-50"
                        >
                          Mejor no
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      id={`mov-delete-${movement.id}`}
                      onClick={() => {
                        setConfirmDeleteId(movement.id);
                        setDeleteNotice(null);
                      }}
                      title="Eliminar"
                      aria-label="Eliminar movimiento"
                      className="mov-borrar text-fg-subtle hover:text-danger px-1 pt-1"
                    >
                      <Trash className="size-4" aria-hidden />
                    </button>
                  )}
                  </div>
                </div>

                {notice && (
                  <p
                    id={`mov-delete-notice-${movement.id}`}
                    role="alert"
                    className="mt-2 text-xs rounded-lg bg-warning/10 text-warning px-3 py-2"
                  >
                    {notice.message}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <p className="text-center text-xs text-fg-subtle pb-2">
        <Link href="/analisis" className="underline inline-flex items-center touch:min-h-11">
          Ver análisis del mes →
        </Link>
      </p>

      {/* ── Aviso persistente de "Deshacer" ─────────────────────────────── */}
      {/* `z-40`: por debajo del modal (z-50). La capa externa es
          `pointer-events-none` para que sólo la píldora reciba clics: el aviso
          aparece pegado abajo y no puede bloquear lo que hay detrás. */}
      {undoToast && (
        <div className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4 pointer-events-none">
          <div
            id="undo-toast"
            className="pointer-events-auto rounded-md bg-primary text-primary-fg px-4 py-3 shadow-2xl text-sm"
          >
            <div className="flex items-center gap-3">
              <span>Movimiento guardado.</span>
              <button
                id="undo-button"
                onClick={undoLastSave}
                disabled={undoToast.busy}
                className="font-bold underline whitespace-nowrap disabled:opacity-50"
              >
                {undoToast.busy ? "Deshaciendo…" : "Deshacer"}
              </button>
              <button
                id="undo-dismiss"
                onClick={() => setUndoToast(null)}
                aria-label="Cerrar aviso"
                className="text-lg leading-none px-1 text-fg-subtle hover:text-fg-muted "
              >
                ×
              </button>
            </div>
            {undoToast.error && (
              <p
                id="undo-error"
                role="alert"
                className="mt-2 text-xs rounded-lg bg-danger text-primary-fg px-2 py-1"
              >
                {undoToast.error}
              </p>
            )}
          </div>
        </div>
      )}

      {paletteOpen && (
        <CommandPalette
          favorites={orderedFavorites}
          onClose={() => setPaletteOpen(false)}
          onNewMovement={(kind) => {
            setPaletteOpen(false);
            openMovement(kind);
          }}
          onUseFavorite={(favorite) => {
            setPaletteOpen(false);
            openMovement(favorite.kind, favorite);
          }}
          onOpenCsv={() => {
            setPaletteOpen(false);
            setCsvOpen(true);
          }}
        />
      )}

      {csvOpen && (
        <CsvImportModal
          onClose={() => setCsvOpen(false)}
          onImported={() => {
            load();
            refreshFavorites();
          }}
        />
      )}

      {modal === "ACCOUNT" ? (
        <AccountForm onClose={() => setModal(null)} onSaved={load} />
      ) : modal ? (
        <TransactionForm
          kind={modal}
          accounts={accounts}
          // TODAS las categorías: el formulario cambia de tipo sin cerrarse y
          // necesita las dos listas para filtrar adentro por tipo activo.
          categories={categories}
          favorite={favoriteForForm}
          onFavoriteSaved={() => void refreshFavorites()}
          onClose={closeMovement}
          onSaved={(movement) => {
            setUndoToast({ movement, error: "", busy: false });
            load();
            // Si el movimiento usó una plantilla, `lastUsedAt` cambió: el orden
            // de los chips se actualiza sin esperar a la próxima recarga.
            refreshFavorites();
          }}
        />
      ) : null}
    </main>
  );
}
