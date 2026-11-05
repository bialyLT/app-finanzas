/**
 * REPRO · F4.4b — `/api/settings` y la invariante de monedas habilitadas.
 *
 * Los tres casos se atacan contra la RUTA REAL (no contra un modelo):
 *
 *   1. `PATCH` IDEMPOTENTE. Reenviar la lista que ya está guardada no cambia
 *      nada, así que no puede devolver 409. Hoy lo devuelve si existe una
 *      cuenta en una moneda que YA estaba apagada, porque la ruta calcula
 *      "qué monedas se están apagando" contra el enum completo y no contra la
 *      fila persistida (`app/api/settings/route.ts:109-111`). El modal del
 *      cliente sí compara contra la lista inicial
 *      (`components/CurrencySettingsModal.tsx:105-107`): dos definiciones del
 *      mismo concepto, y la del servidor es la que bloquea al usuario.
 *
 *   2. `GET` con la fila singleton AUSENTE. El dev afirma que responde `["ARS"]`
 *      sin escribir y no hay ningún test que lo cubra (el `beforeEach` de la
 *      suite siempre tiene la fila de la migración).
 *
 *   3. La invariante "ninguna cuenta en una moneda apagada" se rompe por un
 *      camino DETERMINISTA: `PATCH /api/accounts` acepta `currency` y sólo
 *      valida la forma; el trigger de la base sólo impide el cambio si la
 *      cuenta tiene historia. Se declara como falla conocida y diferida (misma
 *      clase que el alta, que el dev dejó fuera del brief).
 *
 * Corre sólo contra `finanzas_test` y crea/borra sus propias filas.
 *   npx vitest run --config scripts/tester-quality/vitest.repro.config.mts
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", async () => {
  const actual = await vi.importActual<typeof import("../../lib/prisma")>(
    "../../lib/prisma",
  );
  const { PrismaClient: PrismaClientDeTest } = await import("@prisma/client");

  const prisma = new PrismaClientDeTest({
    datasourceUrl:
      process.env.DATABASE_URL_TEST ?? "postgresql://nadie@127.0.0.1:1/nunca",
    transactionOptions: actual.TRANSACTION_OPTIONS,
  });

  return { prisma, TRANSACTION_OPTIONS: actual.TRANSACTION_OPTIONS };
});

vi.mock("@/lib/auth/dal", () => ({
  requireApiSession: vi.fn(),
  unauthorized: vi.fn(
    () =>
      new Response(JSON.stringify({ error: "No autorizado" }), { status: 401 }),
  ),
}));

vi.mock("@/lib/auth/csrf", () => ({
  assertSameOrigin: vi.fn(() => null),
}));

import { PrismaClient } from "@prisma/client";
import * as dalModule from "@/lib/auth/dal";
import * as csrfModule from "@/lib/auth/csrf";
import { GET as getSettings, PATCH as patchSettings } from "@/app/api/settings/route";
import { PATCH as patchAccount } from "@/app/api/accounts/route";

const TEST_URL = process.env.DATABASE_URL_TEST;
const describeDb = describe.skipIf(!TEST_URL);

if (TEST_URL && !/finanzas_test/.test(TEST_URL)) {
  throw new Error("Los repros de calidad sólo corren contra finanzas_test.");
}

const db = new PrismaClient({ datasourceUrl: TEST_URL });

const creadas: string[] = [];
let enabledOriginal: ("ARS" | "USD")[] = ["ARS"];

function request(method: string, path: string, body?: unknown) {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function nuevaCuenta(name: string, currency: "ARS" | "USD") {
  const cuenta = await db.account.create({
    data: { name, kind: "CASH", currency, openingBalance: "0" },
  });
  creadas.push(cuenta.id);
  return cuenta;
}

describeDb("REPRO F4.4b · /api/settings", () => {
  beforeEach(async () => {
    vi.mocked(dalModule.requireApiSession).mockResolvedValue({
      v: 1,
      iat: 0,
      exp: 0,
    });
    vi.mocked(csrfModule.assertSameOrigin).mockReturnValue(null);
    const fila = await db.appSettings.findUnique({ where: { id: 1 } });
    enabledOriginal = (fila?.enabledCurrencies ?? ["ARS"]) as ("ARS" | "USD")[];
    await db.appSettings.update({
      where: { id: 1 },
      data: { enabledCurrencies: ["ARS"] },
    });
  });

  afterAll(async () => {
    if (creadas.length > 0) {
      await db.account.deleteMany({ where: { id: { in: creadas } } }).catch(() => {});
    }
    await db.appSettings
      .update({ where: { id: 1 }, data: { enabledCurrencies: enabledOriginal } })
      .catch(() => {});
    await db.$disconnect();
  });

  it("un PATCH que no cambia nada no devuelve 409", async () => {
    // Estado: la fila dice ["ARS"] y hay una cuenta en USD (el estado que el
    // otro camino del producto puede crear). La lista que se manda es la MISMA
    // que ya está guardada: no se apaga ninguna moneda.
    await nuevaCuenta("repro-tq-usd", "USD");

    const res = await patchSettings(
      request("PATCH", "/api/settings", { enabledCurrencies: ["ARS"] }),
    );

    expect(res.status).toBe(200);
  });

  it("GET con la fila singleton ausente responde ARS y no escribe", async () => {
    await db.appSettings.deleteMany();

    const res = await getSettings();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabledCurrencies: ["ARS"] });

    const filas = await db.appSettings.count();
    expect(filas).toBe(0);

    // Se restaura el valor ORIGINAL, no `["ARS"]`: otro tester puede estar
    // usando la misma base con ARS+USD habilitados.
    await db.appSettings.create({
      data: { id: 1, enabledCurrencies: enabledOriginal },
    });
  });

  it("DIFERIDO: mover una cuenta a una moneda apagada no se rechaza", async () => {
    const cuenta = await nuevaCuenta("repro-tq-ars", "ARS");

    const res = await patchAccount(
      request("PATCH", "/api/accounts", { id: cuenta.id, currency: "USD" }),
    );

    // Lo deseable: la API dice que no (la moneda está apagada). Hoy: 200.
    expect(res.status).toBe(409);
  });
});
