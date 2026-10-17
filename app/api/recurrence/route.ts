import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { todayCalendar } from "@/lib/dates";
import { getRecurrenceOverview } from "@/lib/recurring";

/**
 * GET /api/recurrence[?includeArchived=1]
 *
 * Devuelve `{ rules, pending, truncated }`: las reglas activas y pausadas con
 * sus próximas fechas proyectadas, y la bandeja de ocurrencias pendientes.
 * Con `includeArchived=1` la lista de reglas también trae las archivadas (al
 * final): es el "ver archivadas" de la pantalla, para poder releer una regla
 * que se sacó de la vista sin haberla borrado. La bandeja no cambia con el
 * parámetro: una ocurrencia pendiente es trabajo, no archivo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTE GET NO MATERIALIZA NADA
 * ─────────────────────────────────────────────────────────────────────────────
 * Sería tentador que "abrir la pantalla" corriera el generador desde acá, pero
 * un GET que escribe rompe la semántica de HTTP: un precargado del navegador,
 * un reintento o un crawler postearían movimientos sin que nadie lo pida. El
 * disparador es explícito —`POST /api/recurrence/run`— y la pantalla llama a
 * los dos en orden.
 *
 * `today` se resuelve con `todayCalendar()` (reloj local del servidor): la
 * proyección y el generador tienen que usar el MISMO "hoy", y la única forma de
 * garantizarlo es que haya un solo lugar que lo lea.
 */
export async function GET(req: Request) {
  // Capa autoritativa de autenticación (ver lib/auth/dal.ts). Es una lectura,
  // así que no lleva chequeo de origen.
  if (!(await requireApiSession())) return unauthorized();

  // Sólo el valor explícito cuenta: `?includeArchived=1`. Cualquier otra cosa
  // (o nada) es el default de siempre, así el contrato viejo no se mueve.
  const includeArchived =
    new URL(req.url).searchParams.get("includeArchived") === "1";

  const overview = await getRecurrenceOverview(prisma, {
    today: todayCalendar(),
    includeArchived,
  });

  return NextResponse.json(overview);
}
