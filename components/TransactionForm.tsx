"use client";

import { useMemo, useState } from "react";
import { todayCalendar } from "@/lib/dates";
import {
  type AccountBalanceDTO,
  type CategoryDTO,
  type MovementKindDTO,
} from "@/lib/finance";
import { formatAmountInput, formatLiability, formatMoney } from "@/lib/format";

interface Props {
  kind: MovementKindDTO;
  accounts: AccountBalanceDTO[];
  categories: CategoryDTO[];
  /** Cuenta preseleccionada, si la pantalla viene de "cargar un gasto acá". */
  defaultAccountId?: string;
  onClose: () => void;
  onSaved: () => void;
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
  { title: string; accent: string; focus: string; badge: string }
> = {
  INCOME: {
    title: "＋ Nuevo ingreso",
    accent: "text-emerald-600",
    focus: "focus:ring-emerald-500",
    badge: "bg-emerald-600 hover:bg-emerald-700",
  },
  EXPENSE: {
    title: "－ Nuevo gasto",
    accent: "text-rose-600",
    focus: "focus:ring-rose-500",
    badge: "bg-rose-600 hover:bg-rose-700",
  },
  TRANSFER: {
    title: "⇄ Nueva transferencia",
    accent: "text-sky-600",
    focus: "focus:ring-sky-500",
    badge: "bg-sky-600 hover:bg-sky-700",
  },
};

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
 * Cuenta de origen por defecto.
 *
 * Para un INGRESO se filtra a las cuentas de dinero: las de pasivo no pueden
 * recibir ingresos (lo impide un trigger en la base), así que preseleccionar una
 * tarjeta dejaría el formulario en un estado que la base va a rechazar. Es mejor
 * que la interfaz no pueda mostrar ese estado que detectarlo después.
 */
function pickSourceAccount(
  kind: MovementKindDTO,
  accounts: AccountBalanceDTO[],
  preferred?: string,
): string {
  if (preferred) return preferred;

  const candidates =
    kind === "INCOME" ? accounts.filter((account) => !account.isLiability) : accounts;

  return candidates[0]?.id ?? "";
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
  kind,
  accounts,
  categories,
  defaultAccountId,
  onClose,
  onSaved,
}: Props) {
  const style = KIND_STYLE[kind];

  // ── La fecha por defecto ───────────────────────────────────────────────────
  // Antes: `new Date().toISOString().slice(0, 10)`.
  //
  // Ese era un bug silencioso y bastante cruel: `toISOString()` convierte a UTC.
  // En Buenos Aires (UTC−3), a partir de las 21:00 el día UTC ya es el
  // siguiente, así que un gasto cargado a las 22:00 se registraba con la fecha
  // de MAÑANA. El usuario no lo notaba hasta que el movimiento aparecía en el
  // mes siguiente.
  //
  const [date, setDate] = useState(() => todayCalendar());

  const [amount, setAmount] = useState("");

  // ── Cuenta de origen por defecto ───────────────────────────────────────────
  const [accountId, setAccountId] = useState(() =>
    pickSourceAccount(kind, accounts, defaultAccountId),
  );

  // ── Cuenta de destino por defecto ──────────────────────────────────────────
  // Arranca con la primera cuenta que NO sea el origen.
  //
  // La primera versión dejaba el destino vacío ("Elegí una cuenta…") para forzar
  // una elección consciente. En la práctica sólo agrega un toque obligatorio al
  // caso más común —pasar plata del banco al efectivo— y deja el formulario en
  // un estado inválido que la validación tiene que rechazar después. Con un
  // destino válido preseleccionado, guardar funciona en un solo toque.
  //
  // Y como el `<option>` vacío ya no existe, es imposible guardar una
  // transferencia sin destino: el estado inválido dejó de ser representable en
  // la interfaz, no sólo detectable en la validación.
  const [toAccountId, setToAccountId] = useState(() =>
    pickDestinationAccount(accounts, pickSourceAccount(kind, accounts, defaultAccountId)),
  );

  const [categoryName, setCategoryName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const isTransfer = kind === "TRANSFER";
  const isIncome = kind === "INCOME";

  // Cuentas que pueden recibir el dinero en una transferencia: todas menos la de
  // origen. Ofrecer la misma cuenta obligaría a la base a rechazar el movimiento
  // y el usuario vería un error que podría haber evitado el formulario.
  const destinationOptions = useMemo(
    () => accounts.filter((a) => a.id !== accountId),
    [accounts, accountId],
  );

  const selectedAccount = accounts.find((a) => a.id === accountId);

  const amountPreview = formatAmountInput(amount);

  const suggestions = useMemo(() => {
    const query = categoryName.trim().toLowerCase();
    if (!query) return categories.slice(0, 6);
    return categories
      .filter((c) => c.name.toLowerCase().includes(query))
      .slice(0, 6);
  }, [categories, categoryName]);

  const categoryExists = useMemo(
    () =>
      categories.some(
        (c) => c.name.toLowerCase() === categoryName.trim().toLowerCase(),
      ),
    [categories, categoryName],
  );

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
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
    if (!isTransfer && !categoryName.trim()) {
      setError(
        isIncome ? "Escribí de dónde viene el ingreso." : "Escribí en qué gastaste.",
      );
      return;
    }

    setSaving(true);
    try {
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
          ...(!isTransfer ? { categoryName: categoryName.trim() } : {}),
          description,
        }),
      });

      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? "No se pudo guardar el movimiento.");
      }

      onSaved();
      onClose();
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
      <div
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4"
        onClick={onClose}
      >
        <div
          className="w-full sm:max-w-md bg-white dark:bg-zinc-900 rounded-t-3xl sm:rounded-3xl p-6 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md max-h-[92vh] overflow-y-auto bg-white dark:bg-zinc-900 rounded-t-3xl sm:rounded-3xl p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
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

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
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
              onChange={(e) => setAmount(e.target.value)}
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
                // Al cambiar el origen, el destino anterior puede ser el mismo.
                // Se re-elige el primero disponible en vez de vaciarlo: el
                // formulario nunca queda en un estado inválido.
                setToAccountId(pickDestinationAccount(accounts, nextSource));
              }}
              className={`mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-3 py-3 outline-none focus:ring-2 ${style.focus}`}
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
                  className={`mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-3 py-3 outline-none focus:ring-2 ${style.focus}`}
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
              <label htmlFor="tx-category" className="text-sm font-medium">
                {isIncome ? "De dónde viene *" : "En qué se fue *"}
              </label>
              <input
                id="tx-category"
                value={categoryName}
                onChange={(e) => setCategoryName(e.target.value)}
                placeholder={
                  isIncome
                    ? "Ej: Sueldo, Freelance, Ventas…"
                    : "Ej: Comida, Alquiler, Transporte…"
                }
                list="tx-categories"
                autoComplete="off"
                className={`mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-4 py-3 outline-none focus:ring-2 ${style.focus}`}
              />
              <datalist id="tx-categories">
                {categories.map((category) => (
                  <option key={category.id} value={category.name} />
                ))}
              </datalist>

              {categoryName.trim() !== "" && (
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

          {/* ── Fecha y nota ──────────────────────────────────────────────── */}
          <div>
            <label htmlFor="tx-date" className="text-sm font-medium">
              Fecha *
            </label>
            <input
              id="tx-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={`mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2.5 outline-none focus:ring-2 ${style.focus}`}
            />
          </div>

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
              con el fondo del modal asomando alrededor.

              El mensaje de error va acá adentro y no entre los campos: un error
              que aparece fuera de la vista es un error que no se leyó. */}
          <div className="sticky bottom-0 -mx-6 -mb-6 mt-4 px-6 pb-6 pt-4 space-y-3 bg-white dark:bg-zinc-900">
            {error && (
              <p
                role="alert"
                className="text-sm text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950 rounded-lg px-3 py-2"
              >
                {error}
              </p>
            )}

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
          </div>
        </form>
      </div>
    </div>
  );
}
