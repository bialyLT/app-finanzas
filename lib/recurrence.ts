/**
 * Motor puro de recurrencia: "¿qué fechas caen?"
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ ES "PURO" ACÁ, Y POR QUÉ IMPORTA
 * ─────────────────────────────────────────────────────────────────────────────
 * Este módulo no sabe nada de la base de datos, ni de HTTP, ni de React. Sólo
 * recibe una regla (frecuencia, intervalo, ancla, límites) y devuelve fechas de
 * CALENDARIO. Como no consulta el reloj —el "hoy" entra SIEMPRE como parámetro—
 * se puede probar un 29 de febrero, un 31 de enero y un año 2100 sin tocar la
 * máquina.
 *
 * Un `new Date()` escondido acá adentro haría que los tests dependieran del día
 * en que se corren: el mismo test en verde un 15 y en rojo un 31. Es el tipo de
 * dependencia que se descubre tarde y se arregla mal.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL CLAMP DE FIN DE MES, CON EL ANCLA CORRECTA
 * ─────────────────────────────────────────────────────────────────────────────
 * El alquiler vence el 31. En febrero no hay 31, así que vence el 28 (o el 29
 * en año bisiesto). Y en marzo vuelve a vencer el 31.
 *
 * Eso último es lo que se hace mal casi siempre: si la regla avanza "un mes
 * desde la ocurrencia ANTERIOR", la ocurrencia de febrero (28) produce la de
 * marzo el 28, y la regla queda PEGADA al 28 para siempre. El error no se ve en
 * el primer mes ni en el segundo: aparece recién en marzo, cuando el vencimiento
 * "se corrió" tres días y nadie entiende por qué.
 *
 * Acá cada ocurrencia se calcula desde el ANCLA (día 31) contra el mes concreto:
 *
 *     ancla 31 → ene 31 · feb 28 · mar 31 · abr 30 · may 31 · jun 30 …
 *
 * Lo mismo vale para el ancla de YEARLY: un 29 de febrero se corre al 28 en los
 * años no bisiestos y VUELVE al 29 en el próximo bisiesto (2028 → 2029-02-28 →
 * 2032-02-29), porque el ancla sigue siendo el 29.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA REGLA TEMPORAL DE UNA OCURRENCIA
 * ─────────────────────────────────────────────────────────────────────────────
 * Ninguna ocurrencia puede caer antes de `startDate` (una regla no tiene pasado
 * antes de empezar) ni después de `endDate`. `count` limita la cantidad de
 * ocurrencias de todo el calendario.
 *
 * Con `dayOfMonth` puede pasar que la ocurrencia del primer mes caiga ANTES de
 * `startDate`: una regla que empieza el 17 de octubre con ancla día 1 vence
 * recién el 1 de noviembre. Esa primera fecha de octubre no existe — y no se
 * "adelanta" al 17, porque el día 17 no es el día que la regla dice.
 */

import {
  addDays,
  calendarToLocalDate,
  clampDayOfMonth,
  type CalendarDate,
} from "./dates";

export type RecurFreq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

/** Lo que el motor necesita saber de una regla. Sin ids, sin montos, sin status. */
export interface RecurrenceSpec {
  freq: RecurFreq;
  /** Cada cuántas unidades de `freq`. Siempre >= 1. */
  interval: number;
  /** Primera fecha posible. Ninguna ocurrencia cae antes. */
  startDate: CalendarDate;
  /** Última fecha posible (inclusive). `null` = sin fin. */
  endDate: CalendarDate | null;
  /** Cuántas ocurrencias produce el calendario. `null` = sin límite. */
  count: number | null;
  /**
   * Ancla del día del mes (1..31) para MONTHLY y YEARLY; `null` = el día de
   * `startDate`. En DAILY y WEEKLY se ignora.
   */
  dayOfMonth: number | null;
}

/**
 * Última fecha representable como fecha-calendario de la app.
 *
 * El formato `YYYY-MM-DD` ordena lexicográficamente SÓLO mientras el año tenga
 * cuatro dígitos: `"10359-01-01" < "2026-01-01"` por comparación de strings.
 * Por eso la búsqueda tiene que quedar acotada ANTES de salirse del año 9999 —
 * no por el dominio financiero, sino porque comparar strings de fechas de cinco
 * dígitos daría un resultado al revés.
 */
const MAX_CALENDAR_DATE: CalendarDate = "9999-12-31";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Días entre dos fechas-calendario. Redondeado: los cambios de horario dan 23h o 25h. */
function daysBetween(from: CalendarDate, to: CalendarDate): number {
  const a = calendarToLocalDate(from).getTime();
  const b = calendarToLocalDate(to).getTime();
  return Math.round((b - a) / 86_400_000);
}

/**
 * El índice más alto que puede existir, o `-1` si la regla no tiene ninguno.
 *
 * Sale de `count` cuando está, y si no del rango hasta el año 9999. Es exacto a
 * propósito: la búsqueda binaria necesita un extremo superior que de verdad
 * exista, y un número "grande" inventado se sale del rango representable y hace
 * que las comparaciones de strings mientan (ver MAX_CALENDAR_DATE).
 */
function searchBound(spec: RecurrenceSpec): number {
  if (spec.count !== null) return spec.count - 1;

  const start = calendarToLocalDate(spec.startDate);
  const last = calendarToLocalDate(MAX_CALENDAR_DATE);

  switch (spec.freq) {
    case "DAILY":
      return Math.floor(daysBetween(spec.startDate, MAX_CALENDAR_DATE) / spec.interval);
    case "WEEKLY":
      return Math.floor(daysBetween(spec.startDate, MAX_CALENDAR_DATE) / (7 * spec.interval));
    case "MONTHLY": {
      const span = (last.getFullYear() * 12 + last.getMonth()) - (start.getFullYear() * 12 + start.getMonth());
      return Math.floor(span / spec.interval);
    }
    case "YEARLY":
      return Math.floor((last.getFullYear() - start.getFullYear()) / spec.interval);
  }
}

/**
 * La fecha de la ocurrencia número `index` (0-based), o `null` si esa
 * ocurrencia no existe porque la regla tiene `count`.
 *
 * NO mira `endDate`: devuelve la fecha del calendario aunque quede fuera del
 * rango. Quien necesita saber si "cuenta", usa `isWithinEnd`. Separar las dos
 * cosas permite distinguir "la lista terminó" de "la regla terminó", que es
 * justo lo que hace falta para decidir si una regla ya no genera más.
 */
export function occurrenceAt(spec: RecurrenceSpec, index: number): CalendarDate | null {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`Índice de ocurrencia inválido: ${index}`);
  }
  if (!Number.isInteger(spec.interval) || spec.interval < 1) {
    // Falla ruidosamente: un intervalo 0 sería un bucle infinito sobre la misma
    // fecha, y el error tiene que aparecer acá y no como un cuelgue.
    throw new RangeError(`El intervalo de una regla tiene que ser >= 1 (llegó ${spec.interval}).`);
  }
  if (spec.count !== null && index >= spec.count) return null;

  switch (spec.freq) {
    case "DAILY":
      return addDays(spec.startDate, index * spec.interval);

    case "WEEKLY":
      // 7 días por semana: la fecha se mueve en días, así que la aritmética es
      // la misma que la diaria multiplicada por 7.
      return addDays(spec.startDate, index * spec.interval * 7);

    case "MONTHLY": {
      const start = calendarToLocalDate(spec.startDate);
      const anchor = spec.dayOfMonth ?? start.getDate();
      // Número de mes absoluto (año × 12 + mes): así el salto de diciembre a
      // enero no necesita ningún caso especial.
      const totalMonths =
        start.getFullYear() * 12 + start.getMonth() + index * spec.interval;
      const year = Math.floor(totalMonths / 12);
      const month = (totalMonths % 12) + 1;
      return `${year}-${pad2(month)}-${pad2(clampDayOfMonth(year, month, anchor))}`;
    }

    case "YEARLY": {
      const start = calendarToLocalDate(spec.startDate);
      const anchor = spec.dayOfMonth ?? start.getDate();
      const year = start.getFullYear() + index * spec.interval;
      const month = start.getMonth() + 1;
      // Un 29 de febrero se corre a 28 en los años no bisiestos y vuelve al 29
      // en los bisiestos: el ancla no se pierde nunca.
      return `${year}-${pad2(month)}-${pad2(clampDayOfMonth(year, month, anchor))}`;
    }
  }
}

/** `true` si la fecha cae dentro del rango de la regla (`endDate` inclusive). */
export function isWithinEnd(spec: RecurrenceSpec, date: CalendarDate): boolean {
  return spec.endDate === null || date <= spec.endDate;
}

/**
 * El primer índice cuya fecha es estrictamente posterior a `after`, o `null` si
 * el calendario termina antes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ BÚSQUEDA BINARIA Y NO UNA ESTIMACIÓN
 * ─────────────────────────────────────────────────────────────────────────────
 * La secuencia es estrictamente creciente (la ocurrencia i+1 siempre cae
 * después de la i), así que alcanza con comparar contra el punto medio. Con una
 * estimación aritmética habría que acotar el error de redondeo de cada
 * frecuencia —y del clamp— con un margen "que en la práctica alcanza"; con la
 * búsqueda binaria el resultado es el mismo para cualquier combinación de
 * frecuencia, intervalo y ancla, sin márgenes que revisar.
 */
function firstIndexAfter(spec: RecurrenceSpec, after: CalendarDate | null): number | null {
  const last = searchBound(spec);
  if (last < 0) return null;

  // Si la última ocurrencia del calendario no supera `after`, no hay más.
  const lastDate = occurrenceAt(spec, last);
  if (lastDate === null) return null;
  if (after !== null && lastDate <= after) return null;

  if (after === null) return 0;

  // Primer índice con `occurrenceAt(i) > after`. Comparar strings
  // `YYYY-MM-DD` es comparar cronológicamente: el formato es lexicográfico.
  let lo = 0;
  let high = last;
  while (lo < high) {
    const mid = (lo + high) >> 1;
    const date = occurrenceAt(spec, mid);
    if (date !== null && date > after) high = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * El primer índice REALMENTE válido: 0, o 1 si la ocurrencia 0 cae antes de
 * `startDate` (pasa cuando el ancla del mes es anterior al día de inicio).
 */
function minIndex(spec: RecurrenceSpec): number {
  const first = occurrenceAt(spec, 0);
  return first !== null && first < spec.startDate ? 1 : 0;
}

/** Núcleo compartido por las tres funciones públicas de recorrido. */
function collect(
  spec: RecurrenceSpec,
  options: { after: CalendarDate | null; through: CalendarDate | null; limit: number },
): CalendarDate[] {
  const { after, through, limit } = options;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`El límite tiene que ser un entero >= 1 (llegó ${limit}).`);
  }

  let index = firstIndexAfter(spec, after);
  if (index === null) return [];

  const start = minIndex(spec);
  if (index < start) index = start;

  const dates: CalendarDate[] = [];
  while (dates.length < limit) {
    const date = occurrenceAt(spec, index);
    if (date === null) break; // se acabaron las ocurrencias (count)
    if (!isWithinEnd(spec, date)) break; // la regla termina antes
    if (through !== null && date > through) break;
    dates.push(date);
    index += 1;
  }
  return dates;
}

/**
 * La próxima ocurrencia estrictamente posterior a `after`.
 *
 * `after` es `null` para preguntar por la primera ocurrencia de la regla.
 */
export function nextOccurrence(
  spec: RecurrenceSpec,
  options: { after: CalendarDate | null },
): CalendarDate | null {
  return collect(spec, { after: options.after, through: null, limit: 1 })[0] ?? null;
}

/**
 * Las ocurrencias que caen en `(after, through]`.
 *
 * Es la consulta del generador: "desde la última que materialicé hasta hoy".
 * `after` en `null` significa "desde el principio de la regla".
 */
export function occurrencesBetween(
  spec: RecurrenceSpec,
  options: { after: CalendarDate | null; through: CalendarDate; limit: number },
): CalendarDate[] {
  return collect(spec, {
    after: options.after,
    through: options.through,
    limit: options.limit,
  });
}

/**
 * Las próximas `limit` ocurrencias, sin tope de fecha.
 *
 * Es la PROYECCIÓN: lo que viene. No son movimientos ni plata — son fechas del
 * calendario de una regla. Ver el criterio de aceptación 4 de la Fase 3: esto
 * jamás puede entrar en un reporte de plata real, y no puede entrar porque no
 * es un `Movement`.
 */
export function projectedOccurrences(
  spec: RecurrenceSpec,
  options: { after: CalendarDate | null; limit: number },
): CalendarDate[] {
  return collect(spec, { after: options.after, through: null, limit: options.limit });
}
