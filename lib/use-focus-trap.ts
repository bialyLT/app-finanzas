"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * EL FOCO DE LOS DIÁLOGOS, EN UN SOLO LUGAR.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL PROBLEMA
 * Un contenedor con `role="dialog"` + `aria-modal="true"` le DICE al lector de
 * pantalla que el resto de la página no existe, pero no lo hace cumplir: el
 * `Tab` sigue recorriendo el documento y, desde el último control, aterriza en
 * el `body` (el tester lo reprodujo en `TransactionForm`: de `#tx-submit` a
 * `BODY`). Al cerrar, además, el foco se quedaba donde cayera.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ LAS PIEZAS PURAS ESTÁN SEPARADAS
 * Este proyecto testea en Node, sin DOM (`vitest.config.mts`). La decisión de
 * qué es enfocable y cuál es el próximo índice del ciclo son lógica, no
 * navegador: viven en funciones puras (`isFocusable`, `filterFocusable`,
 * `nextFocusIndex`) que se prueban sin inventar un DOM. El hook sólo las
 * conecta con el documento.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL CONTRATO
 *   · al montar enfoca el primer enfocable, salvo que algo de adentro ya tenga
 *     el foco (un `autoFocus` legítimo: no se le roba al campo elegido);
 *   · `Tab` / `Shift+Tab` ciclan SOLO entre los enfocables del contenedor;
 *   · si no hay ninguno, el foco se queda en el contenedor (que se vuelve
 *     enfocable con `tabindex="-1"` temporal);
 *   · al desmontar devuelve el foco al elemento que lo tenía antes de abrir.
 */

/** Lo mínimo que hace falta para decidir si un elemento entra en el ciclo. */
export interface FocusCandidate {
  /** Atributo booleano `hidden`. */
  hidden?: boolean;
  /** `disabled` nativo (button/input/select/textarea/fieldset). */
  disabled?: boolean;
  /** `element.tabIndex`: negativo = fuera del orden de tabulación. */
  tabIndex: number;
  /** Resultado de la comprobación de visibilidad (display/visibility). */
  visible?: boolean;
}

/**
 * ¿Este elemento participa del ciclo de `Tab`?
 *
 * Un elemento `tabindex="-1"` es enfocable por código pero NO por teclado: si
 * entrara en el ciclo, el trap lo saltearía de todos modos y el cálculo del
 * próximo índice quedaría desfasado.
 */
export function isFocusable(candidate: FocusCandidate): boolean {
  return (
    !candidate.hidden &&
    !candidate.disabled &&
    candidate.tabIndex >= 0 &&
    candidate.visible !== false
  );
}

/** La lista de enfocables, en el orden en que los devuelve el DOM. */
export function filterFocusable<T extends FocusCandidate>(
  candidates: readonly T[],
): T[] {
  return candidates.filter(isFocusable);
}

/**
 * El índice al que hay que mover el foco después de un `Tab`.
 *
 * @param currentIndex índice del elemento activo dentro de la lista; `-1`
 *   cuando el foco no está en ninguno (p. ej. quedó en el contenedor).
 * @param total cantidad de enfocables.
 * @param shift `true` para `Shift+Tab`.
 * @returns el próximo índice, o `-1` si no hay ningún enfocable.
 *
 * En los dos extremos envuelve: del último al primero y del primero al último.
 */
export function nextFocusIndex(
  currentIndex: number,
  total: number,
  shift: boolean,
): number {
  if (total <= 0) return -1;
  const index =
    currentIndex >= 0 && currentIndex < total ? currentIndex : -1;

  if (index === -1) return shift ? total - 1 : 0;
  return shift ? (index - 1 + total) % total : (index + 1) % total;
}

/** El selector de candidatos. `tabindex` se filtra después con `isFocusable`. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "iframe",
  "[contenteditable]:not([contenteditable=false])",
  "[tabindex]",
].join(",");

/** ¿El navegador lo considera visible? (`display:none`, `visibility:hidden`…) */
function isVisible(element: HTMLElement): boolean {
  if (typeof element.checkVisibility === "function") {
    return element.checkVisibility();
  }
  // Navegadores viejos: sin cajas no hay nada que enfocar.
  return element.getClientRects().length > 0;
}

function describe(element: HTMLElement): FocusCandidate {
  return {
    hidden: element.hidden,
    disabled:
      "disabled" in element &&
      (element as unknown as { disabled?: boolean }).disabled === true,
    tabIndex: element.tabIndex,
    visible: isVisible(element),
  };
}

/**
 * Los elementos enfocables de un contenedor, en orden de documento.
 *
 * Los elementos ocultos se descartan aunque matcheen el selector: un botón
 * dentro de un pestaña inactiva (`display:none`) no puede recibir el foco.
 */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const candidates = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).map((element) => ({ element, ...describe(element) }));

  return filterFocusable(candidates).map((candidate) => candidate.element);
}

/**
 * Atrapa el foco dentro del contenedor mientras el componente esté montado.
 *
 * DEVUELVE UN REF DE CALLBACK: se usa así
 *
 *   const dialogRef = useFocusTrap<HTMLDivElement>();
 *   return <div ref={dialogRef} role="dialog">…</div>;
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ CALLBACK Y NO `useRef` + EFECTO
 * Un diálogo puede no estar en el primer commit (p. ej. `TransactionForm`
 * monta mientras las cuentas todavía no llegaron y su primer render es la
 * pantalla "Primero creá una cuenta"). Con un ref de objeto el efecto corre
 * una sola vez con `ref.current === null` y la trampa nunca se engancha. El
 * callback re-entrega el nodo cuando el diálogo aparece y el efecto se
 * vuelve a montar sobre el nodo real.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ EL DISPARADOR SE CAPTURA EN EL RENDER
 * React aplica `autoFocus` durante el commit, ANTES de los efectos: si el
 * disparador se leyera en el efecto, ya sería un campo de adentro del diálogo
 * y al cerrar el foco iría a un nodo que deja de existir. Se captura una sola
 * vez, en el inicializador de estado (render), cuando el foco todavía está en
 * el control que abrió.
 */
/**
 * Último destino al que una trampa DEVOLVIÓ el foco.
 *
 * POR QUÉ EXISTE: cuando un diálogo abre a otro en el mismo commit (paleta →
 * CSV), el elemento previo del segundo está dentro del primero, que se
 * desmonta: al cerrar el segundo, ese nodo ya no está conectado y el foco
 * caía en `BODY`. El cierre del primero sí devolvió el foco a su disparador
 * (queda acá), así que el segundo puede reusarlo como destino razonable.
 */
let lastRestoredFocus: HTMLElement | null = null;

export function useFocusTrap<T extends HTMLElement = HTMLElement>(): (
  node: T | null,
) => void {
  const [container, setContainer] = useState<T | null>(null);

  const [previouslyFocused] = useState<HTMLElement | null>(() => {
    if (typeof document === "undefined") return null;
    return document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  });

  const ref = useCallback((node: T | null) => {
    setContainer(node);
  }, []);

  useEffect(() => {
    if (!container) return;
    // `container` ya está verificado: el alias no cambia en el efecto y las
    // funciones de adentro no pierden el estrechamiento de tipos.
    const node = container;

    // El contenedor necesita ser enfocable por código para poder conservar el
    // foco cuando no hay ningún control adentro. Se restaura al desmontar.
    const hadTabIndex = node.hasAttribute("tabindex");
    if (!hadTabIndex) node.setAttribute("tabindex", "-1");

    // Un `autoFocus` de un campo de adentro ya eligió el destino: respetarlo.
    if (!node.contains(document.activeElement)) {
      const [first] = getFocusableElements(node);
      (first ?? node).focus();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab" || event.defaultPrevented) return;

      const focusable = getFocusableElements(node);
      event.preventDefault();

      if (focusable.length === 0) {
        // Sin controles, el foco se queda en el diálogo: nunca en el `body`.
        node.focus();
        return;
      }

      const active = document.activeElement;
      const currentIndex =
        active instanceof HTMLElement ? focusable.indexOf(active) : -1;
      const nextIndex = nextFocusIndex(
        currentIndex,
        focusable.length,
        event.shiftKey,
      );
      focusable[nextIndex]?.focus();
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (!hadTabIndex) node.removeAttribute("tabindex");

      // Si el disparador desapareció con el diálogo (o nunca tuvo foco), no se
      // inventa un destino: el navegador deja el foco donde está.
      const previous =
        previouslyFocused &&
        previouslyFocused !== document.body &&
        previouslyFocused.isConnected
          ? previouslyFocused
          : null;
      const fallback =
        lastRestoredFocus && lastRestoredFocus.isConnected
          ? lastRestoredFocus
          : null;
      const target = previous ?? fallback;
      if (target) {
        target.focus();
        lastRestoredFocus = target;
      }
    };
  }, [container, previouslyFocused]);

  return ref;
}
