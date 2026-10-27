"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  filterPaletteItems,
  movePaletteIndex,
  type PaletteItem,
} from "@/lib/command-palette";
import {
  MOVEMENT_KIND_LABEL,
  type FavoriteDTO,
  type MovementKindDTO,
} from "@/lib/finance";
import { formatMoney } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Props {
  favorites: FavoriteDTO[];
  onClose: () => void;
  onNewMovement: (kind: MovementKindDTO) => void;
  onUseFavorite: (favorite: FavoriteDTO) => void;
  onOpenCsv: () => void;
}

/** Una entrada de la paleta con la acción que ejecuta. */
interface PaletteAction extends PaletteItem {
  run: () => void;
}

/** Una plantilla no se puede usar si su cuenta (origen o destino) está archivada. */
function favoriteBlocked(favorite: FavoriteDTO): boolean {
  if (favorite.account.archived) return true;
  return favorite.kind === "TRANSFER" && (favorite.toAccount?.archived ?? true);
}

/**
 * Paleta global de comandos (`Ctrl+K` / `Cmd+K`).
 *
 * El componente sólo dibuja y ejecuta; el filtrado, el orden y el wrap-around
 * viven en `lib/command-palette.ts` (testeados sin navegador). El foco queda
 * atrapado adentro y se devuelve a la pantalla al cerrar porque la paleta se
 * desmonta y el navegador devuelve el foco al elemento anterior.
 */
export default function CommandPalette({
  favorites,
  onClose,
  onNewMovement,
  onUseFavorite,
  onOpenCsv,
}: Props) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const actions = useMemo<PaletteAction[]>(() => {
    const closeAndRun = (run: () => void) => () => {
      onClose();
      run();
    };

    const items: PaletteAction[] = [
      {
        id: "action-expense",
        label: "Nuevo gasto",
        hint: "Carga rápida · tecla T",
        group: "Acciones",
        keywords: "gasto compra egreso cargar",
        run: closeAndRun(() => onNewMovement("EXPENSE")),
      },
      {
        id: "action-income",
        label: "Nuevo ingreso",
        hint: "Carga rápida · tecla I",
        group: "Acciones",
        keywords: "ingreso sueldo cobro cargar",
        run: closeAndRun(() => onNewMovement("INCOME")),
      },
      {
        id: "action-transfer",
        label: "Nueva transferencia",
        hint: "Mover plata entre cuentas",
        group: "Acciones",
        keywords: "transferencia pasar mover cuenta",
        run: closeAndRun(() => onNewMovement("TRANSFER")),
      },
      {
        id: "action-csv",
        label: "Importar CSV",
        hint: "Datos históricos · preview antes de guardar",
        group: "Acciones",
        keywords: "csv importar pegar archivo historico",
        run: closeAndRun(onOpenCsv),
      },
      {
        id: "action-export-csv",
        label: "Descargar movimientos en CSV",
        hint: "Exportar todos los datos a archivo CSV",
        group: "Acciones",
        keywords: "csv exportar descargar backup guardar archivo",
        run: closeAndRun(() => {
          window.location.href = "/api/export?format=csv";
        }),
      },
      {
        id: "action-export-json",
        label: "Descargar movimientos en JSON",
        hint: "Exportar todos los datos a archivo JSON estructurado",
        group: "Acciones",
        keywords: "json exportar descargar backup guardar datos",
        run: closeAndRun(() => {
          window.location.href = "/api/export?format=json";
        }),
      },
      {
        id: "nav-home",
        label: "Ir al panel",
        hint: "Movimientos del mes",
        group: "Pantallas",
        keywords: "inicio home panel movimientos",
        run: closeAndRun(() => router.push("/")),
      },
      {
        id: "nav-analysis",
        label: "Ir a Análisis",
        hint: "Reportes del mes",
        group: "Pantallas",
        keywords: "analisis reportes graficos",
        run: closeAndRun(() => router.push("/analisis")),
      },
      {
        id: "nav-cards",
        label: "Ir a Tarjetas",
        hint: "Resúmenes, cuotas y planes",
        group: "Pantallas",
        keywords: "tarjetas credito cuotas resumen",
        run: closeAndRun(() => router.push("/tarjetas")),
      },
      {
        id: "nav-recurrence",
        label: "Ir a Recurrencia",
        hint: "Reglas y pendientes",
        group: "Pantallas",
        keywords: "recurrencia reglas pendientes",
        run: closeAndRun(() => router.push("/recurrencia")),
      },
      {
        id: "nav-loans",
        label: "Ir a Préstamos",
        hint: "Deudas y préstamos a cobrar",
        group: "Pantallas",
        keywords: "prestamos deuda cobrar",
        run: closeAndRun(() => router.push("/prestamos")),
      },
    ];

    for (const favorite of favorites) {
      const blocked = favoriteBlocked(favorite);
      const amount = favorite.amount ? ` · ${formatMoney(favorite.amount)}` : "";
      items.push({
        id: `favorite-${favorite.id}`,
        label: favorite.name,
        hint: `${MOVEMENT_KIND_LABEL[favorite.kind]}${amount}${
          blocked ? " · cuenta archivada" : ""
        }`,
        group: "Plantillas",
        keywords: [
          favorite.description,
          favorite.category?.name ?? "",
          favorite.account.name,
          favorite.toAccount?.name ?? "",
        ]
          .join(" ")
          .trim(),
        disabled: blocked,
        run: closeAndRun(() => onUseFavorite(favorite)),
      });
    }

    return items;
  }, [favorites, onClose, onNewMovement, onOpenCsv, onUseFavorite, router]);

  const filtered = useMemo(
    () => filterPaletteItems(actions, query),
    [actions, query],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // El índice activo siempre apunta a algo visible. Al cambiar la búsqueda se
  // vuelve al primero, como en cualquier combobox.
  useEffect(() => {
    setActive(filtered.length > 0 ? 0 : -1);
  }, [filtered]);

  useEffect(() => {
    if (active < 0) return;
    document
      .getElementById(`palette-item-${active}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // Escape y trampa de foco. Tab cicla por los elementos focusables del
  // diálogo; sin esto el foco se iría al panel de atrás (que sigue visible).
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'input, button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;

      if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function run(action: PaletteAction) {
    if (action.disabled) return;
    action.run();
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 px-4 pt-[10vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {/* El panel se limita al alto de la ventana (`max-h-[80vh]`) y la lista
          toma lo que sobra (`flex-1 min-h-0`): en un teléfono ACOSTADO la
          ventana tiene 390 px de alto y la paleta, con su lista de 320 px, se
          iba 88 px más abajo del borde (medido: el panel ocupaba de y=39 a
          y=478 y sólo 5 de las 9 acciones quedaban a la vista). Con el tope, la
          paleta entra en cualquier ventana y la lista scrollea adentro. */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Paleta de comandos"
        id="command-palette"
        className="w-full max-w-lg max-h-[80vh] flex flex-col rounded-md bg-surface-2 shadow-2xl overflow-hidden"
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <span aria-hidden="true" className="text-fg-subtle">
            ⌘
          </span>
          <Input
            ref={inputRef}
            id="palette-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActive((current) =>
                  movePaletteIndex(
                    current,
                    event.key === "ArrowDown" ? 1 : -1,
                    filtered.length,
                  ),
                );
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                const action = filtered[active];
                if (action) run(action);
              }
            }}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-listbox"
            aria-activedescendant={active >= 0 ? `palette-item-${active}` : undefined}
            aria-autocomplete="list"
            placeholder="Buscar acciones, pantallas o plantillas…"
            autoComplete="off"
            className="flex-1 text-sm"
          />
          <Button
            id="palette-close"
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Cerrar paleta"
            className="text-lg leading-none text-fg-subtle hover:text-fg-muted px-1 h-auto w-auto"
          >
            ×
          </Button>
        </div>

        <div
          id="palette-listbox"
          role="listbox"
          aria-label="Resultados de la paleta"
          className="min-h-0 flex-1 overflow-y-auto py-1"
        >
          {filtered.length === 0 ? (
            <p className="px-4 py-6 text-sm text-fg-muted text-center">
              Nada coincide con “{query}”.
            </p>
          ) : (
            filtered.map((action, index) => (
              <Button
                key={action.id}
                id={`palette-item-${index}`}
                variant="ghost"
                size="sm"
                role="option"
                aria-selected={active === index}
                aria-disabled={action.disabled}
                disabled={action.disabled}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => run(action)}
                className={`w-full justify-between px-4 py-2 text-left ${
                  active === index
                    ? "bg-surface-3 "
                    : "hover:bg-surface-3 hover:bg-surface-3/60"
                } ${action.disabled ? "opacity-40 cursor-not-allowed" : ""}`}
              >
                <span className="min-w-0">
                  <span className="block text-sm font-medium truncate">
                    {action.label}
                  </span>
                  {action.hint && (
                    <span className="block text-xs text-fg-muted truncate">
                      {action.hint}
                    </span>
                  )}
                </span>
                <span className="text-xs uppercase tracking-wide text-fg-subtle whitespace-nowrap">
                  {action.group}
                </span>
              </Button>
            ))
          )}
        </div>

        <p className="border-t border-line px-4 py-2 text-xs text-fg-subtle">
          ↑ ↓ navegar · Enter elegir · Esc cerrar · los favoritos con cuenta
          archivada se muestran deshabilitados
        </p>
      </div>
    </div>
  );
}
