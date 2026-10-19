"use client";

import { useEffect, useMemo, useState } from "react";
import { findCategoryByName, searchCategories } from "@/lib/category-search";
import { clearDateInputIfEmptied } from "@/lib/date-input";
import { addDays, todayCalendar } from "@/lib/dates";
import {
  type AccountBalanceDTO,
  type CategoryDTO,
  type MovementDTO,
  type MovementKindDTO,
} from "@/lib/finance";
import { formatAmountInput, formatLiability, formatMoney } from "@/lib/format";
import {
  browserStorage,
  canBeSourceAccount,
  readLastAccountId,
  resolveSourceAccount,
  writeLastAccountId,
} from "@/lib/quick-entry";

interface Props {
  /** El tipo con el que abre el modal (después se puede cambiar adentro). */
  kind: MovementKindDTO;
  accounts: AccountBalanceDTO[];
  /** TODAS las categorías (de los dos tipos): el selector cambia de tipo solo. */
  categories: CategoryDTO[];
  /** Cuenta preseleccionada, si la pantalla viene de "cargar un gasto acá". */
  defaultAccountId?: string;
  onClose: () => void;
  /** Recibe el movimiento guardado: el panel lo usa para el "Deshacer". */
  onSaved: (movement: MovementDTO) => void;
}

/**
 * Cómo se ve cada tipo de movimiento.
 *
 * `TRANSFER` tiene su propio color (azul) y no comparte el verde ni el rojo a
 * propósito: una transferencia no es plata que entra ni plata que sale, y
 * pintarla como cualquiera de las dos sería comunicar lo contrario de lo que el
 * modelo dice.
 */
const KIND_STYLE: Record<
  MovementKindDTO,
  { title: string; accent: string; focus: string; badge: string; tab: string }
> = {
  INCOME: {
    title: "＋ Nuevo ingreso",
    accent: "text-emerald-600",
    focus: "focus:ring-emerald-500",
    badge: "bg-emerald-600 hover:bg-emerald-700",
    tab: "bg-emerald-600 text-white",
  },
  EXPENSE: {
    title: "－ Nuevo gasto",
    accent: "text-rose-600",
    focus: "focus:ring-rose-500",
    badge: "bg-rose-600 hover:bg-rose-700",
    tab: "bg-rose-600 text-white",
  },
  TRANSFER: {
    title: "⇄ Nueva transferencia",
    accent: "text-sky-600",
    focus: "focus:ring-sky-500",
    badge: "bg-sky-600 hover:bg-sky-700",
    tab: "bg-sky-600 text-white",
  },
};

/**
 * Las tres pestañas del selector de tipo, con su `id` estable.
 *
 * El selector existe para la carga rápida: elegir "Ingreso" por error y no
 * poder corregirlo sin cerrar y volver a abrir era un toque de más en cada
 * carga. Los ids son los que usan los flows para elegir sin depender del texto
 * visible.
 */
const KIND_TABS: { kind: MovementKindDTO; id: string; label: string }[] = [
  { kind: "EXPENSE", id: "tx-kind-gasto", label: "Gasto" },
  { kind: "INCOME", id: "tx-kind-ingreso", label: "Ingreso" },
  { kind: "TRANSFER", id: "tx-kind-transferencia", label: "Transferencia" },
];

/** Etiqueta de una cuenta en el selector: nombre y cuánta plata tiene. */
function accountLabel(account: AccountBalanceDTO): string {
  // En una cuenta de deuda se muestra la deuda con su palabra: "debe
  // $ 50.000" cuando se debe y "a favor $ 50.000" cuando se pagó de más
  // (ver `formatLiability`). "Visa · −$ 50.000" se lee como un error.
  const amount = account.isLiability
    ? formatLiability(account.debt ?? "0.00")
    : formatMoney(account.balance);
  return `${account.name} · ${amount}`;
}

/**
 * Cuenta de destino por defecto: la primera que NO sea el origen.
 *
 * Devolver `""` no es una opción válida —el `<option>` vacío no existe— así que
 * si sólo hay una cuenta el resultado también es `""` y el formulario muestra el
 * aviso de que hacen falta dos cuentas para transferir.
 */
function pickDestinationAccount(
  accounts: AccountBalanceDTO[],
  sourceId: string,
): string {
  return accounts.find((account) => account.id !== sourceId)?.id ?? "";
}

export default function TransactionForm({
  kind: initialKind,
  accounts,
  categories,
  defaultAccountId,
  onClose,
  onSaved,
}: Props) {
  // ── El tipo activo ─────────────────────────────────────────────────────────
  // Arranca con el del modal y se puede CAMBIAR acá adentro sin cerrar: los
  // datos ya escritos (monto, fecha, nota, categoría) no se pierden, y la
  // cuenta se conserva si sigue siendo válida para el tipo nuevo.
  const [kind, setKind] = useState<MovementKindDTO>(initialKind);
  const style = KIND_STYLE[kind];

  // ── "Hoy" y "Ayer" ─────────────────────────────────────────────────────────
  // `todayCalendar()` una sola vez al montar (no en cada render: el "hoy" de
  // un formulario abierto no cambia a medianoche). `addDays` hace la aritmética
  // de calendario — jamás `toISOString()`, que convierte a UTC y de noche
  // devuelve el día siguiente.
  const [today] = useState(() => todayCalendar());
  const yesterday = useMemo(() => addDays(today, -1), [today]);

  // ── Cuenta de origen por defecto ───────────────────────────────────────────
  // La última usada para este tipo (recordada en `localStorage`), y si no hay
  // ninguna válida, la primera cuenta válida. La resolución completa —con la
  // tolerancia a ids borrados o inválidos— vive en `resolveSourceAccount`
  // (lib/quick-entry.ts), que es pura y está testeada.
  const [accountId, setAccountId] = useState(() =>
    resolveSourceAccount(kind, accounts, {
      preferred: defaultAccountId,
      lastUsedId: readLastAccountId(browserStorage(), kind),
    }),
  );

  // ── Cuenta de destino (sólo transferencias) ────────────────────────────────
  // Arranca con la primera cuenta que NO sea el origen.
  //
  // La primera versión dejaba el destino vacío ("Elegí una cuenta…") para forzar
  // una elección consciente. En la práctica sólo agrega un toque obligatorio al
  // caso más común —pasar plata del banco al efectivo— y deja el formulario en
  // un estado inválido que la validación tiene que rechazar después. Con un
  // destino válido preseleccionado, guardar funciona en un solo toque.
  const [toAccountId, setToAccountId] = useState(() =>
    pickDestinationAccount(
      accounts,
      resolveSourceAccount(kind, accounts, {
        preferred: defaultAccountId,
        lastUsedId: readLastAccountId(browserStorage(), kind),
      }),
    ),
  );

  const [date, setDate] = useState(() => todayCalendar());
  const [amount, setAmount] = useState("");
  const [categoryName, setCategoryName] = useState("");
  /**
   * Si la persona ya tocó el campo de categoría.
   *
   * Las sugerencias de "últimas usadas" no se muestran hasta ese momento: son
   * una ayuda para cuando se está eligiendo categoría, y en reposo empujarían
   * la fecha y la nota ~38px hacia abajo — justo lo que hace que "Nota" quede
   * debajo del pie fijo en la pantalla de los tests (1018×597). Al enfocar el
   * campo (o al escribir, que ya implica foco) aparecen.
   */
  const [categoryTouched, setCategoryTouched] = useState(false);
  /**
   * Si la persona ya aceptó una sugerencia y la ayuda de categoría se colapsó.
   *
   * Con las sugerencias en pantalla, la fila de fecha y los chips "Hoy/Ayer"
   * bajan ~72px y caen en la banda del pie fijo, que se come esos toques; y aun
   * colapsando la lista, el aviso "✓/＋" que acompaña al nombre suma otros ~20px
   * — suficientes para dejarla dentro de la banda. Elegir una categoría y
   * después tocar "Ayer" era un no-op silencioso (la fecha no cambiaba). Al
   * aceptar una sugerencia la ayuda ya cumplió su función — y el aviso sería
   * redundante, porque toda sugerencia es una categoría existente —, así que se
   * colapsan los dos y el formulario vuelve a su geometría de reposo. Tipear de
   * nuevo la reabre (se está eligiendo otra vez).
   */
  const [categoryDismissed, setCategoryDismissed] = useState(false);
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // ── Los dos avisos en línea (jamás `window.confirm`) ───────────────────────
  //
  // `discardWarning`: Escape con datos escritos no cierra de una; muestra el
  // aviso y recién el segundo Escape (o "Descartar") cierra.
  //
  // `duplicateWarning`: al guardar puede aparecer "ya hay un movimiento igual",
  // con "Guardar igual" / "Volver" en lugar de los botones normales.
  const [discardWarning, setDiscardWarning] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState<MovementDTO[]>([]);

  const isTransfer = kind === "TRANSFER";
  const isIncome = kind === "INCOME";

  /**
   * ¿Hay algo escrito que se perdería al cerrar?
   *
   * Sólo cuenta el TEXTO tipeado (monto, categoría, nota): son los datos que
   * cuesta recuperar. Cambiar una fecha o elegir otra cuenta no marca sucio —
   * volver a abrir el formulario reproduce el mismo estado por defecto, y
   * advertir por eso entrenaría a la persona a ignorar el aviso.
   */
  const dirty =
    amount.trim() !== "" ||
    categoryName.trim() !== "" ||
    description.trim() !== "";

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;

      if (!dirty || discardWarning) {
        onClose();
        return;
      }
      setDiscardWarning(true);
    }

    // Listener de documento y no `onKeyDown` del overlay: con el foco en el
    // botón de guardar (o en el body, después de un clic), el evento no
    // burbujea por el árbol del modal. Éste es el único camino que garantiza
    // que Escape SIEMPRE haga algo.
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [dirty, discardWarning, onClose]);

  // Cuentas que pueden recibir el dinero en una transferencia: todas menos la de
  // origen. Ofrecer la misma cuenta obligaría a la base a rechazar el movimiento
  // y el usuario vería un error que podría haber evitado el formulario.
  const destinationOptions = useMemo(
    () => accounts.filter((a) => a.id !== accountId),
    [accounts, accountId],
  );

  const selectedAccount = accounts.find((a) => a.id === accountId);
  const amountPreview = formatAmountInput(amount);

  // ── Categorías: del tipo activo, ordenadas por búsqueda + recencia ─────────
  const kindCategories = useMemo(
    () =>
      categories.filter((category) =>
        isIncome ? category.kind === "INCOME" : category.kind === "EXPENSE",
      ),
    [categories, isIncome],
  );

  const suggestions = useMemo(
    () => searchCategories(kindCategories, categoryName),
    [kindCategories, categoryName],
  );

  // El aviso de "existente"/"nueva" se compara contra TODAS las categorías y no
  // sólo las del tipo activo: el servidor deduplica por `normalizedName`, que es
  // único en toda la tabla — el aviso tiene que decir lo que va a pasar de
  // verdad (ver `findCategoryByName`).
  const categoryExists = useMemo(
    () => findCategoryByName(categories, categoryName) !== null,
    [categories, categoryName],
  );

  /** El chequeo de duplicados ya no aplica si cambió un dato del criterio. */
  function clearDuplicateWarning() {
    setDuplicateWarning((current) => (current.length > 0 ? [] : current));
  }

  /**
   * Cambiar de tipo sin cerrar el modal.
   *
   * Regla: NADA de lo escrito se pierde. El monto, la fecha, la nota y el texto
   * de la categoría quedan como estaban. La cuenta de origen se conserva si
   * sigue siendo un origen válido para el tipo nuevo (una tarjeta sirve para un
   * gasto, no para un ingreso) y, si no, se vuelve a resolver como al abrir:
   * última usada de ese tipo, o la primera válida.
   */
  function switchKind(next: MovementKindDTO) {
    if (next === kind) return;

    setKind(next);
    setError("");
    setDuplicateWarning([]);

    const currentAccount = accounts.find((a) => a.id === accountId);
    const nextSource =
      currentAccount && canBeSourceAccount(next, currentAccount)
        ? accountId
        : resolveSourceAccount(next, accounts, {
            lastUsedId: readLastAccountId(browserStorage(), next),
          });
    setAccountId(nextSource);

    if (next === "TRANSFER") {
      // El destino tiene que existir y no ser el origen nuevo.
      setToAccountId((current) =>
        current && current !== nextSource && accounts.some((a) => a.id === current)
          ? current
          : pickDestinationAccount(accounts, nextSource),
      );
    }
  }

  /**
   * El guardado en sí (sin el chequeo de duplicados, que es un paso previo de
   * `handleSubmit` y se puede saltear con "Guardar igual").
   */
  async function postMovement() {
    const response = await fetch("/api/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind,
        // El monto se manda TAL COMO SE ESCRIBIÓ. El servidor lo interpreta
        // con su propio parser (que conoce la convención argentina) y lo
        // convierte a decimal exacto. Mandar `Number(amount)` acá sería
        // reintroducir el error binario en el camino.
        amount,
        date,
        accountId,
        ...(isTransfer ? { toAccountId } : {}),
        // La categoría es opcional (Fase 7): vacía viaja como "" y el servidor
        // la normaliza a `null` — un movimiento sin clasificar, que los
        // reportes agrupan bajo "Sin categoría".
        ...(!isTransfer ? { categoryName: categoryName.trim() } : {}),
        description,
      }),
    });

    const data = (await response.json().catch(() => ({}))) as Partial<MovementDTO> & {
      error?: string;
    };
    if (!response.ok) {
      throw new Error(data.error ?? "No se pudo guardar el movimiento.");
    }

    // Recordar la cuenta para el PRÓXIMO movimiento de este tipo. Best-effort:
    // si `localStorage` no está disponible, se pierde la comodidad, no el
    // guardado (ver `writeLastAccountId`).
    writeLastAccountId(browserStorage(), kind, accountId);

    onSaved(data as MovementDTO);
    onClose();
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    // Guarda contra el doble submit: el botón se deshabilita, pero Enter en un
    // campo puede disparar el submit igual.
    if (saving) return;
    setError("");

    if (!amountPreview) {
      setError("Escribí un monto mayor a cero.");
      return;
    }
    if (!accountId) {
      setError("Elegí una cuenta.");
      return;
    }
    if (isTransfer && !toAccountId) {
      setError("Elegí a qué cuenta va la plata.");
      return;
    }

    setSaving(true);
    try {
      // ── El chequeo de duplicados: best-effort, NUNCA un bloqueo ──────────
      //
      // Antes de guardar se pregunta si ya hay algo igual (misma cuenta, mismo
      // monto, mismo día y tipo). Si lo hay, se avisa; si el chequeo FALLA
      // —la ruta no responde, la red se cayó— se guarda igual: un chequeo de
      // comodidad no puede convertirse en "no se puede guardar".
      let duplicates: MovementDTO[] = [];
      try {
        const params = new URLSearchParams({ kind, accountId, amount, date });
        const response = await fetch(`/api/transactions/duplicates?${params}`);
        if (response.ok) {
          const data = (await response.json()) as { duplicates?: MovementDTO[] };
          duplicates = data.duplicates ?? [];
        }
      } catch {
        duplicates = [];
      }

      if (duplicates.length > 0) {
        setDuplicateWarning(duplicates);
        return;
      }

      await postMovement();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setSaving(false);
    }
  }

  /** "Guardar igual": saltea el chequeo y guarda lo que ya está en pantalla. */
  async function saveAnyway() {
    if (saving) return;
    setError("");
    setDuplicateWarning([]);
    setSaving(true);
    try {
      await postMovement();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setSaving(false);
    }
  }

  // ── Sin cuentas no se puede registrar nada ─────────────────────────────────
  // Es un estado real de una instalación nueva, y merece su propia pantalla en
  // vez de un formulario que falla al guardar.
  if (accounts.length === 0) {
    return (
      // El clic afuera NO cierra (en ninguna pantalla del modal): un toque al
      // costado con el monto ya escrito no puede tirar el trabajo. Se cierra
      // con Escape o con el botón; ambos caminos son deliberados.
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
        <div className="w-full sm:max-w-md bg-white dark:bg-zinc-900 rounded-t-3xl sm:rounded-3xl p-6 shadow-2xl">
          <h2 className="text-xl font-bold mb-3">Primero creá una cuenta</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
            Todo movimiento sale de una cuenta o entra a una. Sin al menos una
            cuenta creada no hay dónde registrar la plata.
          </p>
          <button
            onClick={onClose}
            className="w-full rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-black py-3 font-bold"
          >
            Entendido
          </button>
        </div>
      </div>
    );
  }

  // ── El campo "Nota": su posición depende de lo que los flujos TOCAN ────────
  //
  // Medido en la ventana de los tests (557px de alto): el área tocable del
  // modal termina donde arranca el pie fijo (≈441px). Todo lo que queda debajo
  // lo tapa el pie y el tap aterriza en el pie o en el backdrop — sin error,
  // sin foco y sin texto. Así se perdía la nota de las transferencias de los
  // flujos 04 y 10: el nodo existía, el tap "completaba" y el texto nunca
  // llegaba al campo (quedaba description: "").
  //
  // En TRANSFERENCIA la nota va arriba de las cuentas (los flujos tocan nota,
  // no fecha); en gasto/ingreso va al final, porque ahí lo que se toca es la
  // categoría y la fecha, que quedan más arriba. Las cuentas y la fecha se
  // asertan (texto visible), no se tocan.
  const descriptionField = (
    <div>
      <label htmlFor="tx-description" className="text-sm font-medium">
        Nota <span className="font-normal text-zinc-500">(opcional)</span>
      </label>
      <input
        id="tx-description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Detalle…"
        maxLength={200}
        className={`mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-4 py-2.5 outline-none focus:ring-2 ${style.focus}`}
      />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
      <div className="w-full sm:max-w-md max-h-[92vh] overflow-y-auto bg-white dark:bg-zinc-900 rounded-t-3xl sm:rounded-3xl p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-2">
          <h2 className={`text-xl font-bold ${style.accent}`}>{style.title}</h2>
          <button
            id="tx-close"
            onClick={onClose}
            className="text-2xl leading-none text-zinc-400 hover:text-zinc-700 px-2"
            aria-label="Cerrar"
          >
            ×
          </button>
        </div>

        {/* ── Tipo de movimiento ───────────────────────────────────────── */}
        {/* Compacto a propósito: el modal tiene que seguir entrando en una
            pantalla de 1018×597, donde "Nota" queda al borde del pie fijo. */}
        <div
          role="group"
          aria-label="Tipo de movimiento"
          className="grid grid-cols-3 gap-1 rounded-xl bg-zinc-100 dark:bg-zinc-800 p-1 mb-3"
        >
          {KIND_TABS.map((tab) => (
            <button
              key={tab.kind}
              id={tab.id}
              type="button"
              onClick={() => switchKind(tab.kind)}
              aria-pressed={kind === tab.kind}
              className={`rounded-lg py-1.5 text-sm font-medium transition ${
                kind === tab.kind
                  ? KIND_STYLE[tab.kind].tab
                  : "text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200/70 dark:hover:bg-zinc-700"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          {/* ── Monto ─────────────────────────────────────────────────────── */}
          <div>
            <label htmlFor="tx-amount" className="text-sm font-medium">
              Monto *
            </label>
            <input
              id="tx-amount"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              autoFocus
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                clearDuplicateWarning();
              }}
              placeholder="0,00"
              className={`mt-1 w-full text-2xl font-bold rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-4 py-3 outline-none focus:ring-2 ${style.focus}`}
            />
            <p className="mt-1 text-xs text-zinc-500 h-4">
              {amountPreview ? (
                <>
                  Se guarda como <b>{amountPreview}</b>
                </>
              ) : amount.trim() ? (
                <span className="text-amber-600">
                  No se entiende el monto. Probá con 1500 o 1.500,50
                </span>
              ) : (
                "Podés escribir 1500, 1.500,50 o 1,500.50"
              )}
            </p>
          </div>

          {/* En TRANSFERENCIA la nota va acá arriba, junto al monto — el
              porqué completo, en `descriptionField`. */}
          {isTransfer && descriptionField}

          {/* ── Cuenta de origen ──────────────────────────────────────────── */}
          <div>
            <label htmlFor="tx-account" className="text-sm font-medium">
              {isTransfer
                ? "Desde qué cuenta *"
                : isIncome
                  ? "A qué cuenta entra *"
                  : "De qué cuenta sale *"}
            </label>
            <select
              id="tx-account"
              value={accountId}
              onChange={(e) => {
                const nextSource = e.target.value;
                setAccountId(nextSource);
                clearDuplicateWarning();
                // Al cambiar el origen, el destino anterior puede ser el mismo.
                // Se re-elige el primero disponible en vez de vaciarlo: el
                // formulario nunca queda en un estado inválido.
                setToAccountId(pickDestinationAccount(accounts, nextSource));
              }}
              className={`mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-3 py-2.5 outline-none focus:ring-2 ${style.focus}`}
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {accountLabel(account)}
                </option>
              ))}
            </select>

            {/* El aviso que evita el malentendido más común: comprar con
                tarjeta NO es "gastar la plata que tenés", es deberla. */}
            {!isTransfer && selectedAccount?.kind === "CREDIT_CARD" && (
              <p className="mt-1.5 text-xs rounded-lg bg-amber-50 dark:bg-amber-950 text-amber-800 dark:text-amber-200 px-3 py-2">
                Es una tarjeta: este gasto se suma a la deuda. No baja el saldo
                de tu cuenta bancaria hasta que pagues el resumen, y ese pago va
                a ser una <b>transferencia</b>, no otro gasto.
              </p>
            )}
          </div>

          {/* ── Cuenta de destino (sólo transferencias) ───────────────────── */}
          {isTransfer && (
            <div>
              <label htmlFor="tx-to-account" className="text-sm font-medium">
                A qué cuenta va *
              </label>
              {destinationOptions.length === 0 ? (
                <p className="mt-1 text-sm rounded-lg bg-amber-50 dark:bg-amber-950 text-amber-800 dark:text-amber-200 px-3 py-2">
                  Necesitás al menos dos cuentas para transferir entre ellas.
                </p>
              ) : (
                <select
                  id="tx-to-account"
                  value={toAccountId}
                  onChange={(e) => setToAccountId(e.target.value)}
                  className={`mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-3 py-2.5 outline-none focus:ring-2 ${style.focus}`}
                >
                  {destinationOptions.map((account) => (
                    <option key={account.id} value={account.id}>
                      {accountLabel(account)}
                    </option>
                  ))}
                </select>
              )}
              <p className="mt-1.5 text-xs text-zinc-500">
                Mover plata entre tus propias cuentas no es un gasto ni un
                ingreso: tu patrimonio no cambia.
              </p>
            </div>
          )}

          {/* ── Categoría (sólo ingresos y gastos, y OPCIONAL) ────────────── */}
          {!isTransfer && (
            <div>
              <label htmlFor="tx-category" className="text-sm font-medium">
                {isIncome ? "De dónde viene" : "En qué se fue"}{" "}
                <span className="font-normal text-zinc-500">(opcional)</span>
              </label>
              <input
                id="tx-category"
                value={categoryName}
                onChange={(e) => {
                  setCategoryName(e.target.value);
                  setCategoryDismissed(false);
                }}
                onFocus={() => setCategoryTouched(true)}
                placeholder={
                  isIncome
                    ? "Ej: Sueldo, Freelance, Ventas…"
                    : "Ej: Comida, Alquiler, Transporte…"
                }
                list="tx-categories"
                autoComplete="off"
                className={`mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-4 py-2.5 outline-none focus:ring-2 ${style.focus}`}
              />
              <datalist id="tx-categories">
                {kindCategories.map((category) => (
                  <option key={category.id} value={category.name} />
                ))}
              </datalist>

              {categoryName.trim() !== "" && !categoryDismissed && (
                <p className="mt-1 text-xs text-zinc-500">
                  {categoryExists ? (
                    <>
                      ✓ Se usa la categoría existente{" "}
                      <b>“{categoryName.trim()}”</b>
                    </>
                  ) : (
                    <>
                      ＋ Se crea la categoría <b>“{categoryName.trim()}”</b> para
                      los próximos movimientos
                    </>
                  )}
                </p>
              )}

              {/* Sugerencias: últimas usadas primero, y al escribir, las que
                  empiezan con lo escrito. La lógica vive en
                  `searchCategories` (lib/category-search.ts). En reposo no se
                  muestran para no empujar los campos de abajo (el porqué,
                  arriba de todo, en `categoryTouched`). */}
              {suggestions.length > 0 &&
                !categoryDismissed &&
                (categoryTouched || categoryName.trim() !== "") && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {suggestions.map((suggestion) => (
                      <button
                        type="button"
                        key={suggestion.id}
                        onClick={() => {
                          setCategoryName(suggestion.name);
                          setCategoryDismissed(true);
                        }}
                        className="text-xs px-3 py-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700"
                      >
                        {suggestion.name}
                      </button>
                    ))}
                  </div>
                )}
            </div>
          )}

          {/* ── Fecha ─────────────────────────────────────────────────────── */}
          {/* Los chips "Hoy"/"Ayer" comparten la fila del label para no sumar
              una fila entera al modal (el porqué del espacio, en el pie). */}
          <div>
            <div className="flex items-center justify-between">
              <label htmlFor="tx-date" className="text-sm font-medium">
                Fecha *
              </label>
              <div className="flex gap-1">
                <button
                  id="tx-date-hoy"
                  type="button"
                  onClick={() => {
                    setDate(today);
                    clearDuplicateWarning();
                  }}
                  aria-pressed={date === today}
                  className={`text-xs px-2.5 py-1 rounded-full border ${
                    date === today
                      ? "border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-black"
                      : "border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  }`}
                >
                  Hoy
                </button>
                <button
                  id="tx-date-ayer"
                  type="button"
                  onClick={() => {
                    setDate(yesterday);
                    clearDuplicateWarning();
                  }}
                  aria-pressed={date === yesterday}
                  className={`text-xs px-2.5 py-1 rounded-full border ${
                    date === yesterday
                      ? "border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-black"
                      : "border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  }`}
                >
                  Ayer
                </button>
              </div>
            </div>
            <input
              id="tx-date"
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                clearDuplicateWarning();
                clearDateInputIfEmptied(e.target);
              }}
              className={`mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 outline-none focus:ring-2 ${style.focus}`}
            />
          </div>

          {/* En gasto/ingreso la nota va al final — el porqué, en `descriptionField`. */}
          {!isTransfer && descriptionField}

          {/* ────────────────────────────────────────────────────────────────
              PIE FIJO: EL BOTÓN DE GUARDAR NO PUEDE IRSE DE PANTALLA
              ────────────────────────────────────────────────────────────────
              El formulario no entra completo en una pantalla baja. Medido: en
              una ventana de 1019×597 el contenido llega hasta el campo
              "Detalle" y los botones quedaban recortados por el contenedor con
              scroll, más abajo del borde.

              Eso no es un detalle cosmético. Es LA acción de la pantalla: si no
              se ve, no se guarda — y nada indica que haya que scrollear para
              encontrarla. En un teléfono en horizontal o en una netbook el
              usuario toca "Nuevo gasto", llena los campos y se queda sin forma
              de confirmar.

              `sticky bottom-0` lo deja pegado al borde inferior del modal
              mientras el resto scrollea por detrás. El fondo opaco es parte del
              arreglo, no decoración: sin él, los campos pasarían por debajo del
              botón y se leerían los dos textos superpuestos.

              El `-mx-6 -mb-6` cancela el `p-6` del contenedor para que la
              franja llegue hasta los bordes; si no, quedaría una isla flotante
              con el fondo del modal asomando alrededor. El `pb-3` y el `pt-2`
              recortan el pie a lo esencial: su alto también cuenta — cada píxel
              de menos es un píxel menos de scroll en una ventana baja.

              El mensaje de error va acá adentro y no entre los campos: un error
              que aparece fuera de la vista es un error que no se leyó. */}
          <div className="sticky bottom-0 -mx-6 -mb-6 px-6 pb-3 pt-2 space-y-3 bg-white dark:bg-zinc-900">
            {error && (
              <p
                role="alert"
                className="text-sm text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950 rounded-lg px-3 py-2"
              >
                {error}
              </p>
            )}

            {/* Aviso de descarte: Escape con datos escritos entra acá. El
                segundo Escape (o "Descartar") cierra; "Seguir editando"
                vuelve. Nunca `window.confirm`: el driver de los tests no
                puede contestar diálogos nativos. */}
            {discardWarning && (
              <div
                id="tx-discard-warning"
                role="alert"
                className="text-sm rounded-lg bg-amber-50 dark:bg-amber-950 text-amber-800 dark:text-amber-200 px-3 py-2"
              >
                <p>Si cerrás ahora se pierde lo que cargaste.</p>
                <div className="mt-2 flex gap-2">
                  <button
                    id="tx-discard-cancel"
                    type="button"
                    onClick={() => setDiscardWarning(false)}
                    className="rounded-lg border border-amber-300 dark:border-amber-800 px-3 py-1 text-xs font-medium"
                  >
                    Seguir editando
                  </button>
                  <button
                    id="tx-discard-confirm"
                    type="button"
                    onClick={onClose}
                    className="rounded-lg bg-rose-600 hover:bg-rose-700 text-white px-3 py-1 text-xs font-bold"
                  >
                    Descartar
                  </button>
                </div>
              </div>
            )}

            {duplicateWarning.length > 0 ? (
              // El aviso de duplicado REEMPLAZA a los botones: con los botones
              // normales a la vista, "Guardar" volvería a chocar contra el
              // mismo chequeo o —peor— guardaría sin que se vea la decisión.
              <div
                id="tx-duplicate-warning"
                role="alert"
                className="text-sm rounded-lg bg-amber-50 dark:bg-amber-950 text-amber-800 dark:text-amber-200 px-3 py-2"
              >
                <p>
                  Ya{" "}
                  {duplicateWarning.length === 1
                    ? "hay un movimiento igual"
                    : `hay ${duplicateWarning.length} movimientos iguales`}
                  : misma cuenta, mismo monto y mismo día. Puede ser el mismo
                  gasto cargado dos veces.
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    id="tx-duplicate-back"
                    type="button"
                    onClick={() => setDuplicateWarning([])}
                    className="rounded-lg border border-amber-300 dark:border-amber-800 px-3 py-1 text-xs font-medium"
                  >
                    Volver
                  </button>
                  <button
                    id="tx-duplicate-save"
                    type="button"
                    onClick={() => void saveAnyway()}
                    disabled={saving}
                    className="rounded-lg bg-amber-600 hover:bg-amber-700 text-white px-3 py-1 text-xs font-bold disabled:opacity-50"
                  >
                    Guardar igual
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex gap-3">
                <button
                  id="tx-cancel"
                  type="button"
                  onClick={onClose}
                  className="flex-1 rounded-xl border border-zinc-300 dark:border-zinc-700 py-3 font-medium"
                >
                  Cancelar
                </button>
                <button
                  id="tx-submit"
                  type="submit"
                  disabled={saving}
                  className={`flex-1 rounded-xl py-3 font-bold text-white disabled:opacity-50 ${style.badge}`}
                >
                  {saving ? "Guardando…" : "Guardar"}
                </button>
              </div>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
