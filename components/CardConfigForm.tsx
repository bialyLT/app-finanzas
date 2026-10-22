"use client";

import { useState } from "react";
import { cardDaysError } from "@/lib/card-form";
import type { CardViewDTO } from "@/lib/finance";
import { formatAmountInput, formatMoney } from "@/lib/format";
import { Settings } from "lucide-react";

interface Props {
  card: CardViewDTO;
  onClose: () => void;
  onSaved: (message: string) => void;
}

/**
 * Modal para editar la configuración de una tarjeta ya creada: día de cierre,
 * día de vencimiento y límite.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ES UN MODAL APARTE Y NO SE EDITA DESDE EL PANEL
 * ─────────────────────────────────────────────────────────────────────────────
 * El alta de cuentas (`AccountForm`) crea la tarjeta con lo que se sabe en ese
 * momento; esto es la edición posterior, con la tarjeta a la vista: la pantalla
 * de tarjetas es donde uno se da cuenta de que falta el cierre (porque no hay
 * resúmenes) o de que el límite cambió.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL 409 SE MUESTRA TAL CUAL
 * ─────────────────────────────────────────────────────────────────────────────
 * Si la tarjeta ya tiene un resumen pagado, cambiar el día de cierre re-factura
 * compras ya incluidas en ese resumen (dos veces el mismo gasto). El servidor
 * lo bloquea con 409 y un mensaje que explica el escape ("borrá primero el
 * pago"). Ese mensaje se muestra VERBATIM: traducirlo acá sería escribir una
 * segunda versión de la regla, que es como se empieza a divergir.
 *
 * El mismo contrato de pares que el resto: cierre y vencimiento van juntos
 * (`lib/card-form.ts`), y dejarlos vacíos es una acción explícita: la tarjeta
 * queda sin períodos y la pantalla lo dice.
 */
export default function CardConfigForm({ card, onClose, onSaved }: Props) {
  const [closingDay, setClosingDay] = useState(
    card.closingDay === null ? "" : String(card.closingDay),
  );
  const [dueDay, setDueDay] = useState(
    card.dueDay === null ? "" : String(card.dueDay),
  );
  const [creditLimit, setCreditLimit] = useState(
    card.creditLimit === null
      ? ""
      : formatMoney(card.creditLimit, { withSymbol: false }),
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const limitPreview = formatAmountInput(creditLimit);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");

    const daysError = cardDaysError(closingDay, dueDay);
    if (daysError) {
      setError(daysError);
      return;
    }

    const closing = closingDay.trim();
    const due = dueDay.trim();

    setSaving(true);
    try {
      const response = await fetch("/api/accounts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: card.id,
          // Los dos vacíos = limpiar la configuración (null explícito). Es el
          // contrato del PATCH; mandar `undefined` significaría "no lo toques".
          closingDay: closing === "" ? null : Number(closing),
          dueDay: due === "" ? null : Number(due),
          creditLimit: creditLimit.trim() === "" ? null : creditLimit,
        }),
      });

      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(
          data.error ?? "No se pudo guardar la configuración de la tarjeta.",
        );
      }

      const limitText = limitPreview;
      onSaved(
        closing === ""
          ? `Configuración guardada: ${card.name} quedó sin día de cierre y no se van a poder correr resúmenes.`
          : `Configuración guardada: ${card.name} cierra el día ${closing} y vence el día ${due}${limitText ? ` · límite ${limitText}` : ""}.`,
      );
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "No se pudo guardar la configuración de la tarjeta.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Configurar ${card.name}`}
        className="w-full sm:max-w-md max-h-[92vh] flex flex-col overflow-hidden bg-surface-2 rounded-t-md sm:rounded-md shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Columna flex: el encabezado y el pie son `flex-none` y el área
            que scrollea termina donde empieza el pie (antes el pie era
            `sticky` dentro del área y tapaba los campos: trampa 15). */}
        <div className="flex-none px-6 pt-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold flex items-center gap-2"><Settings className="size-5" aria-hidden />{card.name}</h2>
          <button
            id="cardconf-close"
            onClick={onClose}
            className="text-2xl leading-none text-fg-subtle hover:text-fg-muted px-2"
            aria-label="Cerrar"
          >
            ×
          </button>
        </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-8">
        <form id="cardconf-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
          <p className="text-sm text-fg-muted">
            El <b>cierre</b> decide en qué resumen cae cada compra; el{" "}
            <b>vencimiento</b>, cuándo vence. El límite es opcional.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="cardconf-closing" className="text-sm font-medium">
                Día de cierre
              </label>
              <input
                id="cardconf-closing"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                autoFocus
                value={closingDay}
                onChange={(e) => setClosingDay(e.target.value)}
                placeholder="15"
                className="mt-1 w-full rounded-md border border-line-strong bg-transparent px-3 py-2.5 outline-none focus:ring-2 focus:ring-focus"
              />
            </div>
            <div>
              <label htmlFor="cardconf-due" className="text-sm font-medium">
                Día de vencimiento
              </label>
              <input
                id="cardconf-due"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={dueDay}
                onChange={(e) => setDueDay(e.target.value)}
                placeholder="5"
                className="mt-1 w-full rounded-md border border-line-strong bg-transparent px-3 py-2.5 outline-none focus:ring-2 focus:ring-focus"
              />
            </div>
          </div>

          <div>
            <label htmlFor="cardconf-limit" className="text-sm font-medium">
              Límite de la tarjeta{" "}
              <span className="font-normal text-fg-muted">(opcional)</span>
            </label>
            <input
              id="cardconf-limit"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={creditLimit}
              onChange={(e) => setCreditLimit(e.target.value)}
              placeholder="500.000"
              className="mt-1 w-full rounded-md border border-line-strong bg-transparent px-4 py-3 outline-none focus:ring-2 focus:ring-focus"
            />
            <p className="mt-1 text-xs text-fg-muted">
              {limitPreview ? (
                <>
                  Utilización = deuda ÷ <b>{limitPreview}</b>.
                </>
              ) : (
                "Sin límite, la utilización se muestra como “no se sabe” en vez de un 0% inventado."
              )}
            </p>
          </div>

          <p className="text-xs rounded-lg bg-surface-3 px-3 py-2 text-fg-muted ">
            Si dejás cierre y vencimiento vacíos y guardás, la tarjeta queda sin
            períodos: no se pueden correr resúmenes hasta que vuelvas a
            cargarlos. Y si ya hay un resumen pagado, cambiar el cierre está
            bloqueado — el aviso te dice por qué.
          </p>

          {/* Pie: hermano del área que scrollea (`flex-none`, no `sticky`). */}
        </form>
        </div>
        <div className="flex-none px-6 pb-6 pt-4 space-y-3 bg-surface-2 ">
            {error && (
              <p
                id="cardconf-error"
                role="alert"
                className="text-sm text-danger bg-danger/10 rounded-lg px-3 py-2"
              >
                {error}
              </p>
            )}

            <div className="flex gap-3">
              <button
                id="cardconf-cancel"
                type="button"
                onClick={onClose}
                className="flex-1 rounded-md border border-line-strong py-3 font-medium"
              >
                Cancelar
              </button>
              <button
                id="cardconf-save"
                type="submit"
                form="cardconf-form"
                disabled={saving}
                className="flex-1 rounded-md py-3 font-bold text-primary-fg bg-transfer hover:bg-transfer/90 disabled:opacity-50"
              >
                {saving ? "Guardando…" : "Guardar"}
              </button>
            </div>
          </div>
      </div>
    </div>
  );
}
