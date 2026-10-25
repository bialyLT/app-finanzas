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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  onClose: () => void;
  /** Se llama después de un commit exitoso: el panel recarga sus datos. */
  onImported: () => void;
}

const STATUS_STYLE: Record<
  CsvRowPreviewDTO["status"],
  { label: string; className: string }
> = {
  VALID: { label: "Válida", className: "bg-success/10 text-success" },
  INVALID: { label: "Inválida", className: "bg-danger/10 text-danger" },
  DUPLICATE: { label: "Duplicada", className: "bg-warning/10 text-warning" },
  EMPTY: { label: "Vacía", className: "bg-surface-3 text-fg-muted" },
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
        className="w-full sm:max-w-3xl max-h-[92vh] flex flex-col overflow-hidden bg-surface-2 rounded-t-md sm:rounded-md shadow-2xl"
      >
        {/* Columna flex: el encabezado y el pie son `flex-none` y el área
            que scrollea termina donde empieza el pie (antes el pie era
            `sticky` dentro del área: los campos pasaban por debajo). */}
        <div className="flex-none px-5 pt-5">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h2 className="text-lg font-bold">Importar CSV</h2>
            <p className="text-xs text-fg-muted">
              Pegá el texto o elegí un archivo. Primero se previsualiza; nada
              se guarda hasta confirmar.
            </p>
          </div>
          <Button
            id="csv-close"
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Cerrar importación"
            className="text-xl leading-none text-fg-subtle hover:text-fg-muted px-2 h-auto w-auto"
          >
            ×
          </Button>
        </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-4">

        {result ? (
          <div
            id="csv-result"
            role="status"
            className="rounded-md bg-success/10 text-success px-4 py-3 text-sm"
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
              <Button
                id="csv-result-close"
                variant="secondary"
                size="sm"
                onClick={onClose}
                className="bg-success hover:bg-success/90 text-primary-fg"
              >
                Listo
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Label htmlFor="csv-text" className="block text-sm font-medium">
              Texto CSV *
            </Label>
            <textarea
              id="csv-text"
              value={text}
              onChange={(event) => changeText(event.target.value)}
              placeholder={
                "fecha,tipo,monto,cuenta,categoria,descripcion\n2026-08-03,EXPENSE,1500,Cuenta principal,Comida,Café"
              }
              rows={5}
              spellCheck={false}
              className="mt-1 w-full rounded-md border border-line-strong bg-transparent px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-focus"
            />

            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
              <Label htmlFor="csv-file" className="font-medium">
                …o elegí un archivo .csv
              </Label>
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
              <span className="text-fg-subtle">
                máx. {Math.floor(CSV_MAX_BYTES / 1024)} KB ·{" "}
                {CSV_MAX_ROWS} filas · UTF-8
              </span>
            </div>
            {fileName && (
              <p className="mt-1 text-xs text-fg-muted">
                Archivo: {fileName}
              </p>
            )}

            <details className="mt-2 text-xs text-fg-muted">
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
                className="mt-3 text-sm rounded-lg bg-danger/10 text-danger px-3 py-2"
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
                  <div className="rounded-lg bg-surface bg-surface-3/60 px-2 py-2">
                    <p className="text-xs text-fg-muted">Filas</p>
                    <p className="font-bold">{preview.totalRows}</p>
                  </div>
                  <div className="rounded-lg bg-success/10 px-2 py-2">
                    <p className="text-xs text-success ">
                      Importables
                    </p>
                    <p className="font-bold text-success ">
                      {preview.importableRows}
                    </p>
                  </div>
                  <div className="rounded-lg bg-danger/10 px-2 py-2">
                    <p className="text-xs text-danger ">
                      Inválidas
                    </p>
                    <p className="font-bold text-danger ">
                      {preview.invalidRows}
                    </p>
                  </div>
                  <div className="rounded-lg bg-warning/10 px-2 py-2">
                    <p className="text-xs text-warning ">
                      Duplicadas
                    </p>
                    <p className="font-bold text-warning ">
                      {preview.duplicateRows}
                    </p>
                  </div>
                  <div className="rounded-lg bg-surface bg-surface-3/60 px-2 py-2">
                    <p className="text-xs text-fg-muted">Vacías</p>
                    <p className="font-bold">{preview.emptyRows}</p>
                  </div>
                </div>

                <p className="mt-2 text-xs text-fg-muted ">
                  Se importarían {preview.totals.count}{" "}
                  {preview.totals.count === 1 ? "movimiento" : "movimientos"}:{" "}
                  ingresos {formatMoney(preview.totals.income)} · gastos{" "}
                  {formatMoney(preview.totals.expenses)} · transferencias{" "}
                  {formatMoney(preview.totals.transfers)}.
                </p>

                {preview.duplicateRows > 0 && (
                  <p className="mt-1 text-xs rounded-lg bg-warning/10 text-warning px-2 py-1.5">
                    {preview.duplicateRows}{" "}
                    {preview.duplicateRows === 1
                      ? "fila ya existe y se omite"
                      : "filas ya existen y se omiten"}
                    . No se duplican.
                  </p>
                )}

                {preview.invalidRows > 0 && (
                  <p className="mt-1 text-xs rounded-lg bg-danger/10 text-danger px-2 py-1.5">
                    Hay filas inválidas. La importación es todo o nada: corregí
                    el archivo o quitá esas filas antes de confirmar.
                  </p>
                )}

                {preview.categoriesToCreate.length > 0 && (
                  <p className="mt-1 text-xs text-fg-muted">
                    Categorías nuevas:{" "}
                    {preview.categoriesToCreate
                      .map((category) => category.name)
                      .join(", ")}
                    .
                  </p>
                )}

                {/*
                  La previsualización tiene dos presentaciones, con la misma
                  información: la tabla (escritorio) y una lista de fichas
                  (teléfono).

                  Por qué: la tabla tiene siete columnas y en 375 px mide 496 px
                  de ancho contra un contenedor de 333 — con `whitespace-nowrap`
                  en fecha, tipo y monto, la tabla no entra ni scrolleando
                  comfortablemente: el usuario tiene que arrastrar la tabla
                  horizontal para ver el monto de cada fila. Eso no es «un
                  scroll horizontal prohibido» (el documento no crece), pero en
                  un teléfono es una vista previa que no se puede leer.
                */}
                <div
                  id="csv-rows-movil"
                  className="sm:hidden mt-2 max-h-64 overflow-y-auto space-y-2 rounded-md border border-line p-2"
                >
                  {preview.rows.map((row) => {
                    const status = STATUS_STYLE[row.status];
                    return (
                      <div
                        key={`movil-${row.line}-${row.status}`}
                        id={`csv-fila-${row.line}`}
                        className="rounded-lg border border-line p-2 text-xs"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-fg-muted">Línea {row.line}</span>
                          <span
                            className={`rounded-full px-1.5 py-0.5 font-bold ${status.className}`}
                          >
                            {status.label}
                          </span>
                        </div>
                        <p className="mt-1 font-semibold">
                          {row.amount ? formatMoney(row.amount) : "—"}
                          <span className="font-normal text-fg-muted">
                            {" · "}
                            {row.date ?? "—"} ·{" "}
                            {row.kind ? MOVEMENT_KIND_LABEL[row.kind] : "—"}
                          </span>
                        </p>
                        <p className="text-fg-muted ">
                          {row.account}
                          {row.toAccount ? ` → ${row.toAccount}` : ""}
                        </p>
                        {(row.category || row.description) && (
                          <p className="text-fg-muted">
                            {row.category || "—"}
                            {row.description ? ` · ${row.description}` : ""}
                          </p>
                        )}
                        {row.errors.length > 0 && (
                          <p className="mt-0.5 text-danger ">
                            {row.errors.join(" · ")}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div
                  id="csv-rows"
                  className="hidden sm:block mt-2 max-h-64 overflow-auto rounded-md border border-line "
                >
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-surface-3 ">
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
                            className="border-t border-line align-top"
                          >
                            <td className="px-2 py-1.5 text-fg-muted">
                              {row.line}
                            </td>
                            <td className="px-2 py-1.5">
                              <span
                                className={`rounded-full px-1.5 py-0.5 font-bold whitespace-nowrap ${status.className}`}
                              >
                                {status.label}
                              </span>
                              {row.errors.length > 0 && (
                                <span className="block mt-0.5 text-danger ">
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

        </div>

        {!result && (
          <div className="flex-none px-5 py-3 bg-surface-2 border-t border-line flex flex-wrap justify-end gap-2">
            <Button
              id="csv-cancel"
              variant="outline"
              onClick={onClose}
              className="py-2 touch:min-h-11"
            >
              Cancelar
            </Button>
            <Button
              id="csv-preview-button"
              onClick={() => void runPreview()}
              disabled={busy}
              className="py-2 touch:min-h-11"
            >
              {busy && !preview ? "Leyendo…" : "Previsualizar"}
            </Button>
            <Button
              id="csv-confirm"
              variant="secondary"
              onClick={() => void confirmImport()}
              disabled={!canConfirm}
              className="py-2 touch:min-h-11 bg-success hover:bg-success/90 text-primary-fg"
            >
              {busy && preview ? "Importando…" : "Confirmar importación"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
