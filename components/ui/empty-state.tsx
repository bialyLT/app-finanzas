import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * `EmptyState` — una sola forma de decir «no hay nada».
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ES UNA PRIMITIVA Y NO MARKUP SUELTO
 * Antes cada vista inventaba su estado vacío: un icono de 32 px en una vista,
 * otro de 40 en la del costado, un `<p className="italic">` acá, un texto sin
 * icono allá. La persona leía seis formas distintas de la misma idea y ninguna
 * decía qué hacer después. Esta pieza fija las cuatro partes del estado vacío:
 *
 *   · un ICONO del set del proyecto (`lucide-react`; nunca un emoji), con
 *     `aria-hidden` porque el texto ya dice qué es;
 *   · un TÍTULO corto, en la voz del producto;
 *   · una EXPLICACIÓN de una o dos líneas (qué pasó y qué se puede hacer);
 *   · una ACCIÓN opcional (un botón o un enlace a la pantalla que resuelve).
 *
 * El icono es de 32 px (`size-8`) en el estado de sección —la escala de los
 * estados vacíos de §4 del design system— y de 20 px (`size-5`) en el compacto,
 * que vive dentro de una tarjeta ya existente (resúmenes, cuotas, etc.).
 *
 * No es una región `aria-live`: un estado vacío es el resultado de un render,
 * no un mensaje que aparece después de una acción. Lo que se anuncia es la
 * confirmación o el error (ver las regiones `aria-live` de cada vista).
 */
interface EmptyStateProps {
  /** Icono de `lucide-react`. Se renderiza decorativo (`aria-hidden`). */
  icon: LucideIcon;
  /** Qué no hay, en una línea. */
  title: string;
  /** Qué pasó y qué puede hacer la persona. */
  description?: ReactNode;
  /** Salida opcional: un `Button`, un `Link`, etc. */
  action?: ReactNode;
  /** Versión chica para listas dentro de una tarjeta. */
  compact?: boolean;
  /** Id estable para los flows y las pruebas (no es estilo). */
  id?: string;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
  id,
  className,
}: EmptyStateProps) {
  return (
    <div
      id={id}
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center text-center text-fg-muted",
        compact ? "gap-1 py-4" : "gap-2 py-10",
        className,
      )}
    >
      <Icon
        className={cn("shrink-0 text-fg-subtle", compact ? "size-5" : "size-8")}
        aria-hidden
      />
      <p
        className={cn(
          "font-medium text-fg",
          compact ? "text-sm" : "text-base",
        )}
      >
        {title}
      </p>
      {description && (
        <p className={cn("text-fg-muted", compact ? "text-xs" : "text-sm")}>
          {description}
        </p>
      )}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
