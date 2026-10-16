/**
 * Manejo de fechas-calendario para la app de finanzas.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL PROBLEMA QUE ESTE MÓDULO RESUELVE (bugs B1/B2/B3 del ROADMAP)
 * ─────────────────────────────────────────────────────────────────────────────
 * Una fecha de movimiento es una FECHA CALENDARIO ("15 de octubre"), NO un instante.
 * El bug original nacía de mezclar las dos cosas:
 *
 *   new Date("2026-10-15")        → 2026-10-15T00:00:00.000Z   (se parsea como UTC)
 *   .toLocaleDateString("es-ES")  → "14 oct"                  (en UTC-3 ¡un día menos!)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAS DOS REGLAS DE ORO
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. NUNCA usar `new Date("YYYY-MM-DD")`. Ese formato se interpreta como UTC.
 *    Siempre `new Date(y, m - 1, d)` (constructor local con componentes sueltos).
 * 2. NUNCA aplicar `toISOString()` a una fecha-calendario. Convierte a UTC y con
 *    offset negativo devuelve el día anterior. Para serializar, usar
 *    `toCalendarString()`, que lee los componentes LOCALES.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL BORDE CON LA BASE DE DATOS (Prisma + @db.Date)
 * ─────────────────────────────────────────────────────────────────────────────
 * Postgres `DATE` no tiene hora. Prisma lo mapea a un `Date` de JS anclado a
 * MEDIANOCHE UTC. Por eso el borde se cruza SIEMPRE por UTC, y nunca con los
 * getters locales:
 *
 *   escribir:  "2026-10-15"  → calendarToDb()  → Date.UTC(...)   → Postgres DATE
 *   leer:      Postgres DATE → dbToCalendar()  → getUTC*(...)    → "2026-10-15"
 *
 * Si se lee con `getDate()` (local) en UTC-3, un `2026-10-15T00:00:00.000Z`
 * devuelve 14. Ese es exactamente el bug que este módulo elimina.
 */

/** Fecha calendario en formato ISO corto: `"YYYY-MM-DD"`. Es el formato canónico. */
export type CalendarDate = string;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/* ────────────────────────────────────────────────────────────────────────────
 * Parseo y serialización
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Convierte `"YYYY-MM-DD"` a un `Date` en hora LOCAL (medianoche local).
 * Evita el parseo UTC implícito de `new Date("YYYY-MM-DD")`.
 *
 * @throws RangeError si el string no tiene el formato o la fecha no existe.
 */
export function calendarToLocalDate(value: CalendarDate): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) {
    throw new RangeError(`Fecha calendario inválida (se esperaba "YYYY-MM-DD"): ${value}`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);

  const date = new Date(year, month - 1, day);
  date.setHours(0, 0, 0, 0);

  // Rechaza fechas imposibles como "2026-02-31" (que JS desborda a marzo).
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new RangeError(`La fecha no existe en el calendario: ${value}`);
  }
  return date;
}

/**
 * Serializa un `Date` local a `"YYYY-MM-DD"` leyendo sus componentes LOCALES.
 * Reemplaza a `toISOString().slice(0, 10)`, que desplaza un día en UTC-3.
 */
export function toCalendarString(date: Date): CalendarDate {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Borde de escritura a la base: `"YYYY-MM-DD"` → `Date` en UTC para `@db.Date`.
 * Prisma espera un `Date`; anclarlo a UTC midnight es lo que Postgres `DATE` guarda
 * de forma canónica y lo que `dbToCalendar()` sabe revertir.
 */
export function calendarToDb(value: CalendarDate): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) {
    throw new RangeError(`Fecha calendario inválida (se esperaba "YYYY-MM-DD"): ${value}`);
  }
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/**
 * Borde de lectura de la base: `Date` (UTC midnight) → `"YYYY-MM-DD"`.
 * Usa los getters UTC **a propósito**: es el espejo exacto de `calendarToDb()`.
 */
export function dbToCalendar(value: Date): CalendarDate {
  return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`;
}

/** `true` si el string es una fecha calendario válida y existente. */
export function isCalendarDate(value: unknown): value is CalendarDate {
  if (typeof value !== "string") return false;
  try {
    calendarToLocalDate(value);
    return true;
  } catch {
    return false;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * "Hoy" y unidad de tiempo (mes financiero)
 * ──────────────────────────────────────────────────────────────────────────── */

/** La fecha calendario de hoy, según el reloj local. */
export function todayCalendar(): CalendarDate {
  return toCalendarString(new Date());
}

/** Aritmética de días sobre fechas-calendario, sin tocar zonas horarias. */
export function addDays(value: CalendarDate, days: number): CalendarDate {
  const d = calendarToLocalDate(value);
  d.setDate(d.getDate() + days);
  return toCalendarString(d);
}

/** Aritmética de meses, clampeando el día a fin de mes (31 ene + 1 mes → 28/29 feb). */
export function addMonths(value: CalendarDate, months: number): CalendarDate {
  const d = calendarToLocalDate(value);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = lastDayOfMonth(d.getFullYear(), d.getMonth() + 1);
  d.setDate(Math.min(day, lastDay));
  return toCalendarString(d);
}

/** Cantidad de días del mes indicado (1-12). Maneja años bisiestos. */
export function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Día del mes clampeado al último día válido.
 * Un ancla de recurrencia "día 31" debe caer el 30 de abril, no desbordar a mayo.
 */
export function clampDayOfMonth(year: number, month: number, day: number): number {
  return Math.min(Math.max(1, day), lastDayOfMonth(year, month));
}

/* ────────────────────────────────────────────────────────────────────────────
 * Períodos de reporte
 * ──────────────────────────────────────────────────────────────────────────── */

export type PeriodMode = "week" | "month" | "year";

/** Rango INCLUSIVO `[from, to]` sobre fechas-calendario. */
export interface CalendarRange {
  from: CalendarDate;
  to: CalendarDate;
}

/**
 * Inicio de semana (lunes) como fecha-calendario.
 * Cuidado: `getDay()` devuelve 0 para domingo, por eso la corrección `+6 % 7`.
 */
export function startOfWeek(value: CalendarDate): CalendarDate {
  const d = calendarToLocalDate(value);
  const daysSinceMonday = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - daysSinceMonday);
  return toCalendarString(d);
}

export function startOfMonth(value: CalendarDate): CalendarDate {
  const d = calendarToLocalDate(value);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-01`;
}

export function endOfMonth(value: CalendarDate): CalendarDate {
  const d = calendarToLocalDate(value);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  return `${year}-${pad2(month)}-${pad2(lastDayOfMonth(year, month))}`;
}

export function startOfYear(value: CalendarDate): CalendarDate {
  return `${calendarToLocalDate(value).getFullYear()}-01-01`;
}

export function endOfYear(value: CalendarDate): CalendarDate {
  return `${calendarToLocalDate(value).getFullYear()}-12-31`;
}

/**
 * Rango calendario del período que contiene a `anchor`.
 * Siempre INCLUSIVO en ambos extremos: es lo que espera el filtro de la base.
 *
 * IMPORTANTE: el rango se compara con `gte`/`lt` sobre la MISMA unidad (fecha
 * calendario). No se mezcla hora local con UTC, que era la fuga del bug B3.
 */
export function periodRange(mode: PeriodMode, anchor: CalendarDate): CalendarRange {
  switch (mode) {
    case "week": {
      const from = startOfWeek(anchor);
      return { from, to: addDays(from, 6) };
    }
    case "month":
      return { from: startOfMonth(anchor), to: endOfMonth(anchor) };
    case "year":
      return { from: startOfYear(anchor), to: endOfYear(anchor) };
  }
}

/** Desplaza el ancla un período hacia atrás (`-1`) o adelante (`+1`). */
export function shiftPeriod(mode: PeriodMode, anchor: CalendarDate, direction: number): CalendarDate {
  switch (mode) {
    case "week":
      return addDays(anchor, direction * 7);
    case "month":
      return addMonths(startOfMonth(anchor), direction);
    case "year": {
      const d = calendarToLocalDate(anchor);
      return `${d.getFullYear() + direction}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    }
  }
}

/**
 * Índice de bucket para los gráficos: posición del día dentro del período.
 * Se calcula sobre componentes locales, nunca sobre diferencia de instantes UTC.
 * Devuelve `null` si la fecha cae fuera del rango.
 */
export function bucketIndex(mode: PeriodMode, range: CalendarRange, value: CalendarDate): number | null {
  const v = calendarToLocalDate(value);
  const from = calendarToLocalDate(range.from);
  const to = calendarToLocalDate(range.to);

  if (v < from || v > to) return null;

  switch (mode) {
    case "week":
      // Diferencia en días entre dos medianoches LOCALES.
      // Se redondea porque un cambio de horario de verano puede dar 23h o 25h.
      return Math.round((v.getTime() - from.getTime()) / 86_400_000);
    case "month":
      return v.getDate() - 1;
    case "year":
      return v.getMonth();
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Presentación
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Formatea una fecha-calendario para mostrar.
 * Como el `Date` se construye en hora local, el día mostrado es el correcto.
 */
export function formatCalendar(
  value: CalendarDate,
  locale = "es-AR",
  options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" },
): string {
  return calendarToLocalDate(value).toLocaleDateString(locale, options);
}

/** Etiqueta del período para los encabezados ("octubre de 2026", "Semana 12 → 18 oct"). */
export function formatPeriodLabel(mode: PeriodMode, range: CalendarRange, locale = "es-AR"): string {
  const from = calendarToLocalDate(range.from);
  const to = calendarToLocalDate(range.to);

  switch (mode) {
    case "week":
      return `${from.toLocaleDateString(locale, { day: "numeric", month: "short" })} → ${to.toLocaleDateString(locale, { day: "numeric", month: "short" })}`;
    case "month":
      return from.toLocaleDateString(locale, { month: "long", year: "numeric" });
    case "year":
      return String(from.getFullYear());
  }
}
