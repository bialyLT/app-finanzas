"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Diálogo (Radix Dialog) — la primitiva de los modales.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL PIE NO SE PIERDE NUNCA (la decisión de producto de la app)
 * Los modales actuales tienen un pie pegajoso: el botón de guardar está
 * siempre a la vista. En Radix, la forma correcta de eso NO es un `sticky`
 * dentro del scroller (los campos pasan por debajo de la banda y el tap cae en
 * otro control: la lección de la Fase 9). Es una COLUMNA FLEX:
 *
 *   DialogContent  flex flex-col, alto máximo acotado, `overflow-hidden`
 *   DialogHeader   flex-none
 *   DialogBody     flex-1 min-h-0 overflow-y-auto   ← sólo esto scrollea
 *   DialogFooter   flex-none
 *
 * El pie queda FUERA del área scrolleable y el tap siempre llega. En F2 se
 * migran los modales con esta estructura; en F1 la primitiva queda lista.
 *
 * Sin animaciones de entrada: las micro-interacciones son F3. El overlay es
 * `bg-black/60` (el velo; `black` es la única excepción de la paleta, igual
 * que en los modales actuales).
 */
function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger(
  props: React.ComponentProps<typeof DialogPrimitive.Trigger>,
) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal(
  props: React.ComponentProps<typeof DialogPrimitive.Portal>,
) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose(
  props: React.ComponentProps<typeof DialogPrimitive.Close>,
) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn("fixed inset-0 z-50 bg-black/60", className)}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-hidden rounded-md border border-line bg-popover p-6 text-popover-foreground",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-3 right-3 inline-flex size-9 items-center justify-center rounded-lg text-fg-subtle transition-colors outline-none hover:bg-surface-3 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" aria-hidden />
            <span className="sr-only">Cerrar</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-none flex-col gap-1.5 pr-8", className)}
      {...props}
    />
  );
}

/**
 * El área scrolleable del modal. Sin `DialogBody`, un formulario largo empuja
 * el pie; con `DialogBody`, el pie es `flex-none` y los campos scrollean por
 * dentro. Es la pieza que hace que la lección de la Fase 9 no se repita.
 */
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn("min-h-0 flex-1 overflow-y-auto", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-none flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg font-semibold leading-snug text-fg", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-fg-muted", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
