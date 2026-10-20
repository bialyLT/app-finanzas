"use client";

import { useEffect, useState } from "react";
import { clearDateInputIfEmptied } from "@/lib/date-input";
import { todayCalendar } from "@/lib/dates";
import type { CardPlanPreviewDTO, CardViewDTO, CategoryDTO } from "@/lib/finance";
import { formatAmountInput, formatMoney, formatPercent } from "@/lib/format";

interface Props {
  card: CardViewDTO;
  categories: CategoryDTO[];
  onClose: () => void;
  onSaved: (message: string) => void;
}

/**
 * Alta de una compra en cuotas sobre una tarjeta.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ LA VISTA PREVIA LA CALCULA EL SERVIDOR (y no este formulario)
 * ─────────────────────────────────────────────────────────────────────────────
 * El mismo criterio que el formulario de préstamos: si el cliente
 * reimplementara el reparto de cuotas o la tasa implícita, podría mostrar una
 * cuota distinta a la que después guarda la app. Acá se pide a
 * `GET /api/cards/plans/preview` DESPUÉS de que la persona deja de escribir
 * (300 ms), no en cada tecla.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL AVISO DE LA TASA IMPLÍCITA (§3.3 del ROADMAP)
 * ─────────────────────────────────────────────────────────────────────────────
 * "12 cuotas sin interés" con descuento por pago al contado NO es sin interés:
 * el interés está escondido en el precio de lista. Cuando hay precio de
 * contado, la vista previa muestra el sobreprecio y la TEA implícita —el número
 * que lo demuestra— en vez de repetir el cartel del comercio.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O1 — DOBLE CLIC EN "REGISTRAR"
 * ─────────────────────────────────────────────────────────────────────────────
 * `POST /api/cards/plans` NO es idempotente (dos altas = dos gastos y dos
 * planes). El botón se deshabilita mientras el alta está en vuelo: un segundo
 * clic no manda un segundo POST.
 */
export default function CardPlanForm({ card, categories, onClose, onSaved }: Props) {
  const [label, setLabel] = useState("");
  const [totalAmount, setTotalAmount] = useState("");
  const [installments, setInstallments] = useState("");
  const [cashPrice, setCashPrice] = useState("");
  const [categoryName, setCategoryName] = useState("");
  const [purchaseDate, setPurchaseDate] = useState(todayCalendar());

  const [preview, setPreview] = useState<CardPlanPreviewDTO | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const expenseCategories = categories.filter(
    (category) => category.kind === "EXPENSE",
  );

  // ── Vista previa (con el mismo debounce que el formulario de préstamos) ─────
  useEffect(() => {
    const total = totalAmount.trim();
    const count = installments.trim();

    if (total === "" || count === "") {
      setPreview(null);
      setPreviewError("");
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ total, installments: count });
        if (cashPrice.trim() !== "") params.set("cashPrice", cashPrice.trim());

        const response = await fetch(`/api/cards/plans/preview?${params}`);

        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          setPreviewError(body.error ?? "No se pudo calcular la cuota.");
          setPreview(null);
          return;
        }

        setPreview((await response.json()) as CardPlanPreviewDTO);
        setPreviewError("");
      } catch {
        setPreviewError("No se pudo calcular la cuota.");
        setPreview(null);
      }
    }, 300);

    // Cancelar el envío pendiente si los valores cambian antes de que se
    // cumpla el tiempo: sin esto, una respuesta lenta de una consulta vieja
    // puede llegar DESPUÉS de una nueva y sobrescribirla.
    return () => clearTimeout(timer);
  }, [totalAmount, installments, cashPrice]);

  const totalPreview = formatAmountInput(totalAmount);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");

    if (!label.trim()) {
      setError("La compra necesita una descripción (ej: Heladera).");
      return;
    }
    if (!totalPreview) {
      setError("El total de la compra tiene que ser un monto mayor a cero.");
      return;
    }
    const count = Number(installments.trim());
    if (!Number.isInteger(count) || count < 1) {
      setError(
        "La cantidad de cuotas tiene que ser un número entero mayor a cero.",
      );
      return;
    }
    if (!categoryName.trim()) {
      setError(
        "La compra necesita una categoría de gasto para poder contarla en los reportes.",
      );
      return;
    }

    setSaving(true);
    try {
      const response = await fetch("/api/cards/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cardId: card.id,
          label: label.trim(),
          totalAmount: totalAmount.trim(),
          installments: count,
          categoryName: categoryName.trim(),
          ...(cashPrice.trim() !== "" ? { cashPrice: cashPrice.trim() } : {}),
          ...(purchaseDate !== "" ? { purchaseDate } : {}),
        }),
      });

      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        // El mensaje del servidor se muestra tal cual, incluido el 409 de
        // "la tarjeta no tiene día de cierre configurado".
        throw new Error(data.error ?? "No se pudo registrar la compra en cuotas.");
      }

      onSaved(
        preview
          ? `Compra en cuotas registrada: “${label.trim()}” en ${count} ${count === 1 ? "cuota" : "cuotas"} de ${formatMoney(preview.installmentAmount)}.`
          : `Compra en cuotas registrada: “${label.trim()}”.`,
      );
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "No se pudo registrar la compra en cuotas.",
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
        aria-label={`Compra en cuotas · ${card.name}`}
        className="w-full sm:max-w-2xl max-h-[92vh] flex flex-col overflow-hidden bg-white dark:bg-zinc-900 rounded-t-3xl sm:rounded-3xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Columna flex: el encabezado y el pie son `flex-none` y el área
            que scrollea termina donde empieza el pie (antes el pie era
            `sticky` dentro del área que scrolleaba y tapaba los campos:
            trampa 15 — un tap en un campo tapado caía en el pie). */}
        <div className="flex-none px-6 pt-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold">🧾 Compra en cuotas · {card.name}</h2>
          <button
            id="plan-close"
            onClick={onClose}
            className="text-2xl leading-none text-zinc-400 hover:text-zinc-700 px-2"
            aria-label="Cerrar"
          >
            ×
          </button>
        </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-8">
        <form id="plan-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/*
            Dos columnas: los campos a la izquierda; a la derecha la categoría
            y la vista previa. La disposición no es estética: el pie del modal
            es `sticky bottom-0` y en una ventana baja tapa el final del
            formulario — un tap sobre el último campo puede caer en el pie (en
            la corrida real cayó sobre "Cancelar"). Por eso TODOS los campos
            van arriba del pie: la categoría abre la columna derecha (posición
            fija, nunca debajo del pie) y la vista previa queda después, que
            es informativa y no se toca.

            Nada se scrollea adentro del modal: Maestro no puede scrollear un
            contenedor interno y los gestos sobre el backdrop lo cierran. El
            contenido entero entra en la ventana de los tests (1034×557). En
            pantallas angostas vuelve a ser una columna.
          */}
          <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_280px] gap-4 sm:gap-5">
            {/* ── Columna de campos ─────────────────────────────────────── */}
            <div className="flex flex-col gap-4">
              <div>
                <label htmlFor="plan-label" className="block text-sm font-medium">
                  Qué compraste *
                </label>
                <input
                  id="plan-label"
                  autoFocus
                  autoComplete="off"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Ej: Heladera"
                  maxLength={200}
                  className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-4 py-3 outline-none focus:ring-2 focus:ring-sky-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="plan-total" className="block text-sm font-medium">
                    Total *
                  </label>
                  <input
                    id="plan-total"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={totalAmount}
                    onChange={(e) => setTotalAmount(e.target.value)}
                    placeholder="120.000"
                    className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2.5 outline-none focus:ring-2 focus:ring-sky-500"
                  />
                  {totalPreview && (
                    <p className="mt-1 text-xs text-zinc-500">{totalPreview}</p>
                  )}
                </div>
                <div>
                  <label htmlFor="plan-installments" className="block text-sm font-medium">
                    Cuotas *
                  </label>
                  <input
                    id="plan-installments"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    value={installments}
                    onChange={(e) => setInstallments(e.target.value)}
                    placeholder="12"
                    className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2.5 outline-none focus:ring-2 focus:ring-sky-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="plan-cash" className="block text-sm font-medium">
                    Precio de contado
                  </label>
                  <input
                    id="plan-cash"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={cashPrice}
                    onChange={(e) => setCashPrice(e.target.value)}
                    placeholder="108.000"
                    className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2.5 outline-none focus:ring-2 focus:ring-sky-500"
                  />
                </div>
                <div>
                  <label htmlFor="plan-date" className="block text-sm font-medium">
                    Fecha de la compra
                  </label>
                  <input
                    id="plan-date"
                    type="date"
                    value={purchaseDate}
                    onChange={(e) => {
                      setPurchaseDate(e.target.value);
                      clearDateInputIfEmptied(e.target);
                    }}
                    className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2.5 outline-none focus:ring-2 focus:ring-sky-500"
                  />
                </div>
              </div>
            </div>

            {/* ── Columna derecha: la categoría y la vista previa ───────── */}
            <div className="flex flex-col gap-3">
              {/*
                La categoría ABRE esta columna a propósito: es un campo que se
                tipea y su lugar tiene que ser el más lejano al pie fijo del
                modal (ver el comentario del grid).
              */}
              <div>
                <label htmlFor="plan-category" className="block text-sm font-medium">
                  Categoría del gasto *
                </label>
                <input
                  id="plan-category"
                  autoComplete="off"
                  value={categoryName}
                  onChange={(e) => setCategoryName(e.target.value)}
                  placeholder="Ej: Tecnología"
                  maxLength={60}
                  list="plan-categories"
                  className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-4 py-3 outline-none focus:ring-2 focus:ring-sky-500"
                />
                <datalist id="plan-categories">
                  {expenseCategories.map((category) => (
                    <option key={category.id} value={category.name} />
                  ))}
                </datalist>
                <p className="mt-1 text-xs text-zinc-500">
                  Si no existe, se crea.
                </p>
              </div>
              {previewError && (
                <p
                  id="plan-preview-error"
                  className="text-sm rounded-lg bg-amber-50 dark:bg-amber-950 text-amber-800 dark:text-amber-200 px-3 py-2"
                >
                  {previewError}
                </p>
              )}

              {preview ? (
                <div
                  id="plan-preview"
                  className="rounded-xl bg-sky-50 dark:bg-sky-950 px-4 py-3 text-sm"
                >
                  <p className="font-bold text-sky-900 dark:text-sky-100">
                    {preview.installments}{" "}
                    {preview.installments === 1 ? "cuota" : "cuotas"} de{" "}
                    {formatMoney(preview.installmentAmount)}
                  </p>
                  {preview.lastInstallmentAmount !== preview.installmentAmount && (
                    <p className="mt-1 text-sky-800 dark:text-sky-200">
                      La última es de {formatMoney(preview.lastInstallmentAmount)}.
                    </p>
                  )}
                  <p className="mt-1 text-sky-800 dark:text-sky-200">
                    En total vas a pagar <b>{formatMoney(preview.totalPaid)}</b>.
                  </p>

                  {preview.cashPrice !== null && preview.implicitRate !== null && (
                    <div className="mt-2 border-t border-sky-200 dark:border-sky-900 pt-2 text-sky-800 dark:text-sky-200">
                      <p>
                        Al contado: <b>{formatMoney(preview.cashPrice)}</b>.
                      </p>
                      <p className="mt-1 font-semibold">
                        No es “sin interés”: el interés está en el precio.
                      </p>
                      <p className="mt-1">
                        Financiar tiene un sobreprecio de{" "}
                        <b>{formatMoney(preview.implicitRate.surcharge)}</b>:{" "}
                        {formatPercent(preview.implicitRate.monthlyRatePercent)} por
                        mes — TEA {formatPercent(preview.implicitRate.teaPercent)}.
                      </p>
                    </div>
                  )}

                  {preview.cashPrice !== null && preview.implicitRate === null && (
                    <p className="mt-2 text-sky-800 dark:text-sky-200">
                      Pagando al contado no hay sobreprecio: financiar no tiene
                      costo extra.
                    </p>
                  )}
                </div>
              ) : (
                !previewError && (
                  <p className="text-xs text-zinc-500 rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 px-3 py-3">
                    La vista previa aparece cuando cargues el total y la cantidad
                    de cuotas. Se registra <b>un gasto por el total</b>; las
                    cuotas se reparten entre los resúmenes.
                  </p>
                )
              )}
            </div>
          </div>

          {/* Pie: hermano del área que scrollea (`flex-none`, no `sticky`). */}
        </form>
        </div>
        <div className="flex-none px-6 pb-6 pt-4 space-y-3 bg-white dark:bg-zinc-900">
            {error && (
              <p
                id="plan-error"
                role="alert"
                className="text-sm text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950 rounded-lg px-3 py-2"
              >
                {error}
              </p>
            )}

            <div className="flex gap-3">
              <button
                id="plan-cancel"
                type="button"
                onClick={onClose}
                className="flex-1 rounded-xl border border-zinc-300 dark:border-zinc-700 py-3 font-medium"
              >
                Cancelar
              </button>
              <button
                id="plan-submit"
                type="submit"
                form="plan-form"
                disabled={saving}
                className="flex-1 rounded-xl py-3 font-bold text-white bg-sky-600 hover:bg-sky-700 disabled:opacity-50"
              >
                {saving ? "Registrando…" : "Registrar compra"}
              </button>
            </div>
          </div>
      </div>
    </div>
  );
}
