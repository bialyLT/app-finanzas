"use client";

import { useMemo, useState } from "react";
import {
  CATEGORY_KIND_LABEL,
  MOVEMENT_KIND_LABEL,
  categoryKindConflicts,
  ruleCategoryKindMessage,
} from "@/lib/category-kind";
import { clearDateInputIfEmptied } from "@/lib/date-input";
import { isCalendarDate, todayCalendar } from "@/lib/dates";
import {
  POSTING_MODE_LABEL,
  RECUR_FREQ_LABEL,
  canReceiveIncome,
  normalizeCategoryName,
  type AccountBalanceDTO,
  type CategoryDTO,
  type MovementKindDTO,
  type PostingModeDTO,
  type RecurFreqDTO,
  type RecurrenceRuleDTO,
} from "@/lib/finance";
import { formatAmountInput, formatLiability, formatMoney } from "@/lib/format";

interface Props {
  /** La regla a editar, o `null` para crear una nueva. */
  rule: RecurrenceRuleDTO | null;
  /** Cuentas con saldo, INCLUIDAS las archivadas (ver nota abajo). */
  accounts: AccountBalanceDTO[];
  categories: CategoryDTO[];
  onClose: () => void;
  onSaved: () => void;
}

const KINDS: MovementKindDTO[] = ["INCOME", "EXPENSE", "TRANSFER"];
const KINDS_LABEL: Record<MovementKindDTO, string> = {
  INCOME: "Ingreso",
  EXPENSE: "Gasto",
  TRANSFER: "Transferencia",
};

const FREQS: RecurFreqDTO[] = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
const MODES: PostingModeDTO[] = ["AUTO", "NOTIFY"];

/** Cómo se ve cada tipo seleccionado, igual que en TransactionForm. */
const KIND_STYLE: Record<MovementKindDTO, { accent: string; selected: string }> = {
  INCOME: { accent: "text-emerald-600", selected: "bg-emerald-600 text-white" },
  EXPENSE: { accent: "text-rose-600", selected: "bg-rose-600 text-white" },
  TRANSFER: { accent: "text-sky-600", selected: "bg-sky-600 text-white" },
};

/**
 * Etiqueta de una cuenta en el selector: nombre, marca si está archivada y
 * cuánta plata tiene. Las archivadas se LISTAN: una regla vieja puede apuntar a
 * una cuenta archivada, y si el `<select>` no la incluyera, abrir la edición
 * mostraría otra cuenta preseleccionada — y guardar cualquier otro campo
 * habría movido la regla de cuenta sin querer.
 */
function accountLabel(account: AccountBalanceDTO): string {
  const amount = account.isLiability
    ? formatLiability(account.debt ?? "0.00")
    : formatMoney(account.balance);
  return `${account.name}${account.archived ? " (archivada)" : ""} · ${amount}`;
}

function isFreqWithAnchor(freq: RecurFreqDTO): boolean {
  return freq === "MONTHLY" || freq === "YEARLY";
}

export default function RecurrenceRuleForm({
  rule,
  accounts,
  categories,
  onClose,
  onSaved,
}: Props) {
  const editing = rule !== null;

  const [title, setTitle] = useState(rule?.title ?? "");
  const [kind, setKind] = useState<MovementKindDTO>(rule?.kind ?? "EXPENSE");
  // El monto de la regla llega canónico ("5000.00"). En el input se muestra con
  // coma decimal, que es como se escribe acá; el parser del servidor acepta las
  // dos formas y la validación de abajo es sobre lo que se escriba.
  const [amount, setAmount] = useState(rule ? rule.amount.replace(".", ",") : "");
  const [accountId, setAccountId] = useState(
    () => rule?.account.id ?? accounts[0]?.id ?? "",
  );
  const [toAccountId, setToAccountId] = useState(
    () =>
      rule?.toAccount?.id ??
      accounts.find((a) => a.id !== (rule?.account.id ?? accounts[0]?.id))?.id ??
      "",
  );
  const [categoryName, setCategoryName] = useState(rule?.category?.name ?? "");
  const [freq, setFreq] = useState<RecurFreqDTO>(rule?.freq ?? "MONTHLY");
  const [interval, setInterval] = useState(String(rule?.interval ?? 1));
  const [dayOfMonth, setDayOfMonth] = useState(
    rule?.dayOfMonth === null || rule?.dayOfMonth === undefined
      ? ""
      : String(rule.dayOfMonth),
  );
  const [startDate, setStartDate] = useState(() => rule?.startDate ?? todayCalendar());
  const [endDate, setEndDate] = useState(rule?.endDate ?? "");
  const [count, setCount] = useState(rule ? String(rule.count ?? "") : "");
  const [postingMode, setPostingMode] = useState<PostingModeDTO>(rule?.postingMode ?? "NOTIFY");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  /**
   * Aviso de descarte: «Cancelar» no descarta en silencio.
   *
   * El pie de este formulario es pegajoso (`sticky bottom-0`) sobre el scroll
   * de la PÁGINA: es la única zona donde un tap perdido puede caer. Cuando
   * hay algo escrito —el nombre, el monto, la categoría— cerrar tira el
   * trabajo, así que primero pregunta, en línea, en dos pasos (nunca un
   * `window.confirm`: el driver de los tests no tiene nodo que conteste).
   *
   * «Sucio» es lo que cuesta recuperar: el nombre, el monto y la categoría.
   * Elegir el tipo o la cuenta no marca sucio — volver a abrir el formulario
   * reproduce el mismo estado por defecto, y advertir por eso entrenaría a
   * ignorar el aviso.
   */
  const [discardWarning, setDiscardWarning] = useState(false);
  const dirty =
    title.trim() !== "" || amount.trim() !== "" || categoryName.trim() !== "";

  const isTransfer = kind === "TRANSFER";
  const isIncome = kind === "INCOME";

  // ── Cuentas de origen según el tipo ────────────────────────────────────────
  // Un INGRESO no puede entrar a una cuenta de deuda (lo rechaza la base, igual
  // que en un movimiento). Se filtra la lista para que el formulario no pueda
  // mostrar ese estado inválido.
  const sourceOptions = useMemo(
    () => (isIncome ? accounts.filter((a) => canReceiveIncome(a.kind)) : accounts),
    [accounts, isIncome],
  );

  const destinationOptions = useMemo(
    () => accounts.filter((a) => a.id !== accountId),
    [accounts, accountId],
  );

  // Si la cuenta elegida dejó de ser válida al cambiar el tipo (era una
  // tarjeta y ahora el tipo es ingreso), se re-elige la primera posible. Mismo
  // criterio que TransactionForm: el formulario nunca queda en un estado que la
  // base va a rechazar.
  const effectiveAccountId = sourceOptions.some((a) => a.id === accountId)
    ? accountId
    : (sourceOptions[0]?.id ?? "");

  // El destino no puede ser el mismo que el origen.
  const effectiveToAccountId =
    toAccountId !== "" &&
    toAccountId !== effectiveAccountId &&
    accounts.some((a) => a.id === toAccountId)
      ? toAccountId
      : (accounts.find((a) => a.id !== effectiveAccountId)?.id ?? "");

  const amountPreview = formatAmountInput(amount);

  const suggestions = useMemo(() => {
    const query = categoryName.trim().toLowerCase();
    const pool = isTransfer
      ? []
      : categories.filter((c) => c.kind === (isIncome ? "INCOME" : "EXPENSE"));
    if (!query) return pool.slice(0, 6);
    return pool
      .filter((c) => c.name.toLowerCase().includes(query))
      .slice(0, 6);
  }, [categories, categoryName, isTransfer, isIncome]);

  const categoryExists = useMemo(
    () =>
      categories.some(
        (c) => c.name.toLowerCase() === categoryName.trim().toLowerCase(),
      ),
    [categories, categoryName],
  );

  /**
   * La categoría escrita es del OTRO TIPO que la regla.
   *
   * ─────────────────────────────────────────────────────────────────────────────
   * POR QUÉ ESTO SE AVISA EN EL FORMULARIO Y NO SÓLO EN EL SERVIDOR
   *
   * "Alquiler" es un Gasto: usarlo para una regla de Ingreso es imposible (la
   * base lo rechaza y el generador no postearía el movimiento). Dejar el error
   * para después del viaje es una forma de hacer que la persona descubra una
   * regla que nunca va a funcionar cuando intente usarla.
   *
   * Y derivar el tipo es MEJOR que dejar el error: si la categoría dice "Gasto",
   * la regla tiene que ser un Gasto. El botón de abajo hace eso, sin perder
   * nada de lo escrito.
   *
   * La comparación usa la MISMA normalización que el servidor
   * (`normalizeCategoryName`): "Alquiler" y "ALQUILER" son la misma categoría.
   * ─────────────────────────────────────────────────────────────────────────────
   */
  const categoryConflict = useMemo(() => {
    if (isTransfer) return null;
    const typed = normalizeCategoryName(categoryName);
    if (!typed) return null;
    const found = categories.find(
      (c) => normalizeCategoryName(c.name) === typed,
    );
    if (!found) return null;
    if (!categoryKindConflicts(kind, found.kind)) return null;
    return found;
  }, [categories, categoryName, kind, isTransfer]);

  // La fecha de inicio sugiere el ancla cuando está vacía: "vacío = el día de
  // la fecha de inicio" es la semántica del servidor, y sin decirlo el campo
  // parece una decisión obligatoria.
  const anchorHint = startDate.length === 10 ? Number(startDate.slice(8, 10)) : null;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");

    // Las validaciones de acá son las MISMAS que aplica el servidor, escritas
    // acá para dar el error sin ida y vuelta. La autoridad sigue siendo la API:
    // estas líneas no reemplazan nada, sólo aceleran el aviso.
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setError("Poné un nombre para la regla.");
      return;
    }
    if (!amountPreview) {
      setError("Escribí un monto mayor a cero.");
      return;
    }
    if (!effectiveAccountId) {
      setError(
        isIncome
          ? "Necesitás una cuenta de dinero (efectivo o banco) para un ingreso."
          : "Elegí una cuenta.",
      );
      return;
    }
    if (isTransfer && !effectiveToAccountId) {
      setError("Elegí a qué cuenta va la plata.");
      return;
    }
    if (!isTransfer && !categoryName.trim()) {
      setError(
        isIncome ? "Escribí de dónde viene el ingreso." : "Escribí en qué se gasta.",
      );
      return;
    }
    // La categoría escrita es del otro tipo: la regla no puede postear ese
    // movimiento. Se corta acá (el servidor también lo rechaza) con el mismo
    // mensaje que usa la API, para que las dos capas digan lo mismo.
    if (categoryConflict) {
      setError(
        ruleCategoryKindMessage(categoryConflict.name, kind, categoryConflict.kind),
      );
      return;
    }

    const intervalNumber = Number(interval);
    if (!Number.isInteger(intervalNumber) || intervalNumber < 1 || intervalNumber > 365) {
      setError("El intervalo tiene que ser un número entero entre 1 y 365.");
      return;
    }

    let dayOfMonthValue: number | null = null;
    if (isFreqWithAnchor(freq) && dayOfMonth.trim() !== "") {
      const parsed = Number(dayOfMonth);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 31) {
        setError("El día del mes tiene que ser un número entero entre 1 y 31.");
        return;
      }
      dayOfMonthValue = parsed;
    }

    if (!isCalendarDate(startDate)) {
      setError("Elegí una fecha de inicio.");
      return;
    }
    if (endDate !== "" && !isCalendarDate(endDate)) {
      setError("La fecha de fin no es válida.");
      return;
    }
    if (endDate !== "" && endDate < startDate) {
      setError("La fecha de fin no puede ser anterior a la de inicio.");
      return;
    }

    let countValue: number | null = null;
    if (count.trim() !== "") {
      const parsed = Number(count);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) {
        setError("La cantidad de ocurrencias tiene que ser un número entero entre 1 y 10000.");
        return;
      }
      countValue = parsed;
    }

    // ── El body es el estado VISIBLE del formulario ──────────────────────────
    // Se manda SIEMPRE lo que se ve: `dayOfMonth`, `endDate` y `count` van
    // explícitos (null cuando están vacíos) porque el servidor los interpreta
    // como "limpiá el valor viejo", no como "no vino". Y los campos que el tipo
    // no admite se mandan SÓLO cuando el tipo los usa: así cambiar a
    // transferencia quita la categoría y volver a gasto quita el destino, sin
    // que la validación de lo mezclado tenga que adivinar.
    const body: Record<string, unknown> = {
      title: cleanTitle,
      kind,
      amount,
      accountId: effectiveAccountId,
      freq,
      interval: intervalNumber,
      dayOfMonth: isFreqWithAnchor(freq) ? dayOfMonthValue : null,
      startDate,
      endDate: endDate === "" ? null : endDate,
      count: countValue,
      postingMode,
    };
    if (isTransfer) body.toAccountId = effectiveToAccountId;
    else body.categoryName = categoryName.trim();
    if (editing) body.id = rule.id;

    setSaving(true);
    try {
      const response = await fetch("/api/recurrence/rules", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? "No se pudo guardar la regla.");
      }

      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la regla.");
    } finally {
      setSaving(false);
    }
  }

  // ── Sin cuentas no hay regla posible ───────────────────────────────────────
  if (accounts.length === 0) {
    return (
      <section
        id="rec-form"
        className="mx-auto w-full max-w-xl bg-white dark:bg-zinc-900 rounded-2xl p-6 shadow-sm"
      >
        <h2 className="text-xl font-bold mb-3">Primero creá una cuenta</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
          Toda regla postea (o propone) movimientos sobre una cuenta. Sin al
          menos una cuenta creada no hay dónde registrar la plata.
        </p>
        <button
          id="rec-form-close"
          onClick={onClose}
          className="w-full rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-black py-3 font-bold"
        >
          Entendido
        </button>
      </section>
    );
  }

  const style = KIND_STYLE[kind];

  // ─────────────────────────────────────────────────────────────────────────────
  // POR QUÉ ESTE FORMULARIO ES UNA SECCIÓN DE LA PÁGINA Y NO UN MODAL
  // ─────────────────────────────────────────────────────────────────────────────
  // Los otros formularios de la app son modales, y con razón: entran en una
  // pantalla. Éste no. Medido en la ventana de los tests (≈1034×557), el modal
  // llegaba a mostrar hasta "Cada cuánto": la categoría —un campo OBLIGATORIO—
  // quedaba recortada por el contenedor con scroll propio.
  //
  // Para una persona eso se resuelve scrolleando el modal, pero el recorte tiene
  // un costo real: el scroll interno es invisible hasta que lo usás y, para
  // cualquier automatización (Maestro incluido), un elemento recortado por un
  // contenedor interno directamente NO EXISTE — no se puede alcanzar. Es la
  // trampa 9 del README, con el mismo remedio: no se arregla el test, se arregla
  // la pantalla.
  //
  // Como sección de la página, el formulario scrollea con el scroll de TODA la
  // página (rueda, teclado, táctil o driver), no hay recorte que esconda nada, y
  // el pie sigue pegado abajo (`sticky bottom-0`) mientras dure el formulario:
  // el botón de guardar no se pierde nunca.
  return (
    <section
      id="rec-form"
      className="mx-auto w-full max-w-xl bg-white dark:bg-zinc-900 rounded-2xl shadow-sm"
    >
      <div className="p-4 sm:p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className={`text-xl font-bold ${style.accent}`}>
            🔁 {editing ? "Editar regla" : "Nueva regla"}
          </h2>
          <button
            id="rec-form-close"
            onClick={onClose}
            className="text-2xl leading-none text-zinc-400 hover:text-zinc-700 px-2"
            aria-label="Cerrar"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* ── Nombre ────────────────────────────────────────────────────── */}
          <div>
            <label htmlFor="rec-title" className="text-sm font-medium">
              Nombre *
            </label>
            <input
              id="rec-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ej: Alquiler, Sueldo, Netflix…"
              maxLength={200}
              autoComplete="off"
              autoFocus
              className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-4 py-3 outline-none focus:ring-2 focus:ring-zinc-400"
            />
          </div>

          {/* ── Tipo ──────────────────────────────────────────────────────── */}
          {/* Botones y NO un `<select>`: los flujos de Maestro tienen que poder
              tocar la opción sin pelear con el desplegable nativo. */}
          <div>
            <p className="text-sm font-medium mb-1">Tipo *</p>
            <div className="grid grid-cols-3 gap-2">
              {KINDS.map((option) => (
                <button
                  key={option}
                  id={`rec-kind-${option}`}
                  type="button"
                  onClick={() => setKind(option)}
                  className={`rounded-xl py-2.5 text-sm font-medium border ${
                    kind === option
                      ? `border-transparent ${KIND_STYLE[option].selected}`
                      : "border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  }`}
                >
                  {KINDS_LABEL[option]}
                </button>
              ))}
            </div>
          </div>

          {/* ── Monto ─────────────────────────────────────────────────────── */}
          <div>
            <label htmlFor="rec-amount" className="text-sm font-medium">
              Monto *
            </label>
            <input
              id="rec-amount"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0,00"
              className="mt-1 w-full text-2xl font-bold rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-4 py-3 outline-none focus:ring-2 focus:ring-zinc-400"
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

          {/* ── Frecuencia ────────────────────────────────────────────────── */}
          <div>
            <p className="text-sm font-medium mb-1">Cada cuánto *</p>
            <div className="grid grid-cols-2 gap-2">
              {FREQS.map((option) => (
                <button
                  key={option}
                  id={`rec-freq-${option}`}
                  type="button"
                  onClick={() => setFreq(option)}
                  className={`rounded-xl py-2.5 text-sm font-medium border ${
                    freq === option
                      ? "border-transparent bg-zinc-900 text-white dark:bg-white dark:text-black"
                      : "border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  }`}
                >
                  {RECUR_FREQ_LABEL[option]}
                </button>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <label htmlFor="rec-interval" className="text-sm text-zinc-500">
                Cada
              </label>
              <input
                id="rec-interval"
                type="number"
                min={1}
                max={365}
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
                className="w-20 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-zinc-400"
              />
              <span className="text-sm text-zinc-500">
                {freq === "DAILY"
                  ? "día(s)"
                  : freq === "WEEKLY"
                    ? "semana(s)"
                    : freq === "MONTHLY"
                      ? "mes(es)"
                      : "año(s)"}
              </span>
            </div>
          </div>

          {/* ── Ancla del día del mes (sólo mensual/anual) ────────────────── */}
          {isFreqWithAnchor(freq) && (
            <div>
              <label htmlFor="rec-day-of-month" className="text-sm font-medium">
                Día del mes{" "}
                <span className="font-normal text-zinc-500">(opcional)</span>
              </label>
              <input
                id="rec-day-of-month"
                type="number"
                min={1}
                max={31}
                value={dayOfMonth}
                onChange={(e) => setDayOfMonth(e.target.value)}
                placeholder={anchorHint ? `Vacío = día ${anchorHint}` : "Vacío = día de inicio"}
                className="mt-1 w-28 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-zinc-400"
              />
              <p className="mt-1 text-xs text-zinc-500">
                Si el mes no tiene ese día, usa el último (31 → 30 de abril).
              </p>
            </div>
          )}

          {/* ── Cuenta de origen ──────────────────────────────────────────── */}
          <div>
            <label htmlFor="rec-account" className="text-sm font-medium">
              {isTransfer
                ? "Desde qué cuenta *"
                : isIncome
                  ? "A qué cuenta entra *"
                  : "De qué cuenta sale *"}
            </label>
            {sourceOptions.length === 0 ? (
              <p className="mt-1 text-sm rounded-lg bg-amber-50 dark:bg-amber-950 text-amber-800 dark:text-amber-200 px-3 py-2">
                Un ingreso necesita una cuenta de dinero (efectivo o banco): las
                tarjetas y los préstamos no reciben ingresos.
              </p>
            ) : (
              <select
                id="rec-account"
                value={effectiveAccountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-3 py-3 outline-none focus:ring-2 focus:ring-zinc-400"
              >
                {sourceOptions.map((account) => (
                  <option key={account.id} value={account.id}>
                    {accountLabel(account)}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* ── Cuenta de destino (sólo transferencias) ───────────────────── */}
          {isTransfer && (
            <div>
              <label htmlFor="rec-to-account" className="text-sm font-medium">
                A qué cuenta va *
              </label>
              {destinationOptions.length === 0 ? (
                <p className="mt-1 text-sm rounded-lg bg-amber-50 dark:bg-amber-950 text-amber-800 dark:text-amber-200 px-3 py-2">
                  Necesitás al menos dos cuentas para transferir entre ellas.
                </p>
              ) : (
                <select
                  id="rec-to-account"
                  value={effectiveToAccountId}
                  onChange={(e) => setToAccountId(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-3 py-3 outline-none focus:ring-2 focus:ring-zinc-400"
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

          {/* ── Categoría (sólo ingresos y gastos) ────────────────────────── */}
          {!isTransfer && (
            <div>
              <label htmlFor="rec-category" className="text-sm font-medium">
                {isIncome ? "De dónde viene *" : "En qué se gasta *"}
              </label>
              <input
                id="rec-category"
                value={categoryName}
                onChange={(e) => setCategoryName(e.target.value)}
                placeholder={
                  isIncome ? "Ej: Sueldo, Alquiler cobrado…" : "Ej: Vivienda, Internet…"
                }
                list="rec-categories"
                autoComplete="off"
                className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-4 py-3 outline-none focus:ring-2 focus:ring-zinc-400"
              />
              <datalist id="rec-categories">
                {/* Sólo las categorías del tipo activo: ofrecer una combinación
                    imposible es peor que no ofrecerla (la base la rechaza). */}
                {categories
                  .filter((c) => c.kind === (isIncome ? "INCOME" : "EXPENSE"))
                  .map((category) => (
                    <option key={category.id} value={category.name} />
                  ))}
              </datalist>

              {categoryName.trim() !== "" && !categoryConflict && (
                <p className="mt-1 text-xs text-zinc-500">
                  {categoryExists ? (
                    <>
                      ✓ Se usa la categoría existente{" "}
                      <b>“{categoryName.trim()}”</b>
                    </>
                  ) : (
                    <>
                      ＋ Se crea la categoría <b>“{categoryName.trim()}”</b> para
                      los movimientos de la regla
                    </>
                  )}
                </p>
              )}

              {/* ── La categoría contradice el tipo de la regla ──────────────
                  El aviso va ACÁ, junto al campo, y no en el pie: el pie es
                  pegajoso y el aviso tiene que estar donde la persona está
                  escribiendo. El botón deriva el tipo de la regla, que es la
                  salida que no tira nada de lo escrito. */}
              {categoryConflict && (
                <div
                  id="rec-category-conflict"
                  role="alert"
                  className="mt-2 rounded-lg bg-amber-50 dark:bg-amber-950 text-amber-800 dark:text-amber-200 px-3 py-2 text-xs"
                >
                  <p>
                    <b>“{categoryConflict.name}”</b> es una categoría de{" "}
                    {CATEGORY_KIND_LABEL[categoryConflict.kind].toLowerCase()} y
                    esta regla es {MOVEMENT_KIND_LABEL[kind].toLowerCase()}: no
                    puede postear ese movimiento.
                  </p>
                  <button
                    id="rec-category-fix"
                    type="button"
                    onClick={() =>
                      setKind(
                        categoryConflict.kind === "INCOME" ? "INCOME" : "EXPENSE",
                      )
                    }
                    className="mt-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 text-xs font-bold"
                  >
                    Usarla como {CATEGORY_KIND_LABEL[categoryConflict.kind].toLowerCase()}
                  </button>
                </div>
              )}

              {suggestions.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {suggestions.map((suggestion) => (
                    <button
                      type="button"
                      key={suggestion.id}
                      onClick={() => setCategoryName(suggestion.name)}
                      className="text-xs px-3 py-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700"
                    >
                      {suggestion.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Fechas: inicio, fin y tope ────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="rec-start-date" className="text-sm font-medium">
                Desde *
              </label>
              <input
                id="rec-start-date"
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  clearDateInputIfEmptied(e.target);
                }}
                className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2.5 outline-none focus:ring-2 focus:ring-zinc-400"
              />
            </div>
            <div>
              <label htmlFor="rec-end-date" className="text-sm font-medium">
                Hasta <span className="font-normal text-zinc-500">(opcional)</span>
              </label>
              <input
                id="rec-end-date"
                type="date"
                value={endDate}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  clearDateInputIfEmptied(e.target);
                }}
                className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2.5 outline-none focus:ring-2 focus:ring-zinc-400"
              />
            </div>
          </div>

          <div>
            <label htmlFor="rec-count" className="text-sm font-medium">
              Cantidad de veces{" "}
              <span className="font-normal text-zinc-500">(opcional)</span>
            </label>
            <input
              id="rec-count"
              type="number"
              min={1}
              max={10000}
              value={count}
              onChange={(e) => setCount(e.target.value)}
              placeholder="Vacío = para siempre"
              className="mt-1 w-40 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-zinc-400"
            />
            <p className="mt-1 text-xs text-zinc-500">
              Hasta la fecha de fin o la cantidad: lo que corte primero.
            </p>
          </div>

          {/* ──Modo de posteo ─────────────────────────────────────────────── */}
          <div>
            <p className="text-sm font-medium mb-1">Cuando vence</p>
            <div className="grid grid-cols-2 gap-2">
              {MODES.map((option) => (
                <button
                  key={option}
                  id={`rec-mode-${option}`}
                  type="button"
                  onClick={() => setPostingMode(option)}
                  className={`rounded-xl py-2.5 px-2 text-sm font-medium border ${
                    postingMode === option
                      ? "border-transparent bg-zinc-900 text-white dark:bg-white dark:text-black"
                      : "border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  }`}
                >
                  {POSTING_MODE_LABEL[option]}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-zinc-500">
              {postingMode === "AUTO"
                ? "El movimiento se carga solo: elegilo cuando la plata ya se movió (sueldo, débito automático)."
                : "Queda esperando en la bandeja para que lo aceptes o lo saltees."}
            </p>
          </div>

          {/* ── Pie fijo (mismo motivo que en TransactionForm) ─────────────── */}
          <div className="sticky bottom-0 -mx-4 -mb-4 sm:-mx-6 sm:-mb-6 mt-4 px-4 pb-4 pt-4 sm:px-6 sm:pb-6 space-y-3 bg-white dark:bg-zinc-900">
            {error && (
              <p
                id="rec-form-error"
                role="alert"
                className="text-sm text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950 rounded-lg px-3 py-2"
              >
                {error}
              </p>
            )}

            {/* Aviso de descarte: dos pasos, en línea (nunca `window.confirm`).
                El pie de este formulario es la única zona donde un tap
                perdido puede caer: el pie es pegajoso sobre el scroll de la
                página, así que «Cancelar» no puede descartar en silencio. */}
            {discardWarning && (
              <div
                id="rec-discard-warning"
                role="alert"
                className="text-sm rounded-lg bg-amber-50 dark:bg-amber-950 text-amber-800 dark:text-amber-200 px-3 py-2"
              >
                <p>Si cerrás ahora se pierde lo que cargaste.</p>
                <div className="mt-2 flex gap-2">
                  <button
                    id="rec-discard-cancel"
                    type="button"
                    onClick={() => setDiscardWarning(false)}
                    className="rounded-lg border border-amber-300 dark:border-amber-800 px-3 py-1 text-xs font-medium"
                  >
                    Seguir editando
                  </button>
                  <button
                    id="rec-discard-confirm"
                    type="button"
                    onClick={onClose}
                    className="rounded-lg bg-rose-600 hover:bg-rose-700 text-white px-3 py-1 text-xs font-bold"
                  >
                    Descartar
                  </button>
                </div>
              </div>
            )}

            <div className="flex gap-3">
              <button
                id="rec-form-cancel"
                type="button"
                onClick={() => (dirty ? setDiscardWarning(true) : onClose())}
                className="flex-1 rounded-xl border border-zinc-300 dark:border-zinc-700 py-3 font-medium"
              >
                Cancelar
              </button>
              <button
                id="rec-form-submit"
                type="submit"
                disabled={saving}
                className={`flex-1 rounded-xl py-3 font-bold text-white disabled:opacity-50 ${
                  isTransfer
                    ? "bg-sky-600 hover:bg-sky-700"
                    : isIncome
                      ? "bg-emerald-600 hover:bg-emerald-700"
                      : "bg-rose-600 hover:bg-rose-700"
                }`}
              >
                {saving ? "Guardando…" : editing ? "Guardar cambios" : "Crear regla"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </section>
  );
}
