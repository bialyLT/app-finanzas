"use client";

import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Hoja lateral (Radix Dialog en modo panel).
 *
 * Es el mismo diálogo con otra geometría: sirve para el menú del teléfono y
 * para los formularios que en mobile ocupan la pantalla. `side` decide de qué
 * borde entra.
 *
 * Misma regla que el diálogo: columna flex con `SheetBody` scrolleable y el
 * pie `flex-none`, para que el botón de guardar no se pierda.
 *
 * Radios: el panel lateral es `rounded-none` (una barra que toca el borde no
 * es una píldora); la hoja inferior usa `rounded-t-md`, de la misma escala.
 */
const sheetVariants = cva(
  "fixed z-50 flex flex-col gap-4 bg-popover text-popover-foreground transition-colors",
  {
    variants: {
      side: {
        right: "inset-y-0 right-0 h-full w-3/4 max-w-sm rounded-none border-l border-line",
        left: "inset-y-0 left-0 h-full w-3/4 max-w-sm rounded-none border-r border-line",
        top: "inset-x-0 top-0 max-h-[80dvh] rounded-none border-b border-line",
        bottom:
          "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-md border-t border-line",
      },
    },
    defaultVariants: {
      side: "right",
    },
  },
);

function Sheet(props: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger(
  props: React.ComponentProps<typeof SheetPrimitive.Trigger>,
) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose(props: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal(
  props: React.ComponentProps<typeof SheetPrimitive.Portal>,
) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn("fixed inset-0 z-50 bg-black/60", className)}
      {...props}
    />
  );
}

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> &
  VariantProps<typeof sheetVariants> & {
    showCloseButton?: boolean;
  }) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(sheetVariants({ side }), className)}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            className="absolute top-3 right-3 inline-flex size-9 items-center justify-center rounded-lg text-fg-subtle transition-colors outline-none hover:bg-surface-3 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" aria-hidden />
            <span className="sr-only">Cerrar</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-none flex-col gap-1.5 p-4 pr-12", className)}
      {...props}
    />
  );
}

/** El área scrolleable de la hoja: el pie (`SheetFooter`) queda fuera. */
function SheetBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-body"
      className={cn("min-h-0 flex-1 overflow-y-auto px-4", className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn(
        "flex flex-none flex-col-reverse gap-2 p-4 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-lg font-semibold leading-snug text-fg", className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-fg-muted", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetBody,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
};
