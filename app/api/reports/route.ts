import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { calendarToDb, isCalendarDate } from "@/lib/dates";
import type { ReportsResponse } from "@/lib/finance";
import {
  categoriesInPeriod,
  movementCategoryBreakdown,
  movementDateBreakdown,
  movementTotals,
} from "@/lib/queries";

/**
 * GET /api/reports?from=YYYY-MM-DD&to=YYYY-MM-DD&categoryId=...&q=...
 *
 * Devuelve `{ totals, byCategory, byDate, categories }`: los agregados que
 * alimentan `/analisis` (tarjetas, torta y barras), calculados en la base sobre
 * el período COMPLETO.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ EXISTE ESTA RUTA
 * ─────────────────────────────────────────────────────────────────────────────
 * `/analisis` calculaba sus tres agregados filtrando la lista de
 * `/api/transactions`, que está topeada en `MOVEMENTS_MAX_ROWS`. Pasado el
 * tope, las tarjetas, la torta y las barras quedaban subestimadas — un número
 * mal que se ve tan confiable como uno bien. Acá los agregados se hacen con
 * `groupBy` sobre todo el período: devuelven a lo sumo unas pocas filas por día
 * o por categoría, así que el problema del tope desaparece en vez de
 * esconderse detrás de un cartel de aviso.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ LOS FILTROS DE PANTALLA VIAJAN COMO PARÁMETROS
 * ─────────────────────────────────────────────────────────────────────────────
 * Cuando el filtro se aplicaba en el cliente, filtrar era gratis: se recorría
 * la lista que ya estaba en memoria. Con los agregados en el servidor, el filtro
 * tiene que llegar ANTES del `groupBy`, o los números serían del período entero
 * mientras la pantalla muestra un subconjunto. De ahí `categoryId` y `q`.
 *
 * Las fechas inválidas se IGNORAN, no son un error: es el mismo criterio
 * permisivo de `GET /api/transactions`. Un `?from=basura` no acota el rango en
 * vez de devolver un 400 que dejaría la pantalla en blanco por un parámetro mal
 * armado.
 *
 * Los GET no llevan chequeo CSRF —es el patrón existente: `assertSameOrigin`
 * sólo protege las mutaciones—, pero sí pasan por la DAL, que es la capa que de
 * verdad protege el dato (ver `lib/auth/dal.ts`).
 */
export async function GET(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const { searchParams } = new URL(req.url);

  const rawFrom = searchParams.get("from");
  const rawTo = searchParams.get("to");
  const categoryId = searchParams.get("categoryId");
  const q = (searchParams.get("q") ?? "").trim();

  // Se validan con `isCalendarDate` y no con un `new Date`: "2026-02-31" existe
  // para el constructor de JS (desborda a marzo) y no para el calendario. El
  // string validado es el que se usa para armar el rango con `calendarToDb`,
  // que ancla a medianoche UTC — el valor canónico de un `@db.Date`.
  const from = rawFrom && isCalendarDate(rawFrom) ? rawFrom : null;
  const to = rawTo && isCalendarDate(rawTo) ? rawTo : null;

  // ── El texto libre: la misma búsqueda que hacía el cliente ────────────────
  //
  // El cliente buscaba la subcadena sin distinguir mayúsculas en cuatro textos:
  // el nombre de la categoría, la descripción y los nombres de las dos cuentas
  // (origen y destino). Acá se replica con un `OR` de `contains` insensibles —
  // cada campo se busca por separado, no concatenados, que es como lo expresa
  // SQL de verdad (`description ILIKE '%q%' OR ...`).
  //
  // Los `null` se comportan solos: un movimiento sin categoría no satisface
  // `category: { name: ... }` porque la relación es `null`, y lo mismo pasa con
  // `toAccount` en todo lo que no es una transferencia. No hace falta un
  // chequeo extra que, además, sería fácil de olvidar.
  const textFilter: Prisma.MovementWhereInput = q
    ? {
        OR: [
          { description: { contains: q, mode: "insensitive" } },
          { category: { name: { contains: q, mode: "insensitive" } } },
          { account: { name: { contains: q, mode: "insensitive" } } },
          { toAccount: { name: { contains: q, mode: "insensitive" } } },
        ],
      }
    : {};

  const where: Prisma.MovementWhereInput = {
    ...(from || to
      ? {
          date: {
            ...(from ? { gte: calendarToDb(from) } : {}),
            ...(to ? { lte: calendarToDb(to) } : {}),
          },
        }
      : {}),
    ...(categoryId ? { categoryId } : {}),
    ...textFilter,
  };

  // ── Las cuatro consultas, en paralelo ──────────────────────────────────────
  //
  // No dependen entre sí y las cuatro van a la misma base: en serie sumarían
  // latencia sin ningún motivo. `Promise.all` corta en el primer error, que es
  // lo que se quiere — mejor un 500 que una respuesta a medias.
  //
  // `categories` recibe `from`/`to` SIN `where` a propósito: el selector de la
  // pantalla no se filtra por categoría ni por texto (ver `ReportsResponse`).
  const [totals, byCategory, byDate, categories] = await Promise.all([
    movementTotals(prisma, where),
    movementCategoryBreakdown(prisma, where),
    movementDateBreakdown(prisma, where),
    categoriesInPeriod(prisma, from, to),
  ]);

  return NextResponse.json({
    totals,
    byCategory,
    byDate,
    categories,
  } satisfies ReportsResponse);
}
