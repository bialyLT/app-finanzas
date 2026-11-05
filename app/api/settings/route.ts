import { NextResponse } from "next/server";
import type { Currency } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireApiSession, unauthorized } from "@/lib/auth/dal";
import { assertSameOrigin } from "@/lib/auth/csrf";
import {
  DEFAULT_CURRENCY,
  currencyNoun,
  parseEnabledCurrencies,
} from "@/lib/currency";
import { describeDatabaseError } from "@/lib/queries";

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * GET /api/settings
 *
 * Devuelve `{ enabledCurrencies }`: las monedas con las que la app trabaja.
 *
 * La fila es un SINGLETON (`id = 1`, con CHECK en la base). Si por algún motivo
 * la fila no existiera —una base a medio migrar— la lectura no inventa una
 * escritura: responde el default de fábrica (`ARS`) y deja que el próximo PATCH
 * cree la fila. Es la diferencia entre "la configuración todavía no se tocó" y
 * "el endpoint falló", y la persona ve la primera.
 */
export async function GET() {
  if (!(await requireApiSession())) return unauthorized();

  try {
    const settings = await prisma.appSettings.findUnique({
      where: { id: 1 },
      select: { enabledCurrencies: true },
    });

    return NextResponse.json({
      enabledCurrencies: settings?.enabledCurrencies ?? [DEFAULT_CURRENCY],
    });
  } catch (error) {
    console.error(error);

    const described = describeDatabaseError(error);
    if (described) {
      return NextResponse.json(
        { error: described.message },
        { status: described.status },
      );
    }

    return NextResponse.json(
      { error: "No se pudo leer la configuración de monedas." },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/settings
 *
 * Body: `{ enabledCurrencies: ["ARS", "USD"] }`
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ QUITAR UNA MONEDA CON CUENTAS ES UN 409 Y NO UN 400
 * ─────────────────────────────────────────────────────────────────────────────
 * El cuerpo es válido: la persona pidió algo que el sistema entiende. Lo que
 * no se puede es llevarlo a cabo con el estado actual de las cuentas. Eso es un
 * CONFLICTO, no un error de sintaxis, y el mensaje tiene que decir qué hacer:
 * archivar esas cuentas o cambiarlas a otra moneda primero.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ LA VERIFICACIÓN VA DENTRO DE UNA TRANSACCIÓN CON LOCK
 * ─────────────────────────────────────────────────────────────────────────────
 * Consultar "¿hay cuentas en dólares?" y después actualizar deja una ventana:
 * entre las dos consultas alguien puede crear una cuenta en dólares y la
 * configuración queda diciendo que los dólares no existen con una cuenta en
 * dólares viva. El `pg_advisory_xact_lock` serializa las ESCRITURAS de esta
 * configuración; el lock se libera solo al terminar la transacción.
 *
 * No es la única puerta de entrada de cuentas (el alta de cuentas no toma este
 * lock), pero sí la que garantiza que dos PATCH simultáneos no se pisen.
 */
const SETTINGS_LOCK_KEY = 442004;

export async function PATCH(req: Request) {
  if (!(await requireApiSession())) return unauthorized();

  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return badRequest("El cuerpo de la petición no es JSON válido.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return badRequest("El cuerpo de la petición tiene que ser un objeto JSON.");
  }

  const parsed = parseEnabledCurrencies(body.enabledCurrencies);
  if (!parsed.ok) return badRequest(parsed.error);
  const enabledCurrencies = parsed.currencies;

  // Las monedas que la persona está apagando se calculan DENTRO de la
  // transacción, contra la fila guardada: una moneda que ya estaba apagada no
  // es un cambio de esta petición. Es la misma definición que usa el modal del
  // cliente (su `initial` es la lista persistida), y la única que hace que un
  // PATCH idempotente no devuelva un 409 por un estado anterior.
  try {
    const result = await prisma.$transaction(async (tx) => {
      // `$executeRaw` y no `$queryRaw`: la función devuelve `void`, que Prisma
      // no sabe deserializar como columna. Acá sólo importa que el lock se
      // tome; el conteo de filas no se usa.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SETTINGS_LOCK_KEY})`;

      // Con el lock tomado, esta lectura es el estado contra el que se decide.
      const actual = await tx.appSettings.findUnique({
        where: { id: 1 },
        select: { enabledCurrencies: true },
      });
      const previas = actual?.enabledCurrencies ?? [DEFAULT_CURRENCY];
      const disabled = previas.filter(
        (currency) => !enabledCurrencies.includes(currency),
      );

      const conflicts: { currency: Currency; accounts: number }[] = [];
      for (const currency of disabled) {
        const accounts = await tx.account.count({ where: { currency } });
        if (accounts > 0) conflicts.push({ currency, accounts });
      }

      if (conflicts.length > 0) {
        return { kind: "conflict" as const, conflicts };
      }

      const updated = await tx.appSettings.upsert({
        where: { id: 1 },
        // La lista se reemplaza ENTERA: es una preferencia, no un incremental.
        // El orden normalizado ya viene de `parseEnabledCurrencies`.
        update: { enabledCurrencies },
        create: { id: 1, enabledCurrencies },
        select: { enabledCurrencies: true },
      });

      return { kind: "ok" as const, enabledCurrencies: updated.enabledCurrencies };
    });

    if (result.kind === "conflict") {
      const names = result.conflicts
        .map((conflict) => currencyNoun(conflict.currency))
        .join(" ni ");
      const detail = result.conflicts
        .map(
          (conflict) =>
            `${conflict.accounts} ${
              conflict.accounts === 1 ? "cuenta" : "cuentas"
            } en ${currencyNoun(conflict.currency)}`,
        )
        .join(" y ");

      return NextResponse.json(
        {
          error: `No podés deshabilitar ${names}: tenés ${detail}. Archivá esas cuentas o cambialas a otra moneda primero.`,
        },
        { status: 409 },
      );
    }

    return NextResponse.json({
      enabledCurrencies: result.enabledCurrencies,
    });
  } catch (error) {
    console.error(error);

    const described = describeDatabaseError(error);
    if (described) {
      return NextResponse.json(
        { error: described.message },
        { status: described.status },
      );
    }

    return NextResponse.json(
      { error: "No se pudo guardar la configuración de monedas." },
      { status: 500 },
    );
  }
}
