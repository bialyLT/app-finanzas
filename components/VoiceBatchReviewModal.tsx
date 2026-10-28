"use client";

import { useState } from "react";
import { AlertCircle, ArrowRight, Check, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  AccountLookup,
  CategoryLookup,
  ResolvedBatch,
  ResolvedMovement,
} from "@/lib/voice-capture/resolve";
import { formatMoney } from "@/lib/format";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  batch: ResolvedBatch | null;
  accounts: AccountLookup[];
  categories: CategoryLookup[];
  onSaved: () => void;
}

export function VoiceBatchReviewModal({
  open,
  onOpenChange,
  batch,
  accounts,
  categories,
  onSaved,
}: Props) {
  const [items, setItems] = useState<ResolvedMovement[]>(
    batch?.movements ?? [],
  );
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sincronizar items si cambia el batch recibido
  useState(() => {
    if (batch?.movements) {
      setItems(batch.movements);
    }
  });

  if (!batch) return null;

  function updateItem(index: number, patch: Partial<ResolvedMovement>) {
    setItems((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      return next;
    });
  }

  function removeItem(index: number) {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }

  const validAccounts = accounts;
  const expenseCategories = categories.filter((c) => c.kind === "EXPENSE");
  const incomeCategories = categories.filter((c) => c.kind === "INCOME");

  const hasBlockingIssues = items.some((item) => {
    if (!item.amount || item.amount <= 0) return true;
    if (item.kind === "TRANSFER") {
      return (
        !item.fromAccountId ||
        !item.toAccountId ||
        item.fromAccountId === item.toAccountId
      );
    }
    return !item.accountId;
  });

  async function handleConfirmSave() {
    if (hasBlockingIssues || items.length === 0) return;

    setIsSaving(true);
    setError(null);

    const payload = {
      movements: items.map((item) => ({
        kind: item.kind,
        amount: item.amount,
        date: item.date,
        description: item.description,
        accountId: item.accountId,
        fromAccountId: item.fromAccountId,
        toAccountId: item.toAccountId,
        categoryId: item.categoryId,
        installments: item.installments,
      })),
    };

    try {
      const res = await fetch("/api/transactions/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "No se pudo guardar el lote de movimientos.");
      }

      onSaved();
      onOpenChange(false);
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : "Error inesperado al guardar los movimientos.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh]">
        <DialogHeader>
          <DialogTitle>Revisar y confirmar movimientos ({items.length})</DialogTitle>
        </DialogHeader>

        <DialogBody className="space-y-4 py-2">
          {error && (
            <div className="flex items-start gap-2 rounded-md bg-danger/10 p-3 text-sm text-danger">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {items.length === 0 ? (
            <p className="text-sm text-fg-muted py-6 text-center">
              No quedaron movimientos para confirmar.
            </p>
          ) : (
            <div className="space-y-4">
              {items.map((item, idx) => {
                const isTransfer = item.kind === "TRANSFER";
                const relevantCategories =
                  item.kind === "INCOME" ? incomeCategories : expenseCategories;

                return (
                  <div
                    key={idx}
                    className="relative rounded-lg border border-border bg-surface-2 p-4 space-y-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-xs px-2 py-0.5 rounded-md font-mono uppercase ${
                            item.kind === "INCOME"
                              ? "bg-success/15 text-success"
                              : item.kind === "EXPENSE"
                              ? "bg-danger/15 text-danger"
                              : "bg-accent/15 text-accent"
                          }`}
                        >
                          {item.kind === "INCOME"
                            ? "Ingreso"
                            : item.kind === "EXPENSE"
                            ? "Gasto"
                            : "Transferencia"}
                        </span>
                        {item.installments && item.installments >= 2 && (
                          <span className="text-xs px-2 py-0.5 rounded-md bg-warning/15 text-warning font-mono">
                            {item.installments} cuotas
                          </span>
                        )}
                      </div>

                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => removeItem(idx)}
                        className="h-8 w-8 text-fg-muted hover:text-danger"
                        title="Eliminar este movimiento"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>

                    {/* Fragmento literal original */}
                    <div className="text-xs text-fg-muted italic">
                      &quot;{item.sourceText}&quot;
                    </div>

                    {/* Aclaraciones / Advertencias */}
                    {item.clarifications.length > 0 && (
                      <div className="space-y-1">
                        {item.clarifications.map((c, cIdx) => (
                          <div
                            key={cIdx}
                            className="flex items-start gap-1.5 text-xs text-warning bg-warning/10 p-2 rounded-md"
                          >
                            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                            <span>{c.reason}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Campos editables del movimiento */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
                      <div>
                        <Label className="text-xs">Monto</Label>
                        <Input
                          type="number"
                          step="0.01"
                          value={item.amount ?? ""}
                          onChange={(e) =>
                            updateItem(idx, {
                              amount: e.target.value ? Number(e.target.value) : null,
                            })
                          }
                          className="mt-1 h-9"
                        />
                      </div>

                      <div>
                        <Label className="text-xs">Fecha</Label>
                        <Input
                          type="date"
                          value={item.date}
                          onChange={(e) =>
                            updateItem(idx, { date: e.target.value })
                          }
                          className="mt-1 h-9"
                        />
                      </div>

                      <div>
                        <Label className="text-xs">Descripción</Label>
                        <Input
                          type="text"
                          value={item.description}
                          onChange={(e) =>
                            updateItem(idx, { description: e.target.value })
                          }
                          className="mt-1 h-9"
                        />
                      </div>
                    </div>

                    {/* Cuentas y Categoría */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                      {isTransfer ? (
                        <>
                          <div>
                            <Label className="text-xs">Desde cuenta</Label>
                            <Select
                              value={item.fromAccountId ?? ""}
                              onValueChange={(val) =>
                                updateItem(idx, { fromAccountId: val })
                              }
                            >
                              <SelectTrigger className="mt-1 h-9">
                                <SelectValue placeholder="Seleccionar origen..." />
                              </SelectTrigger>
                              <SelectContent>
                                {validAccounts.map((a) => (
                                  <SelectItem key={a.id} value={a.id}>
                                    {a.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <Label className="text-xs">Hacia cuenta</Label>
                            <Select
                              value={item.toAccountId ?? ""}
                              onValueChange={(val) =>
                                updateItem(idx, { toAccountId: val })
                              }
                            >
                              <SelectTrigger className="mt-1 h-9">
                                <SelectValue placeholder="Seleccionar destino..." />
                              </SelectTrigger>
                              <SelectContent>
                                {validAccounts.map((a) => (
                                  <SelectItem key={a.id} value={a.id}>
                                    {a.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </>
                      ) : (
                        <>
                          <div>
                            <Label className="text-xs">Cuenta</Label>
                            <Select
                              value={item.accountId ?? ""}
                              onValueChange={(val) =>
                                updateItem(idx, { accountId: val })
                              }
                            >
                              <SelectTrigger className="mt-1 h-9">
                                <SelectValue placeholder="Seleccionar cuenta..." />
                              </SelectTrigger>
                              <SelectContent>
                                {validAccounts.map((a) => (
                                  <SelectItem key={a.id} value={a.id}>
                                    {a.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <Label className="text-xs">Categoría</Label>
                            <Select
                              value={item.categoryId ?? ""}
                              onValueChange={(val) =>
                                updateItem(idx, { categoryId: val })
                              }
                            >
                              <SelectTrigger className="mt-1 h-9">
                                <SelectValue placeholder="Sin categoría" />
                              </SelectTrigger>
                              <SelectContent>
                                {relevantCategories.map((c) => (
                                  <SelectItem key={c.id} value={c.id}>
                                    {c.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </DialogBody>

        <DialogFooter className="flex items-center justify-between gap-2 border-t border-border pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
            className="min-h-[44px]"
          >
            Descartar
          </Button>

          <Button
            type="button"
            variant="default"
            onClick={handleConfirmSave}
            disabled={isSaving || items.length === 0 || hasBlockingIssues}
            className="gap-2 min-h-[44px]"
          >
            {isSaving ? (
              <span>Guardando...</span>
            ) : (
              <>
                <Check className="h-4 w-4" />
                <span>
                  Confirmar y guardar ({items.length})
                </span>
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
