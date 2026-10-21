/**
 * La banderita: «esta plata que declaré, contala como ingreso de este mes».
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ ES (y qué NO es)
 *
 * El modelo de la cuenta NO cambia: el saldo inicial sigue siendo un STOCK (la
 * plata que ya tenías). Lo que se agrega es una DECLARACIÓN opt-in por cuenta:
 * "este saldo, en este mes, contalo como ingreso".
 *
 * Con la bandera apagada (el default, y el estado de TODAS las cuentas que
 * existían antes de esta ronda) la app se comporta exactamente como antes: el
 * saldo inicial no entra en los ingresos de ningún mes. Por eso los números
 * canónicos del proyecto no se mueven.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAS TRES REGLAS (escritas una sola vez)
 *
 *   1. Sólo en cuentas de DINERO (CASH/BANK). Una tarjeta o un préstamo no
 *      tienen plata propia: su saldo negativo es una DEUDA, y una deuda no es
 *      un ingreso.
 *   2. Sólo con saldo POSITIVO. Un saldo negativo es un pasivo (un préstamo ya
 *      desembolsado): pesa en el patrimonio por el lado de las deudas y no
 *      infla los ingresos.
 *   3. Sólo en el MES declarado. La plata declarada cuenta como ingreso en SU
 *      mes; en los meses siguientes está en el saldo arrastrado, no en el
 *      ingreso. (Y en el mes de la declaración el saldo al inicio es 0: la
 *      cuenta se creó ese mes.)
 *
 * La MISMA regla 1 y 2 la custodia un CHECK en la base (migración
 * `20261021120000_banderita_ingreso_de_saldo`): la app valida para poder
 * explicar el error, pero la base es la que no deja pasar la fila.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTO VIVE EN SU PROPIO MÓDULO
 *
 * Son reglas puras (parsear un mes, decidir si una cuenta puede declarar) más
 * una consulta de una sola suma. Si vivieran adentro de una ruta de API, la
 * otra ruta (o la vista previa, o el test) tendría su propia copia y algún día
 * las dos copias dirían cosas distintas — que es la clase de error que este
 * proyecto ya Pagó una vez.
 */

import type { Prisma } from "@prisma/client";
import type { Db } from "./balance";
import { calendarToDb, isCalendarDate } from "./dates";
import { isNegative, isZero, money, zero, type Money } from "./money";

/**
 * El mes de la declaración, como `"YYYY-MM"`.
 *
 * Es un MES, no un día: la persona dice "de este mes", y el mes es lo que
 * cuenta. En la base se guarda el PRIMER día del mes, en calendario (`@db.Date`).
 */
export type IncomeMonth = string;

/**
 * El resultado de interpretar el mes que manda la persona.
 *
 * Tres estados y no dos, porque "no lo mandaron" y "lo mandaron mal" no son lo
 * mismo: el primero apaga la bandera, el segundo es un 400 con mensaje.
 */
export type ParsedIncomeMonth =
  | { ok: true; month: IncomeMonth | null }
  | { ok: false; error: string };

/**
 * Interpreta el mes de la declaración que llega del cliente.
 *
 * Acepta `"2026-10"` y `"2026-10-01"` (el primer día del mes) y devuelve
 * siempre el mes: `"2026-10"`. Un día cualquiera del mes (`"2026-10-15"`)
 * también se acepta y se Reduce a su mes — la persona está declarando un mes,
 * no un día.
 *
 * Un cuerpo hostil (un número, un array, `"2026-13"`, `"basura"`) NO se
 * convierte: se rechaza con un mensaje que dice qué formato se espera.
 */
export function parseIncomeMonth(value: unknown): ParsedIncomeMonth {
  if (value === undefined || value === null || value === "") {
    // "No lo mandaron" = la bandera apagada. Es el estado de todas las cuentas
    // que ya existían.
    return { ok: true, month: null };
  }

  if (typeof value !== "string") {
    return {
      ok: false,
      error: "El mes de la declaración tiene que ser un texto con el formato AAAA-MM.",
    };
  }

  const trimmed = value.trim();

  if (/^\d{4}-\d{2}$/.test(trimmed)) {
    return isCalendarDate(`${trimmed}-01`)
      ? { ok: true, month: trimmed }
      : { ok: false, error: "El mes de la declaración tiene que ser un mes real (del 01 al 12)." };
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    if (!isCalendarDate(trimmed)) {
      return {
        ok: false,
        error: "La fecha de la declaración no es una fecha válida.",
      };
    }
    return { ok: true, month: trimmed.slice(0, 7) };
  }

  return {
    ok: false,
    error: "El mes de la declaración tiene que ser un mes válido en formato AAAA-MM.",
  };
}

/**
 * ¿Esta cuenta puede declarar su saldo como ingreso?
 *
 * Las reglas 1 y 2 (sólo dinero, sólo saldo positivo). Devuelve el mensaje
 * exacto que se muestra cuando no puede, para que la persona entienda qué
 * cambiar: no es un error genérico.
 */
export function canDeclareIncome(
  kind: string,
  openingBalance: Money,
): { ok: true } | { ok: false; error: string } {
  if (kind !== "CASH" && kind !== "BANK") {
    return {
      ok: false,
      error:
        "Sólo las cuentas de efectivo o banco pueden contar su saldo como ingreso: en una tarjeta o un préstamo ese saldo es una deuda, no plata que entró.",
    };
  }

  if (isZero(openingBalance) || isNegative(openingBalance)) {
    return {
      ok: false,
      error:
        "Para contar el saldo como ingreso tiene que ser mayor a cero: en cero o en negativo no hay plata declarada (un saldo negativo es una deuda).",
    };
  }

  return { ok: true };
}

/**
 * El filtro de las cuentas que declararon plata en un período.
 *
 * El `where` EXPRESA las reglas 1 y 2 y el mes: por eso el cálculo vive en la
 * base y no en la memoria de la aplicación (la suma la hace Postgres, que es
 * exacto).
 *
 * El rango se arma con `gte`/`lte` y NO con `not: null`: una comparación con
 * NULL en SQL es "desconocida", así que una cuenta con la bandera apagada
 * (`openingIncomeMonth IS NULL`) queda AFUERA del rango sin tener que decirlo
 * aparte.
 */
export function declaredIncomeWhere(period: {
  from: string | null;
  to: string | null;
}): Prisma.AccountWhereInput {
  return {
    openingIncomeMonth: {
      // Los extremos son generosos a propósito: una cuenta declarada en un mes
      // anterior al período no cuenta, y una declarada en un mes posterior
      // tampoco.
      gte: calendarToDb(period.from ?? "1970-01-01"),
      lte: calendarToDb(period.to ?? "2999-12-31"),
    },
    kind: { in: ["CASH", "BANK"] },
    openingBalance: { gt: 0 },
  };
}

/**
 * La plata declarada como ingreso de un período, como string decimal exacto.
 *
 * La suma la hace la base (`_sum`): el número que llega es el que Postgres
 * calculó, con Decimal(18,2) y sin vueltas.
 */
export async function declaredIncomeInPeriod(
  db: Db,
  period: { from: string | null; to: string | null },
): Promise<Money> {
  const aggregate = await db.account.aggregate({
    where: declaredIncomeWhere(period),
    _sum: { openingBalance: true },
  });

  // Sin cuentas que declararon, la suma de un conjunto vacío es NULL: el mismo
  // caso defensivo que en `movementTotals`.
  return aggregate._sum.openingBalance === null
    ? zero()
    : money(aggregate._sum.openingBalance);
}

/**
 * El mes de la declaración en el formato del DTO: `"2026-10"` o `null`.
 *
 * La base guarda el primer día del mes (calendario); la interfaz y la API
 * hablan de MESES. Esta función es el único lugar donde se pasa de uno a otro,
 * para que el formato no se defina en dos sitios.
 */
export function incomeMonthToDto(value: Date | string | null | undefined): IncomeMonth | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.slice(0, 7);
  // `getUTC*` y no `getDate*`: la columna es un `@db.Date`, y Prisma la vuelve
  // un Date a medianoche UTC. Con `getDate()` (hora local) el día 1 se
  // convertía en el día anterior — el bug que el modelo de fechas ya documenta.
  const year = value.getUTCFullYear();
  const month = value.getUTCMonth() + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}
