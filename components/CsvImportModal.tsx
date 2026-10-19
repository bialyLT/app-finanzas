"use client";

import { useState } from "react";
import { CSV_MAX_BYTES, CSV_MAX_ROWS } from "@/lib/csv";
import {
  MOVEMENT_KIND_LABEL,
  type CsvImportResultDTO,
  type CsvPreviewDTO,
  type CsvRowPreviewDTO,
} from "@/lib/finance";
import { formatMoney } from "@/lib/format";

interface Props {
  onClose: () => void;
  /** Se llama después de un commit exitoso: el panel recarga sus datos. */
  onImported: () => void;
}

const STATUS_STYLE: Record<
  CsvRowPreviewDTO["status"],
  { label: string; className: string }
> = {
  VALID: { label: "Válida", className: "bg-emerald-100 text-emerald-800" },
  INVALID: { label: "Inválida", className: "bg-rose-100 text-rose-800" },
  DUPLICATE: { label: "Duplicada", className: "bg-amber-100 text-amber-800" },
  EMPTY: { label: "Vacía", className: "bg-zinc-100 text-zinc-600" },
};

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Importación CSV (Fase 7 ronda 2).
 *
 * Flujo en dos pasos explícitos: previsualizar y recién después confirmar.
 * Nada se escribe hasta el segundo paso, y el commit es todo-o-nada en el
 * servidor. El preview se pide al servidor (misma validación que el commit),
 * no se reimplementa acá: una segunda implementación de las reglas sería una
 * segunda fuente de verdad.
 */
export default function CsvImportModal({ onClose, onImported }: Props) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<CsvPreviewDTO | null>(null);
  const [result, setResult] = useState<CsvImportResultDTO | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  /** Cambiar el texto invalida el preview: se confirmaría algo que ya no es. */
  function changeText(value: string) {
    setText(value);
    setPreview(null);
    setResult(null);
    setError("");
  }

  async function readFile(file: File) {
    setError("");
    if (file.size > CSV_MAX_BYTES) {
      setError(
        `El archivo supera el máximo de ${Math.floor(CSV_MAX_BYTES / 1024)} KB.`,
      );
      return;
    }
    try {
      const content = await file.text();
      changeText(content);
      setFileName(file.name);
    } catch {
      setError("No se pudo leer el archivo. Probá pegando el texto.");
    }
  }

  async function runPreview() {
    if (busy) return;
    setError("");
    setResult(null);

    if (!text.trim()) {
      setError("Pegá el texto del CSV antes de previsualizar.");
      return;
    }
    if (byteLength(text) > CSV_MAX_BYTES) {
      setError(
        `El CSV supera el máximo de ${Math.floor(CSV_MAX_BYTES / 1024)} KB.`,
      );
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/import/csv/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = (await response.json().catch(() => ({}))) as
        | CsvPreviewDTO
        | { error?: string };
      if (!response.ok) {
        throw new Error(
          (data as { error?: string }).error ??
            "No se pudo previsualizar el CSV.",
        );
      }
      setPreview(data as CsvPreviewDTO);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "No se pudo previsualizar el CSV.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function confirmImport() {
    if (busy || !preview) return;
    if (preview.invalidRows > 0) {
      setError("Hay filas inválidas: corregilas antes de importar.");
      return;
    }
    if (preview.importableRows === 0) {
      setError("No hay filas válidas para importar.");
      return;
    }

    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/import/csv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          expected: {
            count: preview.totals.count,
            income: preview.totals.income,
            expenses: preview.totals.expenses,
            transfers: preview.totals.transfers,
          },
        }),
      });
      const data = (await response.json().catch(() => ({}))) as
        | CsvImportResultDTO
        | { error?: string };
      if (!response.ok) {
        throw new Error(
          (data as { error?: string }).error ?? "No se pudo importar el CSV.",
        );
      }
      setResult(data as CsvImportResultDTO);
      setPreview(null);
      onImported();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "No se pudo importar el CSV.",
      );
    } finally {
      setBusy(false);
    }
  }

  const canConfirm =
    preview !== null &&
    preview.invalidRows === 0 &&
    preview.importableRows > 0 &&
    !busy;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Importar movimientos desde CSV"
        className="w-full sm:max-w-3xl max-h-[92vh] overflow-y-auto bg-white dark:bg-zinc-900 rounded-t-3xl sm:rounded-3xl p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h2 className="text-xl font-bold">Importar CSV</h2>
            <p className="text-xs text-zinc-500">
              Pegá el texto o elegí un archivo. Primero se previsualiza; nada
              se guarda hasta confirmar.
            </p>
          </div>
          <button
            id="csv-close"
            type="button"
            onClick={onClose}
            aria-label="Cerrar importación"
            className="text-2xl leading-none text-zinc-400 hover:text-zinc-700 px-2"
          >
            ×
          </button>
        </div>

        {result ? (
          <div
            id="csv-result"
            role="status"
            className="rounded-xl bg-emerald-50 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-200 px-4 py-3 text-sm"
          >
            <p className="font-bold">
              Importación completa: {result.imported}{" "}
              {result.imported === 1 ? "movimiento" : "movimientos"}.
            </p>
            <p className="mt-1">
              {result.skippedDuplicates > 0
                ? `${result.skippedDuplicates} ${
                    result.skippedDuplicates === 1
                      ? "duplicado omitido"
                      : "duplicados omitidos"
                  } · `
                : ""}
              Ingresos {formatMoney(result.totals.income)} · Gastos{" "}
              {formatMoney(result.totals.expenses)} · Transferencias{" "}
              {formatMoney(result.totals.transfers)}.
            </p>
            {result.categoriesCreated.length > 0 && (
              <p className="mt-1 text-xs">
                Categorías creadas:{" "}
                {result.categoriesCreated.map((category) => category.name).join(", ")}.
              </p>
            )}
            <div className="mt-3">
              <button
                id="csv-result-close"
                type="button"
                onClick={onClose}
                className="rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 text-xs font-bold"
              >
                Listo
              </button>
            </div>
          </div>
        ) : (
          <>
            <label htmlFor="csv-text" className="block text-sm font-medium">
              Texto CSV *
            </label>
            <textarea
              id="csv-text"
              value={text}
              onChange={(event) => changeText(event.target.value)}
              placeholder={
                "fecha,tipo,monto,cuenta,categoria,descripcion\n2026-08-03,EXPENSE,1500,Cuenta principal,Comida,Café"
              }
              rows={5}
              spellCheck={false}
              className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-emerald-500"
            />

            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
              <label htmlFor="csv-file" className="font-medium">
                …o elegí un archivo .csv
              </label>
              <input
                id="csv-file"
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void readFile(file);
                  event.target.value = "";
                }}
                className="text-xs"
              />
              <span className="text-zinc-400">
                máx. {Math.floor(CSV_MAX_BYTES / 1024)} KB ·{" "}
                {CSV_MAX_ROWS} filas · UTF-8
              </span>
            </div>
            {fileName && (
              <p className="mt-1 text-[11px] text-zinc-500">
                Archivo: {fileName}
              </p>
            )}

            <details className="mt-2 text-xs text-zinc-500">
              <summary className="cursor-pointer">
                Formato aceptado (headers y alias)
              </summary>
              <p className="mt-1 leading-snug">
                Obligatorios: <b>fecha</b> (YYYY-MM-DD o DD/MM/YYYY),{" "}
                <b>tipo</b> (INCOME / EXPENSE / TRANSFER, o ingreso / gasto /
                transferencia), <b>monto</b> (1500, 1.500,50 o 1500.50) y{" "}
                <b>cuenta</b>. Opcionales: <b>cuenta_destino</b> (obligatoria en
                TRANSFER), <b>categoria</b> y <b>descripcion</b>. Se aceptan
                BOM, CRLF, comillas y saltos de línea dentro de un campo.
                También: date/fecha, kind/tipo, amount/monto, account/cuenta,
                to_account/cuenta_destino, category/categoria,
                description/descripcion/nota.
              </p>
            </details>

            {error && (
              <p
                id="csv-error"
                role="alert"
                className="mt-3 text-sm rounded-lg bg-rose-50 dark:bg-rose-950 text-rose-700 dark:text-rose-300 px-3 py-2"
              >
                {error}
              </p>
            )}

            {preview && (
              <div id="csv-preview" className="mt-4">
                <div
                  id="csv-summary"
                  className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center"
                >
                  <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800/60 px-2 py-2">
                    <p className="text-[11px] text-zinc-500">Filas</p>
                    <p className="font-bold">{preview.totalRows}</p>
                  </div>
                  <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950 px-2 py-2">
                    <p className="text-[11px] text-emerald-700 dark:text-emerald-300">
                      Importables
                    </p>
                    <p className="font-bold text-emerald-700 dark:text-emerald-300">
                      {preview.importableRows}
                    </p>
                  </div>
                  <div className="rounded-lg bg-rose-50 dark:bg-rose-950 px-2 py-2">
                    <p className="text-[11px] text-rose-700 dark:text-rose-300">
                      Inválidas
                    </p>
                    <p className="font-bold text-rose-700 dark:text-rose-300">
                      {preview.invalidRows}
                    </p>
                  </div>
                  <div className="rounded-lg bg-amber-50 dark:bg-amber-950 px-2 py-2">
                    <p className="text-[11px] text-amber-700 dark:text-amber-300">
                      Duplicadas
                    </p>
                    <p className="font-bold text-amber-700 dark:text-amber-300">
                      {preview.duplicateRows}
                    </p>
                  </div>
                  <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800/60 px-2 py-2">
                    <p className="text-[11px] text-zinc-500">Vacías</p>
                    <p className="font-bold">{preview.emptyRows}</p>
                  </div>
                </div>

                <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-300">
                  Se importarían {preview.totals.count}{" "}
                  {preview.totals.count === 1 ? "movimiento" : "movimientos"}:{" "}
                  ingresos {formatMoney(preview.totals.income)} · gastos{" "}
                  {formatMoney(preview.totals.expenses)} · transferencias{" "}
                  {formatMoney(preview.totals.transfers)}.
                </p>

                {preview.duplicateRows > 0 && (
                  <p className="mt-1 text-xs rounded-lg bg-amber-50 dark:bg-amber-950 text-amber-800 dark:text-amber-200 px-2 py-1.5">
                    {preview.duplicateRows}{" "}
                    {preview.duplicateRows === 1
                      ? "fila ya existe y se omite"
                      : "filas ya existen y se omiten"}
                    . No se duplican.
                  </p>
                )}

                {preview.invalidRows > 0 && (
                  <p className="mt-1 text-xs rounded-lg bg-rose-50 dark:bg-rose-950 text-rose-800 dark:text-rose-200 px-2 py-1.5">
                    Hay filas inválidas. La importación es todo o nada: corregí
                    el archivo o quitá esas filas antes de confirmar.
                  </p>
                )}

                {preview.categoriesToCreate.length > 0 && (
                  <p className="mt-1 text-xs text-zinc-500">
                    Categorías nuevas:{" "}
                    {preview.categoriesToCreate
                      .map((category) => category.name)
                      .join(", ")}
                    .
                  </p>
                )}

                <div
                  id="csv-rows"
                  className="mt-2 max-h-64 overflow-auto rounded-xl border border-zinc-200 dark:border-zinc-800"
                >
                  <table className="w-full text-left text-[11px]">
                    <thead className="sticky top-0 bg-zinc-100 dark:bg-zinc-800">
                      <tr>
                        <th className="px-2 py-1.5">Línea</th>
                        <th className="px-2 py-1.5">Estado</th>
                        <th className="px-2 py-1.5">Fecha</th>
                        <th className="px-2 py-1.5">Tipo</th>
                        <th className="px-2 py-1.5">Monto</th>
                        <th className="px-2 py-1.5">Cuenta</th>
                        <th className="px-2 py-1.5">Categoría / nota</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row) => {
                        const status = STATUS_STYLE[row.status];
                        return (
                          <tr
                            key={`${row.line}-${row.status}`}
                            id={`csv-row-${row.line}`}
                            className="border-t border-zinc-100 dark:border-zinc-800 align-top"
                          >
                            <td className="px-2 py-1.5 text-zinc-500">
                              {row.line}
                            </td>
                            <td className="px-2 py-1.5">
                              <span
                                className={`rounded-full px-1.5 py-0.5 font-bold whitespace-nowrap ${status.className}`}
                              >
                                {status.label}
                              </span>
                              {row.errors.length > 0 && (
                                <span className="block mt-0.5 text-rose-600 dark:text-rose-400">
                                  {row.errors.join(" · ")}
                                </span>
                              )}
                            </td>
                            <td className="px-2 py-1.5 whitespace-nowrap">
                              {row.date ?? "—"}
                            </td>
                            <td className="px-2 py-1.5 whitespace-nowrap">
                              {row.kind
                                ? MOVEMENT_KIND_LABEL[row.kind]
                                : "—"}
                            </td>
                            <td className="px-2 py-1.5 whitespace-nowrap">
                              {row.amount ? formatMoney(row.amount) : "—"}
                            </td>
                            <td className="px-2 py-1.5">
                              {row.account}
                              {row.toAccount ? ` → ${row.toAccount}` : ""}
                            </td>
                            <td className="px-2 py-1.5">
                              {row.category || "—"}
                              {row.description ? ` · ${row.description}` : ""}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}

        {!result && (
          <div className="sticky bottom-0 -mx-5 -mb-5 mt-4 px-5 py-3 bg-white dark:bg-zinc-900 border-t border-zinc-100 dark:border-zinc-800 flex flex-wrap justify-end gap-2">
            <button
              id="csv-cancel"
              type="button"
              onClick={onClose}
              className="rounded-xl border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium"
            >
              Cancelar
            </button>
            <button
              id="csv-preview-button"
              type="button"
              onClick={() => void runPreview()}
              disabled={busy}
              className="rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-black px-4 py-2 text-sm font-bold disabled:opacity-50"
            >
              {busy && !preview ? "Leyendo…" : "Previsualizar"}
            </button>
            <button
              id="csv-confirm"
              type="button"
              onClick={() => void confirmImport()}
              disabled={!canConfirm}
              className="rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 text-sm font-bold disabled:opacity-50"
            >
              {busy && preview ? "Importando…" : "Confirmar importación"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
