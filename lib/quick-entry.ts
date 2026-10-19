/**
 * La lógica pura de la carga rápida (Fase 7).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ VIVE ACÁ Y NO DENTRO DEL FORMULARIO
 * ─────────────────────────────────────────────────────────────────────────────
 * Tres decisiones de la carga rápida no necesitan React para nada:
 *
 *   1. Cuál es la cuenta de origen por defecto (la última usada para ese tipo,
 *      con caída a la primera cuenta válida).
 *   2. Dónde se recuerda esa cuenta (`localStorage`, con todas las formas de
 *      fallar que tiene).
 *   3. Qué tecla abre qué formulario (T → gasto, I → ingreso), y cuándo la
 *      tecla NO debe hacer nada (escribiendo en un campo, o con un modal
 *      abierto).
 *
 * Adentro de un componente, esas decisiones sólo se pueden verificar corriendo
 * un navegador. Acá se verifican con tests de Node — y el atajo T/I, además,
 * NO se puede probar por flow: el driver web de Maestro sólo mapea ENTER y
 * BACKSPACE en `pressKey` (trampa 13 de flows/README.md). Esta separación es
 * lo que hace que la parte más difícil de testear de la ronda sea, igual, la
 * más testeada.
 */

import type { AccountBalanceDTO, MovementKindDTO } from "./finance";

/* ────────────────────────────────────────────────────────────────────────────
 * La última cuenta usada, por tipo de movimiento
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * La clave de `localStorage` de la última cuenta usada para un tipo.
 *
 * Una clave POR TIPO: el gasto suele salir del banco y el ingreso suele entrar
 * al banco, pero la transferencia arranca donde la persona venía moviendo la
 * plata. Compartir una sola clave haría que cargar un ingreso cambiara el
 * origen del próximo gasto — una sorpresa, no una comodidad.
 */
export const LAST_ACCOUNT_KEY_PREFIX = "finanzas:ultima-cuenta:";

export function lastAccountStorageKey(kind: MovementKindDTO): string {
  return `${LAST_ACCOUNT_KEY_PREFIX}${kind}`;
}

/**
 * Lo mínimo que este módulo necesita de `localStorage`.
 *
 * Se declara estructuralmente para que los tests puedan pasar un objeto falso
 * —o uno que reviente— sin tocar el navegador.
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * El `localStorage` del navegador, o `null` si no se puede tocar.
 *
 * En SSR no existe `window`, y en el navegador `localStorage` puede LANZAR al
 * accederse (modo privado, almacenamiento bloqueado por el navegador). Un
 * recordatorio de comodidad no puede romper la pantalla que lo usa, así que
 * todas las fallas se degradan a `null`/no-op.
 */
export function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * La última cuenta recordada para ese tipo, o `null`.
 *
 * Se guarda el id CRUDO como string —no JSON— para que leer no pueda fallar por
 * parseo: cualquier cosa que no sea un id válido simplemente no matchea contra
 * las cuentas y `resolveSourceAccount` cae al siguiente candidato. Ausente,
 * vacío, con espacios, con basura o con un `localStorage` que lanza: las cinco
 * formas devuelven `null`.
 */
export function readLastAccountId(
  storage: StorageLike | null | undefined,
  kind: MovementKindDTO,
): string | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(lastAccountStorageKey(kind));
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * Recuerda la cuenta usada para ese tipo. Best-effort: un almacenamiento lleno
 * o bloqueado no puede tumbar un guardado que ya salió bien.
 */
export function writeLastAccountId(
  storage: StorageLike | null | undefined,
  kind: MovementKindDTO,
  accountId: string,
): void {
  if (!storage) return;
  const trimmed = accountId.trim();
  if (!trimmed) return;
  try {
    storage.setItem(lastAccountStorageKey(kind), trimmed);
  } catch {
    // Perder el recordatorio es una molestia; romper el guardado, un problema.
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * La cuenta de origen por defecto
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Si esta cuenta puede ser el ORIGEN de un movimiento de este tipo.
 *
 * Un INGRESO no puede entrar a una cuenta de deuda (lo impide un trigger en la
 * base), así que la interfaz no puede preseleccionar una: es mejor no poder
 * mostrar el estado inválido que detectarlo al guardar. Para EXPENSE y TRANSFER
 * todas las cuentas son válidas como origen.
 */
export function canBeSourceAccount(
  kind: MovementKindDTO,
  account: AccountBalanceDTO,
): boolean {
  return kind === "INCOME" ? !account.isLiability : true;
}

/**
 * La cuenta de origen que el formulario debe preseleccionar.
 *
 * Prioridad:
 *   1. `preferred` — la cuenta que la pantalla pasó a propósito ("cargar un
 *      gasto acá"); sólo si sigue siendo válida para el tipo.
 *   2. `lastUsedId` — la última cuenta usada para ese tipo, si todavía existe y
 *      es válida. Un id inexistente (cuenta borrada) o inválido (una tarjeta
 *      para un ingreso) no es un error: se ignora y se cae al siguiente.
 *   3. La primera cuenta válida para el tipo.
 *
 * Devuelve `""` sin cuentas válidas: el formulario tiene su propia pantalla
 * para el caso "todavía no hay ninguna cuenta".
 */
export function resolveSourceAccount(
  kind: MovementKindDTO,
  accounts: AccountBalanceDTO[],
  options: { preferred?: string | null; lastUsedId?: string | null } = {},
): string {
  const { preferred, lastUsedId } = options;

  if (
    preferred &&
    accounts.some((a) => a.id === preferred && canBeSourceAccount(kind, a))
  ) {
    return preferred;
  }
  if (
    lastUsedId &&
    accounts.some((a) => a.id === lastUsedId && canBeSourceAccount(kind, a))
  ) {
    return lastUsedId;
  }
  return accounts.find((a) => canBeSourceAccount(kind, a))?.id ?? "";
}

/* ────────────────────────────────────────────────────────────────────────────
 * Los atajos de teclado (T → gasto, I → ingreso)
 * ──────────────────────────────────────────────────────────────────────────── */

/** Lo que el módulo necesita saber del evento: nada de React ni del DOM real. */
export interface ShortcutEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** El elemento que tiene el foco, si se conoce. */
  target?: { tagName?: string; isContentEditable?: boolean } | null;
}

/** Etiquetas donde una tecla es TEXTO, jamás un atajo. */
const TEXT_INPUT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Qué formulario abre una tecla, o `null` si la tecla no es un atajo acá.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAS TRES GUARDAS (las tres son por el caso real de "escribí t y se abrió algo")
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. Con un MODAL abierto no se dispara nada: la tecla pertenece al diálogo
 *      (o simplemente se ignora).
 *   2. Con el foco en un campo de texto (`input`, `textarea`, `select`) o en
 *      contenido editable, la tecla es DATO — se está escribiendo "tomate" o
 *      "internet" — no un atajo. Sin esta guarda, tipear una nota que empiece
 *      con t abriría el modal de gasto a mitad de la palabra.
 *   3. Con Ctrl/Alt/Meta apretadas no se toca: esos son atajos del navegador o
 *      del sistema y robarse `Ctrl+T` sería romper una pestaña nueva.
 *
 * Mayúscula no importa (`T` = `t`): con Shift sí se dispara, y está bien — el
 * contexto sigue siendo "no estoy escribiendo en un campo".
 */
export function shortcutMovementKind(
  event: ShortcutEventLike,
  options: { modalOpen: boolean },
): MovementKindDTO | null {
  if (options.modalOpen) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;

  const target = event.target;
  if (target) {
    const tag = (target.tagName ?? "").toUpperCase();
    if (TEXT_INPUT_TAGS.has(tag) || target.isContentEditable) return null;
  }

  const key = event.key.toLowerCase();
  if (key === "t") return "EXPENSE";
  if (key === "i") return "INCOME";
  return null;
}
