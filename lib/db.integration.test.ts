/**
 * Tests de integración contra una base PostgreSQL real.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTOS TESTS IMPORTAN MÁS QUE LOS UNITARIOS
 * ─────────────────────────────────────────────────────────────────────────────
 * Las restricciones de `invariantes_de_dominio` están escritas en SQL dentro de
 * una migración. Nada garantiza que funcionen: un `CHECK` mal escrito, un trigger
 * que nunca se dispara o una condición que se evalúa siempre como verdadera son
 * todos errores silenciosos. La única forma de saber que la base realmente se
 * niega a guardar datos imposibles es INTENTAR GUARDARLOS y ver qué pasa.
 *
 * Cada test de "rechaza" es un intento real de insertar basura. Si alguno pasa a
 * fallar, significa que la base dejó de proteger el modelo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BASE DE DATOS
 * ─────────────────────────────────────────────────────────────────────────────
 * Usa `DATABASE_URL_TEST`, nunca `DATABASE_URL`: estos tests borran todo. Si la
 * variable no está definida, la suite se saltea completa en vez de fallar —
 * así `npm test` funciona en una máquina sin base de datos configurada.
 *
 *     scripts\db-local.ps1 start
 *     npm run db:test:setup       (aplica migraciones a finanzas_test)
 *     npm test
 */

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSACTION_OPTIONS } from "./prisma";

/* ═════════════════════════════════════════════════════════════════════════════
 * LAS RUTAS HTTP, CON LA BASE DE TEST
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Desde la Fase 4.3 este archivo también ejerce los handlers de verdad
 * (`POST /api/transactions`, etc.), no sólo los servicios. Para eso hay que
 * reemplazar tres cosas:
 *
 *   · la sesión y el CSRF (no son el objeto de la prueba);
 *   · el `prisma` singleton de la app, que apunta a `DATABASE_URL` —la base de
 *     la persona— y acá TIENE que apuntar a `finanzas_test`. Se toma la
 *     configuración de transacciones del módulo real para no probar una
 *     configuración distinta de la que la app despliega.
 *
 * El cliente real (`actual.prisma`) se construye pero no se consulta nunca: el
 * mock devuelve uno propio, con el mismo `TRANSACTION_OPTIONS`.
 * ═════════════════════════════════════════════════════════════════════════════ */
vi.mock("@/lib/prisma", async () => {
  const actual = await vi.importActual<typeof import("./prisma")>("./prisma");
  const { PrismaClient: PrismaClientDeTest } = await import("@prisma/client");

  const prisma = new PrismaClientDeTest({
    // Sin base de test, una URL imposible: los tests que la usan ya están
    // salteados y así nunca se cae a `DATABASE_URL`.
    datasourceUrl:
      process.env.DATABASE_URL_TEST ?? "postgresql://nadie@127.0.0.1:1/nunca",
    transactionOptions: actual.TRANSACTION_OPTIONS,
  });

  return { ...actual, prisma };
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

import * as dalModule from "@/lib/auth/dal";
import * as csrfModule from "@/lib/auth/csrf";
import { prisma as apiPrisma } from "@/lib/prisma";
import {
  GET as getAccounts,
  PATCH as patchAccount,
  POST as postAccount,
} from "@/app/api/accounts/route";
import {
  GET as getSettings,
  PATCH as patchSettings,
} from "@/app/api/settings/route";
import {
  GET as getTransactions,
  POST as postTransaction,
} from "@/app/api/transactions/route";
import {
  GET as getBudgets,
  POST as postBudget,
} from "@/app/api/budgets/route";
import { POST as postBatch } from "@/app/api/transactions/batch/route";
import { POST as postFavorite } from "@/app/api/favorites/route";
import {
  POST as postRecurrenceRule,
  PATCH as patchRule,
} from "@/app/api/recurrence/rules/route";
import { addDays, calendarToDb, dbToCalendar } from "./dates";
import { MOVEMENTS_MAX_ROWS } from "./finance";
import { amortizationSchedule, money } from "./money";
import { getAccountBalances, getNetWorth, getNetWorthByCurrency } from "./balance";
import { describeDatabaseError } from "./queries";
import {
  createCardPlan,
  deleteCardPlan,
  getCardsView,
  payStatement,
  runCardStatements,
} from "./card-service";
import {
  RECURRENCE_RUN_MAX_PER_RULE,
  acceptOccurrence,
  deleteMovement,
  getRecurrenceOverview,
  runDueOccurrences,
  skipOccurrence,
} from "./recurring";
import {
  createLoanAccount,
  ensureLoanInstallments,
  getLoansView,
  payLoanInstallment,
} from "./loan-service";
import { dueDateSeries, loanScheduleFor } from "./loans";
import {
  categoriesInPeriod,
  findDuplicateCandidates,
  getDebtReport,
  getMonthReconciliation,
  getNetWorthSeries,
  movementBurn,
  movementBurnCandidates,
  movementCashFlow,
  movementCategoryBreakdown,
  movementDateBreakdown,
  movementTotals,
  periodTotals,
  toAccountDTO,
  DUPLICATES_MAX_ROWS,
} from "./queries";
import {
  FAVORITES_MAX,
  FavoriteError,
  createFavorite,
  deleteFavorite,
  listFavorites,
  parseFavoriteInput,
  touchFavorite,
} from "./favorites";
import { analyzeCsv, importCsv, parseCsvExpected } from "./csv-import";
import { declaredIncomeInPeriod } from "./declared-income";

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST;

/** Los tests de integración sólo corren si hay base de datos de test. */
const describeDb = describe.skipIf(!TEST_DATABASE_URL);

const db = new PrismaClient({
  datasourceUrl: TEST_DATABASE_URL,
  // La MISMA configuración de transacciones que usa el server (lib/prisma.ts):
  // los tests del pool (más abajo) verifican la configuración que la app
  // realmente despliega, no una parecida.
  transactionOptions: TRANSACTION_OPTIONS,
});

/**
 * Vacía las tablas respetando el orden de las claves foráneas.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ LAS OCURRENCIAS VAN PRIMERO
 * ─────────────────────────────────────────────────────────────────────────────
 * `RecurrenceOccurrence.movementId` es `SetNull`: borrar un movimiento POSTEADO
 * dispara el `SetNull`, deja la ocurrencia en POSTED sin movimiento y el CHECK
 * `occurrence_shape_by_status` RECHAZA el borrado. Borrando primero las
 * ocurrencias, el `SetNull` no tiene a quién aplicar.
 */
async function resetDatabase() {
  // Orden FK: los resúmenes referencian movimientos (SetNull) y cuentas
  // (Restrict); los planes referencian su gasto (Restrict). Van antes que los
  // movimientos, o el delete de un movimiento con plan fallaría.
  await db.favoriteTemplate.deleteMany();
  await db.statement.deleteMany();
  await db.cardPlan.deleteMany();
  await db.recurrenceOccurrence.deleteMany();
  // El cronograma de un préstamo cuelga de su cuenta con Cascade —borrar la
  // cuenta lo arrastraría—, pero se borra explícito: el orden tiene que leerse
  // de arriba a abajo sin conocer las reglas de cada FK.
  await db.installment.deleteMany();
  await db.movement.deleteMany();
  await db.recurrenceRule.deleteMany();
  await db.category.deleteMany();
  await db.account.deleteMany();
}

/** Crea las dos categorías que usan casi todos los tests. */
async function seedCategories() {
  const [gastos, sueldo] = await Promise.all([
    db.category.create({
      data: { name: "Gastos", normalizedName: "gastos", kind: "EXPENSE" },
    }),
    db.category.create({
      data: { name: "Sueldo", normalizedName: "sueldo", kind: "INCOME" },
    }),
  ]);
  return { gastos, sueldo };
}

/**
 * El escenario del §3.2, idéntico al que siembra `scripts/smoke.mjs`:
 * banco con 100.000 de saldo inicial, tarjeta, préstamo de 500.000 al 60% en
 * 12 cuotas desembolsado el 30/09, el mes de octubre completo y la cuota 1
 * partida en capital (transferencia) e interés (gasto).
 *
 * Vive acá, en el módulo, y no dentro de un `describe`: lo comparten la
 * reconciliación y los reportes de deuda — dos reportes del MISMO escenario.
 */
async function seedScenario() {
  const { gastos, sueldo } = await seedCategories();

  const [bank, card] = await Promise.all([
    db.account.create({
      data: { name: "Banco", kind: "BANK", openingBalance: "100000" },
    }),
    db.account.create({ data: { name: "Visa", kind: "CREDIT_CARD" } }),
  ]);

  const loan = await db.account.create({
    data: {
      name: "Préstamo",
      kind: "LOAN",
      currency: "ARS",
      principal: "500000",
      tnaPercent: "60",
      installmentCount: 12,
    },
  });

  await db.movement.create({
    data: {
      kind: "TRANSFER",
      amount: "500000",
      date: calendarToDb("2026-09-30"),
      accountId: loan.id,
      toAccountId: bank.id,
      description: "Desembolso del préstamo",
    },
  });

  await db.movement.createMany({
    data: [
      {
        kind: "INCOME",
        amount: "800000",
        date: calendarToDb("2026-10-01"),
        accountId: bank.id,
        categoryId: sueldo.id,
      },
      {
        kind: "EXPENSE",
        amount: "250000",
        date: calendarToDb("2026-10-03"),
        accountId: bank.id,
        categoryId: gastos.id,
      },
      {
        kind: "EXPENSE",
        amount: "120000",
        date: calendarToDb("2026-10-05"),
        accountId: bank.id,
        categoryId: gastos.id,
      },
      {
        kind: "EXPENSE",
        amount: "45000",
        date: calendarToDb("2026-10-08"),
        accountId: bank.id,
        categoryId: gastos.id,
      },
      {
        kind: "EXPENSE",
        amount: "50000",
        date: calendarToDb("2026-10-12"),
        accountId: card.id,
        categoryId: gastos.id,
      },
    ],
  });

  const first = amortizationSchedule("500000", "60", 12)[0];

  await db.movement.createMany({
    data: [
      {
        kind: "TRANSFER",
        amount: first.principal.toFixed(2),
        date: calendarToDb("2026-10-15"),
        accountId: bank.id,
        toAccountId: loan.id,
        description: "Cuota 1 · capital",
      },
      {
        kind: "EXPENSE",
        amount: first.interest.toFixed(2),
        date: calendarToDb("2026-10-15"),
        accountId: bank.id,
        categoryId: gastos.id,
        description: "Cuota 1 · interés",
      },
    ],
  });

  return { bank, card, loan };
}

describeDb("Invariantes del modelo en la base de datos", () => {
  beforeAll(async () => {
    // Verifica que la migración de invariantes haya corrido. Si falta, los
    // tests de "rechaza" fallarían con un mensaje confuso sobre un dato que se
    // guardó, cuando el problema real es que la base está desactualizada.
    const trigger = await db.$queryRaw<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger WHERE tgname = 'movement_account_kind_check'
    `;
    if (trigger.length === 0) {
      throw new Error(
        "Falta la migración 'invariantes_de_dominio'. Corré: npm run db:test:setup",
      );
    }
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
    await db.$disconnect();
  });

  describe("El monto siempre es positivo", () => {
    it("rechaza un monto de cero", async () => {
      const account = await db.account.create({
        data: { name: "Efectivo", kind: "CASH" },
      });
      const category = await db.category.create({
        data: { name: "Gastos", normalizedName: "gastos", kind: "EXPENSE" },
      });

      await expect(
        db.movement.create({
          data: {
            kind: "EXPENSE",
            amount: "0",
            date: calendarToDb("2026-10-15"),
            accountId: account.id,
            categoryId: category.id,
          },
        }),
      ).rejects.toThrow();
    });

    it("rechaza un monto negativo", async () => {
      // Un EXPENSE de −500 sería un gasto que SUMA plata: un dato que se
      // contradice a sí mismo.
      const account = await db.account.create({
        data: { name: "Efectivo", kind: "CASH" },
      });
      const category = await db.category.create({
        data: { name: "Gastos", normalizedName: "gastos", kind: "EXPENSE" },
      });

      await expect(
        db.movement.create({
          data: {
            kind: "EXPENSE",
            amount: "-500",
            date: calendarToDb("2026-10-15"),
            accountId: account.id,
            categoryId: category.id,
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe("La forma del movimiento depende de su tipo", () => {
    it("rechaza una transferencia sin cuenta de destino", async () => {
      const account = await db.account.create({
        data: { name: "Efectivo", kind: "CASH" },
      });

      await expect(
        db.movement.create({
          data: {
            kind: "TRANSFER",
            amount: "1000",
            date: calendarToDb("2026-10-15"),
            accountId: account.id,
          },
        }),
      ).rejects.toThrow();
    });

    it("rechaza una transferencia CON categoría", async () => {
      // Una transferencia entre bolsillos propios no es un gasto: categorizarla
      // sería mentir, y además se contaría en el gráfico de gastos por
      // categoría inflando el total.
      const [a, b] = await Promise.all([
        db.account.create({ data: { name: "Efectivo", kind: "CASH" } }),
        db.account.create({ data: { name: "Banco", kind: "BANK" } }),
      ]);
      const category = await db.category.create({
        data: { name: "Gastos", normalizedName: "gastos", kind: "EXPENSE" },
      });

      await expect(
        db.movement.create({
          data: {
            kind: "TRANSFER",
            amount: "1000",
            date: calendarToDb("2026-10-15"),
            accountId: a.id,
            toAccountId: b.id,
            categoryId: category.id,
          },
        }),
      ).rejects.toThrow();
    });

    it("ACEPTA un ingreso SIN categoría (Fase 7)", async () => {
      // La versión anterior de este test exigía lo contrario, y el cambio es el
      // corazón de la fase: la categoría obligatoria era el campo que hacía
      // lenta la carga más frecuente. Un movimiento sin clasificar es un dato
      // válido — los reportes lo agrupan bajo "Sin categoría".
      const account = await db.account.create({
        data: { name: "Banco", kind: "BANK" },
      });

      const movement = await db.movement.create({
        data: {
          kind: "INCOME",
          amount: "1000",
          date: calendarToDb("2026-10-15"),
          accountId: account.id,
        },
      });

      expect(movement.categoryId).toBeNull();
    });

    it("ACEPTA un gasto SIN categoría (Fase 7)", async () => {
      const account = await db.account.create({
        data: { name: "Efectivo", kind: "CASH" },
      });

      const movement = await db.movement.create({
        data: {
          kind: "EXPENSE",
          amount: "1000",
          date: calendarToDb("2026-10-15"),
          accountId: account.id,
        },
      });

      expect(movement.categoryId).toBeNull();
    });

    it("sigue ACEPTANDO la categoría cuando viene", async () => {
      // El control positivo de los dos tests de arriba: sin esto, una base que
      // rechazara TODA categoría los haría pasar igual.
      const account = await db.account.create({
        data: { name: "Efectivo", kind: "CASH" },
      });
      const category = await db.category.create({
        data: { name: "Gastos", normalizedName: "gastos", kind: "EXPENSE" },
      });

      const movement = await db.movement.create({
        data: {
          kind: "EXPENSE",
          amount: "1000",
          date: calendarToDb("2026-10-15"),
          accountId: account.id,
          categoryId: category.id,
        },
      });

      expect(movement.categoryId).toBe(category.id);
    });

    it("rechaza un gasto con cuenta de destino", async () => {
      // Un gasto no "llega" a ningún lado: la plata se va. Una cuenta de
      // destino en un gasto es un dato que no significa nada.
      const [a, b] = await Promise.all([
        db.account.create({ data: { name: "Efectivo", kind: "CASH" } }),
        db.account.create({ data: { name: "Banco", kind: "BANK" } }),
      ]);
      const category = await db.category.create({
        data: { name: "Gastos", normalizedName: "gastos", kind: "EXPENSE" },
      });

      await expect(
        db.movement.create({
          data: {
            kind: "EXPENSE",
            amount: "1000",
            date: calendarToDb("2026-10-15"),
            accountId: a.id,
            toAccountId: b.id,
            categoryId: category.id,
          },
        }),
      ).rejects.toThrow();
    });

    it("rechaza una transferencia a la misma cuenta", async () => {
      const account = await db.account.create({
        data: { name: "Efectivo", kind: "CASH" },
      });

      await expect(
        db.movement.create({
          data: {
            kind: "TRANSFER",
            amount: "1000",
            date: calendarToDb("2026-10-15"),
            accountId: account.id,
            toAccountId: account.id,
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe("La recurrencia SIGUE exigiendo categoría (la Fase 7 no la tocó)", () => {
    it("rechaza una regla de gasto sin categoría", async () => {
      // El CHECK `recurrence_shape_by_kind` quedó intacto a propósito: una regla
      // sin categoría explotaría recién al postear su primer movimiento. La
      // carga rápida relajó el MOVIMIENTO manual, no la promesa automática.
      const account = await db.account.create({
        data: { name: "Efectivo", kind: "CASH" },
      });

      await expect(
        db.recurrenceRule.create({
          data: {
            title: "Alquiler",
            kind: "EXPENSE",
            amount: "1000",
            freq: "MONTHLY",
            startDate: calendarToDb("2026-10-15"),
            accountId: account.id,
          },
        }),
      ).rejects.toThrow();
    });

    it("sigue aceptando una regla CON categoría", async () => {
      // Control positivo: sin esto, el test de arriba pasaría también si las
      // reglas estuvieran rechazando todo por otro motivo (una columna nueva,
      // un enum cambiado).
      const [account, category] = await Promise.all([
        db.account.create({ data: { name: "Efectivo", kind: "CASH" } }),
        db.category.create({
          data: { name: "Gastos", normalizedName: "gastos", kind: "EXPENSE" },
        }),
      ]);

      const rule = await db.recurrenceRule.create({
        data: {
          title: "Alquiler",
          kind: "EXPENSE",
          amount: "1000",
          freq: "MONTHLY",
          startDate: calendarToDb("2026-10-15"),
          accountId: account.id,
          categoryId: category.id,
        },
      });

      expect(rule.categoryId).toBe(category.id);
    });
  });

  describe("Los movimientos sin categoría se reportan como 'Sin categoría'", () => {
    it("movementCategoryBreakdown los agrupa en un solo bucket y los SUMA", async () => {
      // Dos gastos sin categoría (de días distintos) y uno con categoría: el
      // bucket `null` tiene que existir, juntar los dos, y ordenarse por monto
      // como cualquier otro. Antes de la Fase 7 este caso era defensivo; ahora
      // es el camino real de "anoté el gasto sin clasificarlo".
      const [account, category] = await Promise.all([
        db.account.create({ data: { name: "Efectivo", kind: "CASH" } }),
        db.category.create({
          data: { name: "Gastos", normalizedName: "gastos", kind: "EXPENSE" },
        }),
      ]);

      await db.movement.createMany({
        data: [
          {
            kind: "EXPENSE",
            amount: "250.00",
            date: calendarToDb("2026-10-01"),
            accountId: account.id,
          },
          {
            kind: "EXPENSE",
            amount: "50.00",
            date: calendarToDb("2026-10-02"),
            accountId: account.id,
          },
          {
            kind: "EXPENSE",
            amount: "100.00",
            date: calendarToDb("2026-10-03"),
            accountId: account.id,
            categoryId: category.id,
          },
        ],
      });

      const breakdown = await movementCategoryBreakdown(db, {}, "ARS");

      expect(breakdown).toEqual([
        { categoryId: null, name: "Sin categoría", amount: "300.00" },
        { categoryId: category.id, name: "Gastos", amount: "100.00" },
      ]);
    });

    it("los totales y el flujo de caja los cuentan igual que a cualquier gasto", async () => {
      // Un gasto sin clasificar es un gasto: si los reportes lo saltearan, el
      // mes mostraría un total que no coincide con la plata que salió.
      const account = await db.account.create({
        data: { name: "Efectivo", kind: "CASH" },
      });

      await db.movement.createMany({
        data: [
          {
            kind: "EXPENSE",
            amount: "120.00",
            date: calendarToDb("2026-10-05"),
            accountId: account.id,
          },
          {
            kind: "EXPENSE",
            amount: "30.00",
            date: calendarToDb("2026-10-06"),
            accountId: account.id,
          },
        ],
      });

      const totals = await movementTotals(db, {}, "ARS");
      expect(totals.expenses).toBe("150.00");
      expect(totals.expenseCount).toBe(2);

      const cashFlow = await movementCashFlow(db, {}, "ARS");
      expect(cashFlow).toBe("-150.00");
    });
  });

  describe("Detección de duplicados (Fase 7)", () => {
    /** Una cuenta y un gasto ya cargado, listos para comparar. */
    async function seedExistingMovement() {
      const account = await db.account.create({
        data: { name: "Banco", kind: "BANK" },
      });
      const existing = await db.movement.create({
        data: {
          kind: "EXPENSE",
          amount: "12345.67",
          date: calendarToDb("2026-08-15"),
          accountId: account.id,
        },
      });
      return { account, existing };
    }

    it("encuentra el candidato con la tupla completa: tipo, cuenta, monto y día", async () => {
      const { account, existing } = await seedExistingMovement();

      const found = await findDuplicateCandidates(db, {
        kind: "EXPENSE",
        accountId: account.id,
        amount: "12345.67",
        date: "2026-08-15",
      });

      expect(found.map((movement) => movement.id)).toEqual([existing.id]);
      // Y viaja como DTO: la pantalla lo puede mostrar sin otra consulta.
      expect(found[0].amount).toBe("12345.67");
    });

    it("sin coincidencia exacta no devuelve nada", async () => {
      const { account } = await seedExistingMovement();
      const other = await db.account.create({
        data: { name: "Efectivo", kind: "CASH" },
      });

      const noMatch = async (input: {
        kind?: "INCOME" | "EXPENSE" | "TRANSFER";
        accountId?: string;
        amount?: string;
        date?: string;
      }) =>
        findDuplicateCandidates(db, {
          kind: input.kind ?? "EXPENSE",
          accountId: input.accountId ?? account.id,
          amount: input.amount ?? "12345.67",
          date: input.date ?? "2026-08-15",
        });

      // Cada campo de la tupla, movido de a uno, deja de ser duplicado.
      expect(await noMatch({ accountId: other.id })).toEqual([]);
      expect(await noMatch({ kind: "INCOME" })).toEqual([]);
      expect(await noMatch({ amount: "12345.68" })).toEqual([]);
      expect(await noMatch({ date: "2026-08-16" })).toEqual([]);
    });

    it("dos cafés iguales son DOS duplicados: la base no deduplica, sólo avisa", async () => {
      // Dos movimientos idénticos son un dato válido (dos cafés el mismo día al
      // mismo precio existen). Por eso la consulta devuelve candidatos y la
      // decisión queda en la persona: "Guardar igual" o "Volver".
      const { account } = await seedExistingMovement();
      const second = await db.movement.create({
        data: {
          kind: "EXPENSE",
          amount: "12345.67",
          date: calendarToDb("2026-08-15"),
          accountId: account.id,
        },
      });

      const found = await findDuplicateCandidates(db, {
        kind: "EXPENSE",
        accountId: account.id,
        amount: "12345.67",
        date: "2026-08-15",
      });

      expect(found).toHaveLength(2);
      expect(found.map((movement) => movement.id)).toContain(second.id);
    });

    it("no devuelve más que el tope aunque haya más repetidos", async () => {
      const { account } = await seedExistingMovement();

      await db.movement.createMany({
        data: Array.from({ length: DUPLICATES_MAX_ROWS + 2 }, () => ({
          kind: "EXPENSE" as const,
          amount: "12345.67",
          date: calendarToDb("2026-08-15"),
          accountId: account.id,
        })),
      });

      const found = await findDuplicateCandidates(db, {
        kind: "EXPENSE",
        accountId: account.id,
        amount: "12345.67",
        date: "2026-08-15",
      });

      // 1 original + 7 creados = 8 iguales; la respuesta se corta en el tope.
      expect(found).toHaveLength(DUPLICATES_MAX_ROWS);
    });

    it("un movimiento sin categoría también puede ser duplicado", async () => {
      // La carga rápida escribe movimientos sin categoría: si el chequeo no los
      // mirara, el error más común —anotar dos veces el mismo gasto— pasaría
      // justo en los casos que la fase hizo fáciles de cargar.
      const { account, existing } = await seedExistingMovement();

      expect(existing.categoryId).toBeNull();
      const found = await findDuplicateCandidates(db, {
        kind: "EXPENSE",
        accountId: account.id,
        amount: "12345.67",
        date: "2026-08-15",
      });

      expect(found).toHaveLength(1);
    });
  });

  describe("Las cuentas de pasivo no reciben ingresos (trigger)", () => {
    it("rechaza un ingreso en un préstamo", async () => {
      // ÉSTE es el error que producía el 49% de ahorro falso: tratar el
      // desembolso del préstamo como un ingreso. La base no lo permite ni
      // siquiera si alguien escribe el código mal.
      const loan = await db.account.create({
        data: {
          name: "Préstamo",
          kind: "LOAN",
          currency: "ARS",
          principal: "500000",
          tnaPercent: "60",
          installmentCount: 12,
        },
      });
      const category = await db.category.create({
        data: { name: "Sueldo", normalizedName: "sueldo", kind: "INCOME" },
      });

      await expect(
        db.movement.create({
          data: {
            kind: "INCOME",
            amount: "500000",
            date: calendarToDb("2026-10-15"),
            accountId: loan.id,
            categoryId: category.id,
          },
        }),
      ).rejects.toThrow();
    });

    it("rechaza un ingreso en una tarjeta de crédito", async () => {
      const card = await db.account.create({
        data: { name: "Visa", kind: "CREDIT_CARD" },
      });
      const category = await db.category.create({
        data: { name: "Sueldo", normalizedName: "sueldo", kind: "INCOME" },
      });

      await expect(
        db.movement.create({
          data: {
            kind: "INCOME",
            amount: "500000",
            date: calendarToDb("2026-10-15"),
            accountId: card.id,
            categoryId: category.id,
          },
        }),
      ).rejects.toThrow();
    });

    it("SÍ permite la transferencia desde el préstamo hacia el banco", async () => {
      // La forma correcta de registrar un desembolso. Si este test falla, el
      // modelo quedó inutilizable.
      const [loan, bank] = await Promise.all([
        db.account.create({
          data: {
            name: "Préstamo",
            kind: "LOAN",
            currency: "ARS",
            principal: "500000",
            tnaPercent: "60",
            installmentCount: 12,
          },
        }),
        db.account.create({ data: { name: "Banco", kind: "BANK" } }),
      ]);

      const movement = await db.movement.create({
        data: {
          kind: "TRANSFER",
          amount: "500000",
          date: calendarToDb("2026-10-15"),
          accountId: loan.id,
          toAccountId: bank.id,
          description: "Desembolso del préstamo",
        },
      });

      expect(movement.id).toBeTruthy();
    });
  });

  describe("El tipo de la categoría y el del movimiento (trigger)", () => {
    // ─────────────────────────────────────────────────────────────────────────
    // EL INVARIANTE QUE FALTABA
    //
    // Una categoría de INCOME no puede acompañar a un EXPENSE (ni al revés).
    // El proyecto lo declaraba, el schema lo suponía y NADA lo custodiaba: la
    // API resolvía la categoría con un `upsert` de `update: {}` (la categoría
    // conserva su tipo) y guardaba el movimiento con la categoría equivocada.
    //
    // Acá se intenta guardar el dato imposible DE VERDAD: si el trigger no
    // dispara, el dato entra y el modelo vuelve a mentir.
    // ─────────────────────────────────────────────────────────────────────────

    it("rechaza un ingreso clasificado con una categoría de GASTO", async () => {
      const account = await db.account.create({
        data: { name: "Efectivo", kind: "CASH" },
      });
      const category = await db.category.create({
        data: { name: "Alquiler", normalizedName: "alquiler", kind: "EXPENSE" },
      });

      await expect(
        db.movement.create({
          data: {
            kind: "INCOME",
            amount: "325000",
            date: calendarToDb("2026-10-19"),
            accountId: account.id,
            categoryId: category.id,
          },
        }),
      ).rejects.toThrow();
    });

    it("rechaza un gasto clasificado con una categoría de INGRESO", async () => {
      const account = await db.account.create({
        data: { name: "Efectivo", kind: "CASH" },
      });
      const category = await db.category.create({
        data: { name: "Sueldo", normalizedName: "sueldo", kind: "INCOME" },
      });

      await expect(
        db.movement.create({
          data: {
            kind: "EXPENSE",
            amount: "1000",
            date: calendarToDb("2026-10-19"),
            accountId: account.id,
            categoryId: category.id,
          },
        }),
      ).rejects.toThrow();
    });

    it("el rechazo se traduce a un 400 con mensaje (nunca un 500)", async () => {
      const account = await db.account.create({
        data: { name: "Efectivo", kind: "CASH" },
      });
      const category = await db.category.create({
        data: { name: "Alquiler", normalizedName: "alquiler", kind: "EXPENSE" },
      });

      let caught: unknown = null;
      try {
        await db.movement.create({
          data: {
            kind: "INCOME",
            amount: "325000",
            date: calendarToDb("2026-10-19"),
            accountId: account.id,
            categoryId: category.id,
          },
        });
      } catch (error) {
        caught = error;
      }

      const described = describeDatabaseError(caught);
      expect(described?.status).toBe(400);
      expect(described?.message).toBeTruthy();
    });

    it("ACEPTA los dos casos que sí son correctos", async () => {
      const account = await db.account.create({
        data: { name: "Efectivo", kind: "CASH" },
      });
      const gasto = await db.category.create({
        data: { name: "Alquiler", normalizedName: "alquiler", kind: "EXPENSE" },
      });
      const ingreso = await db.category.create({
        data: { name: "Sueldo", normalizedName: "sueldo", kind: "INCOME" },
      });

      const exp = await db.movement.create({
        data: {
          kind: "EXPENSE",
          amount: "325000",
          date: calendarToDb("2026-10-19"),
          accountId: account.id,
          categoryId: gasto.id,
        },
      });
      const inc = await db.movement.create({
        data: {
          kind: "INCOME",
          amount: "500000",
          date: calendarToDb("2026-10-01"),
          accountId: account.id,
          categoryId: ingreso.id,
        },
      });

      expect(exp.id).toBeTruthy();
      expect(inc.id).toBeTruthy();
    });

    it("NO rompe una fila que ya venía violando el invariante", async () => {
      // Hay una fila así en la base de la persona (un INCOME con una categoría
      // de gasto). Los triggers no se disparan sobre las filas que ya existen,
      // así que la fila queda como está — y tiene que poder ACTUALIZARSE sin
      // quedar trancada: el trigger no revalida un UPDATE que no cambia ni el
      // tipo ni la categoría.
      const account = await db.account.create({
        data: { name: "Efectivo", kind: "CASH" },
      });
      const category = await db.category.create({
        data: { name: "Alquiler", normalizedName: "alquiler", kind: "EXPENSE" },
      });

      // El trigger se apaga UN MOMENTO para simular la fila que ya existía
      // (los triggers no ven las filas anteriores a ellos).
      await db.$executeRawUnsafe(
        `ALTER TABLE "Movement" DISABLE TRIGGER "movement_category_kind_check"`,
      );
      let legacy: { id: string };
      try {
        legacy = await db.movement.create({
          data: {
            kind: "INCOME",
            amount: "325000",
            date: calendarToDb("2026-10-19"),
            accountId: account.id,
            categoryId: category.id,
          },
        });
      } finally {
        await db.$executeRawUnsafe(
          `ALTER TABLE "Movement" ENABLE TRIGGER "movement_category_kind_check"`,
        );
      }

      // La fila sigue ahí, con su contradicción: no se "arregló" sola.
      const antes = await db.movement.findUnique({ where: { id: legacy.id } });
      expect(antes?.kind).toBe("INCOME");
      expect(antes?.categoryId).toBe(category.id);

      // Y se puede actualizar (cambiar la descripción no cambia el tipo ni la
      // categoría: no hay nada nuevo que validar).
      const despues = await db.movement.update({
        where: { id: legacy.id },
        data: { description: "Alquiler (corregido a mano)" },
      });
      expect(despues.description).toBe("Alquiler (corregido a mano)");

      // Pero cambiar su tipo a algo que siga contradiciéndose, NO.
      await expect(
        db.movement.update({
          where: { id: legacy.id },
          data: { kind: "TRANSFER", toAccountId: account.id },
        }),
      ).rejects.toThrow();
    });

    it("el tipo de una categoría EN USO es inmutable", async () => {
      const account = await db.account.create({
        data: { name: "Efectivo", kind: "CASH" },
      });
      const category = await db.category.create({
        data: { name: "Alquiler", normalizedName: "alquiler", kind: "EXPENSE" },
      });
      await db.movement.create({
        data: {
          kind: "EXPENSE",
          amount: "325000",
          date: calendarToDb("2026-10-19"),
          accountId: account.id,
          categoryId: category.id,
        },
      });

      // Cambiarle el tipo dejaría al movimiento contradiciéndola.
      await expect(
        db.category.update({
          where: { id: category.id },
          data: { kind: "INCOME" },
        }),
      ).rejects.toThrow();
    });

    it("una categoría que NO está en uso puede cambiar de tipo", async () => {
      const category = await db.category.create({
        data: { name: "Sueldo", normalizedName: "sueldo", kind: "EXPENSE" },
      });

      const cambiada = await db.category.update({
        where: { id: category.id },
        data: { kind: "INCOME" },
      });

      expect(cambiada.kind).toBe("INCOME");
    });

    it("rechaza una REGLA cuyo tipo contradice el de su categoría", async () => {
      // La regla es la PROMESA de un movimiento: si es imposible, el
      // generador no puede postear nunca y el fallo aparece meses después.
      const account = await db.account.create({
        data: { name: "Efectivo", kind: "CASH" },
      });
      const category = await db.category.create({
        data: { name: "Alquiler", normalizedName: "alquiler", kind: "EXPENSE" },
      });

      await expect(
        db.recurrenceRule.create({
          data: {
            title: "Alquiler",
            kind: "INCOME",
            amount: "325000",
            accountId: account.id,
            categoryId: category.id,
            freq: "MONTHLY",
            startDate: calendarToDb("2026-10-01"),
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe("Los préstamos no se pueden crear a medias", () => {
    it("rechaza un préstamo sin tasa", async () => {
      // Sin tasa no se puede descomponer la cuota en capital e interés, y sin
      // esa descomposición volvemos al problema original.
      await expect(
        db.account.create({
          data: {
            name: "Préstamo",
            kind: "LOAN",
            currency: "ARS",
            principal: "500000",
            installmentCount: 12,
          },
        }),
      ).rejects.toThrow();
    });

    it("rechaza un préstamo sin cantidad de cuotas", async () => {
      await expect(
        db.account.create({
          data: {
            name: "Préstamo",
            kind: "LOAN",
            currency: "ARS",
            principal: "500000",
            tnaPercent: "60",
          },
        }),
      ).rejects.toThrow();
    });

    it("rechaza parámetros de préstamo en una cuenta que no es préstamo", async () => {
      await expect(
        db.account.create({
          data: {
            name: "Caja de ahorro",
            kind: "BANK",
            tnaPercent: "60",
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe("Unicidad", () => {
    it("rechaza dos cuentas con el mismo nombre", async () => {
      await db.account.create({ data: { name: "Efectivo", kind: "CASH" } });

      await expect(
        db.account.create({ data: { name: "Efectivo", kind: "BANK" } }),
      ).rejects.toThrow();
    });

    it("rechaza dos categorías que normalizan al mismo nombre", async () => {
      // ÉSTE es el bug de las categorías duplicadas: el esquema viejo tenía
      // @@unique([name]) sobre el nombre CRUDO, y Postgres es sensible a
      // mayúsculas. "Comida" y "comida" eran dos categorías distintas, y el
      // gráfico de gastos partía el mismo concepto en dos porciones.
      await db.category.create({
        data: { name: "Comida", normalizedName: "comida", kind: "EXPENSE" },
      });

      await expect(
        db.category.create({
          data: { name: "COMIDA", normalizedName: "comida", kind: "EXPENSE" },
        }),
      ).rejects.toThrow();
    });
  });
});

describeDb("Cálculo de saldos", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
    await db.$disconnect();
  });

  it("el saldo de una cuenta vacía es su saldo inicial", async () => {
    const account = await db.account.create({
      data: { name: "Efectivo", kind: "CASH", openingBalance: "1500.50" },
    });

    const [balance] = await getAccountBalances(db);
    expect(balance.id).toBe(account.id);
    expect(balance.balance.toFixed(2)).toBe("1500.50");
  });

  it("suma ingresos y resta gastos", async () => {
    const { gastos, sueldo } = await seedCategories();
    const account = await db.account.create({
      data: { name: "Banco", kind: "BANK", openingBalance: "1000" },
    });

    await db.movement.createMany({
      data: [
        {
          kind: "INCOME",
          amount: "5000",
          date: calendarToDb("2026-10-01"),
          accountId: account.id,
          categoryId: sueldo.id,
        },
        {
          kind: "EXPENSE",
          amount: "2000",
          date: calendarToDb("2026-10-05"),
          accountId: account.id,
          categoryId: gastos.id,
        },
      ],
    });

    const [balance] = await getAccountBalances(db);
    // 1000 + 5000 − 2000 = 4000
    expect(balance.balance.toFixed(2)).toBe("4000.00");
  });

  it("una transferencia saca de una cuenta y mete en la otra, sin perderse", async () => {
    // Si este test falla, mover plata entre bolsillos hace desaparecer dinero.
    const bank = await db.account.create({
      data: { name: "Banco", kind: "BANK", openingBalance: "10000" },
    });
    const cash = await db.account.create({
      data: { name: "Efectivo", kind: "CASH", openingBalance: "0" },
    });

    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "3000",
        date: calendarToDb("2026-10-10"),
        accountId: bank.id,
        toAccountId: cash.id,
      },
    });

    const balances = await getAccountBalances(db);
    const bankBalance = balances.find((b) => b.id === bank.id)!;
    const cashBalance = balances.find((b) => b.id === cash.id)!;

    expect(bankBalance.balance.toFixed(2)).toBe("7000.00");
    expect(cashBalance.balance.toFixed(2)).toBe("3000.00");

    // La suma se conserva: la transferencia no creó ni destruyó plata.
    expect(
      bankBalance.balance.plus(cashBalance.balance).toFixed(2),
    ).toBe("10000.00");
  });

  it("asOf corta el saldo en una fecha y el día del corte entra", async () => {
    const { gastos } = await seedCategories();
    const account = await db.account.create({
      data: { name: "Banco", kind: "BANK", openingBalance: "0" },
    });

    await db.movement.createMany({
      data: [
        {
          kind: "EXPENSE",
          amount: "100",
          date: calendarToDb("2026-10-15"),
          accountId: account.id,
          categoryId: gastos.id,
        },
        {
          kind: "EXPENSE",
          amount: "200",
          date: calendarToDb("2026-10-16"),
          accountId: account.id,
          categoryId: gastos.id,
        },
      ],
    });

    // El movimiento del 15 tiene que ENTRAR (es `<=`, no `<`).
    const onThe15th = await getAccountBalances(db, { asOf: "2026-10-15" });
    expect(onThe15th[0].balance.toFixed(2)).toBe("-100.00");

    const onThe14th = await getAccountBalances(db, { asOf: "2026-10-14" });
    expect(onThe14th[0].balance.toFixed(2)).toBe("0.00");
  });

  it("una cuenta de pasivo tiene saldo negativo y deuda positiva", async () => {
    const card = await db.account.create({
      data: { name: "Visa", kind: "CREDIT_CARD" },
    });
    const { gastos } = await seedCategories();

    await db.movement.create({
      data: {
        kind: "EXPENSE",
        amount: "50000",
        date: calendarToDb("2026-10-10"),
        accountId: card.id,
        categoryId: gastos.id,
      },
    });

    const [balance] = await getAccountBalances(db);
    // El saldo contable es −50.000 (lo que necesita la aritmética)...
    expect(balance.balance.toFixed(2)).toBe("-50000.00");
    // ...y la deuda mostrada es 50.000 (lo que espera leer la persona).
    expect(balance.debt?.toFixed(2)).toBe("50000.00");
  });

  it("las cuentas de dinero no tienen deuda", async () => {
    await db.account.create({ data: { name: "Efectivo", kind: "CASH" } });
    const [balance] = await getAccountBalances(db);
    expect(balance.debt).toBeNull();
  });

  it("las cuentas archivadas siguen contando en el patrimonio", async () => {
    // Archivar oculta la cuenta de la interfaz, no la borra del pasado. Si su
    // saldo desapareciera, el patrimonio neto mentiría.
    await db.account.create({
      data: {
        name: "Caja vieja",
        kind: "CASH",
        openingBalance: "500",
        archived: true,
      },
    });

    const netWorth = await getNetWorth(db, { currency: "ARS" });
    expect(netWorth.assets.toFixed(2)).toBe("500.00");
  });
});

describeDb("EL ESCENARIO COMPLETO · sueldo, gastos, préstamo y tarjeta", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
    await db.$disconnect();
  });

  /**
   * Sueldo 800.000 · Gastos 600.000 · Préstamo 500.000 a TNA 60% en 12 cuotas
   * · Compra con tarjeta 50.000
   *
   * El objetivo del test es que el PATRIMONIO NETO dé el número honesto, sin
   * importar cómo se hayan cargado los movimientos. Es el único número que no
   * se puede maquillar: la tasa de ahorro depende de qué contás como ingreso,
   * el patrimonio neto no.
   */
  it("el patrimonio neto refleja la realidad, no el optimismo", async () => {
    const [gastos, sueldo, intereses, compras] = await Promise.all([
      db.category.create({ data: { name: "Gastos", normalizedName: "gastos", kind: "EXPENSE" } }),
      db.category.create({ data: { name: "Sueldo", normalizedName: "sueldo", kind: "INCOME" } }),
      db.category.create({ data: { name: "Intereses", normalizedName: "intereses", kind: "EXPENSE" } }),
      db.category.create({ data: { name: "Compras", normalizedName: "compras", kind: "EXPENSE" } }),
    ]);

    const [cash, bank, card] = await Promise.all([
      db.account.create({ data: { name: "Efectivo", kind: "CASH" } }),
      // Arranca con 100.000 ahorrados de antes.
      db.account.create({ data: { name: "Banco", kind: "BANK", openingBalance: "100000" } }),
      db.account.create({ data: { name: "Visa", kind: "CREDIT_CARD" } }),
    ]);

    const loan = await db.account.create({
      data: {
        name: "Préstamo",
        kind: "LOAN",
        currency: "ARS",
        principal: "500000",
        tnaPercent: "60",
        installmentCount: 12,
      },
    });

    // ── El desembolso: NO es un ingreso ──────────────────────────────────────
    // Es una transferencia. El préstamo queda en −500.000 y el banco sube
    // 500.000. El patrimonio neto no cambia: te endeudaste, no ganaste plata.
    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "500000",
        date: calendarToDb("2026-09-30"),
        accountId: loan.id,
        toAccountId: bank.id,
        description: "Desembolso del préstamo",
      },
    });

    // ── El mes ───────────────────────────────────────────────────────────────
    await db.movement.createMany({
      data: [
        {
          kind: "INCOME",
          amount: "800000",
          date: calendarToDb("2026-10-01"),
          accountId: bank.id,
          categoryId: sueldo.id,
          description: "Sueldo de octubre",
        },
        {
          kind: "EXPENSE",
          amount: "600000",
          date: calendarToDb("2026-10-10"),
          accountId: bank.id,
          categoryId: gastos.id,
          description: "Gastos del mes",
        },
        {
          // La compra con tarjeta es un gasto en el momento que la hacés, y la
          // deuda aparece en el mismo momento. No se espera al resumen.
          kind: "EXPENSE",
          amount: "50000",
          date: calendarToDb("2026-10-12"),
          accountId: card.id,
          categoryId: compras.id,
          description: "Compra con tarjeta",
        },
      ],
    });

    // ── La cuota del préstamo, descompuesta como la descompone el banco ──────
    const schedule = amortizationSchedule("500000", "60", 12);
    const first = schedule[0];

    await db.movement.create({
      data: {
        // Amortización de capital: baja la deuda. NO es un gasto.
        kind: "TRANSFER",
        amount: first.principal.toFixed(2),
        date: calendarToDb("2026-10-15"),
        accountId: bank.id,
        toAccountId: loan.id,
        description: "Cuota 1 · capital",
      },
    });

    await db.movement.create({
      data: {
        // El interés: ésta es la ÚNICA parte de la cuota que es costo real.
        kind: "EXPENSE",
        amount: first.interest.toFixed(2),
        date: calendarToDb("2026-10-15"),
        accountId: bank.id,
        categoryId: intereses.id,
        description: "Cuota 1 · interés",
      },
    });

    const balances = await getAccountBalances(db);
    const byName = (name: string) => balances.find((b) => b.name === name)!;

    // Banco: 100.000 + 500.000 (préstamo) + 800.000 (sueldo)
    //        − 600.000 (gastos) − capital − interés
    const expectedBank = 100_000 + 500_000 + 800_000 - 600_000 -
      Number(first.principal.toFixed(2)) - Number(first.interest.toFixed(2));
    expect(byName("Banco").balance.toNumber()).toBeCloseTo(expectedBank, 2);

    // Préstamo: −500.000 + capital amortizado
    expect(byName("Préstamo").balance.toFixed(2)).toBe(
      `-${(500_000 - Number(first.principal.toFixed(2))).toFixed(2)}`,
    );
    // Deuda mostrada en positivo.
    expect(byName("Préstamo").debt?.toNumber()).toBeCloseTo(
      500_000 - Number(first.principal.toFixed(2)),
      2,
    );

    // Tarjeta: −50.000, la compra ya cuenta.
    expect(byName("Visa").debt?.toFixed(2)).toBe("50000.00");

    // ── La prueba de fuego ───────────────────────────────────────────────────
    const netWorth = await getNetWorth(db, { currency: "ARS" });

    // Patrimonio inicial: 100.000 (los ahorros previos) + 0 (efectivo).
    // Cambio del período: 800.000 de sueldo − 600.000 de gastos
    //                     − 25.000 de interés − 50.000 de la compra con tarjeta
    //                   = 125.000
    // Patrimonio final: 100.000 + 125.000 = 225.000
    expect(netWorth.net.toFixed(2)).toBe("225000.00");

    // Y se verifica el desglose, que es lo que explica el número.
    expect(netWorth.assets.toFixed(2)).toBe(
      (
        Number(byName("Efectivo").balance.toFixed(2)) +
        Number(byName("Banco").balance.toFixed(2))
      ).toFixed(2),
    );
    expect(netWorth.liabilities.toNumber()).toBeCloseTo(
      Number(byName("Préstamo").debt!.toFixed(2)) +
        Number(byName("Visa").debt!.toFixed(2)),
      2,
    );
  });

  it("el desembolso del préstamo NO mueve el patrimonio neto", async () => {
    // La demostración más limpia del modelo. Antes de cobrar el préstamo y
    // después, el patrimonio neto es IDÉNTICO: sólo cambió de qué está hecho
    // (más plata en el banco, más deuda). Nada se creó.
    const bank = await db.account.create({
      data: { name: "Banco", kind: "BANK", openingBalance: "0" },
    });
    const loan = await db.account.create({
      data: {
        name: "Préstamo",
        kind: "LOAN",
        currency: "ARS",
        principal: "500000",
        tnaPercent: "60",
        installmentCount: 12,
      },
    });

    const before = await getNetWorth(db, { currency: "ARS" });
    expect(before.net.toFixed(2)).toBe("0.00");

    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "500000",
        date: calendarToDb("2026-09-30"),
        accountId: loan.id,
        toAccountId: bank.id,
      },
    });

    const after = await getNetWorth(db, { currency: "ARS" });
    expect(after.net.toFixed(2)).toBe("0.00");
    expect(after.assets.toFixed(2)).toBe("500000.00");
    expect(after.liabilities.toFixed(2)).toBe("500000.00");

    // Y sin embargo, el banco SÍ tiene más plata. Las dos cosas son ciertas.
    const balances = await getAccountBalances(db);
    expect(balances.find((b) => b.id === bank.id)!.balance.toFixed(2)).toBe(
      "500000.00",
    );
  });

  it("pagar la tarjeta no es un gasto: baja el banco y baja la deuda", async () => {
    // El error más común de las apps de finanzas es contar la compra Y el pago
    // como dos gastos. Acá el pago es una transferencia, así que sólo se contó
    // la compra.
    const compras = await db.category.create({
      data: { name: "Compras", normalizedName: "compras", kind: "EXPENSE" },
    });
    const bank = await db.account.create({
      data: { name: "Banco", kind: "BANK", openingBalance: "100000" },
    });
    const card = await db.account.create({
      data: { name: "Visa", kind: "CREDIT_CARD" },
    });

    await db.movement.create({
      data: {
        kind: "EXPENSE",
        amount: "50000",
        date: calendarToDb("2026-10-12"),
        accountId: card.id,
        categoryId: compras.id,
      },
    });

    const afterPurchase = await getNetWorth(db, { currency: "ARS" });
    expect(afterPurchase.net.toFixed(2)).toBe("50000.00");

    // Pagás el resumen completo.
    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "50000",
        date: calendarToDb("2026-11-05"),
        accountId: bank.id,
        toAccountId: card.id,
        description: "Pago del resumen",
      },
    });

    const afterPayment = await getNetWorth(db, { currency: "ARS" });
    // El patrimonio NO cambió: pagar la tarjeta es mover plata de un bolsillo
    // a otro. Si el pago hubiera sido un gasto, acá habría bajado a 0.
    expect(afterPayment.net.toFixed(2)).toBe("50000.00");

    const balances = await getAccountBalances(db);
    expect(balances.find((b) => b.id === card.id)!.debt?.toFixed(2)).toBe("0.00");
    expect(balances.find((b) => b.id === bank.id)!.balance.toFixed(2)).toBe(
      "50000.00",
    );
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * EL BUG DE LOS TOTALES TRUNCADOS
 * ─────────────────────────────────────────────────────────────────────────────
 * Este bloque existe por un bug concreto, encontrado al escribir los flows de
 * Maestro: el panel calculaba "Ingresos", "Gastos", "Te quedó" y la tasa de
 * ahorro **filtrando la lista ya topeada**, así que a partir del movimiento 501
 * los cuatro números quedaban subestimados — con la misma cara de confianza que
 * los correctos.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ LOS TESTS QUE YA EXISTÍAN NO LO ENCONTRARON
 * ─────────────────────────────────────────────────────────────────────────────
 * Porque sumaban la lista: reimplementaban el bug. Un test que calcula lo mismo
 * que el código, de la misma forma, no puede encontrar el error — lo confirma.
 *
 * Lo único que lo encuentra es comparar contra un valor **conocido de antemano**,
 * con más filas que el tope. De ahí las 505 filas de abajo.
 */
describeDb("movementTotals · el tope limita lo que se muestra, no lo que se calcula", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
    await db.$disconnect();
  });

  it("suma 505 movimientos aunque la lista se topee en 500", async () => {
    const bank = await db.account.create({
      data: { name: "Banco", kind: "BANK" },
    });
    const { gastos, sueldo } = await seedCategories();

    const GASTOS = 400;
    const INGRESOS = 105;

    // El test tiene que CRUZAR el tope o no prueba nada. Si algún día alguien sube
    // `MOVEMENTS_MAX_ROWS` por encima de 505, esta aserción falla — que es
    // exactamente lo que tiene que pasar: el test dejó de ser válido y hay que
    // agrandarlo, no dejarlo pasar en verde.
    expect(GASTOS + INGRESOS).toBeGreaterThan(MOVEMENTS_MAX_ROWS);

    await db.movement.createMany({
      data: [
        ...Array.from({ length: GASTOS }, () => ({
          kind: "EXPENSE" as const,
          amount: "10.00",
          date: calendarToDb("2026-10-15"),
          accountId: bank.id,
          categoryId: gastos.id,
        })),
        ...Array.from({ length: INGRESOS }, () => ({
          kind: "INCOME" as const,
          amount: "100.00",
          date: calendarToDb("2026-10-15"),
          accountId: bank.id,
          categoryId: sueldo.id,
        })),
      ],
    });

    const where = {
      date: {
        gte: calendarToDb("2026-10-01"),
        lte: calendarToDb("2026-10-31"),
      },
    };

    // 1 · La lista se trunca, y está bien que lo haga: mandar miles de filas al
    //     navegador por cada mes es un problema de memoria. El `+1` es cómo se
    //     detecta que hay más.
    const list = await db.movement.findMany({
      where,
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: MOVEMENTS_MAX_ROWS + 1,
    });
    expect(list.length).toBe(MOVEMENTS_MAX_ROWS + 1);

    // 2 · Los totales NO se truncan. Si `movementTotals` tomara el mismo `take`
    //     que la lista —el bug—, acá daría 5.000,00 en vez de 10.500,00.
    const totals = await movementTotals(db, where, "ARS");
    expect(totals.expenseCount).toBe(GASTOS);
    expect(totals.incomeCount).toBe(INGRESOS);
    expect(totals.expenses).toBe((GASTOS * 10).toFixed(2));
    expect(totals.income).toBe((INGRESOS * 100).toFixed(2));

    // 3 · Un tipo sin movimientos devuelve 0,00 y no `null`: en SQL la suma de un
    //     conjunto vacío es NULL, y sin el chequeo esto reventaría en el panel.
    expect(totals.transferCount).toBe(0);
    expect(totals.transfers).toBe("0.00");
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LA TORTA Y LAS BARRAS, CON LA MISMA REGLA QUE LOS TOTALES
 * ─────────────────────────────────────────────────────────────────────────────
 * `movementTotals` ya está cubierto arriba. Pero `/analisis` tenía DOS agregados
 * más que sumaba en el cliente sobre la lista topeada —la torta "En qué se fue"
 * y las barras "Evolución"—, así que sufrían exactamente el mismo bug: pasadas
 * las 500 filas, las porciones y las barras quedaban recortadas y el gráfico
 * mentía con la misma cara de confianza.
 *
 * El arreglo es el mismo (agregar en la base con `groupBy` sobre el período
 * completo) y el test es el espejo del de arriba: sembrar más filas que el tope
 * y comparar contra números calculados a mano. Si alguien vuelve a "simplificar"
 * los agregados sumando la lista, acá se cae.
 */
describeDb("Los agregados de reportes · completos aunque la lista se topee", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
    await db.$disconnect();
  });

  it("la torta suma el total de gastos y las barras cubren todos los días, con más de 500 movimientos", async () => {
    const [gastos, compras, sueldo, vieja] = await Promise.all([
      db.category.create({ data: { name: "Gastos", normalizedName: "gastos", kind: "EXPENSE" } }),
      db.category.create({ data: { name: "Compras", normalizedName: "compras", kind: "EXPENSE" } }),
      db.category.create({ data: { name: "Sueldo", normalizedName: "sueldo", kind: "INCOME" } }),
      // Esta categoría sólo tiene un movimiento en SEPTIEMBRE: no tiene que
      // aparecer en el selector de octubre, y sí en el de septiembre.
      db.category.create({ data: { name: "Vieja", normalizedName: "vieja", kind: "EXPENSE" } }),
    ]);

    const [bank, cash] = await Promise.all([
      db.account.create({ data: { name: "Banco", kind: "BANK" } }),
      db.account.create({ data: { name: "Efectivo", kind: "CASH" } }),
    ]);

    // ── El sembrado: 507 filas en total, 506 dentro de octubre (el período que
    //    se verifica), más que el tope de la lista ───────────────────────────
    //
    //     Gastos   300 × 10,00 = 3.000,00   (100 por día en 3 días)
    //     Compras  100 × 15,00 = 1.500,00   ( 50 por día en 2 días)
    //     Sueldo   105 × 100,00 = 10.500,00 ( 35 por día en 3 días)
    //     ─────────────────────────────────
    //     Gastos totales: 3.000 + 1.500 = 4.500,00
    //
    // Los días se eligieron para que cada fila de `byDate` dé un número redondo
    // y distinto del total: si un día se perdiera por el camino, el mapa del
    // final no tendría la fecha y el test falla NOMBRANDO el día que falta.
    const GASTOS_GRANDES = 300;
    const GASTOS_CHICOS = 100;
    const INGRESOS = 105;

    expect(GASTOS_GRANDES + GASTOS_CHICOS + INGRESOS).toBeGreaterThan(MOVEMENTS_MAX_ROWS);

    const diasDeGastos = ["2026-10-05", "2026-10-12", "2026-10-19"];
    const diasDeCompras = ["2026-10-08", "2026-10-22"];
    const diasDeSueldo = ["2026-10-02", "2026-10-15", "2026-10-28"];

    await db.movement.createMany({
      data: [
        ...diasDeGastos.flatMap((date) =>
          Array.from({ length: 100 }, () => ({
            kind: "EXPENSE" as const,
            amount: "10.00",
            date: calendarToDb(date),
            accountId: bank.id,
            categoryId: gastos.id,
          })),
        ),
        ...diasDeCompras.flatMap((date) =>
          Array.from({ length: 50 }, () => ({
            kind: "EXPENSE" as const,
            amount: "15.00",
            date: calendarToDb(date),
            accountId: bank.id,
            categoryId: compras.id,
          })),
        ),
        ...diasDeSueldo.flatMap((date) =>
          Array.from({ length: 35 }, () => ({
            kind: "INCOME" as const,
            amount: "100.00",
            date: calendarToDb(date),
            accountId: bank.id,
            categoryId: sueldo.id,
          })),
        ),
        {
          // Una transferencia más. NINGUNO de los agregados de reportes la
          // puede contar: no es ingreso, no es gasto y no tiene categoría.
          kind: "TRANSFER" as const,
          amount: "500.00",
          date: calendarToDb("2026-10-20"),
          accountId: bank.id,
          toAccountId: cash.id,
        },
        {
          // El de septiembre, fuera del rango que verifica todo lo demás.
          kind: "EXPENSE" as const,
          amount: "1.00",
          date: calendarToDb("2026-09-15"),
          accountId: bank.id,
          categoryId: vieja.id,
        },
      ],
    });

    const where = {
      date: {
        gte: calendarToDb("2026-10-01"),
        lte: calendarToDb("2026-10-31"),
      },
    };

    /** Suma montos en centavos enteros: comparar strings decimales no existe. */
    const sumaEnCentavos = (rows: readonly { amount: string }[]): number =>
      rows.reduce((total, row) => total + Math.round(Number(row.amount) * 100), 0);

    // ── 1 · Los totales ──────────────────────────────────────────────────────
    // Si `movementTotals` tomara el `take` de la lista, acá daría 5.000,00 y
    // 2.500,00 en vez de 4.500,00 y 10.500,00 (las primeras 500 filas sembradas).
    const totals = await movementTotals(db, where, "ARS");
    expect(totals.expenses).toBe("4500.00");
    expect(totals.expenseCount).toBe(GASTOS_GRANDES + GASTOS_CHICOS);
    expect(totals.income).toBe("10500.00");
    expect(totals.incomeCount).toBe(INGRESOS);
    expect(totals.transfers).toBe("500.00");
    expect(totals.transferCount).toBe(1);

    // ── 2 · La torta ─────────────────────────────────────────────────────────
    // Dos porciones (Gastos y Compras), ordenadas de mayor a menor, y la suma
    // de TODAS las porciones tiene que ser exactamente el total de gastos: es
    // la coherencia interna de la pantalla. Si la transferencia se colara como
    // gasto, la igualdad se rompería por 500,00.
    const byCategory = await movementCategoryBreakdown(db, where, "ARS");
    expect(byCategory.length).toBe(2);
    expect(byCategory[0].name).toBe("Gastos");
    expect(byCategory[0].amount).toBe("3000.00");
    expect(byCategory[1].name).toBe("Compras");
    expect(byCategory[1].amount).toBe("1500.00");
    expect(sumaEnCentavos(byCategory)).toBe(
      Math.round(Number(totals.expenses) * 100),
    );

    // ── 3 · Las barras ───────────────────────────────────────────────────────
    // Un renglón por día CON movimientos de cada tipo (5 de gastos + 3 de
    // ingresos), y ninguno el 20, que es el día de la transferencia.
    const byDate = await movementDateBreakdown(db, where, "ARS");
    expect(byDate.length).toBe(8);
    expect(byDate.some((row) => row.date === "2026-10-20")).toBe(false);

    const porFecha = new Map(
      byDate.map((row) => [`${row.date}|${row.kind}`, row.amount]),
    );
    expect(porFecha.get("2026-10-05|EXPENSE")).toBe("1000.00");
    expect(porFecha.get("2026-10-12|EXPENSE")).toBe("1000.00");
    expect(porFecha.get("2026-10-19|EXPENSE")).toBe("1000.00");
    expect(porFecha.get("2026-10-08|EXPENSE")).toBe("750.00");
    expect(porFecha.get("2026-10-22|EXPENSE")).toBe("750.00");
    expect(porFecha.get("2026-10-02|INCOME")).toBe("3500.00");
    expect(porFecha.get("2026-10-15|INCOME")).toBe("3500.00");
    expect(porFecha.get("2026-10-28|INCOME")).toBe("3500.00");

    // La suma por tipo también da los totales: 4.500,00 de gastos y 10.500,00
    // de ingresos, en centavos enteros.
    expect(sumaEnCentavos(byDate.filter((row) => row.kind === "EXPENSE"))).toBe(450_000);
    expect(sumaEnCentavos(byDate.filter((row) => row.kind === "INCOME"))).toBe(1_050_000);

    // ── 4 · El selector de categorías ────────────────────────────────────────
    // Todas las categorías con movimientos en octubre —y ninguna otra—,
    // ordenadas por nombre normalizado. "Vieja" sólo vive en septiembre.
    const enOctubre = await categoriesInPeriod(db, "2026-10-01", "2026-10-31", "ARS");
    expect(enOctubre.map((category) => category.name)).toEqual([
      "Compras",
      "Gastos",
      "Sueldo",
    ]);

    // El mismo selector visto desde septiembre: ahí la única es "Vieja". Es el
    // cruce de mes del bug B3, aplicado al selector.
    const enSeptiembre = await categoriesInPeriod(db, "2026-09-01", "2026-09-30", "ARS");
    expect(enSeptiembre.map((category) => category.name)).toEqual(["Vieja"]);

    // Sin extremos de rango: todas las categorías usadas alguna vez.
    const todas = await categoriesInPeriod(db, null, null, "ARS");
    expect(todas.length).toBe(4);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * EL FLUJO DE CAJA · LA LIQUIDEZ, NO LA GANANCIA
 * ─────────────────────────────────────────────────────────────────────────────
 * `movementTotals` responde "cuánto gané y cuánto gasté". `movementCashFlow`
 * responde OTRA pregunta: "cuánta plata entró y salió de mis cuentas de
 * dinero". El punto del rediseño es que los dos números se puedan separar —
 * apenas hay deuda de por medio, se separan:
 *
 *   · El desembolso del préstamo entra a la caja y NO es un ingreso.
 *   · Una compra con tarjeta es un gasto y NO mueve la caja (todavía).
 *   · El pago del resumen mueve la caja y NO es un gasto.
 *   · Una transferencia entre dos cuentas de dinero se anula sola.
 *
 * Si alguno de estos tests se cae, la app volvió a tratar liquidez y ahorro
 * como si fueran lo mismo — y los dos números se ven igual de confiables.
 */
describeDb("Flujo de caja · el desembolso entra, la tarjeta no", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
    await db.$disconnect();
  });

  /** Un rango de fechas de calendario, listo para pasar como `where`. */
  const rango = (from: string, to: string) => ({
    date: { gte: calendarToDb(from), lte: calendarToDb(to) },
  });

  it("el desembolso del préstamo CUENTA como entrada (y sigue sin ser ingreso)", async () => {
    const [loan, bank] = await Promise.all([
      db.account.create({
        data: {
          name: "Préstamo",
          kind: "LOAN",
          currency: "ARS",
          principal: "500000",
          tnaPercent: "60",
          installmentCount: 12,
        },
      }),
      db.account.create({ data: { name: "Banco", kind: "BANK" } }),
    ]);

    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "500000",
        date: calendarToDb("2026-09-30"),
        accountId: loan.id,
        toAccountId: bank.id,
        description: "Desembolso del préstamo",
      },
    });

    const septiembre = rango("2026-09-01", "2026-09-30");

    // La caja: entró medio millón al banco. El préstamo es deuda, así que su
    // lado del movimiento no cuenta.
    expect(await movementCashFlow(db, septiembre, "ARS")).toBe("500000.00");

    // Y la misma lectura desde el DTO que usa el panel: $ 0 de ingreso,
    // +500.000 de flujo. Las dos cosas son ciertas al mismo tiempo, y por eso
    // los dos números existen por separado.
    const totals = await movementTotals(db, septiembre, "ARS");
    expect(totals.income).toBe("0.00");
    expect(totals.expenses).toBe("0.00");
    expect(totals.cashFlow).toBe("500000.00");
  });

  it("una compra con tarjeta NO mueve el flujo de caja (aunque sí sea gasto)", async () => {
    const card = await db.account.create({
      data: { name: "Visa", kind: "CREDIT_CARD" },
    });
    const { gastos } = await seedCategories();

    await db.movement.create({
      data: {
        kind: "EXPENSE",
        amount: "50000",
        date: calendarToDb("2026-10-12"),
        accountId: card.id,
        categoryId: gastos.id,
        description: "Compra con tarjeta",
      },
    });

    const octubre = rango("2026-10-01", "2026-10-31");

    // Ninguna cuenta de dinero participó: no salió un peso de la caja.
    expect(await movementCashFlow(db, octubre, "ARS")).toBe("0.00");

    // Pero el gasto consumido es real: la deuda subió. Si la compra contara en
    // el flujo, acá daría −50.000,00.
    const totals = await movementTotals(db, octubre, "ARS");
    expect(totals.expenses).toBe("50000.00");
    expect(totals.cashFlow).toBe("0.00");
  });

  it("el pago del resumen SÍ cuenta: sale del banco, sin ser gasto", async () => {
    const [bank, card] = await Promise.all([
      db.account.create({ data: { name: "Banco", kind: "BANK" } }),
      db.account.create({ data: { name: "Visa", kind: "CREDIT_CARD" } }),
    ]);

    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "50000",
        date: calendarToDb("2026-11-05"),
        accountId: bank.id,
        toAccountId: card.id,
        description: "Pago del resumen",
      },
    });

    const noviembre = rango("2026-11-01", "2026-11-30");

    // Origen de dinero (banco), destino pasivo (tarjeta): la caja baja 50.000.
    expect(await movementCashFlow(db, noviembre, "ARS")).toBe("-50000.00");

    const totals = await movementTotals(db, noviembre, "ARS");
    expect(totals.transfers).toBe("50000.00");
    expect(totals.expenses).toBe("0.00");
    expect(totals.cashFlow).toBe("-50000.00");
  });

  it("una transferencia entre dos cuentas de dinero se anula (entra Y sale)", async () => {
    const [bank, cash] = await Promise.all([
      db.account.create({ data: { name: "Banco", kind: "BANK" } }),
      db.account.create({ data: { name: "Efectivo", kind: "CASH" } }),
    ]);

    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "300000",
        date: calendarToDb("2026-10-10"),
        accountId: bank.id,
        toAccountId: cash.id,
      },
    });

    const octubre = rango("2026-10-01", "2026-10-31");

    // Salió del banco Y entró al efectivo: neto 0,00. Si el flujo contara sólo
    // una punta, mover plata entre bolsillos parecería que ganaste o perdiste.
    expect(await movementCashFlow(db, octubre, "ARS")).toBe("0.00");

    // El movimiento sigue informado en `transfers`: la lista cuenta hechos, el
    // flujo mide liquidez.
    const totals = await movementTotals(db, octubre, "ARS");
    expect(totals.transfers).toBe("300000.00");
    expect(totals.cashFlow).toBe("0.00");
  });

  it("en un mes con préstamo, flujo de caja ≠ ahorro: los DOS números correctos", async () => {
    // El escenario del §3.2: sueldo 800.000, gastos 600.000 y un préstamo de
    // 500.000 al 60% TNA en 12 cuotas, desembolsado el 30/09. Octubre tiene la
    // cuota 1 (capital 31.412,71 + interés 25.000) y una compra con tarjeta.
    const [gastos, sueldo, intereses, compras] = await Promise.all([
      db.category.create({ data: { name: "Gastos", normalizedName: "gastos", kind: "EXPENSE" } }),
      db.category.create({ data: { name: "Sueldo", normalizedName: "sueldo", kind: "INCOME" } }),
      db.category.create({ data: { name: "Intereses", normalizedName: "intereses", kind: "EXPENSE" } }),
      db.category.create({ data: { name: "Compras", normalizedName: "compras", kind: "EXPENSE" } }),
    ]);

    const [bank, card] = await Promise.all([
      db.account.create({ data: { name: "Banco", kind: "BANK" } }),
      db.account.create({ data: { name: "Visa", kind: "CREDIT_CARD" } }),
    ]);

    const loan = await db.account.create({
      data: {
        name: "Préstamo",
        kind: "LOAN",
        currency: "ARS",
        principal: "500000",
        tnaPercent: "60",
        installmentCount: 12,
      },
    });

    // Septiembre: el desembolso, como transferencia desde el préstamo al banco.
    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "500000",
        date: calendarToDb("2026-09-30"),
        accountId: loan.id,
        toAccountId: bank.id,
        description: "Desembolso del préstamo",
      },
    });

    // Octubre: sueldo, gastos, compra con tarjeta.
    await db.movement.createMany({
      data: [
        {
          kind: "INCOME",
          amount: "800000",
          date: calendarToDb("2026-10-01"),
          accountId: bank.id,
          categoryId: sueldo.id,
          description: "Sueldo de octubre",
        },
        {
          kind: "EXPENSE",
          amount: "600000",
          date: calendarToDb("2026-10-10"),
          accountId: bank.id,
          categoryId: gastos.id,
          description: "Gastos del mes",
        },
        {
          kind: "EXPENSE",
          amount: "50000",
          date: calendarToDb("2026-10-12"),
          accountId: card.id,
          categoryId: compras.id,
          description: "Compra con tarjeta",
        },
      ],
    });

    // La cuota 1, descompuesta como la descompone el banco: el capital es
    // TRANSFER del banco al préstamo y el interés es EXPENSE del banco.
    const first = amortizationSchedule("500000", "60", 12)[0];

    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: first.principal.toFixed(2),
        date: calendarToDb("2026-10-15"),
        accountId: bank.id,
        toAccountId: loan.id,
        description: "Cuota 1 · capital",
      },
    });

    await db.movement.create({
      data: {
        kind: "EXPENSE",
        amount: first.interest.toFixed(2),
        date: calendarToDb("2026-10-15"),
        accountId: bank.id,
        categoryId: intereses.id,
        description: "Cuota 1 · interés",
      },
    });

    // ── Septiembre: ahorro 0, flujo +500.000 ────────────────────────────────
    // El mes donde los dos números NO pueden parecerse ni de casualidad.
    const septiembre = await movementTotals(db, rango("2026-09-01", "2026-09-30"), "ARS");
    expect(septiembre.income).toBe("0.00");
    expect(septiembre.cashFlow).toBe("500000.00");

    // ── Octubre: los dos números, calculados a mano ─────────────────────────
    //
    //   Ahorro (income − expenses) = 800.000 − (600.000 + 50.000 + 25.000)
    //                              = 125.000,00
    //   Flujo de caja              = 800.000 − (600.000 + 25.000 + 31.412,71)
    //                              = 143.587,29
    //
    // La diferencia son las dos caras de la deuda:
    //   · La compra con tarjeta es gasto consumido que TODAVÍA no salió de la
    //     caja: resta en el ahorro (−50.000) y no toca el flujo.
    //   · El capital de la cuota es plata que SALIÓ de la caja sin ser gasto:
    //     resta en el flujo (−31.412,71) y no toca el ahorro.
    //   125.000,00 + 50.000,00 − 31.412,71 = 143.587,29 ✓
    const octubre = await movementTotals(db, rango("2026-10-01", "2026-10-31"), "ARS");
    expect(octubre.income).toBe("800000.00");
    expect(octubre.expenses).toBe("675000.00");
    expect(octubre.cashFlow).toBe("143587.29");

    const ahorro = (Number(octubre.income) - Number(octubre.expenses)).toFixed(2);
    expect(ahorro).toBe("125000.00");
    expect(octubre.cashFlow).not.toBe(ahorro);

    // ── Y los dos meses suman el flujo del año ──────────────────────────────
    // 500.000,00 + 143.587,29 = 643.587,29. La liquidez no desaparece al
    // cambiar de período: sólo se reparte distinto.
    expect(await movementCashFlow(db, rango("2026-01-01", "2026-12-31"), "ARS")).toBe(
      "643587.29",
    );
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LA SERIE MENSUAL DEL PATRIMONIO · DE DÓNDE VIENE EL NÚMERO DE HOY
 * ─────────────────────────────────────────────────────────────────────────────
 * El panel mostraba la foto de hoy y ninguna evolución. La serie es la
 * respuesta a "¿ese número subió porque ahorré o porque me endeudé?" — y su
 * test tiene el mismo rigor que el de cualquier otro total del proyecto: los
 * números se calculan A MANO contra el escenario sembrado (el mismo de
 * `scripts/smoke.mjs`), no sumando la lista como lo hace el código.
 *
 * Los tres casos que cubren estos tests:
 *   1. El escenario completo: agosto, septiembre y octubre con los netos y la
 *      descomposición exactos — incluida la foto de septiembre, donde el
 *      desembolso del préstamo sube activos Y deudas y el neto NO se mueve.
 *   2. El borde de mes: el 31/07 es de julio, el 01/09 es de septiembre, y el
 *      mes en curso se corta a HOY (lo del 17/10 no entra en una foto del 16).
 *   3. El mes sin movimientos: no es un hueco ni un cero — arrastra el saldo
 *      anterior. Y una base sin cuentas devuelve serie VACÍA, no 12 ceros.
 */
describeDb("Serie mensual del patrimonio · la foto de cada mes", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
    await db.$disconnect();
  });

  it("el escenario sembrado, mes a mes (netos calculados a mano)", async () => {
    const { gastos, sueldo } = await seedCategories();

    const [bank, card] = await Promise.all([
      db.account.create({
        data: { name: "Banco", kind: "BANK", openingBalance: "100000" },
      }),
      db.account.create({ data: { name: "Visa", kind: "CREDIT_CARD" } }),
    ]);

    const loan = await db.account.create({
      data: {
        name: "Préstamo",
        kind: "LOAN",
        currency: "ARS",
        principal: "500000",
        tnaPercent: "60",
        installmentCount: 12,
      },
    });

    // El desembolso, el 30/09: transferencia del préstamo al banco.
    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "500000",
        date: calendarToDb("2026-09-30"),
        accountId: loan.id,
        toAccountId: bank.id,
        description: "Desembolso del préstamo",
      },
    });

    // Octubre: sueldo, tres gastos del banco, la compra con tarjeta.
    await db.movement.createMany({
      data: [
        {
          kind: "INCOME",
          amount: "800000",
          date: calendarToDb("2026-10-01"),
          accountId: bank.id,
          categoryId: sueldo.id,
        },
        {
          kind: "EXPENSE",
          amount: "250000",
          date: calendarToDb("2026-10-03"),
          accountId: bank.id,
          categoryId: gastos.id,
        },
        {
          kind: "EXPENSE",
          amount: "120000",
          date: calendarToDb("2026-10-05"),
          accountId: bank.id,
          categoryId: gastos.id,
        },
        {
          kind: "EXPENSE",
          amount: "45000",
          date: calendarToDb("2026-10-08"),
          accountId: bank.id,
          categoryId: gastos.id,
        },
        {
          kind: "EXPENSE",
          amount: "50000",
          date: calendarToDb("2026-10-12"),
          accountId: card.id,
          categoryId: gastos.id,
        },
      ],
    });

    // La cuota 1 del préstamo, descompuesta: capital (transferencia) e interés
    // (gasto), como la descompone el banco.
    const first = amortizationSchedule("500000", "60", 12)[0];

    await db.movement.createMany({
      data: [
        {
          kind: "TRANSFER",
          amount: first.principal.toFixed(2),
          date: calendarToDb("2026-10-15"),
          accountId: bank.id,
          toAccountId: loan.id,
          description: "Cuota 1 · capital",
        },
        {
          kind: "EXPENSE",
          amount: first.interest.toFixed(2),
          date: calendarToDb("2026-10-15"),
          accountId: bank.id,
          categoryId: gastos.id,
          description: "Cuota 1 · interés",
        },
      ],
    });

    // ── EL CÁLCULO A MANO ────────────────────────────────────────────────────
    //
    //   agosto 2026    Activos: banco 100.000 + efectivo 0 = 100.000,00
    //                  Deudas: 0,00 (la tarjeta y el préstamo todavía están en 0)
    //                  Neto: 100.000,00 — no hay ni un movimiento
    //
    //   septiembre     Activos: 100.000 + 500.000 (desembolso del 30/09) = 600.000,00
    //                  Deudas: 500.000,00 (el préstamo, por el desembolso)
    //                  Neto: 600.000 − 500.000 = 100.000,00
    //                  ★ El desembolso NO movió el patrimonio: subió la plata en
    //                    el banco a la vez que subió la deuda. Cambia la
    //                    COMPOSICIÓN, no el neto.
    //
    //   octubre        Banco: 100.000 + 500.000 + 800.000 (sueldo)
    //                         − 250.000 − 120.000 − 45.000 (gastos)
    //                         − 31.412,71 (capital de la cuota)
    //                         − 25.000,00 (interés de la cuota)
    //                        = 928.587,29
    //                  Deudas: 50.000 (tarjeta) + 468.587,29 (préstamo: 500.000
    //                          − 31.412,71 de capital) = 518.587,29
    //                  Neto: 928.587,29 − 518.587,29 = 410.000,00
    //                      = 100.000 iniciales + 310.000 de ahorro real
    //                        (800.000 de sueldo − 490.000 de gastos reales)
    const serie = await getNetWorthSeries(db, { currency: "ARS", anchor: "2026-10-31" });

    // Doce meses, del más viejo (noviembre 2025) al más nuevo (octubre 2026).
    expect(serie).toHaveLength(12);
    expect(serie[0].month).toBe("2025-11");
    expect(serie[11].month).toBe("2026-10");

    const porMes = new Map(serie.map((point) => [point.month, point]));

    // Agosto: la foto completa del mes sin movimientos.
    expect(porMes.get("2026-08")).toEqual({
      month: "2026-08",
      assets: "100000.00",
      liabilities: "0.00",
      net: "100000.00",
      partial: false,
    });

    // Septiembre: el neto es el MISMO que agosto — y sin embargo pasó todo.
    expect(porMes.get("2026-09")).toEqual({
      month: "2026-09",
      assets: "600000.00",
      liabilities: "500000.00",
      net: "100000.00",
      partial: false,
    });

    // Octubre: el número de hoy, al cierre.
    expect(porMes.get("2026-10")).toEqual({
      month: "2026-10",
      assets: "928587.29",
      liabilities: "518587.29",
      net: "410000.00",
      partial: false,
    });

    // El último punto es EXACTAMENTE la foto que devuelve `getNetWorth` para la
    // misma fecha: la serie no puede inventar un patrimonio distinto del que
    // muestra el panel para el mismo día.
    const fotoDeOctubre = await getNetWorth(db, { currency: "ARS", asOf: "2026-10-31" });
    expect(porMes.get("2026-10")?.net).toBe(fotoDeOctubre.net.toFixed(2));

    // Los diez meses anteriores a septiembre no tienen movimientos: ninguno es
    // un hueco ni un cero — cada uno arrastra el saldo inicial del banco.
    const sinMovimientos = serie.filter((point) => point.month <= "2026-08");
    expect(sinMovimientos).toHaveLength(10);
    for (const point of sinMovimientos) {
      expect(point).toEqual({
        month: point.month,
        assets: "100000.00",
        liabilities: "0.00",
        net: "100000.00",
        partial: false,
      });
    }
  });

  it("los bordes de mes caen donde tienen que caer, y el mes en curso es parcial", async () => {
    const { gastos, sueldo } = await seedCategories();

    const bank = await db.account.create({
      data: { name: "Banco", kind: "BANK", openingBalance: "100000" },
    });
    const cash = await db.account.create({
      data: { name: "Efectivo", kind: "CASH" },
    });

    await db.movement.createMany({
      data: [
        {
          // El ÚLTIMO día de julio: es de julio, no de agosto.
          kind: "EXPENSE",
          amount: "5000",
          date: calendarToDb("2026-07-31"),
          accountId: bank.id,
          categoryId: gastos.id,
        },
        {
          // El último de agosto.
          kind: "EXPENSE",
          amount: "20000",
          date: calendarToDb("2026-08-31"),
          accountId: bank.id,
          categoryId: gastos.id,
        },
        {
          // El PRIMERO de septiembre: es de septiembre, no de agosto.
          kind: "INCOME",
          amount: "50000",
          date: calendarToDb("2026-09-01"),
          accountId: bank.id,
          categoryId: sueldo.id,
        },
        {
          // Una transferencia entre cuentas de dinero: no cambia el neto.
          kind: "TRANSFER",
          amount: "30000",
          date: calendarToDb("2026-10-05"),
          accountId: bank.id,
          toAccountId: cash.id,
        },
        {
          // El día del corte del mes en curso: ENTRA (`asOf` es inclusivo).
          kind: "EXPENSE",
          amount: "10000",
          date: calendarToDb("2026-10-16"),
          accountId: bank.id,
          categoryId: gastos.id,
        },
        {
          // Después del corte: NO entra. Un movimiento cargado con fecha
          // futura no puede aparecer en la foto de "hoy".
          kind: "EXPENSE",
          amount: "999.99",
          date: calendarToDb("2026-10-17"),
          accountId: bank.id,
          categoryId: gastos.id,
        },
      ],
    });

    // ── EL CÁLCULO A MANO (ancla: 16/10) ─────────────────────────────────────
    //
    //   julio       100.000 − 5.000            =  95.000,00
    //   agosto       95.000 − 20.000           =  75.000,00
    //   septiembre   75.000 + 50.000           = 125.000,00
    //   octubre     125.000 + 30.000 − 30.000  = 125.000,00  (la transferencia
    //                          − 10.000       = 115.000,00   se anula sola)
    //
    // Si el gasto del 17/10 se colara, octubre daría 114.000,01. Si el 31/07
    // cayera en agosto, agosto daría 95.000. Si el 01/09 cayera en agosto,
    // agosto daría 125.000.
    const serie = await getNetWorthSeries(db, { currency: "ARS", anchor: "2026-10-16" });
    const porMes = new Map(serie.map((point) => [point.month, point]));

    expect(porMes.get("2026-07")?.net).toBe("95000.00");
    expect(porMes.get("2026-08")?.net).toBe("75000.00");
    expect(porMes.get("2026-09")?.net).toBe("125000.00");

    // El mes en curso (octubre) es PARCIAL: la foto es "a hoy", no a fin de mes.
    expect(porMes.get("2026-10")?.net).toBe("115000.00");
    expect(porMes.get("2026-10")?.partial).toBe(true);

    // Los meses cerrados no: su foto es fin de mes de verdad.
    expect(porMes.get("2026-09")?.partial).toBe(false);
    expect(porMes.get("2026-07")?.partial).toBe(false);

    // Y el mes en curso también llega marcado así cuando el ancla es el último
    // día: ahí el mes SÍ terminó, aunque siga siendo el mes de hoy.
    const finDeMes = await getNetWorthSeries(db, { currency: "ARS", anchor: "2026-10-31" });
    const octubreCerrado = finDeMes.find((point) => point.month === "2026-10");
    expect(octubreCerrado?.net).toBe("114000.01");
    expect(octubreCerrado?.partial).toBe(false);
  });

  it("sin ninguna cuenta la serie es vacía, no 12 ceros", async () => {
    // Doce fotos en cero afirmarían "tu patrimonio fue exactamente 0", que la
    // app no puede saber. Sin cuentas no hay ni saldos iniciales que mostrar:
    // es "no hay datos", y el contrato del DTO lo dice con una lista vacía.
    // (Un saldo inicial de cero en una cuenta que existe SÍ es un cero real:
    // eso lo cubren los otros dos tests.)
    expect(await getNetWorthSeries(db, { currency: "ARS", anchor: "2026-10-16" })).toEqual([]);
  });
});

/**
 * La reconciliación visible: `ΔPatrimonio = Ahorro`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ SE VERIFICA Y POR QUÉ ASÍ
 * ─────────────────────────────────────────────────────────────────────────────
 * Es la red de seguridad del modelo: compara dos caminos INDEPENDIENTES al
 * mismo número —la variación de los saldos y el ahorro de los movimientos— y su
 * contrato es mostrar la diferencia cuando no cuadra, nunca esconderla.
 *
 * Los números de estos tests se calculan A MANO sobre el escenario sembrado (el
 * mismo del §3.2 del ROADMAP y de `scripts/smoke.mjs`):
 *
 *   · Agosto:  neto 100.000,00 (sólo el saldo inicial del banco).
 *   · Septiembre: el desembolso de 500.000 mueve el banco a 600.000 y la deuda
 *     a 500.000 — el neto NO se mueve. Δ 0,00 = ahorro 0,00.
 *   · Octubre: sueldo 800.000, gastos 490.000 (incluido el interés de la cuota)
 *     y capital 31.412,71 de la cuota. Δ = 410.000 − 100.000 = 310.000,00 =
 *     ahorro 800.000 − 490.000.
 *
 * El caso que NO cuadra se fuerza interviniendo UNA de las dos mitades: con las
 * restricciones de la base (CHECKs + trigger) es IMPOSIBLE escribir movimientos
 * que rompan la identidad —es un teorema del modelo— y exactamente por eso el
 * control existe: para el día que una consulta o una escritura por afuera de la
 * app rompa una de las suposiciones. El test simula esa falla en el lugar donde
 * este control tiene que verla: una de las dos mitades devolviendo otro número.
 */
describeDb("Reconciliación visible · ΔPatrimonio = Ahorro", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
    await db.$disconnect();
  });

  it("octubre cierra cuadrando al centavo: Δ +310.000,00 = ahorro +310.000,00", async () => {
    await seedScenario();

    //   net(30/09): banco 100.000 + 500.000 (desembolso) − 500.000 (deuda) = 100.000,00
    //   net(31/10): 928.587,29 de activos − 518.587,29 de deudas         = 410.000,00
    //   Δ: 410.000 − 100.000                                             = +310.000,00
    //   ahorro: 800.000 (sueldo) − 490.000 (gastos reales)               = +310.000,00
    const rec = await getMonthReconciliation(db, { currency: "ARS",
      month: "2026-10",
      anchor: "2026-10-31",
    });

    expect(rec).toEqual({
      month: "2026-10",
      netStart: "100000.00",
      netEnd: "410000.00",
      netDelta: "310000.00",
      saving: "310000.00",
      declaredIncome: "0.00",
      difference: "0.00",
      balanced: true,
      partial: false,
      cutAt: "2026-10-31",
    });
  });

  it("septiembre cuadra en cero: el préstamo mueve activos y pasivos, no el patrimonio", async () => {
    await seedScenario();

    // El caso que el modelo viejo contaba como "+500.000 de ingresos": el
    // desembolso entra al banco Y sube la deuda por el mismo monto. La
    // composición prueba que pasó algo; el neto prueba que no ganaste nada.
    const sep = await getNetWorth(db, { currency: "ARS", asOf: "2026-09-30" });
    expect(sep.assets.toFixed(2)).toBe("600000.00");
    expect(sep.liabilities.toFixed(2)).toBe("500000.00");

    const rec = await getMonthReconciliation(db, { currency: "ARS",
      month: "2026-09",
      anchor: "2026-10-31",
    });

    expect(rec).toEqual({
      month: "2026-09",
      netStart: "100000.00",
      netEnd: "100000.00",
      netDelta: "0.00",
      saving: "0.00",
      declaredIncome: "0.00",
      difference: "0.00",
      balanced: true,
      partial: false,
      cutAt: "2026-09-30",
    });
  });

  it("un mes sin movimientos cuadra en cero y muestra las dos fotos intactas", async () => {
    await seedScenario();

    // Agosto no tuvo ni un movimiento: las dos fotos son el saldo inicial del
    // banco, y el ahorro es 0,00. No es un hueco ni un caso especial — es la
    // misma identidad.
    const rec = await getMonthReconciliation(db, { currency: "ARS",
      month: "2026-08",
      anchor: "2026-10-31",
    });

    expect(rec).toEqual({
      month: "2026-08",
      netStart: "100000.00",
      netEnd: "100000.00",
      netDelta: "0.00",
      saving: "0.00",
      declaredIncome: "0.00",
      difference: "0.00",
      balanced: true,
      partial: false,
      cutAt: "2026-08-31",
    });
  });

  it("el mes en curso se corta a hoy en los DOS lados (lo posterior no entra)", async () => {
    // Un escenario con movimientos que caen a los dos lados del corte:
    // el 16/10 (incluido, `<=`) y el 17/10 (excluido mientras el ancla sea el 16).
    const { gastos, sueldo } = await seedCategories();

    const bank = await db.account.create({
      data: { name: "Banco", kind: "BANK", openingBalance: "100000" },
    });
    const cash = await db.account.create({
      data: { name: "Efectivo", kind: "CASH" },
    });

    await db.movement.createMany({
      data: [
        {
          kind: "EXPENSE",
          amount: "5000",
          date: calendarToDb("2026-07-31"),
          accountId: bank.id,
          categoryId: gastos.id,
        },
        {
          kind: "EXPENSE",
          amount: "20000",
          date: calendarToDb("2026-08-31"),
          accountId: bank.id,
          categoryId: gastos.id,
        },
        {
          kind: "INCOME",
          amount: "50000",
          date: calendarToDb("2026-09-01"),
          accountId: bank.id,
          categoryId: sueldo.id,
        },
        {
          kind: "TRANSFER",
          amount: "30000",
          date: calendarToDb("2026-10-05"),
          accountId: bank.id,
          toAccountId: cash.id,
        },
        {
          kind: "EXPENSE",
          amount: "10000",
          date: calendarToDb("2026-10-16"),
          accountId: bank.id,
          categoryId: gastos.id,
        },
        {
          kind: "EXPENSE",
          amount: "999.99",
          date: calendarToDb("2026-10-17"),
          accountId: bank.id,
          categoryId: gastos.id,
        },
      ],
    });

    // Con el ancla del 16: net(30/09) = 125.000 (100.000 − 5.000 − 20.000 +
    // 50.000) y net(16/10) = 115.000 (125.000 + 30.000 − 30.000 − 10.000). El
    // gasto del 17 NO puede entrar: si entrara en un solo lado (por ejemplo,
    // sólo en el ahorro), la reconciliación daría una falsa alarma.
    const al16 = await getMonthReconciliation(db, { currency: "ARS",
      month: "2026-10",
      anchor: "2026-10-16",
    });

    expect(al16).toEqual({
      month: "2026-10",
      netStart: "125000.00",
      netEnd: "115000.00",
      netDelta: "-10000.00",
      saving: "-10000.00",
      declaredIncome: "0.00",
      difference: "0.00",
      balanced: true,
      partial: true,
      cutAt: "2026-10-16",
    });

    // Y con el ancla a fin de mes —el mes cerró— el 17/10 entra en los DOS
    // lados: Δ y ahorro bajan juntos 10.000 + 999,99 y la identidad se mantiene.
    const al31 = await getMonthReconciliation(db, { currency: "ARS",
      month: "2026-10",
      anchor: "2026-10-31",
    });

    expect(al31.netDelta).toBe("-10999.99");
    expect(al31.saving).toBe("-10999.99");
    expect(al31.difference).toBe("0.00");
    expect(al31.balanced).toBe(true);
    expect(al31.partial).toBe(false);
    expect(al31.cutAt).toBe("2026-10-31");
  });

  it("un mes futuro con datos precargados reconcilia entre ellos", async () => {
    await seedScenario();

    // Un gasto cargado con fecha de noviembre, mirando noviembre desde octubre.
    const fecha = await db.category.findFirstOrThrow({
      where: { kind: "EXPENSE" },
    });
    const banco = await db.account.findFirstOrThrow({ where: { kind: "BANK" } });

    await db.movement.create({
      data: {
        kind: "EXPENSE",
        amount: "7000",
        date: calendarToDb("2026-11-03"),
        accountId: banco.id,
        categoryId: fecha.id,
      },
    });

    // El mes futuro se corta a su fin de mes (no "a hoy"): los precargados
    // entran en los dos caminos y el resultado es honesto — 0,00 de diferencia.
    const rec = await getMonthReconciliation(db, { currency: "ARS",
      month: "2026-11",
      anchor: "2026-10-31",
    });

    expect(rec.netStart).toBe("410000.00");
    expect(rec.netEnd).toBe("403000.00");
    expect(rec.netDelta).toBe("-7000.00");
    expect(rec.saving).toBe("-7000.00");
    expect(rec.difference).toBe("0.00");
    expect(rec.balanced).toBe(true);
    expect(rec.partial).toBe(false);
    expect(rec.cutAt).toBe("2026-11-30");
  });

  it("cuando los dos caminos no coinciden, la diferencia se muestra tal cual", async () => {
    await seedScenario();

    // ── CÓMO SE FUERZA LA FALLA ────────────────────────────────────────────
    // Con las restricciones de la base puestas, NINGUNA secuencia de escrituras
    // puede romper la identidad: es un teorema del modelo. La falla que este
    // control existe para atrapar es otra —una de las dos mitades contando
    // distinto— así que acá se simula exactamente eso: un cliente que infla el
    // INCOME del camino de los movimientos en $ 500,00. La mitad de los saldos
    // queda real; la de los movimientos, mentirosa. La diferencia tiene que
    // asomar con su signo exacto, y `balanced` tiene que decir que no.
    const inflado = db.$extends({
      query: {
        movement: {
          async groupBy({ args, query }) {
            const rows = await query(args);
            const byKind = Array.isArray(args.by)
              ? args.by.includes("kind")
              : args.by === "kind";
            if (!byKind) return rows;
            return rows.map((row) => {
              const amount = row._sum?.amount;
              if (row.kind !== "INCOME" || amount === null || amount === undefined) {
                return row;
              }
              return { ...row, _sum: { ...row._sum, amount: amount.plus("500") } };
            });
          },
        },
      },
    });

    const rec = await getMonthReconciliation(inflado as unknown as PrismaClient, { currency: "ARS",
      month: "2026-10",
      anchor: "2026-10-31",
    });

    // El camino saboteado devuelve 800.500 de ingresos → ahorro 310.500,00.
    expect(rec.saving).toBe("310500.00");
    // El camino de los saldos no se tocó.
    expect(rec.netDelta).toBe("310000.00");
    // Y la diferencia viaja TAL CUAL: −500,00, sin redondear a cero.
    expect(rec.difference).toBe("-500.00");
    expect(rec.balanced).toBe(false);
  });
});

/**
 * Los reportes de deuda: deuda viva, progreso del capital, interés pagado,
 * cuotas restantes y DTI.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ SE VERIFICA Y POR QUÉ CON ESTOS NÚMEROS
 * ─────────────────────────────────────────────────────────────────────────────
 * El escenario es el mismo de la reconciliación (`seedScenario`, §3.2 del
 * ROADMAP). Los números de estos tests se calculan A MANO sobre él:
 *
 *   · Deuda viva al 31/10:  Visa 50.000,00 (la compra con tarjeta del 12/10)
 *                           Préstamo 468.587,29 (500.000 − 31.412,71 de capital)
 *   · Cuota 1: 56.412,71 = 31.412,71 de capital + 25.000,00 de interés
 *   · Progreso: 31.412,71 / 500.000 = 6,28% → 11 cuotas restantes de 12
 *   · DTI: 56.412,71 / 800.000 = 7,05%
 *
 * Las dos definiciones que más fácil se romperían sin que nadie lo note:
 *
 *   · El interés pagado NO se estima con el calendario: es la suma del interés
 *     de las cuotas EFECTIVAMENTE cubiertas por el capital amortizado. Con el
 *     pago parcial del 20/10 (que deja 40.000,00) sigue cubierta UNA sola
 *     cuota: la próxima necesita 64.396,06 acumulados.
 *   · El DTI no divide por cero: un mes sin ingresos devuelve `percent: null`
 *     ("no se puede calcular"), no un 0% que afirmaría algo falso.
 */
describeDb("Reportes de deuda · progreso, interés y DTI", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
    await db.$disconnect();
  });

  it("octubre · deuda viva, progreso e interés al corte, y el DTI del mes", async () => {
    const { card, loan } = await seedScenario();

    const report = await getDebtReport(db, { currency: "ARS",
      month: "2026-10",
      anchor: "2026-10-31",
    });

    expect(report).toEqual({
      month: "2026-10",
      cutAt: "2026-10-31",
      partial: false,
      totalDebt: "518587.29",
      rows: [
        {
          accountId: card.id,
          name: "Visa",
          kind: "CREDIT_CARD",
          archived: false,
          debt: "50000.00",
          // Una tarjeta no tiene plan: no es un cero, es "no se sabe".
          plan: null,
          capitalPaid: null,
          interestPaid: null,
          progressPercent: null,
        },
        {
          accountId: loan.id,
          name: "Préstamo",
          kind: "LOAN",
          archived: false,
          debt: "468587.29",
          plan: {
            payment: "56412.71",
            principal: "500000.00",
            installmentCount: 12,
            paidCount: 1,
            remainingCount: 11,
          },
          capitalPaid: "31412.71",
          interestPaid: "25000.00",
          progressPercent: "6.28",
        },
      ],
      dti: {
        monthlyCommitment: "56412.71",
        income: "800000.00",
        percent: "7.05",
        planCount: 1,
      },
    });
  });

  it("un corte anterior a la cuota no cuenta ni capital ni compra", async () => {
    await seedScenario();

    // Al 10/10 la cuota es del 15 y la compra con tarjeta, del 12: las dos
    // quedan FUERA del corte. El corte del mes en curso es el ancla —la misma
    // convención que la reconciliación (`monthCut`)— y viaja marcado parcial.
    const al10 = await getDebtReport(db, { currency: "ARS",
      month: "2026-10",
      anchor: "2026-10-10",
    });

    expect(al10.cutAt).toBe("2026-10-10");
    expect(al10.partial).toBe(true);
    expect(al10.totalDebt).toBe("500000.00");

    const visa = al10.rows.find((row) => row.kind === "CREDIT_CARD");
    const prestamo = al10.rows.find((row) => row.kind === "LOAN");
    expect(visa?.debt).toBe("0.00");
    expect(prestamo?.debt).toBe("500000.00");
    expect(prestamo?.capitalPaid).toBe("0.00");
    expect(prestamo?.interestPaid).toBe("0.00");
    expect(prestamo?.plan?.paidCount).toBe(0);
    expect(prestamo?.plan?.remainingCount).toBe(12);
  });

  it("septiembre · la deuda es sólo el préstamo y el DTI sin ingreso es null", async () => {
    await seedScenario();

    // Al 30/09 sólo pasó el desembolso: el préstamo debe 500.000,00 y no hay
    // capital amortizado —ni, por lo tanto, interés pagado—. Septiembre no tuvo
    // ingresos: el DTI viaja como "no se puede calcular".
    const report = await getDebtReport(db, { currency: "ARS",
      month: "2026-09",
      anchor: "2026-10-31",
    });

    expect(report.cutAt).toBe("2026-09-30");
    expect(report.partial).toBe(false);
    expect(report.totalDebt).toBe("500000.00");
    expect(report.dti).toEqual({
      monthlyCommitment: "56412.71",
      income: "0.00",
      percent: null,
      planCount: 1,
    });

    const prestamo = report.rows.find((row) => row.kind === "LOAN");
    expect(prestamo?.debt).toBe("500000.00");
    expect(prestamo?.capitalPaid).toBe("0.00");
    expect(prestamo?.interestPaid).toBe("0.00");
    expect(prestamo?.progressPercent).toBe("0.00");
    expect(prestamo?.plan?.paidCount).toBe(0);
    expect(prestamo?.plan?.remainingCount).toBe(12);

    // La Visa, aunque deba 0, sigue apareciendo: el cero es un dato.
    const visa = report.rows.find((row) => row.kind === "CREDIT_CARD");
    expect(visa?.debt).toBe("0.00");
    expect(visa?.plan).toBeNull();
  });

  it("un pago parcial suma capital pero no cubre la cuota siguiente", async () => {
    const { bank, loan } = await seedScenario();

    // 31.412,71 (cuota 1) + 8.587,29 = 40.000,00 exactos. La cuota 2 se daría
    // por cubierta recién con 64.396,06 acumulados: el progreso se mide con la
    // PLATA amortizada, no con "pagó algo este mes".
    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "8587.29",
        date: calendarToDb("2026-10-20"),
        accountId: bank.id,
        toAccountId: loan.id,
        description: "Pago parcial del préstamo",
      },
    });

    const report = await getDebtReport(db, { currency: "ARS",
      month: "2026-10",
      anchor: "2026-10-31",
    });

    const prestamo = report.rows.find((row) => row.kind === "LOAN");
    expect(prestamo?.debt).toBe("460000.00");
    expect(prestamo?.capitalPaid).toBe("40000.00");
    expect(prestamo?.interestPaid).toBe("25000.00");
    expect(prestamo?.progressPercent).toBe("8.00");
    expect(prestamo?.plan?.paidCount).toBe(1);
    expect(prestamo?.plan?.remainingCount).toBe(11);
  });

  it("un plan terminado libera su cuota: el DTI queda en 0% y el progreso en 100", async () => {
    const { bank, loan } = await seedScenario();

    // Amortizar TODO lo que quedaba (468.587,29 al 20/10) lleva el capital
    // pagado a 500.000,00 exactos: las 12 cuotas quedan cubiertas, el interés
    // pagado es el total del plan y el préstamo ya no compromete cuota mensual.
    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "468587.29",
        date: calendarToDb("2026-10-20"),
        accountId: bank.id,
        toAccountId: loan.id,
        description: "Cancelación del préstamo",
      },
    });

    const report = await getDebtReport(db, { currency: "ARS",
      month: "2026-10",
      anchor: "2026-10-31",
    });

    const prestamo = report.rows.find((row) => row.kind === "LOAN");
    expect(prestamo?.debt).toBe("0.00");
    expect(prestamo?.capitalPaid).toBe("500000.00");
    expect(prestamo?.interestPaid).toBe("176952.44");
    expect(prestamo?.progressPercent).toBe("100.00");
    expect(prestamo?.plan?.paidCount).toBe(12);
    expect(prestamo?.plan?.remainingCount).toBe(0);

    // Sin cuotas pendientes no hay compromiso: 0,00 sobre un ingreso real es un
    // 0% verdadero (ya no es "no se puede calcular").
    expect(report.dti.monthlyCommitment).toBe("0.00");
    expect(report.dti.planCount).toBe(0);
    expect(report.dti.percent).toBe("0.00");
  });

  it("archivada con deuda se muestra marcada; archivada en cero se omite", async () => {
    const { card } = await seedScenario();

    // Una tarjeta vieja, archivada y sin movimientos (deuda 0): no dice nada y
    // no se muestra. La Visa, archivada pero con 50.000 vivos, es deuda real:
    // se muestra marcada, después del préstamo (las no archivadas van primero).
    await db.account.create({
      data: { name: "Vieja", kind: "CREDIT_CARD", archived: true },
    });
    await db.account.update({
      where: { id: card.id },
      data: { archived: true },
    });

    const report = await getDebtReport(db, { currency: "ARS",
      month: "2026-10",
      anchor: "2026-10-31",
    });

    expect(report.rows.map((row) => row.name)).toEqual(["Préstamo", "Visa"]);
    expect(report.rows.map((row) => row.archived)).toEqual([false, true]);
    expect(report.totalDebt).toBe("518587.29");
    // El plan del préstamo sigue sumando al DTI: archivarla no lo cancela.
    expect(report.dti.percent).toBe("7.05");
  });
});

describeDb("Burn mensualizado · el gasto anual en las dos vistas", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
    await db.$disconnect();
  });

  /**
   * El escenario del burn: enero 2027, con el gasto anual entero en un mes.
   *
   *     Sueldo               +600.000,00   (2027-01-01)
   *     Alquiler             −500.000,00   (2027-01-05)
   *     Expensas anuales     −240.000,00   (2027-01-20)   ← el gasto del burn
   *     Regalo de fin de año − 10.000,00   (2026-12-15)   ← OTRO período
   *
   * Los números a mano, para no repetir las fórmulas que se están probando:
   *
   *   Mes de caja:  600.000 − (500.000 + 240.000)               = −140.000,00
   *   Burn:         600.000 − (740.000 − 240.000 + 240.000/12)  = + 80.000,00
   *
   * Enero 2027 y no un mes de 2026 a propósito: todos los demás tests del
   * archivo viven en septiembre–octubre de 2026, así que el gasto anual acá no
   * pisa ningún número ya verificado a mano.
   */
  async function seedAnnualScenario() {
    const [sueldo, alquiler, expensas, regalos] = await Promise.all([
      db.category.create({
        data: { name: "Sueldo", normalizedName: "sueldo", kind: "INCOME" },
      }),
      db.category.create({
        data: { name: "Alquiler", normalizedName: "alquiler", kind: "EXPENSE" },
      }),
      db.category.create({
        data: { name: "Expensas", normalizedName: "expensas", kind: "EXPENSE" },
      }),
      db.category.create({
        data: { name: "Regalos", normalizedName: "regalos", kind: "EXPENSE" },
      }),
    ]);

    const bank = await db.account.create({
      data: { name: "Banco", kind: "BANK", openingBalance: "100000" },
    });

    const [sueldoEnero, alquilerEnero, expensasAnuales, regalo] =
      await Promise.all([
        db.movement.create({
          data: {
            kind: "INCOME",
            amount: "600000",
            date: calendarToDb("2027-01-01"),
            accountId: bank.id,
            categoryId: sueldo.id,
            description: "Sueldo de enero",
          },
        }),
        db.movement.create({
          data: {
            kind: "EXPENSE",
            amount: "500000",
            date: calendarToDb("2027-01-05"),
            accountId: bank.id,
            categoryId: alquiler.id,
            description: "Alquiler de enero",
          },
        }),
        db.movement.create({
          data: {
            kind: "EXPENSE",
            amount: "240000",
            date: calendarToDb("2027-01-20"),
            accountId: bank.id,
            categoryId: expensas.id,
            description: "Expensas anuales",
          },
        }),
        db.movement.create({
          data: {
            kind: "EXPENSE",
            amount: "10000",
            date: calendarToDb("2026-12-15"),
            accountId: bank.id,
            categoryId: regalos.id,
            description: "Regalo de fin de año",
          },
        }),
      ]);

    return {
      bank,
      categories: { sueldo, alquiler, expensas, regalos },
      sueldoEnero,
      alquilerEnero,
      expensasAnuales,
      regalo,
    };
  }

  it("los candidatos son los EXPENSE del período, de mayor a menor", async () => {
    const { sueldoEnero, regalo } = await seedAnnualScenario();

    const { candidates, truncated } = await movementBurnCandidates(db, {
      from: "2027-01-01",
      to: "2027-01-31",
    }, "ARS");

    // El sueldo no es candidato (no es un gasto) y el regalo tampoco (es de
    // otro período): la lista es del período Y de los EXPENSE, las dos cosas.
    expect(candidates.map((c) => c.amount)).toEqual(["500000.00", "240000.00"]);
    expect(candidates.map((c) => c.id)).not.toContain(sueldoEnero.id);
    expect(candidates.map((c) => c.id)).not.toContain(regalo.id);

    // La opción del selector se arma con estos campos: fecha, monto íntegro y
    // los dos textos posibles de etiqueta.
    expect(candidates[1]).toMatchObject({
      date: "2027-01-20",
      description: "Expensas anuales",
      categoryName: "Expensas",
    });

    expect(truncated).toBe(false);
  });

  it("el burn devuelve el mes de caja y el mismo mes repartido en 12", async () => {
    const { expensasAnuales } = await seedAnnualScenario();

    const burn = await movementBurn(db, {
      from: "2027-01-01",
      to: "2027-01-31",
      movementId: expensasAnuales.id,
    }, "ARS");

    expect(burn).toMatchObject({
      movementId: expensasAnuales.id,
      date: "2027-01-20",
      amount: "240000.00",
      // 240.000 / 12 = 20.000, exacto.
      monthlyShare: "20000.00",
      income: "600000.00",
      expenses: "740000.00",
      // 740.000 − 240.000 + 20.000
      burnExpenses: "520000.00",
      // 600.000 − 740.000: el mes de caja, en rojo...
      cashResult: "-140000.00",
      // ...y 600.000 − 520.000: el mismo mes, previsible.
      burnResult: "80000.00",
    });
  });

  it("un id que no es un gasto del período no inventa una vista", async () => {
    const { sueldoEnero, regalo } = await seedAnnualScenario();
    const period = { from: "2027-01-01", to: "2027-01-31" };

    // No existe.
    expect(
      await movementBurn(db, { ...period, movementId: "no-existe" }, "ARS"),
    ).toBeNull();
    // Existe, pero es un ingreso: no hay gasto que repartir.
    expect(
      await movementBurn(db, { ...period, movementId: sueldoEnero.id }, "ARS"),
    ).toBeNull();
    // Existe y es un gasto, pero de OTRO período.
    expect(await movementBurn(db, { ...period, movementId: regalo.id }, "ARS")).toBeNull();

    // El mismo regalo SÍ tiene burn en su propio período: el `null` de arriba
    // es el período, no el gasto.
    const diciembre = await movementBurn(db, {
      from: "2026-12-01",
      to: "2026-12-31",
      movementId: regalo.id,
    }, "ARS");
    expect(diciembre?.monthlyShare).toBe("833.33"); // 10.000 / 12
  });

  it("el tope de la lista se avisa, pero el burn calcula sobre el período completo", async () => {
    const { bank, categories, expensasAnuales } = await seedAnnualScenario();

    // 500 gastos de 100 cruzan el tope de la lista con los tres movimientos del
    // escenario (502 EXPENSE en el período).
    await db.movement.createMany({
      data: Array.from({ length: MOVEMENTS_MAX_ROWS }, () => ({
        kind: "EXPENSE" as const,
        amount: "100.00",
        date: calendarToDb("2027-01-10"),
        accountId: bank.id,
        categoryId: categories.alquiler.id,
      })),
    });

    const { candidates, truncated } = await movementBurnCandidates(db, {
      from: "2027-01-01",
      to: "2027-01-31",
    }, "ARS");

    // La lista se corta y LO DICE: una lista incompleta que se ve completa es
    // la clase de mentira que el tope existe para no repetir.
    expect(truncated).toBe(true);
    expect(candidates).toHaveLength(MOVEMENTS_MAX_ROWS);
    // Los dos gastos grandes quedaron primero (y el más chico de todos afuera).
    expect(candidates[0]?.amount).toBe("500000.00");
    expect(candidates[1]?.amount).toBe("240000.00");

    const burn = await movementBurn(db, {
      from: "2027-01-01",
      to: "2027-01-31",
      movementId: expensasAnuales.id,
    }, "ARS");

    // El cálculo mira los 502 gastos aunque la lista haya cortado en 500:
    // 500 × 100 + 500.000 + 240.000 = 790.000, y con el burn 570.000. Si el
    // cálculo usara la lista, los dos gastos descartados desaparecerían del
    // resultado y el número no sería de ningún mes real.
    expect(burn?.expenses).toBe("790000.00");
    expect(burn?.burnExpenses).toBe("570000.00");
    expect(burn?.burnResult).toBe("30000.00");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * RECURRENCIA · FASE 3
 * ═══════════════════════════════════════════════════════════════════════════ */

describeDb("Recurrencia · el generador \"desde la última vez\"", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
    await db.$disconnect();
  });

  /**
   * El "hoy" fijo de todos los tests de recurrencia.
   *
   * El generador recibe `today` como parámetro a propósito (ver
   * `lib/recurrence.ts`): así estos tests prueban cualquier cumpleaños de mes,
   * incluido el 31, sin depender del día en que se corran.
   */
  const TODAY = "2026-10-17";

  /** La cuenta de banco y las dos categorías de siempre. */
  async function seedBase() {
    const { gastos, sueldo } = await seedCategories();
    const bank = await db.account.create({
      data: { name: "Banco", kind: "BANK", openingBalance: "100000" },
    });
    return { bank, gastos, sueldo };
  }

  it("materializa desde startDate hasta hoy, exactamente una vez", async () => {
    const { bank, gastos } = await seedBase();

    const rule = await db.recurrenceRule.create({
      data: {
        title: "Café diario",
        kind: "EXPENSE",
        amount: "1500",
        accountId: bank.id,
        categoryId: gastos.id,
        freq: "DAILY",
        startDate: calendarToDb(addDays(TODAY, -5)),
        postingMode: "NOTIFY",
      },
    });

    const first = await runDueOccurrences(db, { today: TODAY });

    // Cinco días atrás + hoy: el día de hoy ENTRA (vencida es `<= today`).
    expect(first.materialized).toBe(6);
    expect(first.posted).toBe(0);
    expect(first.pending).toBe(6);
    expect(first.capped).toBe(false);
    expect(first.rules).toEqual([
      { ruleId: rule.id, title: "Café diario", materialized: 6, posted: 0, pending: 6 },
    ]);

    // Segunda corrida: no hay nada nuevo, y no duplica lo anterior.
    const second = await runDueOccurrences(db, { today: TODAY });
    expect(second.materialized).toBe(0);
    expect(await db.recurrenceOccurrence.count({ where: { ruleId: rule.id } })).toBe(6);

    const dates = await db.recurrenceOccurrence.findMany({
      where: { ruleId: rule.id },
      orderBy: { dueDate: "asc" },
      select: { dueDate: true },
    });
    expect(dates.map((row) => row.dueDate.toISOString().slice(0, 10))).toEqual([
      addDays(TODAY, -5),
      addDays(TODAY, -4),
      addDays(TODAY, -3),
      addDays(TODAY, -2),
      addDays(TODAY, -1),
      TODAY,
    ]);
  });

  it("AUTO postea al vuelo, con la fecha de la OCURRENCIA y no la de la corrida", async () => {
    const { bank, gastos } = await seedBase();

    // Se corrió tarde a propósito: hoy es 17/10 y las ocurrencias son de
    // agosto, septiembre y octubre. Ponerse al día no puede fechar todo hoy.
    const rule = await db.recurrenceRule.create({
      data: {
        title: "Alquiler",
        kind: "EXPENSE",
        amount: "5000",
        accountId: bank.id,
        categoryId: gastos.id,
        freq: "MONTHLY",
        dayOfMonth: 1,
        startDate: calendarToDb("2026-08-01"),
        postingMode: "AUTO",
      },
    });

    const run = await runDueOccurrences(db, { today: TODAY });
    expect(run.materialized).toBe(3);
    expect(run.posted).toBe(3);
    expect(run.pending).toBe(0);

    const movements = await db.movement.findMany({
      orderBy: { date: "asc" },
      select: { date: true, amount: true, recurrenceRuleId: true },
    });
    expect(movements.map((m) => m.date.toISOString().slice(0, 10))).toEqual([
      "2026-08-01",
      "2026-09-01",
      "2026-10-01",
    ]);
    expect(movements.every((m) => m.recurrenceRuleId === rule.id)).toBe(true);

    // Y la plata posteada SÍ entra en los números reales.
    const totals = await movementTotals(db, {}, "ARS");
    expect(totals.expenses).toBe("15000.00");
    expect(totals.expenseCount).toBe(3);
  });

  it("una pendiente no toca ningún número hasta que se acepta (criterio 4)", async () => {
    const { bank, gastos } = await seedBase();

    await db.recurrenceRule.create({
      data: {
        title: "Internet",
        kind: "EXPENSE",
        amount: "1000",
        accountId: bank.id,
        categoryId: gastos.id,
        freq: "MONTHLY",
        dayOfMonth: 20,
        startDate: calendarToDb("2026-08-20"),
        postingMode: "NOTIFY",
      },
    });

    const run = await runDueOccurrences(db, { today: TODAY });
    expect(run.materialized).toBe(2); // 20/08 y 20/09; el 20/10 todavía no venció

    // La bandeja las ve...
    const overview = await getRecurrenceOverview(db, { today: TODAY });
    expect(overview.pending.map((p) => p.dueDate)).toEqual(["2026-08-20", "2026-09-20"]);

    // ...pero NINGÚN total las cuenta: una ocurrencia no es un movimiento.
    expect((await movementTotals(db, {}, "ARS")).expenses).toBe("0.00");
    const balances = await getAccountBalances(db, {});
    expect(balances[0]?.balance.toFixed(2)).toBe("100000.00");

    // Aceptar la primera SÍ mueve la plata...
    const accepted = await acceptOccurrence(db, overview.pending[0].id);
    expect(accepted.created).toBe(true);
    expect((await movementTotals(db, {}, "ARS")).expenses).toBe("1000.00");

    // ...y la segunda sigue sin mover nada hasta su propio "aceptar".
    expect((await movementTotals(db, {}, "ARS")).expenseCount).toBe(1);
  });

  it("una regla con startDate futuro no materializa nada", async () => {
    const { bank, gastos } = await seedBase();
    const future = addDays(TODAY, 5);

    await db.recurrenceRule.create({
      data: {
        title: "Gimnasio",
        kind: "EXPENSE",
        amount: "900",
        accountId: bank.id,
        categoryId: gastos.id,
        freq: "MONTHLY",
        startDate: calendarToDb(future),
        postingMode: "AUTO",
      },
    });

    const run = await runDueOccurrences(db, { today: TODAY });
    expect(run.materialized).toBe(0);
    expect(await db.movement.count()).toBe(0);
    expect(await db.recurrenceOccurrence.count()).toBe(0);

    // Se VE en la proyección de la regla, que es la vista correcta para algo
    // que todavía no pasó.
    const overview = await getRecurrenceOverview(db, { today: TODAY });
    expect(overview.rules[0]?.upcoming[0]).toBe(future);
  });

  it("aceptar es idempotente: el doble clic devuelve el mismo movimiento", async () => {
    const { bank, gastos } = await seedBase();

    await db.recurrenceRule.create({
      data: {
        title: "Luz",
        kind: "EXPENSE",
        amount: "3000",
        accountId: bank.id,
        categoryId: gastos.id,
        freq: "MONTHLY",
        startDate: calendarToDb(TODAY),
        postingMode: "NOTIFY",
      },
    });
    await runDueOccurrences(db, { today: TODAY });

    const pending = (await getRecurrenceOverview(db, { today: TODAY })).pending[0];
    const first = await acceptOccurrence(db, pending.id);
    const second = await acceptOccurrence(db, pending.id);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.occurrence.movementId).toBe(first.occurrence.movementId);
    expect(await db.movement.count()).toBe(1);
  });

  it("dos \"aceptar\" simultáneos: uno solo crea el movimiento", async () => {
    const { bank, gastos } = await seedBase();

    await db.recurrenceRule.create({
      data: {
        title: "Agua",
        kind: "EXPENSE",
        amount: "2000",
        accountId: bank.id,
        categoryId: gastos.id,
        freq: "MONTHLY",
        startDate: calendarToDb(TODAY),
        postingMode: "NOTIFY",
      },
    });
    await runDueOccurrences(db, { today: TODAY });
    const pending = (await getRecurrenceOverview(db, { today: TODAY })).pending[0];

    const [a, b] = await Promise.all([
      acceptOccurrence(db, pending.id),
      acceptOccurrence(db, pending.id),
    ]);

    // Exactamente uno creó el movimiento; el otro devolvió ESE movimiento.
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(a.occurrence.movementId).toBe(b.occurrence.movementId);
    expect(await db.movement.count()).toBe(1);
  });

  it("el doble posteo también es imposible en la base", async () => {
    const { bank, gastos } = await seedBase();

    const rule = await db.recurrenceRule.create({
      data: {
        title: "Seguro",
        kind: "EXPENSE",
        amount: "700",
        accountId: bank.id,
        categoryId: gastos.id,
        freq: "MONTHLY",
        startDate: calendarToDb(TODAY),
        postingMode: "NOTIFY",
      },
    });
    await runDueOccurrences(db, { today: TODAY });
    const pending = (await getRecurrenceOverview(db, { today: TODAY })).pending[0];
    await acceptOccurrence(db, pending.id);

    // Dos ocurrencias de la misma regla en la misma fecha: no.
    await expect(
      db.recurrenceOccurrence.create({
        data: { ruleId: rule.id, dueDate: calendarToDb(TODAY) },
      }),
    ).rejects.toThrow();

    // Dos movimientos de la misma regla en la misma fecha: tampoco. Éste es el
    // índice parcial `Movement_recurrence_rule_date_key`, la defensa final.
    await expect(
      db.movement.create({
        data: {
          kind: "EXPENSE",
          amount: "700",
          date: calendarToDb(TODAY),
          accountId: bank.id,
          categoryId: gastos.id,
          recurrenceRuleId: rule.id,
        },
      }),
    ).rejects.toThrow();

    // Un movimiento manual de la MISMA fecha sigue permitido: el índice es
    // parcial justamente para no meterse con la vida manual.
    await db.movement.create({
      data: {
        kind: "EXPENSE",
        amount: "100",
        date: calendarToDb(TODAY),
        accountId: bank.id,
        categoryId: gastos.id,
      },
    });
  });

  it("saltar deja la marca: el pasado no se reescribe solo", async () => {
    const { bank, gastos } = await seedBase();

    const rule = await db.recurrenceRule.create({
      data: {
        title: "Diario",
        kind: "EXPENSE",
        amount: "500",
        accountId: bank.id,
        categoryId: gastos.id,
        freq: "DAILY",
        startDate: calendarToDb(addDays(TODAY, -2)),
        postingMode: "NOTIFY",
      },
    });

    // Primera corrida: sólo la ocurrencia vencida de hace dos días.
    const run1 = await runDueOccurrences(db, { today: addDays(TODAY, -2) });
    expect(run1.materialized).toBe(1);
    const first = (await getRecurrenceOverview(db, { today: TODAY })).pending[0];
    await skipOccurrence(db, first.id);

    // Segunda corrida: materializa las dos fechas nuevas y NI TOCA la saltada.
    const run2 = await runDueOccurrences(db, { today: TODAY });
    expect(run2.materialized).toBe(2);

    const occurrences = await db.recurrenceOccurrence.findMany({
      where: { ruleId: rule.id },
      orderBy: { dueDate: "asc" },
      select: { dueDate: true, status: true },
    });
    expect(occurrences).toHaveLength(3);
    expect(occurrences.map((o) => [o.dueDate.toISOString().slice(0, 10), o.status])).toEqual([
      [addDays(TODAY, -2), "SKIPPED"],
      [addDays(TODAY, -1), "PENDING"],
      [TODAY, "PENDING"],
    ]);

    // Saltar de nuevo es idempotente; postear primero y saltar después es 409.
    const skippedAgain = await skipOccurrence(db, first.id);
    expect(skippedAgain.status).toBe("SKIPPED");

    const stillPending = (await getRecurrenceOverview(db, { today: TODAY })).pending;
    const posted = await acceptOccurrence(db, stillPending[0].id);
    await expect(skipOccurrence(db, posted.occurrence.id)).rejects.toThrow(
      /posteada/,
    );
  });

  it("editar la regla no toca lo posteado y rige desde la última materializada", async () => {
    const { bank, gastos } = await seedBase();

    const rule = await db.recurrenceRule.create({
      data: {
        title: "Alquiler",
        kind: "EXPENSE",
        amount: "1000",
        accountId: bank.id,
        categoryId: gastos.id,
        freq: "MONTHLY",
        dayOfMonth: 1,
        startDate: calendarToDb("2026-08-01"),
        postingMode: "AUTO",
      },
    });

    await runDueOccurrences(db, { today: TODAY });
    expect(await db.movement.count()).toBe(3);

    // La edición cambia monto y fecha de inicio (retrocederla sería un intento
    // de "agregar meses": el generador NO debe rellenar el pasado).
    await db.recurrenceRule.update({
      where: { id: rule.id },
      data: { amount: "2500", startDate: calendarToDb("2026-01-01") },
    });

    const laterRun = await runDueOccurrences(db, { today: "2026-11-17" });
    expect(laterRun.materialized).toBe(1); // sólo 01/11, la próxima después de 01/10
    expect(laterRun.posted).toBe(1);

    const movements = await db.movement.findMany({
      orderBy: { date: "asc" },
      select: { date: true, amount: true },
    });
    expect(movements.map((m) => [m.date.toISOString().slice(0, 10), m.amount.toFixed(2)])).toEqual([
      // Lo ya posteado quedó congelado con su monto original...
      ["2026-08-01", "1000.00"],
      ["2026-09-01", "1000.00"],
      ["2026-10-01", "1000.00"],
      // ...y lo nuevo sale con el monto vigente.
      ["2026-11-01", "2500.00"],
    ]);
    expect(await db.recurrenceOccurrence.count({ where: { ruleId: rule.id } })).toBe(4);
  });

  it("count y endDate cortan el calendario", async () => {
    const { bank, gastos } = await seedBase();

    await db.recurrenceRule.create({
      data: {
        title: "Tres días",
        kind: "EXPENSE",
        amount: "100",
        accountId: bank.id,
        categoryId: gastos.id,
        freq: "DAILY",
        startDate: calendarToDb(addDays(TODAY, -5)),
        count: 3,
        postingMode: "NOTIFY",
      },
    });
    await db.recurrenceRule.create({
      data: {
        title: "Hasta el martes",
        kind: "EXPENSE",
        amount: "200",
        accountId: bank.id,
        categoryId: gastos.id,
        freq: "DAILY",
        startDate: calendarToDb(addDays(TODAY, -5)),
        endDate: calendarToDb(addDays(TODAY, -3)),
        postingMode: "NOTIFY",
      },
    });

    const run = await runDueOccurrences(db, { today: TODAY });
    // Tres por count + tres por endDate. Nada más, y nada menos.
    expect(run.materialized).toBe(6);

    const second = await runDueOccurrences(db, { today: TODAY });
    expect(second.materialized).toBe(0);
  });

  it("el tope por corrida se avisa (capped) y la corrida siguiente sigue", async () => {
    const { bank, gastos } = await seedBase();

    // 601 días vencidos: más que el tope de una corrida.
    await db.recurrenceRule.create({
      data: {
        title: "Diario viejo",
        kind: "EXPENSE",
        amount: "10",
        accountId: bank.id,
        categoryId: gastos.id,
        freq: "DAILY",
        startDate: calendarToDb(addDays(TODAY, -600)),
        postingMode: "NOTIFY",
      },
    });

    const first = await runDueOccurrences(db, { today: TODAY });
    expect(first.materialized).toBe(RECURRENCE_RUN_MAX_PER_RULE);
    expect(first.capped).toBe(true);

    // La segunda corrida termina el trabajo: 601 − 500 = 101, sin duplicar
    // ninguna de las 500 anteriores.
    const second = await runDueOccurrences(db, { today: TODAY });
    expect(second.materialized).toBe(101);
    expect(second.capped).toBe(false);
    expect(await db.recurrenceOccurrence.count()).toBe(601);
  }, 60_000);

  it("pausar y archivar detienen la generación", async () => {
    const { bank, gastos } = await seedBase();

    await db.recurrenceRule.create({
      data: {
        title: "Pausada",
        kind: "EXPENSE",
        amount: "100",
        accountId: bank.id,
        categoryId: gastos.id,
        freq: "DAILY",
        startDate: calendarToDb(TODAY),
        status: "PAUSED",
      },
    });
    await db.recurrenceRule.create({
      data: {
        title: "Archivada",
        kind: "EXPENSE",
        amount: "100",
        accountId: bank.id,
        categoryId: gastos.id,
        freq: "DAILY",
        startDate: calendarToDb(TODAY),
        status: "ARCHIVED",
      },
    });

    const run = await runDueOccurrences(db, { today: TODAY });
    expect(run.materialized).toBe(0);

    // Y la vista de reglas no lista las archivadas (sí las pausadas: se pueden
    // reactivar).
    const overview = await getRecurrenceOverview(db, { today: TODAY });
    expect(overview.rules.map((r) => r.title)).toEqual(["Pausada"]);
  });

  it("una regla con la categoría del OTRO tipo no postea y dice por qué", async () => {
    // El generador cruzaba `rule.kind` con `rule.categoryId` sin cruzarlos
    // entre sí: una regla de Ingreso con una categoría de Gasto posteaba un
    // movimiento imposible. Ahora la regla NO postea, sus ocurrencias quedan en
    // la bandeja y la corrida dice qué hay que arreglar.
    const { bank, gastos } = await seedBase();

    // El trigger de la base no deja crear la regla imposible: para reproducir
    // el caso se apaga UN MOMENTO (así se ven las filas que ya existían antes
    // del trigger).
    await db.$executeRawUnsafe(
      `ALTER TABLE "RecurrenceRule" DISABLE TRIGGER "recurrence_category_kind_check"`,
    );
    let rule: { id: string };
    try {
      rule = await db.recurrenceRule.create({
        data: {
          title: "Alquiler",
          kind: "INCOME",
          amount: "325000",
          accountId: bank.id,
          categoryId: gastos.id, // `gastos` es de tipo EXPENSE
          freq: "MONTHLY",
          startDate: calendarToDb(TODAY),
          postingMode: "AUTO",
        },
      });
    } finally {
      await db.$executeRawUnsafe(
        `ALTER TABLE "RecurrenceRule" ENABLE TRIGGER "recurrence_category_kind_check"`,
      );
    }

    const run = await runDueOccurrences(db, { today: TODAY });

    // No posteó NADA y lo dijo.
    expect(run.posted).toBe(0);
    expect(run.blocked).toHaveLength(1);
    expect(run.blocked[0].title).toBe("Alquiler");
    expect(run.blocked[0].reason).toContain("Gasto");
    expect(run.blocked[0].reason).toContain("Ingreso");

    // Y no existe ningún movimiento imposible.
    expect(await db.movement.count()).toBe(0);

    // La ocurrencia quedó en la bandeja (espera decisión, no es plata).
    const overview = await getRecurrenceOverview(db, { today: TODAY });
    expect(overview.pending).toHaveLength(1);

    // Aceptarla a mano tampoco postea un movimiento imposible: el 409 explica
    // por qué.
    await expect(acceptOccurrence(db, overview.pending[0].id)).rejects.toThrow(
      /no puede postear/i,
    );
    expect(await db.movement.count()).toBe(0);
  });

  it("borrar un movimiento posteado reabre su ocurrencia en la bandeja", async () => {
    const { bank, gastos } = await seedBase();

    const rule = await db.recurrenceRule.create({
      data: {
        title: "Suscripción",
        kind: "EXPENSE",
        amount: "800",
        accountId: bank.id,
        categoryId: gastos.id,
        freq: "MONTHLY",
        startDate: calendarToDb(TODAY),
        postingMode: "AUTO",
      },
    });

    await runDueOccurrences(db, { today: TODAY });
    const movement = await db.movement.findFirstOrThrow();
    expect((await movementTotals(db, {}, "ARS")).expenses).toBe("800.00");

    // Borrar el movimiento reabre la ocurrencia en la MISMA transacción.
    await deleteMovement(db, movement.id);
    expect(await db.movement.count()).toBe(0);
    const reopened = await db.recurrenceOccurrence.findFirstOrThrow({
      where: { ruleId: rule.id },
    });
    expect(reopened.status).toBe("PENDING");
    expect(reopened.movementId).toBeNull();
    expect((await movementTotals(db, {}, "ARS")).expenses).toBe("0.00");

    // El generador NO la recrea: la fecha ya está materializada. Y una regla
    // AUTO tampoco la re-postea sola: la ocurrencia reabierta espera en la
    // bandeja (borrar un movimiento es un acto explícito, no se deshace en la
    // próxima recarga).
    const reRun = await runDueOccurrences(db, { today: TODAY });
    expect(reRun.materialized).toBe(0);
    expect(reRun.posted).toBe(0);
    const inInbox = await getRecurrenceOverview(db, { today: TODAY });
    expect(inInbox.pending.map((p) => p.id)).toEqual([reopened.id]);

    // Aceptarla a mano la vuelve a postear: la plata que había borrado vuelve
    // porque la persona lo pidió.
    const accepted = await acceptOccurrence(db, reopened.id);
    expect(accepted.created).toBe(true);
    expect((await movementTotals(db, {}, "ARS")).expenses).toBe("800.00");

    // Un id inexistente da el error de dominio de "no existe".
    await expect(deleteMovement(db, "no-existe")).rejects.toThrow(/no existe/);
  });

  it("la vista de recurrencia: bandeja ordenada y proyección después de hoy", async () => {
    const { bank, gastos } = await seedBase();

    await db.recurrenceRule.create({
      data: {
        title: "Mensual",
        kind: "EXPENSE",
        amount: "100",
        accountId: bank.id,
        categoryId: gastos.id,
        freq: "MONTHLY",
        startDate: calendarToDb("2026-10-12"),
        postingMode: "NOTIFY",
      },
    });

    await runDueOccurrences(db, { today: TODAY });

    const overview = await getRecurrenceOverview(db, { today: TODAY });

    // Una pendiente (la del 12/10) y la proyección arranca después de hoy: la
    // fecha que ya está en la bandeja no se duplica en "lo que viene".
    expect(overview.pending.map((p) => p.dueDate)).toEqual(["2026-10-12"]);
    expect(overview.pending[0]).toMatchObject({
      title: "Mensual",
      kind: "EXPENSE",
      amount: "100.00",
      account: { name: "Banco" },
      category: { name: "Gastos" },
    });
    expect(overview.rules[0]?.upcoming).toEqual([
      "2026-11-12",
      "2026-12-12",
      "2027-01-12",
      "2027-02-12",
      "2027-03-12",
    ]);
    expect(overview.truncated).toBe(false);
  });

  it("la base no deja que una regla quede sin categoría (borrar la categoría se rechaza)", async () => {
    const { bank, gastos } = await seedBase();

    await db.recurrenceRule.create({
      data: {
        title: "Ex categoría",
        kind: "EXPENSE",
        amount: "400",
        accountId: bank.id,
        categoryId: gastos.id,
        freq: "MONTHLY",
        startDate: calendarToDb(TODAY),
        postingMode: "AUTO",
      },
    });

    // ── El hallazgo que este test documenta ──────────────────────────────────
    // El FK de `RecurrenceRule.categoryId` es `SetNull`, así que borrar la
    // categoría intentaría dejar la regla sin categoría... y la fila resultante
    // viola `recurrence_shape_by_kind` (un EXPENSE sin categoría no es una
    // forma válida). El borrado queda RECHAZADO por la base.
    //
    // Es mejor de lo que cualquier defensa en código podría hacer: el estado
    // "regla a medio armar" no llega a existir nunca. La guarda `blocked` de la
    // corrida (AUTO sin categoría → se encola) queda como defensa en
    // profundidad para una base ya corrupta, no como camino alcanzable.
    await expect(
      db.category.delete({ where: { id: gastos.id } }),
    ).rejects.toThrow(/recurrence_shape_by_kind/);

    // La regla sigue intacta y postea normalmente.
    const run = await runDueOccurrences(db, { today: TODAY });
    expect(run.posted).toBe(1);
    expect(run.blocked).toHaveLength(0);
    expect((await movementTotals(db, {}, "ARS")).expenses).toBe("400.00");
  });

  it("rechaza una regla con monto cero", async () => {
    const { bank, gastos } = await seedBase();

    await expect(
      db.recurrenceRule.create({
        data: {
          title: "Cero",
          kind: "EXPENSE",
          amount: "0",
          accountId: bank.id,
          categoryId: gastos.id,
          freq: "MONTHLY",
          startDate: calendarToDb(TODAY),
        },
      }),
    ).rejects.toThrow(/recurrence_amount_positive/);
  });

  it("rechaza una regla cuya forma no corresponde a su tipo", async () => {
    const { bank, gastos } = await seedBase();

    // TRANSFER sin destino.
    await expect(
      db.recurrenceRule.create({
        data: {
          title: "Sin destino",
          kind: "TRANSFER",
          amount: "100",
          accountId: bank.id,
          freq: "MONTHLY",
          startDate: calendarToDb(TODAY),
        },
      }),
    ).rejects.toThrow(/recurrence_shape_by_kind/);

    // EXPENSE CON cuenta de destino (y con categoría: la forma la define el tipo).
    await expect(
      db.recurrenceRule.create({
        data: {
          title: "Gasto con destino",
          kind: "EXPENSE",
          amount: "100",
          accountId: bank.id,
          toAccountId: bank.id,
          categoryId: gastos.id,
          freq: "MONTHLY",
          startDate: calendarToDb(TODAY),
        },
      }),
    ).rejects.toThrow(/recurrence_shape_by_kind|recurrence_transfer_to_other_account/);
  });

  it("rechaza dayOfMonth fuera de lugar y endDate anterior al inicio", async () => {
    const { bank, gastos } = await seedBase();

    // El ancla del día del mes no existe en una regla diaria.
    await expect(
      db.recurrenceRule.create({
        data: {
          title: "Diaria con ancla",
          kind: "EXPENSE",
          amount: "100",
          accountId: bank.id,
          categoryId: gastos.id,
          freq: "DAILY",
          dayOfMonth: 15,
          startDate: calendarToDb(TODAY),
        },
      }),
    ).rejects.toThrow(/recurrence_dayofmonth_range/);

    // Una regla que termina antes de empezar no tiene ninguna ocurrencia.
    await expect(
      db.recurrenceRule.create({
        data: {
          title: "Al revés",
          kind: "EXPENSE",
          amount: "100",
          accountId: bank.id,
          categoryId: gastos.id,
          freq: "MONTHLY",
          startDate: calendarToDb(TODAY),
          endDate: calendarToDb(addDays(TODAY, -1)),
        },
      }),
    ).rejects.toThrow(/recurrence_end_after_start/);
  });

  it("una regla de ingreso hacia un pasivo tampoco existe (trigger)", async () => {
    const loan = await db.account.create({
      data: {
        name: "Préstamo",
        kind: "LOAN",
        currency: "ARS",
        principal: "500000",
        tnaPercent: "60",
        installmentCount: 12,
      },
    });
    const sueldo = await db.category.create({
      data: { name: "Sueldo", normalizedName: "sueldo", kind: "INCOME" },
    });

    await expect(
      db.recurrenceRule.create({
        data: {
          title: "Sueldo al préstamo",
          kind: "INCOME",
          amount: "100",
          accountId: loan.id,
          categoryId: sueldo.id,
          freq: "MONTHLY",
          startDate: calendarToDb(TODAY),
        },
      }),
    ).rejects.toThrow(/pasivo_no_recibe_ingreso/);
  });

  it("rechaza una ocurrencia POSTED sin movimiento", async () => {
    const { bank, gastos } = await seedBase();

    const rule = await db.recurrenceRule.create({
      data: {
        title: "Regla",
        kind: "EXPENSE",
        amount: "100",
        accountId: bank.id,
        categoryId: gastos.id,
        freq: "MONTHLY",
        startDate: calendarToDb(TODAY),
      },
    });

    // "Posteada" sin el movimiento que la cumple es una afirmación de plata que
    // no existe: el CHECK la rechaza.
    await expect(
      db.recurrenceOccurrence.create({
        data: {
          ruleId: rule.id,
          dueDate: calendarToDb(TODAY),
          status: "POSTED",
          postedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/occurrence_shape_by_status/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * TARJETAS DE CRÉDITO Y CUOTAS · FASE 5
 * ═══════════════════════════════════════════════════════════════════════════ */

describeDb("Tarjetas · compras en cuotas, resúmenes y pago", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
    await db.$disconnect();
  });

  /**
   * El "hoy" FIJO de todos los tests de tarjetas. Igual que en recurrencia: las
   * reglas de fechas reciben `today` como parámetro, así que acá se puede fijar
   * el 17 de octubre de 2026 y probar bordes (cierre el 25, compras en el cierre,
   * cruce de año) sin depender del día en que se corra la suite.
   */
  const TODAY = "2026-10-17";

  /** Banco con plata y una tarjeta con cierre 25 y vencimiento 5. */
  async function seedBase(options: { closingDay?: number | null; dueDay?: number | null; creditLimit?: string } = {}) {
    const { gastos } = await seedCategories();

    const bank = await db.account.create({
      data: { name: "Banco", kind: "BANK", openingBalance: "100000" },
    });

    const card = await db.account.create({
      data: {
        name: "Visa",
        kind: "CREDIT_CARD",
        closingDay: options.closingDay === undefined ? 25 : options.closingDay,
        dueDay: options.dueDay === undefined ? 5 : options.dueDay,
        creditLimit: options.creditLimit ?? "600000",
      },
    });

    return { bank, card, gastos };
  }

  it("una compra en 12 cuotas es UN gasto por el total y 12 cuotas asignadas", async () => {
    const { card } = await seedBase();

    const plan = await createCardPlan(
      db,
      {
        cardId: card.id,
        label: "Heladera",
        totalAmount: "120000",
        installments: 12,
        purchaseDate: "2026-10-17",
        categoryName: "Hogar",
      },
      { today: TODAY },
    );

    // UN solo gasto, por el TOTAL, a la fecha de compra. La deuda de la tarjeta
    // nace completa: el gasto no se reparte.
    expect(await db.movement.count()).toBe(1);
    expect(plan.movement.kind).toBe("EXPENSE");
    expect(plan.movement.amount).toBe("120000.00");
    expect(plan.movement.date).toBe("2026-10-17");

    // Las cuotas suman EXACTO el total y están numeradas.
    expect(plan.items).toHaveLength(12);
    expect(plan.items.map((item) => item.number)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(
      plan.items.reduce((total, item) => total.plus(item.amount), money("0")).toFixed(2),
    ).toBe("120000.00");

    // La primera cuota cae en el resumen que cierra en octubre; la 12.ª, un año
    // después (septiembre de 2027).
    expect(plan.items[0]).toMatchObject({ periodYear: 2026, periodMonth: 10 });
    expect(plan.items[11]).toMatchObject({ periodYear: 2027, periodMonth: 9 });

    // El saldo de la tarjeta ES la deuda: 120.000 en negativo.
    const balances = await getAccountBalances(db);
    const cardBalance = balances.find((balance) => balance.id === card.id);
    expect(cardBalance?.debt?.toFixed(2)).toBe("120000.00");

    // Y el plan sabe cuántas cuotas ya se facturaron: ninguna (octubre no cerró).
    expect(plan.billedInstallments).toBe(0);
  });

  it("una compra EN el día de cierre entra en ese resumen (criterio 4)", async () => {
    const { card } = await seedBase();

    const enElCierre = await createCardPlan(
      db,
      {
        cardId: card.id,
        label: "En el cierre",
        totalAmount: "10000",
        installments: 1,
        purchaseDate: "2026-10-25",
        categoryName: "Hogar",
      },
      { today: TODAY },
    );
    expect(enElCierre.items[0]).toMatchObject({ periodYear: 2026, periodMonth: 10 });

    const despuesDelCierre = await createCardPlan(
      db,
      {
        cardId: card.id,
        label: "Un día después",
        totalAmount: "10000",
        installments: 1,
        purchaseDate: "2026-10-26",
        categoryName: "Hogar",
      },
      { today: TODAY },
    );
    expect(despuesDelCierre.items[0]).toMatchObject({
      periodYear: 2026,
      periodMonth: 11,
    });
  });

  it("con cierre 31, la compra del último día de un mes corto entra a ese mes", async () => {
    const { card } = await seedBase({ closingDay: 31, dueDay: 10 });

    const plan = await createCardPlan(
      db,
      {
        cardId: card.id,
        label: "Fin de abril",
        totalAmount: "30000",
        installments: 3,
        purchaseDate: "2026-04-30",
        categoryName: "Hogar",
      },
      { today: "2026-05-01" },
    );

    expect(plan.items[0]).toMatchObject({ periodYear: 2026, periodMonth: 4 });
    expect(plan.items[1]).toMatchObject({ periodYear: 2026, periodMonth: 5 });
  });

  it("una tarjeta sin cierre no puede cargar cuotas (409)", async () => {
    const { card } = await seedBase({ closingDay: null, dueDay: null });

    await expect(
      createCardPlan(
        db,
        {
          cardId: card.id,
          label: "Sin cierre",
          totalAmount: "10000",
          installments: 1,
          categoryName: "Hogar",
        },
        { today: TODAY },
      ),
    ).rejects.toThrow(/cierre/);
  });

  it("corre los resúmenes de los períodos cerrados: cuotas + compras directas, idempotente", async () => {
    const { card } = await seedBase();

    // 12 cuotas de 10.000; la primera entra al resumen de octubre.
    await createCardPlan(
      db,
      {
        cardId: card.id,
        label: "Heladera",
        totalAmount: "120000",
        installments: 12,
        purchaseDate: "2026-10-17",
        categoryName: "Hogar",
      },
      { today: TODAY },
    );

    // Una compra directa (no en cuotas) ANTES del cierre: entra al mismo resumen.
    await db.movement.create({
      data: {
        kind: "EXPENSE",
        amount: "5000",
        date: calendarToDb("2026-10-10"),
        description: "Supermercado",
        accountId: card.id,
        categoryId: (await db.category.findFirstOrThrow({ where: { kind: "EXPENSE" } })).id,
      },
    });

    // Aún no cerró octubre (hoy 17): la corrida no emite nada.
    const antesDelCierre = await runCardStatements(db, { today: TODAY });
    expect(antesDelCierre.results[0].created).toBe(0);
    expect(antesDelCierre.results[0].statements).toHaveLength(0);

    // El 26 de octubre octubre ya cerró (25). Total = cuota (10.000) + compra
    // directa (5.000). El mínimo es el 5% del total.
    const corrida = await runCardStatements(db, { today: "2026-10-26" });
    expect(corrida.results[0].created).toBe(1);
    expect(corrida.results[0].updated).toBe(0);

    const octubre = corrida.results[0].statements[0];
    expect(octubre).toMatchObject({
      year: 2026,
      month: 10,
      closingDate: "2026-10-25",
      dueDate: "2026-11-05",
      totalDue: "15000.00",
      minimumDue: "750.00",
      paid: false,
    });

    // El gasto de compra en cuotas NO se cuenta dos veces: el resumen tiene
    // 15.000 (10.000 de la cuota + 5.000 directos), no 135.000.
    expect(octubre.totalDue).toBe("15000.00");

    // Idempotente: dos corridas seguidas no duplican ni cambian nada.
    const repetida = await runCardStatements(db, { today: "2026-10-26" });
    expect(repetida.results[0].created).toBe(0);
    expect(repetida.results[0].unchanged).toBe(1);
    expect(await db.statement.count()).toBe(1);

    // Una compra cargada TARDE en el período cerrado se refleja al recalcular
    // (el resumen está impago, así que no está congelado).
    await db.movement.create({
      data: {
        kind: "EXPENSE",
        amount: "2000",
        date: calendarToDb("2026-10-20"),
        description: "Farmacia (cargada tarde)",
        accountId: card.id,
        categoryId: (await db.category.findFirstOrThrow({ where: { kind: "EXPENSE" } })).id,
      },
    });

    const recalculada = await runCardStatements(db, { today: "2026-10-26" });
    expect(recalculada.results[0].updated).toBe(1);
    expect(recalculada.results[0].statements[0].totalDue).toBe("17000.00");
    expect(recalculada.results[0].statements[0].minimumDue).toBe("850.00");
  });

  it("pagar un resumen crea una TRANSFERENCIA (nunca un gasto), baja la deuda y es idempotente", async () => {
    const { bank, card } = await seedBase();

    await createCardPlan(
      db,
      {
        cardId: card.id,
        label: "Heladera",
        totalAmount: "120000",
        installments: 12,
        purchaseDate: "2026-10-17",
        categoryName: "Hogar",
      },
      { today: TODAY },
    );

    const corrida = await runCardStatements(db, { today: "2026-10-26" });
    const statement = await db.statement.findFirstOrThrow();

    // Antes de pagar: un solo EXPENSE (la compra) y deuda de 120.000.
    expect(await db.movement.count({ where: { kind: "EXPENSE" } })).toBe(1);

    const pago = await payStatement(
      db,
      { statementId: statement.id, fromAccountId: bank.id },
      { today: "2026-10-27" },
    );

    expect(pago.created).toBe(true);
    expect(pago.movement.kind).toBe("TRANSFER");
    expect(pago.movement.amount).toBe("10000.00");
    expect(pago.movement.date).toBe("2026-10-27");
    expect(pago.movement.account.id).toBe(bank.id);
    expect(pago.movement.toAccount?.id).toBe(card.id);
    expect(pago.statement.paid).toBe(true);

    // Pagar NO crea un gasto: sigue habiendo UN solo EXPENSE.
    expect(await db.movement.count({ where: { kind: "EXPENSE" } })).toBe(1);

    // La deuda bajó: 120.000 de la compra − 10.000 pagados.
    const balances = await getAccountBalances(db);
    expect(
      balances.find((balance) => balance.id === card.id)?.debt?.toFixed(2),
    ).toBe("110000.00");

    // Doble clic: devuelve el pago existente, no crea otra transferencia.
    const repetido = await payStatement(
      db,
      { statementId: statement.id, fromAccountId: bank.id },
      { today: "2026-10-28" },
    );
    expect(repetido.created).toBe(false);
    expect(repetido.movement.id).toBe(pago.movement.id);
    expect(await db.movement.count({ where: { kind: "TRANSFER" } })).toBe(1);
  });

  it("un resumen pagado queda congelado y el plan que lo originó no se puede borrar (409)", async () => {
    const { bank, card } = await seedBase();

    const plan = await createCardPlan(
      db,
      {
        cardId: card.id,
        label: "Notebook",
        totalAmount: "120000",
        installments: 12,
        purchaseDate: "2026-10-17",
        categoryName: "Hogar",
      },
      { today: TODAY },
    );

    await runCardStatements(db, { today: "2026-10-26" });
    const statement = await db.statement.findFirstOrThrow();
    await payStatement(
      db,
      { statementId: statement.id, fromAccountId: bank.id },
      { today: "2026-10-27" },
    );

    // Una compra cargada tarde en un período YA PAGADO no reescribe el documento.
    await db.movement.create({
      data: {
        kind: "EXPENSE",
        amount: "9999",
        date: calendarToDb("2026-10-12"),
        description: "Tarde",
        accountId: card.id,
        categoryId: (await db.category.findFirstOrThrow({ where: { kind: "EXPENSE" } })).id,
      },
    });

    const corrida = await runCardStatements(db, { today: "2026-10-28" });
    expect(corrida.results[0].frozen).toBe(1);
    expect(corrida.results[0].statements[0].totalDue).toBe("10000.00");

    await expect(deleteCardPlan(db, plan.id)).rejects.toThrow(/pagado|historial/);
  });

  it("borrar un plan impago deshace la compra y el resumen se recalcula", async () => {
    const { card } = await seedBase();

    const plan = await createCardPlan(
      db,
      {
        cardId: card.id,
        label: "Sillón",
        totalAmount: "30000",
        installments: 3,
        purchaseDate: "2026-10-17",
        categoryName: "Hogar",
      },
      { today: TODAY },
    );

    await runCardStatements(db, { today: "2026-10-26" });
    expect((await db.statement.findFirstOrThrow()).totalDue.toFixed(2)).toBe("10000.00");

    await deleteCardPlan(db, plan.id);

    // El plan, sus cuotas y el gasto desaparecieron.
    expect(await db.cardPlan.count()).toBe(0);
    expect(await db.cardPlanItem.count()).toBe(0);
    expect(await db.movement.count()).toBe(0);

    // La próxima corrida deja el resumen impago en cero (el documento existía y
    // se recalcula; no se borra la historia).
    const corrida = await runCardStatements(db, { today: "2026-10-26" });
    expect(corrida.results[0].updated).toBe(1);
    expect(corrida.results[0].statements[0].totalDue).toBe("0.00");
    expect(corrida.results[0].statements[0].minimumDue).toBe("0.00");
  });

  it("el cruce diciembre/enero: el resumen de diciembre cierra en diciembre y vence en enero", async () => {
    const { card } = await seedBase();

    await createCardPlan(
      db,
      {
        cardId: card.id,
        label: "Regalo",
        totalAmount: "50000",
        installments: 2,
        purchaseDate: "2026-12-20",
        categoryName: "Hogar",
      },
      { today: "2026-12-20" },
    );

    const corrida = await runCardStatements(db, { today: "2027-01-26" });

    // Dos resúmenes: diciembre 2026 (cerró el 25/12, venció el 5/1) y enero
    // 2027 (cerró el 25/1, vence el 5/2).
    expect(corrida.results[0].created).toBe(2);
    const [enero, diciembre] = corrida.results[0].statements;
    expect(diciembre).toMatchObject({
      year: 2026,
      month: 12,
      closingDate: "2026-12-25",
      dueDate: "2027-01-05",
      totalDue: "25000.00",
    });
    expect(enero).toMatchObject({
      year: 2027,
      month: 1,
      closingDate: "2027-01-25",
      dueDate: "2027-02-05",
      totalDue: "25000.00",
    });
  });

  it("borrar el gasto de una compra en cuotas lo explica con la constraint correcta", async () => {
    const { card } = await seedBase();

    const plan = await createCardPlan(
      db,
      {
        cardId: card.id,
        label: "Heladera",
        totalAmount: "12000",
        installments: 1,
        purchaseDate: "2026-10-17",
        categoryName: "Hogar",
      },
      { today: TODAY },
    );

    // El FK es Restrict: borrar el movimiento dejaría al plan sin su compra.
    let caught: unknown = null;
    try {
      await db.movement.delete({ where: { id: plan.movement.id } });
    } catch (error) {
      caught = error;
    }

    expect(caught).not.toBeNull();

    // El mensaje que ve la persona tiene que mandarla al plan y no hablar de
    // "archivar una cuenta", que es el consejo del P2003 genérico.
    const described = describeDatabaseError(caught);
    expect(described?.status).toBe(409);
    expect(described?.message).toMatch(/plan/);
  });

  it("la vista de tarjetas: utilización, período en curso y compromisos 6/12", async () => {
    const { card } = await seedBase({ creditLimit: "600000" });

    await createCardPlan(
      db,
      {
        cardId: card.id,
        label: "Heladera",
        totalAmount: "120000",
        installments: 12,
        purchaseDate: "2026-10-17",
        categoryName: "Hogar",
      },
      { today: TODAY },
    );

    const view = await getCardsView(db, { today: TODAY });
    const cardView = view.cards.find((candidate) => candidate.id === card.id);

    expect(cardView?.debt).toBe("120000.00");
    expect(cardView?.utilizationPercent).toBe("20.00");

    // El período en curso es octubre (cierra el 25). Proyecta la cuota 1 y no
    // está emitido todavía.
    expect(cardView?.currentPeriod).toMatchObject({
      year: 2026,
      month: 10,
      totalDue: "10000.00",
      minimumDue: "500.00",
      closed: false,
      persisted: false,
    });

    // Próximos 12 resúmenes: las 12 cuotas. Los primeros 6 suman 60.000.
    expect(cardView?.commitments.next6Months).toBe("60000.00");
    expect(cardView?.commitments.next12Months).toBe("120000.00");
    expect(cardView?.commitments.months).toHaveLength(12);
    expect(cardView?.commitments.months[0].amount).toBe("10000.00");
    expect(cardView?.plans[0].implicitRate).toBeNull();
  });

  it("la corrida saltea (con motivo) las tarjetas con compras y sin cierre configurado", async () => {
    const { gastos } = await seedCategories();
    const sinCierre = await db.account.create({
      data: { name: "Visa sin cierre", kind: "CREDIT_CARD" },
    });
    await db.movement.create({
      data: {
        kind: "EXPENSE",
        amount: "1000",
        date: calendarToDb(TODAY),
        description: "Compra",
        accountId: sinCierre.id,
        categoryId: gastos.id,
      },
    });

    const corrida = await runCardStatements(db, { today: TODAY });
    expect(corrida.results).toHaveLength(0);
    expect(corrida.skipped).toHaveLength(1);
    expect(corrida.skipped[0].cardId).toBe(sinCierre.id);
    expect(corrida.skipped[0].reason).toMatch(/cierre/);
    expect(corrida.skipped[0].cardName).toBe("Visa sin cierre");
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * PRÉSTAMOS (FASE 4): CRONOGRAMA, PAGO Y VISTA
 * ════════════════════════════════════════════════════════════════════════════
 * El contrato de un préstamo es su cronograma MATERIALIZADO. Estos tests
 * verifican, contra la base real: que el alta lo escriba completo y en la misma
 * transacción, que el pago lo respete (cobertura por capital, no por
 * calendario), que la cancelación pague lo que queda sin interés, que un
 * préstamo dado (RECEIVABLE) sea un ACTIVO y no entre al reporte de deudas, y
 * que la base se niegue a guardar cuotas imposibles.
 */
describeDb("Préstamos: cronograma, pago y vista (Fase 4)", () => {
  const TODAY = "2026-11-30";
  const FIRST = "2026-11-15";

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
    await db.$disconnect();
  });

  /** El escenario mínimo: banco con 100.000 y préstamo francés de 500.000. */
  async function seedFrenchLoan() {
    const bank = await db.account.create({
      data: { name: "Banco", kind: "BANK", openingBalance: "100000" },
    });
    const loan = await createLoanAccount(db, {
      name: "Préstamo",
      kind: "LOAN",
      currency: "ARS",
      openingBalance: "0",
      system: "FRENCH",
      principal: money("500000"),
      tnaPercent: money("60"),
      installmentCount: 12,
      firstInstallmentDate: FIRST,
      imported: null,
    });

    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "500000",
        date: calendarToDb("2026-09-30"),
        accountId: loan.id,
        toAccountId: bank.id,
        description: "Desembolso del préstamo",
      },
    });

    return { bank, loan };
  }

  it("el alta materializa el cronograma completo, con sus fechas de vencimiento", async () => {
    const loan = await createLoanAccount(db, {
      name: "Préstamo",
      kind: "LOAN",
      currency: "ARS",
      openingBalance: "0",
      system: "FRENCH",
      principal: money("500000"),
      tnaPercent: money("60"),
      installmentCount: 12,
      firstInstallmentDate: FIRST,
      imported: null,
    });

    expect(loan.amortizationSystem).toBe("FRENCH");
    expect(loan.installmentCount).toBe(12);
    expect(dbToCalendar(loan.firstInstallmentDate as Date)).toBe(FIRST);

    const rows = await db.installment.findMany({
      where: { accountId: loan.id },
      orderBy: { number: "asc" },
    });
    expect(rows).toHaveLength(12);

    // El documento guardado es, cuota por cuota, el cronograma puro — con las
    // fechas de la serie mensual, que en los sistemas calculados viene de
    // `dueDateSeries`.
    const schedule = loanScheduleFor({
      system: "FRENCH",
      principal: "500000",
      tnaPercent: "60",
      installmentCount: 12,
    });
    const dueDates = dueDateSeries(FIRST, 12);
    expect(
      rows.map((row) => ({
        number: row.number,
        payment: row.payment.toFixed(2),
        interest: row.interest.toFixed(2),
        principal: row.principal.toFixed(2),
        remainingBalance: row.remainingBalance.toFixed(2),
        dueDate: dbToCalendar(row.dueDate),
      })),
    ).toEqual(
      schedule.map((item, index) => ({
        number: item.number,
        payment: item.payment.toFixed(2),
        interest: item.interest.toFixed(2),
        principal: item.principal.toFixed(2),
        remainingBalance: item.remainingBalance.toFixed(2),
        dueDate: dueDates[index],
      })),
    );

    // La cuota del §3.2, clavada a mano además del cruce con la función pura.
    expect(rows[0].payment.toFixed(2)).toBe("56412.71");
    expect(rows[0].remainingBalance.toFixed(2)).toBe("468587.29");
    expect(rows[11].remainingBalance.toFixed(2)).toBe("0.00");
  });

  it("el alta sobrevive un pool de conexiones ocupado (no muere con P2028)", async () => {
    // ── EL REPRO DEL HALLAZGO ────────────────────────────────────────────────
    // Un pico real de pedidos dejó el alta en un 500 genérico («No se pudo
    // crear la cuenta») con el P2028 de Prisma escondido en el log del
    // servidor: su transacción interactiva no consiguió una conexión del pool
    // dentro del maxWait DEFAULT (2 s) y nunca llegó a arrancar.
    //
    // Las transacciones que duermen 2 s simulan ese pico: ocupan todas las
    // conexiones. El alta pide lugar DESPUÉS y tiene que ESPERAR su turno
    // —con el maxWait configurado del cliente— en vez de morir a los 2 s.
    // La cantidad supera cualquier pool razonable (el default de Prisma es
    // 2×núcleos+1: acá, 9).
    const sleepers = Array.from({ length: 30 }, () =>
      db.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe("SELECT pg_sleep(2)");
        },
        // Los que esperan en la cola también tienen que sobrevivir su turno:
        // sin esto, el default de 2 s los mata a mitad de camino y la cola se
        // desarma sola.
        { maxWait: 30_000 },
      ),
    );

    try {
      const loan = await createLoanAccount(db, {
        name: "Préstamo bajo pico",
        kind: "LOAN",
        currency: "ARS",
        openingBalance: "0",
        system: "FRENCH",
        principal: money("500000"),
        tnaPercent: money("60"),
        installmentCount: 12,
        firstInstallmentDate: FIRST,
        imported: null,
      });

      // El alta salió completa A PESAR del pico: cuenta y cronograma entero.
      const rows = await db.installment.findMany({
        where: { accountId: loan.id },
      });
      expect(rows).toHaveLength(12);
    } finally {
      await Promise.all(sleepers);
    }
  }, 30_000);

  it("una transacción que no alcanza a arrancar se responde como 503 «volvé a intentar», no como 500 genérico", async () => {
    // El P2028 REAL, no uno inventado: con el pool ocupado, una transacción
    // con un maxWait diminuto falla de verdad. Así la traducción del error se
    // prueba contra el error que Prisma tira en la vida real.
    const sleepers = Array.from({ length: 30 }, () =>
      db.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe("SELECT pg_sleep(2)");
        },
        // Los que esperan en la cola también tienen que sobrevivir su turno:
        // sin esto, el default de 2 s los mata a mitad de camino y la cola se
        // desarma sola.
        { maxWait: 30_000 },
      ),
    );

    try {
      let caught: unknown = null;
      try {
        await db.$transaction(async () => undefined, { maxWait: 150 });
      } catch (error) {
        caught = error;
      }

      expect(caught).not.toBeNull();
      expect((caught as { code?: string }).code).toBe("P2028");

      // Lo que ve la persona es que el servidor estaba ocupado y puede
      // reintentar — no un 500 que la manda a revisar datos que están bien.
      const described = describeDatabaseError(caught);
      expect(described?.status).toBe(503);
      expect(described?.message).toMatch(/volvé a intentar/i);
    } finally {
      await Promise.all(sleepers);
    }
  }, 30_000);

  it("el alta importada guarda el cronograma del banco tal cual y exige coherencia", async () => {
    const loan = await createLoanAccount(db, {
      name: "Préstamo importado",
      kind: "LOAN",
      currency: "ARS",
      openingBalance: "0",
      system: "IMPORTED",
      principal: money("47500"),
      tnaPercent: null,
      installmentCount: null,
      firstInstallmentDate: null,
      imported: [
        { dueDate: "2026-11-15", payment: money("30000"), interest: money("5000") },
        { dueDate: "2026-12-15", payment: money("25000"), interest: money("2500") },
      ],
    });

    expect(loan.amortizationSystem).toBe("IMPORTED");
    // El largo y la primera fecha del contrato se DERIVAN del documento.
    expect(loan.installmentCount).toBe(2);
    expect(dbToCalendar(loan.firstInstallmentDate as Date)).toBe("2026-11-15");

    const rows = await db.installment.findMany({
      where: { accountId: loan.id },
      orderBy: { number: "asc" },
    });
    expect(
      rows.map((row) => ({
        number: row.number,
        dueDate: dbToCalendar(row.dueDate),
        payment: row.payment.toFixed(2),
        interest: row.interest.toFixed(2),
        principal: row.principal.toFixed(2),
        remainingBalance: row.remainingBalance.toFixed(2),
      })),
    ).toEqual([
      {
        number: 1,
        dueDate: "2026-11-15",
        payment: "30000.00",
        interest: "5000.00",
        principal: "25000.00",
        remainingBalance: "22500.00",
      },
      {
        number: 2,
        dueDate: "2026-12-15",
        payment: "25000.00",
        interest: "2500.00",
        principal: "22500.00",
        remainingBalance: "0.00",
      },
    ]);

    // Σ capital ≠ monto: el cronograma describe otro préstamo → 400 con palabras.
    await expect(
      createLoanAccount(db, {
        name: "Importado roto",
        kind: "LOAN",
        currency: "ARS",
        openingBalance: "0",
        system: "IMPORTED",
        principal: money("100000"),
        tnaPercent: null,
        installmentCount: null,
        firstInstallmentDate: null,
        imported: [
          { dueDate: "2026-11-15", payment: money("30000"), interest: money("5000") },
        ],
      }),
    ).rejects.toThrow(/no coincide/);

    // Fechas que no crecen: dos cuotas el mismo día no existen.
    await expect(
      createLoanAccount(db, {
        name: "Importado desordenado",
        kind: "LOAN",
        currency: "ARS",
        openingBalance: "0",
        system: "IMPORTED",
        principal: money("47500"),
        tnaPercent: null,
        installmentCount: null,
        firstInstallmentDate: null,
        imported: [
          { dueDate: "2026-11-15", payment: money("30000"), interest: money("5000") },
          { dueDate: "2026-11-15", payment: money("25000"), interest: money("2500") },
        ],
      }),
    ).rejects.toThrow(/estrictamente crecientes/);

    // Los dos rechazos son de VALIDACIÓN: no quedó ninguna cuenta a medias.
    expect(await db.account.count()).toBe(1);
    expect(await db.installment.count()).toBe(2);
  });

  it("la vista deriva la cobertura del capital real y arma los compromisos", async () => {
    const { bank, loan } = await seedFrenchLoan();
    const schedule = loanScheduleFor({
      system: "FRENCH",
      principal: "500000",
      tnaPercent: "60",
      installmentCount: 12,
    });

    // La cuota 1, pagada el día de su vencimiento.
    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: schedule[0].principal.toFixed(2),
        date: calendarToDb("2026-11-15"),
        accountId: bank.id,
        toAccountId: loan.id,
        description: "Cuota 1 · capital",
      },
    });

    const { loans } = await getLoansView(db, { today: TODAY });
    expect(loans).toHaveLength(1);

    const view = loans[0];
    expect(view.kind).toBe("LOAN");
    expect(view.direction).toBe("I_OWE");
    expect(view.system).toBe("FRENCH");
    expect(view.debt).toBe("468587.29");
    expect(view.receivable).toBeNull();
    expect(view.plan).toEqual({
      payment: "56412.71",
      principal: "500000.00",
      installmentCount: 12,
      paidCount: 1,
      remainingCount: 11,
    });
    expect(view.capitalPaid).toBe("31412.71");
    expect(view.interestPaid).toBe("25000.00");
    expect(view.progressPercent).toBe("6.28");
    expect(view.nextInstallment?.number).toBe(2);
    expect(view.nextInstallment?.dueDate).toBe("2026-12-15");
    expect(view.installments).toHaveLength(12);
    expect(view.installments[0].covered).toBe(true);
    expect(view.installments[1].covered).toBe(false);

    // Compromisos: la ventana arranca en el mes de `today` (noviembre) y las 11
    // cuotas impagas caen dentro de los 12 meses — la 1 ya está cubierta.
    expect(view.commitments?.months).toHaveLength(12);
    expect(view.commitments?.months[0]).toMatchObject({
      year: 2026,
      month: 11,
      amount: "0.00",
    });
    expect(view.commitments?.months[1]).toMatchObject({
      year: 2026,
      month: 12,
      amount: "56412.71",
    });
    expect(view.commitments?.next6Months).toBe("282063.55");
    // 11 cuotas × 56.412,71 menos los 8 centavos que ajusta la última al cerrar
    // el capital: el compromiso suma los PAGOS reales del cronograma (la 12.ª
    // es de 56.412,63), no una cuota redonda hipotética.
    expect(view.commitments?.next12Months).toBe("620539.73");
    expect(view.commitments?.overdue).toBe("0.00");
    expect(view.commitments?.overdueCount).toBe(0);
  });

  it("el desembolso se deriva de la plata, no del saldo: apertura 0 sin transferencia lo delata", async () => {
    const bank = await db.account.create({
      data: { name: "Banco", kind: "BANK", openingBalance: "100000" },
    });

    // El caso que la pantalla tiene que avisar: un alta guiada que se saltea el
    // desembolso deja el préstamo con deuda "aparecida de la nada".
    const loan = await createLoanAccount(db, {
      name: "Préstamo",
      kind: "LOAN",
      currency: "ARS",
      openingBalance: "0",
      system: "FRENCH",
      principal: money("500000"),
      tnaPercent: money("60"),
      installmentCount: 12,
      firstInstallmentDate: FIRST,
      imported: null,
    });

    const antes = await getLoansView(db, { today: TODAY });
    expect(antes.loans).toHaveLength(1);
    expect(antes.loans[0].disbursed).toBe(false);

    // Una transferencia HACIA el préstamo (un pago suelto) no declara el
    // desembolso: el sentido importa.
    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "1000",
        date: calendarToDb("2026-11-20"),
        accountId: bank.id,
        toAccountId: loan.id,
        description: "Pago suelto",
      },
    });
    const conPago = await getLoansView(db, { today: TODAY });
    expect(conPago.loans[0].disbursed).toBe(false);

    // La transferencia del desembolso: sale del préstamo y entra al banco.
    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "500000",
        date: calendarToDb("2026-09-30"),
        accountId: loan.id,
        toAccountId: bank.id,
        description: "Desembolso del préstamo",
      },
    });
    const despues = await getLoansView(db, { today: TODAY });
    expect(despues.loans[0].disbursed).toBe(true);

    // Una transferencia POSTERIOR al corte no cuenta: la vista es una foto.
    await db.movement.deleteMany({
      where: { OR: [{ accountId: loan.id }, { toAccountId: loan.id }] },
    });
    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "500000",
        date: calendarToDb("2026-12-15"),
        accountId: loan.id,
        toAccountId: bank.id,
        description: "Desembolso del préstamo",
      },
    });
    const noviembre = await getLoansView(db, { today: TODAY });
    expect(noviembre.loans[0].disbursed).toBe(false);
    const diciembre = await getLoansView(db, { today: "2026-12-31" });
    expect(diciembre.loans[0].disbursed).toBe(true);
  });

  it("un préstamo dado (RECEIVABLE): declara el desembolso lo que ENTRA, no lo que vuelve", async () => {
    const bank = await db.account.create({
      data: { name: "Banco", kind: "BANK", openingBalance: "100000" },
    });
    const receivable = await createLoanAccount(db, {
      name: "Préstamo a Marce",
      kind: "RECEIVABLE",
      currency: "ARS",
      openingBalance: "0",
      system: "FRENCH",
      principal: money("100000"),
      tnaPercent: money("60"),
      installmentCount: 6,
      firstInstallmentDate: FIRST,
      imported: null,
    });

    const antes = await getLoansView(db, { today: TODAY });
    expect(antes.loans[0].disbursed).toBe(false);

    // Una devolución (transferencia que SALE de la cuenta por cobrar) no es el
    // desembolso: el desembolso de este lado es lo que ENTRA.
    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "10000",
        date: calendarToDb("2026-11-20"),
        accountId: receivable.id,
        toAccountId: bank.id,
        description: "Devolución",
      },
    });
    const conDevolucion = await getLoansView(db, { today: TODAY });
    expect(conDevolucion.loans[0].disbursed).toBe(false);

    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "100000",
        date: calendarToDb("2026-10-05"),
        accountId: bank.id,
        toAccountId: receivable.id,
        description: "Le presté a Marce",
      },
    });
    const despues = await getLoansView(db, { today: TODAY });
    expect(despues.loans[0].disbursed).toBe(true);
    expect(despues.loans[0].receivable).toBe("90000.00");
  });

  it("la apertura que ya declara la plata cuenta como desembolso (préstamos migrados)", async () => {
    // Un préstamo migrado a mano: la deuda vive en la apertura (negativa) y la
    // plata ya entró en su momento — no hay transferencia que la declare.
    await createLoanAccount(db, {
      name: "Préstamo viejo",
      kind: "LOAN",
      currency: "ARS",
      openingBalance: "-400000",
      system: "FRENCH",
      principal: money("400000"),
      tnaPercent: money("48"),
      installmentCount: 12,
      firstInstallmentDate: FIRST,
      imported: null,
    });

    // Y del otro lado: lo prestado antes de la app es una apertura positiva.
    await createLoanAccount(db, {
      name: "Plata de Marce",
      kind: "RECEIVABLE",
      currency: "ARS",
      openingBalance: "150000",
      system: "FRENCH",
      principal: money("150000"),
      tnaPercent: money("48"),
      installmentCount: 6,
      firstInstallmentDate: FIRST,
      imported: null,
    });

    const { loans } = await getLoansView(db, { today: TODAY });
    expect(loans).toHaveLength(2);
    for (const view of loans) expect(view.disbursed).toBe(true);
  });

  it("pagar la cuota parte el pago: transferencia por capital y gasto por interés", async () => {
    const { bank, loan } = await seedFrenchLoan();
    const schedule = loanScheduleFor({
      system: "FRENCH",
      principal: "500000",
      tnaPercent: "60",
      installmentCount: 12,
    });

    const first = schedule[0];
    const result = await payLoanInstallment(
      db,
      {
        accountId: loan.id,
        cashAccountId: bank.id,
        date: "2026-11-15",
        installmentNumber: 1,
        extraCapital: null,
        cancel: false,
        categoryName: null,
      },
      { today: TODAY },
    );

    expect(result.created).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.installment?.number).toBe(1);
    expect(result.installment?.covered).toBe(true);
    expect(result.principalPaid).toBe(first.principal.toFixed(2));
    expect(result.interestPaid).toBe(first.interest.toFixed(2));

    // Las dos patas, en el orden del contrato: el capital es una transferencia
    // (no un gasto) y el interés es el único gasto.
    expect(result.movements).toHaveLength(2);
    expect(result.movements[0]).toMatchObject({
      kind: "TRANSFER",
      amount: first.principal.toFixed(2),
      description: "Cuota 1 · capital",
    });
    expect(result.movements[0].account.id).toBe(bank.id);
    expect(result.movements[0].toAccount?.id).toBe(loan.id);
    expect(result.movements[1]).toMatchObject({
      kind: "EXPENSE",
      amount: first.interest.toFixed(2),
      description: "Cuota 1 · interés",
    });
    expect(result.movements[1].category?.name).toBe("Intereses");

    // La vista posterior: cubierta 1, próxima la 2.
    expect(result.loan.plan?.paidCount).toBe(1);
    expect(result.loan.nextInstallment?.number).toBe(2);

    // La plata: el banco pagó capital + interés; el préstamo bajó el capital.
    const balances = await getAccountBalances(db);
    const bankBalance = balances.find((item) => item.id === bank.id);
    const loanBalance = balances.find((item) => item.id === loan.id);
    expect(bankBalance?.balance.toFixed(2)).toBe("543587.29");
    expect(loanBalance?.balance.toFixed(2)).toBe("-468587.29");
    expect(loanBalance?.debt?.toFixed(2)).toBe("468587.29");

    // ── El doble toque: la MISMA cuota otra vez — created: false, nada escrito.
    const again = await payLoanInstallment(
      db,
      {
        accountId: loan.id,
        cashAccountId: bank.id,
        date: "2026-11-15",
        installmentNumber: 1,
        extraCapital: null,
        cancel: false,
        categoryName: null,
      },
      { today: TODAY },
    );
    expect(again.created).toBe(false);
    expect(again.movements).toEqual([]);
    expect(again.principalPaid).toBeNull();
    expect(
      await db.movement.count({
        where: { OR: [{ accountId: loan.id }, { toAccountId: loan.id }] },
      }),
    ).toBe(2); // desembolso + capital de la cuota 1

    // ── Las cuotas se pagan en orden: saltar a la 3 con la 2 pendiente es 400.
    await expect(
      payLoanInstallment(
        db,
        {
          accountId: loan.id,
          cashAccountId: bank.id,
          date: "2026-12-01",
          installmentNumber: 3,
          extraCapital: null,
          cancel: false,
          categoryName: null,
        },
        { today: TODAY },
      ),
    ).rejects.toThrow(/en orden/);

    // ── Omitir el número paga la próxima impaga (la 2).
    const second = await payLoanInstallment(
      db,
      {
        accountId: loan.id,
        cashAccountId: bank.id,
        date: "2026-12-15",
        installmentNumber: null,
        extraCapital: null,
        cancel: false,
        categoryName: null,
      },
      { today: TODAY },
    );
    expect(second.created).toBe(true);
    expect(second.installment?.number).toBe(2);
    expect(second.principalPaid).toBe(schedule[1].principal.toFixed(2));

    // ── Pagar de más del saldo que queda es 400 (y no escribe nada).
    const movementsBefore = await db.movement.count();
    await expect(
      payLoanInstallment(
        db,
        {
          accountId: loan.id,
          cashAccountId: bank.id,
          date: "2027-01-15",
          installmentNumber: 3,
          extraCapital: money("999999"),
          cancel: false,
          categoryName: null,
        },
        { today: TODAY },
      ),
    ).rejects.toThrow(/supera el saldo/);
    expect(await db.movement.count()).toBe(movementsBefore);
  });

  it("el capital extra amortiza de más y la cancelación paga el resto sin interés", async () => {
    const { bank, loan } = await seedFrenchLoan();
    const schedule = loanScheduleFor({
      system: "FRENCH",
      principal: "500000",
      tnaPercent: "60",
      installmentCount: 12,
    });

    // Cuota 1 + 50.000 de capital extra: el extra baja la deuda, no adelanta
    // el interés (el cronograma es el contrato y no se recalcula).
    const conExtra = await payLoanInstallment(
      db,
      {
        accountId: loan.id,
        cashAccountId: bank.id,
        date: "2026-11-15",
        installmentNumber: 1,
        extraCapital: money("50000"),
        cancel: false,
        categoryName: null,
      },
      { today: TODAY },
    );

    expect(conExtra.created).toBe(true);
    expect(conExtra.principalPaid).toBe(
      schedule[0].principal.plus("50000").toFixed(2),
    );
    // El capital pagado cubre la 1 y la 2: la 3 sigue pendiente.
    expect(conExtra.loan.capitalPaid).toBe("81412.71");
    expect(conExtra.loan.plan?.paidCount).toBe(2);
    expect(conExtra.loan.nextInstallment?.number).toBe(3);

    // ── Cancelación anticipada: todo el capital que queda, SIN interés. La
    // vista se evalúa EL DÍA DEL PAGO (12-01): un pago fechado el 12-01 no
    // cuenta en un `today` del 11-30 — y con el mismo `today` que el pago, el
    // doble toque de más abajo sigue siendo idempotente.
    const remaining = money("500000").minus("81412.71");
    const cancelacion = await payLoanInstallment(
      db,
      {
        accountId: loan.id,
        cashAccountId: bank.id,
        date: "2026-12-01",
        installmentNumber: null,
        extraCapital: null,
        cancel: true,
        categoryName: null,
      },
      { today: "2026-12-01" },
    );

    expect(cancelacion.created).toBe(true);
    expect(cancelacion.cancelled).toBe(true);
    expect(cancelacion.principalPaid).toBe(remaining.toFixed(2));
    expect(cancelacion.interestPaid).toBeNull();
    expect(cancelacion.movements).toHaveLength(1);
    expect(cancelacion.movements[0]).toMatchObject({
      kind: "TRANSFER",
      amount: remaining.toFixed(2),
      description: "Cancelación anticipada · capital",
    });

    // La vista final: capital completo, ninguna cuota pendiente y el interés
    // pagado con la semántica de la Fase 6 (Σ interés de las cuotas cubiertas).
    expect(cancelacion.loan.capitalPaid).toBe("500000.00");
    expect(cancelacion.loan.plan?.paidCount).toBe(12);
    expect(cancelacion.loan.plan?.remainingCount).toBe(0);
    expect(cancelacion.loan.nextInstallment).toBeNull();
    expect(cancelacion.loan.interestPaid).toBe("176952.44");
    expect(cancelacion.loan.progressPercent).toBe("100.00");
    expect(cancelacion.loan.debt).toBe("0.00");

    // Cancelar otra vez no paga dos veces.
    const cancelAgain = await payLoanInstallment(
      db,
      {
        accountId: loan.id,
        cashAccountId: bank.id,
        date: "2026-12-01",
        installmentNumber: null,
        extraCapital: null,
        cancel: true,
        categoryName: null,
      },
      { today: "2026-12-01" },
    );
    expect(cancelAgain.created).toBe(false);
    expect(cancelAgain.cancelled).toBe(false);

    // Cancelar JUNTO con una cuota o con extra no existe: es una cosa o la otra.
    await expect(
      payLoanInstallment(
        db,
        {
          accountId: loan.id,
          cashAccountId: bank.id,
          date: "2026-12-01",
          installmentNumber: 1,
          extraCapital: null,
          cancel: true,
          categoryName: null,
        },
        { today: TODAY },
      ),
    ).rejects.toThrow(/no se combina/);
  });

  it("un préstamo dado (RECEIVABLE) cobra al revés y NO es deuda", async () => {
    const bank = await db.account.create({
      data: { name: "Banco", kind: "BANK", openingBalance: "100000" },
    });
    const receivable = await createLoanAccount(db, {
      name: "Préstamo a Marce",
      kind: "RECEIVABLE",
      currency: "ARS",
      openingBalance: "0",
      system: "FRENCH",
      principal: money("100000"),
      tnaPercent: money("60"),
      installmentCount: 6,
      firstInstallmentDate: FIRST,
      imported: null,
    });

    const rows = await db.installment.findMany({
      where: { accountId: receivable.id },
      orderBy: { number: "asc" },
    });

    // El desembolso: la plata SALE del banco y entra a la cuenta por cobrar
    // (me deben). No es un gasto: el patrimonio no cambia.
    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "100000",
        date: calendarToDb("2026-10-05"),
        accountId: bank.id,
        toAccountId: receivable.id,
        description: "Le presté a Marce",
      },
    });

    const hastaOctubre = await getAccountBalances(db, { asOf: "2026-10-31" });
    const receivableBalance = hastaOctubre.find((item) => item.id === receivable.id);
    expect(receivableBalance?.balance.toFixed(2)).toBe("100000.00");
    expect(receivableBalance?.isLiability).toBe(false);
    expect(receivableBalance?.debt).toBeNull();

    // El reporte de deudas NO lo ve: es un activo, no una deuda.
    const report = await getDebtReport(db, { currency: "ARS",
      month: "2026-10",
      anchor: "2026-10-31",
    });
    expect(report.rows).toEqual([]);
    expect(report.totalDebt).toBe("0.00");
    expect(report.dti).toMatchObject({ monthlyCommitment: "0.00", planCount: 0 });

    // El patrimonio tampoco cambia por prestar: el activo reemplaza a la plata.
    const worth = await getNetWorth(db, { currency: "ARS", asOf: "2026-10-31" });
    expect(worth.assets.toFixed(2)).toBe("100000.00");
    expect(worth.liabilities.toFixed(2)).toBe("0.00");
    expect(worth.net.toFixed(2)).toBe("100000.00");

    // ── Cobrar la cuota 1: el capital vuelve (transferencia inversa) y el
    // interés es un INGRESO real, pero entra al banco — NUNCA a la cuenta por
    // cobrar (el trigger lo prohíbe aparte).
    const first = rows[0];
    const cobro = await payLoanInstallment(
      db,
      {
        accountId: receivable.id,
        cashAccountId: bank.id,
        date: "2026-11-15",
        installmentNumber: 1,
        extraCapital: null,
        cancel: false,
        categoryName: null,
      },
      { today: TODAY },
    );

    expect(cobro.created).toBe(true);
    expect(cobro.principalPaid).toBe(first.principal.toFixed(2));
    expect(cobro.interestPaid).toBe(first.interest.toFixed(2));
    expect(cobro.movements).toHaveLength(2);
    expect(cobro.movements[0]).toMatchObject({
      kind: "TRANSFER",
      amount: first.principal.toFixed(2),
    });
    expect(cobro.movements[0].account.id).toBe(receivable.id);
    expect(cobro.movements[0].toAccount?.id).toBe(bank.id);
    expect(cobro.movements[1]).toMatchObject({
      kind: "INCOME",
      amount: first.interest.toFixed(2),
    });
    expect(cobro.movements[1].account.id).toBe(bank.id);

    // La categoría del interés cobrado es de INGRESO: es plata que entra. Si
    // fuera la misma que usa el interés que se PAGA ("Intereses", un Gasto),
    // el movimiento sería imposible — y la base lo rechaza.
    expect(cobro.movements[1].category?.name).toBe("Intereses cobrados");
    expect(cobro.movements[1].category?.kind).toBe("INCOME");

    // La vista: dirección invertida, sin "deuda", con lo que te deben.
    const { loans } = await getLoansView(db, { today: TODAY });
    expect(loans).toHaveLength(1);
    const view = loans[0];
    expect(view.kind).toBe("RECEIVABLE");
    expect(view.direction).toBe("OWED_TO_ME");
    expect(view.debt).toBeNull();
    expect(view.capitalPaid).toBe(first.principal.toFixed(2));
    expect(view.plan?.paidCount).toBe(1);
    expect(view.receivable).toBe(
      money("100000").minus(first.principal).toFixed(2),
    );

    // Un INCOME directo a la cuenta por cobrar inflaría un activo sin plata.
    // La categoría se pide con upsert: el cobro de la cuota ya la creó (misma
    // normalización de nombre), y un create chocaría con su unicidad.
    const categoria = await db.category.upsert({
      where: { normalizedName: "intereses cobrados" },
      update: {},
      create: {
        name: "Intereses cobrados",
        normalizedName: "intereses cobrados",
        kind: "INCOME",
      },
    });
    await expect(
      db.movement.create({
        data: {
          kind: "INCOME",
          amount: "1000",
          date: calendarToDb("2026-11-20"),
          accountId: receivable.id,
          categoryId: categoria.id,
        },
      }),
    ).rejects.toThrow(/pasivo_no_recibe_ingreso/);
  });

  it("el rotativo no acepta cuotas por la ruta y se cancela pagando el capital", async () => {
    const bank = await db.account.create({
      data: { name: "Banco", kind: "BANK", openingBalance: "200000" },
    });
    const revolving = await createLoanAccount(db, {
      name: "Línea rotativa",
      kind: "LOAN",
      currency: "ARS",
      openingBalance: "0",
      system: "INTEREST_ONLY",
      principal: money("100000"),
      tnaPercent: money("60"),
      installmentCount: 12,
      firstInstallmentDate: FIRST,
      imported: null,
    });

    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "100000",
        date: calendarToDb("2026-10-05"),
        accountId: revolving.id,
        toAccountId: bank.id,
        description: "Desembolso del rotativo",
      },
    });

    // Pagar "una cuota" no puede: el interés no toca el saldo y la cobertura no
    // se puede derivar (un doble toque sería indetectable).
    await expect(
      payLoanInstallment(
        db,
        {
          accountId: revolving.id,
          cashAccountId: bank.id,
          date: "2026-11-15",
          installmentNumber: 1,
          extraCapital: null,
          cancel: false,
          categoryName: null,
        },
        { today: TODAY },
      ),
    ).rejects.toThrow(/solo interés/);

    // La vista: sin próxima cuota, interés "no se sabe" y compromisos de los
    // meses que vienen — pero NADA vencido (no hay fuente de verdad).
    const { loans } = await getLoansView(db, { today: TODAY });
    const view = loans[0];
    expect(view.system).toBe("INTEREST_ONLY");
    expect(view.nextInstallment).toBeNull();
    expect(view.interestPaid).toBeNull();
    expect(view.plan?.paidCount).toBe(0);
    expect(view.commitments?.overdue).toBe("0.00");
    expect(view.commitments?.overdueCount).toBe(0);
    expect(view.commitments?.next12Months).toBe("60000.00");

    // Cancelar: paga el capital entero (no pagado todavía), sin interés.
    const cancelacion = await payLoanInstallment(
      db,
      {
        accountId: revolving.id,
        cashAccountId: bank.id,
        date: "2026-11-20",
        installmentNumber: null,
        extraCapital: null,
        cancel: true,
        categoryName: null,
      },
      { today: TODAY },
    );
    expect(cancelacion.created).toBe(true);
    expect(cancelacion.principalPaid).toBe("100000.00");
    expect(cancelacion.movements).toHaveLength(1);

    const { loans: despues } = await getLoansView(db, { today: TODAY });
    expect(despues[0].plan?.paidCount).toBe(12);
    expect(despues[0].plan?.remainingCount).toBe(0);
    expect(despues[0].interestPaid).toBeNull();
    expect(despues[0].debt).toBe("0.00");
  });

  it("la curación completa las filas faltantes sin reescribir lo existente", async () => {
    // Cuenta con parámetros completos pero sin filas (creada antes de que el
    // alta materializara): la primera lectura las crea, idempotentemente.
    const loan = await db.account.create({
      data: {
        name: "Préstamo viejo",
        kind: "LOAN",
        currency: "ARS",
        principal: "500000",
        tnaPercent: "60",
        installmentCount: 12,
        firstInstallmentDate: calendarToDb(FIRST),
        amortizationSystem: "FRENCH",
      },
    });

    const { loans } = await getLoansView(db, { today: TODAY });
    const view = loans.find((item) => item.id === loan.id);
    expect(view?.installments).toHaveLength(12);
    expect(view?.plan?.payment).toBe("56412.71");
    expect(await db.installment.count({ where: { accountId: loan.id } })).toBe(12);

    // Segunda pasada: no agrega nada (skipDuplicates) ni pisa lo que hay.
    const created = await ensureLoanInstallments(db, {
      id: loan.id,
      principal: money("500000"),
      tnaPercent: money("60"),
      installmentCount: 12,
      firstInstallmentDate: calendarToDb(FIRST),
      amortizationSystem: "FRENCH",
    });
    expect(created).toBe(0);
  });

  it("un préstamo legado sin fecha no inventa cronograma: vista sin plan", async () => {
    const loan = await db.account.create({
      data: {
        name: "Préstamo legado",
        kind: "LOAN",
        currency: "ARS",
        principal: "500000",
        tnaPercent: "60",
        installmentCount: 12,
      },
    });

    const { loans } = await getLoansView(db, { today: TODAY });
    const view = loans.find((item) => item.id === loan.id);
    expect(view?.system).toBe("FRENCH");
    expect(view?.installments).toEqual([]);
    expect(view?.plan).toBeNull();
    expect(view?.commitments).toBeNull();
    expect(view?.nextInstallment).toBeNull();

    // Y pagar por API tampoco se puede: sin cuotas materializadas no hay
    // contrato que pagar (el mensaje manda a cargar parámetros o transferir).
    const bank = await db.account.create({
      data: { name: "Banco", kind: "BANK" },
    });
    await expect(
      payLoanInstallment(
        db,
        {
          accountId: loan.id,
          cashAccountId: bank.id,
          date: "2026-11-15",
          installmentNumber: 1,
          extraCapital: null,
          cancel: false,
          categoryName: null,
        },
        { today: TODAY },
      ),
    ).rejects.toThrow(/no tiene cronograma/);
  });

  it("la base rechaza cuotas imposibles (los CHECK del cronograma)", async () => {
    const loan = await db.account.create({
      data: {
        name: "Préstamo",
        kind: "LOAN",
        currency: "ARS",
        principal: "1000",
        tnaPercent: "60",
        installmentCount: 1,
      },
    });

    const base = {
      accountId: loan.id,
      number: 1,
      dueDate: calendarToDb(FIRST),
    };

    // Pago cero: una cuota de cero no es una cuota.
    await expect(
      db.installment.create({
        data: { ...base, payment: "0", interest: "0", principal: "0", remainingBalance: "0" },
      }),
    ).rejects.toThrow(/installment_payment_positive/);

    // Interés negativo.
    await expect(
      db.installment.create({
        data: {
          ...base,
          payment: "100",
          interest: "-1",
          principal: "101",
          remainingBalance: "1000",
        },
      }),
    ).rejects.toThrow(/installment_interest_nonnegative/);

    // La identidad del split: payment = interest + principal.
    await expect(
      db.installment.create({
        data: {
          ...base,
          payment: "100",
          interest: "60",
          principal: "50",
          remainingBalance: "900",
        },
      }),
    ).rejects.toThrow(/installment_split_matches_payment/);

    // Saldo negativo: un cronograma que "debe al revés" describe una quita.
    await expect(
      db.installment.create({
        data: {
          ...base,
          payment: "100",
          interest: "60",
          principal: "40",
          remainingBalance: "-1",
        },
      }),
    ).rejects.toThrow(/installment_remaining_nonnegative/);

    // Único por préstamo: dos cuotas con el mismo número no existen.
    await db.installment.create({
      data: {
        ...base,
        payment: "100",
        interest: "60",
        principal: "40",
        remainingBalance: "960",
      },
    });
    await expect(
      db.installment.create({
        data: {
          ...base,
          payment: "100",
          interest: "60",
          principal: "40",
          remainingBalance: "960",
        },
      }),
    ).rejects.toThrow();
  });

  it("la base admite el importado sin tasa y RECEIVABLE, y prohíbe el sistema fuera de préstamos", async () => {
    // IMPORTED sin tasa: la composición la dicta el cronograma del banco.
    const imported = await db.account.create({
      data: {
        name: "Importado",
        kind: "LOAN",
        currency: "ARS",
        principal: "1000",
        installmentCount: 1,
        amortizationSystem: "IMPORTED",
      },
    });
    expect(imported.id).toBeTruthy();

    // Un sistema de amortización en una cuenta que no es préstamo es una
    // promesa vacía.
    await expect(
      db.account.create({
        data: { name: "Caja", kind: "CASH", amortizationSystem: "FRENCH" },
      }),
    ).rejects.toThrow(/loan_parameters_only_on_loans/);

    // RECEIVABLE es una de las DOS cuentas de préstamo: parámetros completos.
    const receivable = await db.account.create({
      data: {
        name: "Préstamo dado",
        kind: "RECEIVABLE",
        currency: "ARS",
        principal: "1000",
        tnaPercent: "60",
        installmentCount: 1,
      },
    });
    expect(receivable.id).toBeTruthy();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * FASE 7 RONDA 2 · PLANTILLAS Y CSV
 * ═══════════════════════════════════════════════════════════════════════════ */

describeDb("Plantillas favoritas y plantillas · Fase 7 r2", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
    await db.$disconnect();
  });

  async function seedBase() {
    const { gastos, sueldo } = await seedCategories();
    const [bank, cash, card] = await Promise.all([
      db.account.create({
        data: { name: "Banco", kind: "BANK", openingBalance: "100000" },
      }),
      db.account.create({ data: { name: "Efectivo", kind: "CASH" } }),
      db.account.create({ data: { name: "Visa", kind: "CREDIT_CARD" } }),
    ]);
    return { gastos, sueldo, bank, cash, card };
  }

  function expenseFavorite(accountId: string, overrides: Record<string, unknown> = {}) {
    return parseFavoriteInput({
      name: "Café",
      kind: "EXPENSE",
      amount: "1500",
      description: "Café con leche",
      categoryName: "Comida",
      accountId,
      toAccountId: null,
      ...overrides,
    });
  }

  it("guarda, lista por último uso y borra sin tocar la historia", async () => {
    const { bank } = await seedBase();

    const first = await createFavorite(db, expenseFavorite(bank.id, { name: "Café" }));
    const second = await createFavorite(
      db,
      expenseFavorite(bank.id, { name: "Súper", amount: null }),
    );

    expect(first.amount).toBe("1500.00");
    expect(second.amount).toBeNull();
    // La categoría se creó con el tipo de la plantilla, una sola vez.
    expect(
      await db.category.count({ where: { normalizedName: "comida" } }),
    ).toBe(1);

    let list = await listFavorites(db);
    expect(list.map((favorite) => favorite.name)).toEqual(["Súper", "Café"]);
    expect(list.every((favorite) => favorite.lastUsedAt === null)).toBe(true);

    await touchFavorite(db, first.id);
    list = await listFavorites(db);
    expect(list[0].name).toBe("Café");
    expect(list[0].lastUsedAt).toBeTruthy();

    // Un movimiento cargado con la plantilla es historia propia: borrar la
    // plantilla no lo borra.
    await db.movement.create({
      data: {
        kind: "EXPENSE",
        amount: "1500",
        date: calendarToDb("2026-08-01"),
        description: "Café con leche",
        accountId: bank.id,
      },
    });
    await deleteFavorite(db, first.id);
    expect(await db.movement.count()).toBe(1);
    expect((await listFavorites(db)).map((favorite) => favorite.name)).toEqual([
      "Súper",
    ]);
  });

  it("rechaza nombres duplicados sin importar acentos ni mayúsculas", async () => {
    const { bank } = await seedBase();
    await createFavorite(db, expenseFavorite(bank.id, { name: "Café" }));

    await expect(
      createFavorite(db, expenseFavorite(bank.id, { name: "cafe" })),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("aplica el tope de plantillas", async () => {
    const { bank } = await seedBase();

    for (let index = 0; index < FAVORITES_MAX; index += 1) {
      await createFavorite(
        db,
        expenseFavorite(bank.id, { name: `Plantilla ${index + 1}`, amount: null }),
      );
    }

    await expect(
      createFavorite(db, expenseFavorite(bank.id, { name: "Una más" })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("valida monto, nombre, destino y tipo antes de escribir", async () => {
    const { bank, cash } = await seedBase();

    expect(() => expenseFavorite(bank.id, { amount: "0" })).toThrow(/mayor a cero/);
    expect(() => expenseFavorite(bank.id, { amount: "-5" })).toThrow(/mayor a cero/);
    expect(() => expenseFavorite(bank.id, { amount: "1,999" })).toThrow(/dos decimales/);
    expect(() => expenseFavorite(bank.id, { name: "   " })).toThrow(/nombre/);
    expect(() => expenseFavorite(bank.id, { name: "x".repeat(41) })).toThrow(/40/);
    expect(() =>
      expenseFavorite(bank.id, { description: "x".repeat(201) }),
    ).toThrow(/200/);

    expect(() =>
      parseFavoriteInput({
        name: "Transfer",
        kind: "TRANSFER",
        amount: null,
        description: "",
        categoryName: null,
        accountId: bank.id,
        toAccountId: bank.id,
      }),
    ).toThrow(/distinta/);
    expect(() =>
      parseFavoriteInput({
        name: "Transfer",
        kind: "TRANSFER",
        amount: null,
        description: "",
        categoryName: null,
        accountId: bank.id,
        toAccountId: null,
      }),
    ).toThrow(/destino/);
    expect(() =>
      parseFavoriteInput({
        name: "Gasto",
        kind: "EXPENSE",
        amount: null,
        description: "",
        categoryName: null,
        accountId: bank.id,
        toAccountId: cash.id,
      }),
    ).toThrow(/no lleva cuenta de destino/);
  });

  it("rechaza cuentas archivadas, ingresos a tarjeta y categorías del tipo contrario", async () => {
    const { bank, cash, card, gastos } = await seedBase();

    await db.account.update({
      where: { id: cash.id },
      data: { archived: true },
    });
    await expect(
      createFavorite(db, expenseFavorite(cash.id)),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      createFavorite(
        db,
        expenseFavorite(card.id, {
          name: "Ingreso a tarjeta",
          kind: "INCOME",
          categoryName: "Sueldo",
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      createFavorite(
        db,
        expenseFavorite(bank.id, {
          name: "Categoría cruzada",
          categoryName: gastos.name,
          kind: "INCOME",
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("la base hace cumplir la forma, el monto y el nombre de la plantilla", async () => {
    const { bank, cash } = await seedBase();

    await expect(
      db.favoriteTemplate.create({
        data: {
          name: "Misma cuenta",
          normalizedName: "misma cuenta",
          kind: "TRANSFER",
          accountId: bank.id,
          toAccountId: bank.id,
        },
      }),
    ).rejects.toThrow(/favorite_shape_by_kind/);

    await expect(
      db.favoriteTemplate.create({
        data: {
          name: "Monto cero",
          normalizedName: "monto cero",
          kind: "EXPENSE",
          amount: "0",
          accountId: bank.id,
        },
      }),
    ).rejects.toThrow(/favorite_amount_positive/);

    await expect(
      db.favoriteTemplate.create({
        data: {
          name: "   ",
          normalizedName: "   ",
          kind: "EXPENSE",
          accountId: bank.id,
        },
      }),
    ).rejects.toThrow(/favorite_name_valid/);

    await db.favoriteTemplate.create({
      data: {
        name: "Válida",
        normalizedName: "valida",
        kind: "TRANSFER",
        accountId: bank.id,
        toAccountId: cash.id,
      },
    });
    await expect(
      db.favoriteTemplate.create({
        data: {
          name: "Otra",
          normalizedName: "valida",
          kind: "EXPENSE",
          accountId: bank.id,
        },
      }),
    ).rejects.toThrow();
  });

  it("borrar la categoría deja la plantilla sin categoría; borrar la cuenta la elimina", async () => {
    const { bank, gastos } = await seedBase();
    const favorite = await createFavorite(db, expenseFavorite(bank.id));

    await db.category.delete({ where: { normalizedName: "comida" } });
    expect(
      (await db.favoriteTemplate.findUnique({ where: { id: favorite.id } }))
        ?.categoryId,
    ).toBeNull();

    await db.account.delete({ where: { id: bank.id } });
    expect(
      await db.favoriteTemplate.findUnique({ where: { id: favorite.id } }),
    ).toBeNull();
  });
});

describeDb("Importación CSV · Fase 7 r2", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
    await db.$disconnect();
  });

  async function seedBase() {
    const { gastos, sueldo } = await seedCategories();
    const [bank, cash] = await Promise.all([
      db.account.create({
        data: { name: "Banco", kind: "BANK", openingBalance: "100000" },
      }),
      db.account.create({ data: { name: "Efectivo", kind: "CASH" } }),
    ]);
    return { gastos, sueldo, bank, cash };
  }

  function csv(rows: string[]) {
    return [
      "fecha,tipo,monto,cuenta,cuenta_destino,categoria,descripcion",
      ...rows,
    ].join("\n");
  }

  it("clasifica filas y calcula totales sólo de las importables", async () => {
    await seedBase();
    const text = csv([
      "2026-08-01,ingreso,1000,Banco,,Sueldo,Agosto",
      '2026-08-02,gasto,"1.234,56",Banco,,Comida,Súper',
      "2026-08-03,transferencia,500,Banco,Efectivo,,Cajero",
      "2026-08-04,gasto,0,Banco,,Comida,Monto inválido",
      ",,,,,",
    ]);

    const { preview } = await analyzeCsv(db, text);

    expect(preview.totalRows).toBe(5);
    expect(preview.importableRows).toBe(3);
    expect(preview.invalidRows).toBe(1);
    expect(preview.duplicateRows).toBe(0);
    expect(preview.emptyRows).toBe(1);
    expect(preview.totals).toEqual({
      income: "1000.00",
      expenses: "1234.56",
      transfers: "500.00",
      count: 3,
      // El total declara su unidad: no es un número suelto que podría sumar
      // pesos con dólares (Fase 4.3).
      currency: "ARS",
    });
    expect(preview.categoriesToCreate).toEqual([
      { name: "Comida", kind: "EXPENSE" },
    ]);
  });

  it("importa todo en una transacción y concilia al centavo", async () => {
    const { bank, cash } = await seedBase();
    const text = csv([
      "2026-08-01,ingreso,1000,Banco,,Sueldo,Agosto",
      '2026-08-02,gasto,"1.234,56",Banco,,Comida,Súper',
      "2026-08-03,transferencia,500,Banco,Efectivo,,Cajero",
    ]);

    const { preview } = await analyzeCsv(db, text);
    const result = await importCsv(db, text, parseCsvExpected(preview.totals));

    expect(result.imported).toBe(3);
    expect(result.skippedDuplicates).toBe(0);
    expect(result.totals).toEqual({
      income: "1000.00",
      expenses: "1234.56",
      transfers: "500.00",
      count: 3,
      currency: "ARS",
    });
    expect(result.categoriesCreated).toHaveLength(1);
    expect(await db.movement.count()).toBe(3);

    const expenses = await db.movement.aggregate({
      where: { kind: "EXPENSE" },
      _sum: { amount: true },
    });
    expect(expenses._sum.amount?.toFixed(2)).toBe("1234.56");
    expect(
      await db.category.count({ where: { normalizedName: "comida" } }),
    ).toBe(1);

    // Reimportar el mismo archivo: todas duplicadas, no se escribe nada.
    const again = await analyzeCsv(db, text);
    expect(again.preview.duplicateRows).toBe(3);
    expect(again.preview.importableRows).toBe(0);
    await expect(
      importCsv(db, text, parseCsvExpected(again.preview.totals)),
    ).rejects.toMatchObject({ status: 422 });
    expect(await db.movement.count()).toBe(3);
  });

  it("avisa y omite duplicados dentro del mismo archivo", async () => {
    await seedBase();
    const text = csv([
      "2026-08-05,gasto,300,Banco,,Comida,Una vez",
      "2026-08-05,gasto,300,Banco,,Comida,Una vez",
    ]);

    const { preview } = await analyzeCsv(db, text);
    expect(preview.importableRows).toBe(1);
    expect(preview.duplicateRows).toBe(1);

    const result = await importCsv(db, text, parseCsvExpected(preview.totals));
    expect(result.imported).toBe(1);
    expect(result.skippedDuplicates).toBe(1);
    expect(await db.movement.count()).toBe(1);
  });

  it("no importa nada si una fila no valida", async () => {
    await seedBase();
    const text = csv([
      "2026-08-06,gasto,100,Banco,,Comida,Bien",
      "2026-02-31,gasto,200,Banco,,Comida,Fecha imposible",
    ]);

    const { preview } = await analyzeCsv(db, text);
    expect(preview.invalidRows).toBe(1);
    expect(preview.importableRows).toBe(1);

    await expect(
      importCsv(db, text, parseCsvExpected(preview.totals)),
    ).rejects.toMatchObject({ status: 422 });
    expect(await db.movement.count()).toBe(0);
  });

  it("rechaza un preview que no coincide con el archivo", async () => {
    await seedBase();
    const original = csv(["2026-08-07,gasto,100,Banco,,Comida,Uno"]);
    const { preview } = await analyzeCsv(db, original);
    const expected = parseCsvExpected(preview.totals);

    const changed = csv(["2026-08-07,gasto,999,Banco,,Comida,Uno"]);
    await expect(importCsv(db, changed, expected)).rejects.toMatchObject({
      status: 409,
    });
    expect(await db.movement.count()).toBe(0);
  });

  it("valida cuentas, destinos y categorías contra la base", async () => {
    const { cash, gastos } = await seedBase();
    await db.account.update({
      where: { id: cash.id },
      data: { archived: true },
    });

    const text = csv([
      "2026-08-08,gasto,100,NoExiste,,Comida,Sin cuenta",
      "2026-08-09,gasto,100,Efectivo,,Comida,Archivada",
      "2026-08-10,transferencia,100,Banco,Banco,,Mismo destino",
      `2026-08-11,ingreso,100,Banco,,${gastos.name},Categoría de gasto`,
    ]);

    const { preview } = await analyzeCsv(db, text);
    expect(preview.importableRows).toBe(0);
    expect(preview.invalidRows).toBe(4);
    const errors = preview.rows.flatMap((row) => row.errors).join(" ");
    expect(errors).toMatch(/no existe/);
    expect(errors).toMatch(/archivada/);
    expect(errors).toMatch(/distinta/);
    expect(errors).toContain(gastos.name);
  });

  it("rechaza el mismo nombre de categoría como ingreso y gasto en el archivo", async () => {
    await seedBase();
    const text = csv([
      "2026-08-12,ingreso,100,Banco,,Varios,Ingreso",
      "2026-08-13,gasto,100,Banco,,Varios,Gasto",
    ]);

    const { preview } = await analyzeCsv(db, text);
    expect(preview.importableRows).toBe(1);
    expect(preview.invalidRows).toBe(1);
    expect(preview.rows[1].errors.join(" ")).toMatch(/nombres distintos/);
  });

  it("permite un ingreso a una cuenta de dinero y lo rechaza en una de deuda", async () => {
    const { bank } = await seedBase();
    const card = await db.account.create({
      data: { name: "Visa", kind: "CREDIT_CARD" },
    });

    const text = csv([
      "2026-08-14,ingreso,100,Banco,,Sueldo,Bien",
      "2026-08-15,ingreso,100,Visa,,Sueldo,Mal",
    ]);
    const { preview } = await analyzeCsv(db, text);
    expect(preview.importableRows).toBe(1);
    expect(preview.invalidRows).toBe(1);
    expect(preview.rows[1].errors.join(" ")).toMatch(/cuenta de dinero/);

    const result = await importCsv(db, text.replace(/.*Visa.*\n?/, ""), {
      count: 1,
      income: "100.00",
      expenses: "0.00",
      transfers: "0.00",
    });
    expect(result.imported).toBe(1);
    expect(await db.movement.count({ where: { accountId: bank.id } })).toBe(1);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LA BANDERITA: «esta plata que declaré, contala como ingreso de este mes»
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * El escenario es el de la persona, con sus números: la cuenta "Efectivo" con
 * 7.000 de saldo inicial, un ingreso de 325.000 (Zully) y dos gastos que suman
 * 331.400. El patrimonio pasa de 7.000 a 600.
 *
 * Con la banderita APAGADA (el default, y el estado de toda cuenta que ya
 * existía) el mes da −6.400 de ahorro: el saldo inicial es un stock y no cuenta
 * como ganancia. Con la banderita TILDADA, el mismo mes da +600: los 7.000
 * declarados entran como ingreso de octubre.
 */
describeDb("La banderita del ingreso declarado", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
  });

  /**
   * El escenario de la persona: la cuenta, el ingreso y los dos gastos.
   *
   * `conBanderita` decide si la cuenta declara su saldo como ingreso de
   * octubre: es el ÚNICO cambio entre los dos caminos que se comparan.
   */
  async function seedEscenario(conBanderita: boolean) {
    const { gastos, sueldo } = await seedCategories();

    const efectivo = await db.account.create({
      data: {
        name: "Efectivo",
        kind: "CASH",
        openingBalance: "7000",
        ...(conBanderita
          ? { openingIncomeMonth: calendarToDb("2026-10-01") }
          : {}),
      },
    });

    await db.movement.createMany({
      data: [
        {
          kind: "INCOME",
          amount: "325000",
          date: calendarToDb("2026-10-19"),
          accountId: efectivo.id,
          categoryId: sueldo.id,
          description: "Zully",
        },
        {
          kind: "EXPENSE",
          amount: "325000",
          date: calendarToDb("2026-10-20"),
          accountId: efectivo.id,
          categoryId: gastos.id,
          description: "Alquiler",
        },
        {
          kind: "EXPENSE",
          amount: "6400",
          date: calendarToDb("2026-10-20"),
          accountId: efectivo.id,
          categoryId: gastos.id,
          description: "Kiosco",
        },
      ],
    });

    return { efectivo };
  }

  const octubre = {
    where: { date: { gte: calendarToDb("2026-10-01"), lte: calendarToDb("2026-10-31") } },
    period: { from: "2026-10-01", to: "2026-10-31" },
  };

  it("APAGADA (el default): el ingreso del mes es el de los movimientos y el ahorro es −6.400", async () => {
    await seedEscenario(false);

    const totals = await periodTotals(db, octubre.where, octubre.period, "ARS");

    expect(totals.income).toBe("325000.00");
    expect(totals.declaredIncome).toBe("0.00");
    expect(totals.expenses).toBe("331400.00");
    // El ahorro del mes: 325.000 − 331.400. El saldo inicial NO es ganancia.
    expect(money(totals.income).minus(totals.expenses).toFixed(2)).toBe("-6400.00");
  });

  it("TILDADA: el ingreso del mes suma el saldo declarado (332.000) y el ahorro queda en +600", async () => {
    await seedEscenario(true);

    const totals = await periodTotals(db, octubre.where, octubre.period, "ARS");

    expect(totals.income).toBe("332000.00");
    expect(totals.declaredIncome).toBe("7000.00");
    expect(totals.expenses).toBe("331400.00");
    expect(money(totals.income).minus(totals.expenses).toFixed(2)).toBe("600.00");
    // El conteo de movimientos NO cambia: la plata declarada no es un
    // movimiento (y por eso no puede contarse dos veces).
    expect(totals.incomeCount).toBe(1);
  });

  it("la plata declarada cuenta en SU mes y en ninguno más", async () => {
    await seedEscenario(true);

    const septiembre = await periodTotals(
      db,
      { date: { gte: calendarToDb("2026-09-01"), lte: calendarToDb("2026-09-30") } },
      { from: "2026-09-01", to: "2026-09-30" },
      "ARS",
    );
    const noviembre = await periodTotals(
      db,
      { date: { gte: calendarToDb("2026-11-01"), lte: calendarToDb("2026-11-30") } },
      { from: "2026-11-01", to: "2026-11-30" },
      "ARS",
    );

    expect(septiembre.declaredIncome).toBe("0.00");
    expect(noviembre.declaredIncome).toBe("0.00");
    expect(septiembre.income).toBe("0.00");
  });

  it("un saldo NEGATIVO no es ingreso: es un pasivo (y la base no lo deja declarar)", async () => {
    // El pasivo: una cuenta de dinero con saldo negativo (plata que debés).
    await expect(
      db.account.create({
        data: {
          name: "Debo",
          kind: "CASH",
          openingBalance: "-1000",
          openingIncomeMonth: calendarToDb("2026-10-01"),
        },
      }),
    ).rejects.toThrow(/opening_income_month_check/);
  });

  it("una tarjeta o un préstamo NO pueden declarar su saldo como ingreso (la base lo rechaza)", async () => {
    await expect(
      db.account.create({
        data: {
          name: "Visa",
          kind: "CREDIT_CARD",
          openingBalance: "500000",
          openingIncomeMonth: calendarToDb("2026-10-01"),
        },
      }),
    ).rejects.toThrow(/opening_income_month_check/);

    await expect(
      db.account.create({
        data: {
          name: "Prestamo",
          kind: "LOAN",
          currency: "ARS",
          openingBalance: "500000",
          openingIncomeMonth: calendarToDb("2026-10-01"),
        },
      }),
    ).rejects.toThrow(/opening_income_month_check/);
  });

  it("un saldo en cero tampoco se puede declarar (no hay plata declarada)", async () => {
    await expect(
      db.account.create({
        data: {
          name: "Vacia",
          kind: "CASH",
          openingBalance: "0",
          openingIncomeMonth: calendarToDb("2026-10-01"),
        },
      }),
    ).rejects.toThrow(/opening_income_month_check/);
  });

  it("la reconciliación SIGUE cuadrando y explica la plata declarada", async () => {
    await seedEscenario(true);

    const rec = await getMonthReconciliation(db, { currency: "ARS",
      month: "2026-10",
      anchor: "2026-10-31",
    });

    // El patrimonio bajó 6.400 (de 7.000 a 600)...
    expect(rec.netStart).toBe("7000.00");
    expect(rec.netEnd).toBe("600.00");
    expect(rec.netDelta).toBe("-6400.00");
    // ...pero el ahorro del mes es +600, porque los 7.000 declarados son
    // ingreso de octubre.
    expect(rec.saving).toBe("600.00");
    expect(rec.declaredIncome).toBe("7000.00");
    // La diferencia es la plata declarada: la identidad del mes es
    // ΔPatrimonio = Ahorro − PlataDeclarada.
    expect(rec.difference).toBe("0.00");
    expect(rec.balanced).toBe(true);
  });

  it("sin la banderita, la reconciliación de octubre es la de siempre (0,00 de diferencia)", async () => {
    await seedEscenario(false);

    const rec = await getMonthReconciliation(db, { currency: "ARS",
      month: "2026-10",
      anchor: "2026-10-31",
    });

    expect(rec.saving).toBe("-6400.00");
    expect(rec.declaredIncome).toBe("0.00");
    expect(rec.difference).toBe("0.00");
    expect(rec.balanced).toBe(true);
  });

  it("el patrimonio NO cambia por la banderita: el saldo de la cuenta es el mismo", async () => {
    await seedEscenario(true);

    const balances = await getAccountBalances(db, {});
    const efectivo = balances.find((b) => b.name === "Efectivo");

    // 7.000 + 325.000 − 325.000 − 6.400 = 600
    expect(efectivo?.balance.toFixed(2)).toBe("600.00");
    expect(efectivo?.openingIncomeMonth).toBe("2026-10");
  });
});

/* ═════════════════════════════════════════════════════════════════════════════
 * FASE 4 · MONEDAS
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Los invariantes de `20261104120000_fase4_monedas` están escritos en SQL. Acá
 * se intenta guardar exactamente lo que la base dice que no se puede guardar.
 *
 * Se agregan a ESTE archivo y no a uno nuevo a propósito: dos archivos de
 * integración corren en workers distintos de vitest y comparten la misma base
 * de test; el `resetDatabase()` de uno borraría las filas del otro a mitad de
 * camino. Un archivo, un dueño de la base.
 * ═════════════════════════════════════════════════════════════════════════════ */
describeDb("Fase 4 · monedas", () => {
  beforeEach(async () => {
    await resetDatabase();
    await db.appSettings.update({
      where: { id: 1 },
      data: { enabledCurrencies: ["ARS"] },
    });
  });

  async function createAccount(
    name: string,
    currency: "ARS" | "USD",
    kind: "CASH" | "BANK" = "CASH",
  ) {
    return db.account.create({ data: { name, kind, currency } });
  }

  describe("transferencias entre monedas", () => {
    it("rechaza una transferencia entre monedas sin monto de destino", async () => {
      const origen = await createAccount("Caja pesos", "ARS");
      const destino = await createAccount("Caja dólares", "USD");

      await expect(
        db.movement.create({
          data: {
            kind: "TRANSFER",
            amount: "120000",
            date: calendarToDb("2026-11-01"),
            accountId: origen.id,
            toAccountId: destino.id,
          },
        }),
      ).rejects.toThrow(/transferencia_entre_monedas_sin_monto_destino/);
    });

    it("rechaza un monto de destino en una transferencia de la misma moneda", async () => {
      const origen = await createAccount("Banco pesos", "ARS", "BANK");
      const destino = await createAccount("Caja pesos", "ARS");

      await expect(
        db.movement.create({
          data: {
            kind: "TRANSFER",
            amount: "10000",
            toAmount: "10000",
            date: calendarToDb("2026-11-01"),
            accountId: origen.id,
            toAccountId: destino.id,
          },
        }),
      ).rejects.toThrow(/monto_destino_en_misma_moneda/);
    });

    it("acepta una transferencia de la misma moneda sin monto de destino", async () => {
      const origen = await createAccount("Banco pesos", "ARS", "BANK");
      const destino = await createAccount("Caja pesos", "ARS");

      const movement = await db.movement.create({
        data: {
          kind: "TRANSFER",
          amount: "10000",
          date: calendarToDb("2026-11-01"),
          accountId: origen.id,
          toAccountId: destino.id,
        },
      });

      expect(movement.toAmount).toBeNull();
    });

    it("acepta una transferencia entre monedas con monto de destino", async () => {
      const origen = await createAccount("Banco pesos", "ARS", "BANK");
      const destino = await createAccount("Caja dólares", "USD");

      const movement = await db.movement.create({
        data: {
          kind: "TRANSFER",
          amount: "120000",
          toAmount: "100",
          date: calendarToDb("2026-11-01"),
          accountId: origen.id,
          toAccountId: destino.id,
        },
      });

      expect(movement.toAmount?.toFixed(2)).toBe("100.00");
    });

    it("rechaza un monto de destino en un gasto", async () => {
      const cuenta = await createAccount("Caja pesos", "ARS");
      const { gastos } = await seedCategories();

      await expect(
        db.movement.create({
          data: {
            kind: "EXPENSE",
            amount: "5000",
            toAmount: "1",
            date: calendarToDb("2026-11-01"),
            accountId: cuenta.id,
            categoryId: gastos.id,
          },
        }),
      ).rejects.toThrow(/movement_to_amount_only_on_transfer/);
    });

    it("rechaza un monto de destino que no es positivo", async () => {
      const origen = await createAccount("Banco pesos", "ARS", "BANK");
      const destino = await createAccount("Caja dólares", "USD");

      await expect(
        db.movement.create({
          data: {
            kind: "TRANSFER",
            amount: "120000",
            toAmount: "0",
            date: calendarToDb("2026-11-01"),
            accountId: origen.id,
            toAccountId: destino.id,
          },
        }),
      ).rejects.toThrow(/movement_to_amount_positive/);
    });
  });

  describe("la moneda de una cuenta", () => {
    it("no se puede cambiar si la cuenta ya tiene historia", async () => {
      const cuenta = await createAccount("Caja", "ARS");
      await db.movement.create({
        data: {
          kind: "INCOME",
          amount: "1000",
          date: calendarToDb("2026-11-01"),
          accountId: cuenta.id,
        },
      });

      await expect(
        db.account.update({
          where: { id: cuenta.id },
          data: { currency: "USD" },
        }),
      ).rejects.toThrow(/cuenta_en_uso_no_cambia_moneda/);
    });

    it("se puede corregir mientras la cuenta no tenga historia", async () => {
      const cuenta = await createAccount("Caja", "ARS");

      const actualizada = await db.account.update({
        where: { id: cuenta.id },
        data: { currency: "USD" },
      });

      expect(actualizada.currency).toBe("USD");
    });

    it("permite el mismo nombre en monedas distintas y lo rechaza en la misma", async () => {
      await createAccount("Efectivo", "ARS");
      await createAccount("Efectivo", "USD");

      await expect(createAccount("Efectivo", "ARS")).rejects.toThrow();
    });
  });

  describe("preferencias de monedas", () => {
    it("arranca con una sola fila habilitando pesos", async () => {
      const settings = await db.appSettings.findMany();

      expect(settings).toHaveLength(1);
      expect(settings[0]?.enabledCurrencies).toEqual(["ARS"]);
    });

    it("no admite una segunda fila", async () => {
      await expect(db.appSettings.create({ data: { id: 2 } })).rejects.toThrow(
        /app_settings_singleton/,
      );
    });

    it("no admite quedarse sin ninguna moneda habilitada", async () => {
      await expect(
        db.appSettings.update({
          where: { id: 1 },
          data: { enabledCurrencies: [] },
        }),
      ).rejects.toThrow(/app_settings_at_least_one_currency/);
    });
  });

  describe("compatibilidad con los datos que ya existían", () => {
    it("las cuentas y movimientos del escenario quedan en pesos y sin monto de destino", async () => {
      await seedScenario();

      const cuentas = await db.account.findMany();
      const movimientos = await db.movement.findMany();

      expect(cuentas.length).toBeGreaterThan(0);
      expect(cuentas.every((cuenta) => cuenta.currency === "ARS")).toBe(true);
      expect(movimientos.length).toBeGreaterThan(0);
      expect(movimientos.every((movimiento) => movimiento.toAmount === null)).toBe(
        true,
      );
    });
  });

  describe("presupuestos por moneda", () => {
    it("admite el mismo mes y categoría en dos monedas y rechaza el duplicado", async () => {
      const { gastos } = await seedCategories();
      const mes = calendarToDb("2026-11-01");

      await db.budget.create({
        data: { month: mes, amount: "1000", categoryId: gastos.id, currency: "ARS" },
      });

      await db.budget.create({
        data: { month: mes, amount: "100", categoryId: gastos.id, currency: "USD" },
      });

      await expect(
        db.budget.create({
          data: {
            month: mes,
            amount: "2000",
            categoryId: gastos.id,
            currency: "ARS",
          },
        }),
      ).rejects.toThrow();
    });
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * FASE 4.2 · CONSULTAS POR MONEDA
 * ─────────────────────────────────────────────────────────────────────────────
 * Los invariantes de la Fase 4.1 garantizan que una transferencia entre
 * monedas dice cuánto llega. Acá se verifica lo otro: que NINGUNA consulta sume
 * pesos con dólares. El escenario mezcla las dos monedas a propósito; cada
 * assertion es un número que la versión anterior (sin scoping) devolvía mal.
 * ───────────────────────────────────────────────────────────────────────────── */
describeDb("Fase 4.2 · consultas por moneda", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  async function createAccount(
    name: string,
    currency: "ARS" | "USD",
    kind: "CASH" | "BANK" | "CREDIT_CARD" | "LOAN" = "CASH",
    openingBalance = "0",
    extra: {
      archived?: boolean;
      principal?: string;
      tnaPercent?: string;
      installmentCount?: number;
      firstInstallmentDate?: Date;
      openingIncomeMonth?: Date;
    } = {},
  ) {
    return db.account.create({
      data: { name, kind, currency, openingBalance, ...extra },
    });
  }

  it("movementTotals no incluye movimientos de otra moneda", async () => {
    const pesos = await createAccount("Caja pesos", "ARS");
    const dolares = await createAccount("Caja dólares", "USD");
    const { gastos, sueldo } = await seedCategories();

    await db.movement.createMany({
      data: [
        {
          kind: "INCOME",
          amount: "1000",
          date: calendarToDb("2026-10-01"),
          accountId: pesos.id,
          categoryId: sueldo.id,
        },
        {
          kind: "EXPENSE",
          amount: "200",
          date: calendarToDb("2026-10-02"),
          accountId: pesos.id,
          categoryId: gastos.id,
        },
        {
          kind: "INCOME",
          amount: "10",
          date: calendarToDb("2026-10-03"),
          accountId: dolares.id,
          categoryId: sueldo.id,
        },
        {
          kind: "EXPENSE",
          amount: "2",
          date: calendarToDb("2026-10-04"),
          accountId: dolares.id,
          categoryId: gastos.id,
        },
      ],
    });

    const ars = await movementTotals(db, {}, "ARS");
    expect(ars.income).toBe("1000.00");
    expect(ars.expenses).toBe("200.00");
    expect(ars.incomeCount).toBe(1);
    expect(ars.expenseCount).toBe(1);

    const usd = await movementTotals(db, {}, "USD");
    expect(usd.income).toBe("10.00");
    expect(usd.expenses).toBe("2.00");
    expect(usd.incomeCount).toBe(1);
    expect(usd.expenseCount).toBe(1);
  });

  it("una transferencia ARS→USD baja el flujo ARS y sube el flujo USD", async () => {
    const banco = await createAccount("Banco pesos", "ARS", "BANK");
    const cajaUsd = await createAccount("Caja dólares", "USD");

    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "120000",
        toAmount: "100",
        date: calendarToDb("2026-10-05"),
        accountId: banco.id,
        toAccountId: cajaUsd.id,
      },
    });

    expect(await movementCashFlow(db, {}, "ARS")).toBe("-120000.00");
    expect(await movementCashFlow(db, {}, "USD")).toBe("100.00");

    // La pata que ENTRA a la cuenta en dólares vale `toAmount`, no `amount`:
    // acreditar 120.000 acá sería el bug que esta fase elimina.
    const balances = await getAccountBalances(db);
    expect(
      balances.find((balance) => balance.id === cajaUsd.id)?.balance.toFixed(2),
    ).toBe("100.00");
    expect(
      balances.find((balance) => balance.id === banco.id)?.balance.toFixed(2),
    ).toBe("-120000.00");
  });

  it("una transferencia USD→ARS baja el flujo USD y sube el ARS por toAmount", async () => {
    const cajaUsd = await createAccount("Caja dólares", "USD");
    const banco = await createAccount("Banco pesos", "ARS", "BANK");

    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "50",
        toAmount: "60000",
        date: calendarToDb("2026-10-06"),
        accountId: cajaUsd.id,
        toAccountId: banco.id,
      },
    });

    expect(await movementCashFlow(db, {}, "USD")).toBe("-50.00");
    expect(await movementCashFlow(db, {}, "ARS")).toBe("60000.00");
  });

  it("una transferencia ARS→ARS no toca el flujo en dólares", async () => {
    const banco = await createAccount("Banco pesos", "ARS", "BANK");
    const caja = await createAccount("Caja pesos", "ARS");

    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "10000",
        date: calendarToDb("2026-10-07"),
        accountId: banco.id,
        toAccountId: caja.id,
      },
    });

    expect(await movementCashFlow(db, {}, "USD")).toBe("0.00");
    // Mover plata entre dos cuentas propias no cambia la liquidez total.
    expect(await movementCashFlow(db, {}, "ARS")).toBe("0.00");
  });

  it("el patrimonio se calcula por moneda y no mezcla cuentas", async () => {
    await createAccount("Banco pesos", "ARS", "BANK", "100000");
    await createAccount("Caja pesos", "ARS", "CASH", "5000");
    await createAccount("Caja dólares", "USD", "CASH", "100");
    // Archivada: su plata sigue siendo tuya y sigue contando.
    await createAccount("Banco dólares", "USD", "BANK", "50", {
      archived: true,
    });
    await createAccount("Visa dólares", "USD", "CREDIT_CARD", "-20");

    const ars = await getNetWorth(db, { currency: "ARS" });
    expect(ars.assets.toFixed(2)).toBe("105000.00");
    expect(ars.liabilities.toFixed(2)).toBe("0.00");
    expect(ars.net.toFixed(2)).toBe("105000.00");

    const usd = await getNetWorth(db, { currency: "USD" });
    expect(usd.assets.toFixed(2)).toBe("150.00");
    expect(usd.liabilities.toFixed(2)).toBe("20.00");
    expect(usd.net.toFixed(2)).toBe("130.00");

    const blocks = await getNetWorthByCurrency(db);
    expect(
      blocks.map((block) => [
        block.currency,
        block.assets.toFixed(2),
        block.liabilities.toFixed(2),
        block.net.toFixed(2),
      ]),
    ).toEqual([
      ["ARS", "105000.00", "0.00", "105000.00"],
      ["USD", "150.00", "20.00", "130.00"],
    ]);
  });

  it("sin cuentas, el patrimonio por moneda es una lista vacía", async () => {
    expect(await getNetWorthByCurrency(db)).toEqual([]);
  });

  it("una moneda sin cuentas no devuelve la serie de la otra", async () => {
    // La serie se arma sólo con las cuentas de la moneda pedida. Si el conteo
    // previo mirara todas las cuentas, pedir USD en una base sin dólares
    // devolvería 12 fotos en pesos rotuladas como dólares: una historia que la
    // app no conoce, y el mismo error de unidad que esta fase elimina.
    await createAccount("Banco pesos", "ARS", "BANK", "100000");

    expect(
      await getNetWorthSeries(db, { currency: "USD", anchor: "2026-10-31" }),
    ).toEqual([]);

    const enPesos = await getNetWorthSeries(db, {
      currency: "ARS",
      anchor: "2026-10-31",
    });
    expect(enPesos).toHaveLength(12);
    expect(enPesos.at(-1)?.net).toBe("100000.00");
  });

  it("la torta y las barras de ARS no ven categorías gastadas sólo en USD", async () => {
    const pesos = await createAccount("Caja pesos", "ARS");
    const dolares = await createAccount("Caja dólares", "USD");
    const [gastosArs, gastosUsd] = await Promise.all([
      db.category.create({
        data: { name: "Gastos ARS", normalizedName: "gastos ars", kind: "EXPENSE" },
      }),
      db.category.create({
        data: { name: "Gastos USD", normalizedName: "gastos usd", kind: "EXPENSE" },
      }),
    ]);

    await db.movement.createMany({
      data: [
        {
          kind: "EXPENSE",
          amount: "200",
          date: calendarToDb("2026-10-02"),
          accountId: pesos.id,
          categoryId: gastosArs.id,
        },
        {
          kind: "EXPENSE",
          amount: "2",
          date: calendarToDb("2026-10-04"),
          accountId: dolares.id,
          categoryId: gastosUsd.id,
        },
      ],
    });

    const ars = await movementCategoryBreakdown(db, {}, "ARS");
    expect(ars).toHaveLength(1);
    expect(ars[0]?.name).toBe("Gastos ARS");
    expect(ars[0]?.amount).toBe("200.00");

    const usd = await movementCategoryBreakdown(db, {}, "USD");
    expect(usd).toHaveLength(1);
    expect(usd[0]?.name).toBe("Gastos USD");

    const arsByDate = await movementDateBreakdown(db, {}, "ARS");
    expect(arsByDate).toEqual([
      { date: "2026-10-02", kind: "EXPENSE", amount: "200.00" },
    ]);
  });

  it("la plata declarada se suma sólo en la moneda de su cuenta", async () => {
    await createAccount("Caja pesos", "ARS", "CASH", "7000", {
      openingIncomeMonth: calendarToDb("2026-10-01"),
    });
    await createAccount("Caja dólares", "USD", "CASH", "100", {
      openingIncomeMonth: calendarToDb("2026-10-01"),
    });

    const period = { from: "2026-10-01", to: "2026-10-31" };
    expect(
      (await declaredIncomeInPeriod(db, period, "ARS")).toFixed(2),
    ).toBe("7000.00");
    expect(
      (await declaredIncomeInPeriod(db, period, "USD")).toFixed(2),
    ).toBe("100.00");

    const ars = await periodTotals(db, {}, period, "ARS");
    expect(ars.declaredIncome).toBe("7000.00");
    expect(ars.income).toBe("7000.00");
    // La cuenta de pesos es la única que declaró en ARS; el conteo de
    // movimientos sigue en cero.
    expect(ars.incomeCount).toBe(0);
  });

  it("el burn no resta un gasto de otra moneda", async () => {
    const pesos = await createAccount("Caja pesos", "ARS");
    const dolares = await createAccount("Caja dólares", "USD");
    const { gastos } = await seedCategories();

    const [gastoArs, gastoUsd] = await Promise.all([
      db.movement.create({
        data: {
          kind: "EXPENSE",
          amount: "1200",
          date: calendarToDb("2026-10-02"),
          accountId: pesos.id,
          categoryId: gastos.id,
        },
      }),
      db.movement.create({
        data: {
          kind: "EXPENSE",
          amount: "12",
          date: calendarToDb("2026-10-03"),
          accountId: dolares.id,
          categoryId: gastos.id,
        },
      }),
    ]);

    const period = { from: "2026-10-01", to: "2026-10-31" };
    const arsCandidates = await movementBurnCandidates(db, period, "ARS");
    expect(arsCandidates.candidates.map((candidate) => candidate.id)).toEqual([
      gastoArs.id,
    ]);

    // El gasto en dólares no participa de la vista en pesos: ni siquiera se
    // puede pedir su burn ahí.
    expect(
      await movementBurn(db, { ...period, movementId: gastoUsd.id }, "ARS"),
    ).toBeNull();
    expect(
      await movementBurn(db, { ...period, movementId: gastoArs.id }, "ARS"),
    ).not.toBeNull();
  });

  it("la reconciliación en ARS no ve movimientos ni cuentas en USD", async () => {
    const banco = await createAccount("Banco pesos", "ARS", "BANK", "100000");
    const cajaUsd = await createAccount("Caja dólares", "USD", "CASH", "500");
    const { gastos, sueldo } = await seedCategories();

    await db.movement.createMany({
      data: [
        {
          kind: "INCOME",
          amount: "50000",
          date: calendarToDb("2026-10-01"),
          accountId: banco.id,
          categoryId: sueldo.id,
        },
        {
          kind: "EXPENSE",
          amount: "20000",
          date: calendarToDb("2026-10-03"),
          accountId: banco.id,
          categoryId: gastos.id,
        },
        {
          kind: "INCOME",
          amount: "1000",
          date: calendarToDb("2026-10-01"),
          accountId: cajaUsd.id,
          categoryId: sueldo.id,
        },
        {
          kind: "EXPENSE",
          amount: "400",
          date: calendarToDb("2026-10-03"),
          accountId: cajaUsd.id,
          categoryId: gastos.id,
        },
      ],
    });

    const ars = await getMonthReconciliation(db, {
      month: "2026-10",
      anchor: "2026-10-31",
      currency: "ARS",
    });
    expect(ars.netStart).toBe("100000.00");
    expect(ars.netEnd).toBe("130000.00");
    expect(ars.netDelta).toBe("30000.00");
    expect(ars.saving).toBe("30000.00");
    expect(ars.balanced).toBe(true);

    const usd = await getMonthReconciliation(db, {
      month: "2026-10",
      anchor: "2026-10-31",
      currency: "USD",
    });
    expect(usd.netStart).toBe("500.00");
    expect(usd.netEnd).toBe("1100.00");
    expect(usd.saving).toBe("600.00");
    expect(usd.balanced).toBe(true);
  });

  it("la reconciliación cuadra aunque haya una transferencia entre monedas", async () => {
    const banco = await createAccount("Banco pesos", "ARS", "BANK", "100000");
    const cajaUsd = await createAccount("Caja dólares", "USD");

    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "120000",
        toAmount: "100",
        date: calendarToDb("2026-10-05"),
        accountId: banco.id,
        toAccountId: cajaUsd.id,
      },
    });

    const ars = await getMonthReconciliation(db, {
      month: "2026-10",
      anchor: "2026-10-31",
      currency: "ARS",
    });
    expect(ars.netStart).toBe("100000.00");
    expect(ars.netEnd).toBe("-20000.00");
    expect(ars.netDelta).toBe("-120000.00");
    expect(ars.saving).toBe("0.00");
    expect(ars.difference).toBe("0.00");
    expect(ars.balanced).toBe(true);

    const usd = await getMonthReconciliation(db, {
      month: "2026-10",
      anchor: "2026-10-31",
      currency: "USD",
    });
    expect(usd.netStart).toBe("0.00");
    expect(usd.netEnd).toBe("100.00");
    expect(usd.netDelta).toBe("100.00");
    expect(usd.saving).toBe("0.00");
    expect(usd.difference).toBe("0.00");
    expect(usd.balanced).toBe(true);
  });

  it("el reporte de deudas en ARS no ve deudas ni ingresos en USD", async () => {
    await createAccount("Banco pesos", "ARS", "BANK", "0");
    await createAccount("Caja dólares", "USD", "CASH", "0");
    await createAccount("Préstamo pesos", "ARS", "LOAN", "-50000", {
      principal: "50000",
      tnaPercent: "60",
      installmentCount: 12,
    });
    await createAccount("Préstamo dólares", "USD", "LOAN", "-1000", {
      principal: "1000",
      tnaPercent: "10",
      installmentCount: 12,
    });
    const { sueldo } = await seedCategories();
    const banco = await db.account.findFirstOrThrow({
      where: { name: "Banco pesos" },
    });
    const cajaUsd = await db.account.findFirstOrThrow({
      where: { name: "Caja dólares" },
    });
    await db.movement.createMany({
      data: [
        {
          kind: "INCOME",
          amount: "10000",
          date: calendarToDb("2026-10-01"),
          accountId: banco.id,
          categoryId: sueldo.id,
        },
        {
          kind: "INCOME",
          amount: "1000",
          date: calendarToDb("2026-10-01"),
          accountId: cajaUsd.id,
          categoryId: sueldo.id,
        },
      ],
    });

    const ars = await getDebtReport(db, {
      month: "2026-10",
      anchor: "2026-10-31",
      currency: "ARS",
    });
    expect(ars.rows.map((row) => row.name)).toEqual(["Préstamo pesos"]);
    expect(ars.totalDebt).toBe("50000.00");
    expect(ars.dti.income).toBe("10000.00");

    const usd = await getDebtReport(db, {
      month: "2026-10",
      anchor: "2026-10-31",
      currency: "USD",
    });
    expect(usd.rows.map((row) => row.name)).toEqual(["Préstamo dólares"]);
    expect(usd.totalDebt).toBe("1000.00");
    expect(usd.dti.income).toBe("1000.00");
  });

  it("la vista de préstamos cuenta el capital pagado entre monedas con toAmount", async () => {
    const banco = await createAccount("Banco pesos", "ARS", "BANK");
    const cajaUsd = await createAccount("Caja dólares", "USD");
    const prestamo = await createAccount("Préstamo dólares", "USD", "LOAN", "-1000", {
      principal: "1000",
      tnaPercent: "10",
      installmentCount: 12,
      firstInstallmentDate: calendarToDb("2026-11-15"),
    });

    // 120.000 ARS → 100 USD: la pata que ENTRA al préstamo vale `toAmount`.
    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "120000",
        toAmount: "100",
        date: calendarToDb("2026-10-05"),
        accountId: banco.id,
        toAccountId: prestamo.id,
      },
    });
    // 50 USD → mismo préstamo: acá `amount` ya está en dólares.
    await db.movement.create({
      data: {
        kind: "TRANSFER",
        amount: "50",
        date: calendarToDb("2026-10-06"),
        accountId: cajaUsd.id,
        toAccountId: prestamo.id,
      },
    });

    const view = await getLoansView(db, { today: "2026-10-31" });
    const loan = view.loans.find((item) => item.id === prestamo.id);

    // Sumar `amount` daría 120.050 → clampeado a 1.000 (100 % pagado): una
    // mentira visible. El número correcto es 150 (15 %).
    expect(loan?.capitalPaid).toBe("150.00");
    expect(loan?.progressPercent).toBe("15.00");
  });

  it("el DTO de la cuenta dice en qué moneda está su saldo", async () => {
    const dolares = await createAccount("Caja dólares", "USD");
    const balances = await getAccountBalances(db);
    const balance = balances[0]!;
    const dto = toAccountDTO({
      id: balance.id,
      name: balance.name,
      kind: balance.kind,
      archived: balance.archived,
      currency: balance.currency,
      openingBalance: balance.opening,
    });

    expect(dolares.currency).toBe("USD");
    expect(dto.currency).toBe("USD");
  });
});

/* ═════════════════════════════════════════════════════════════════════════════
 * FASE 4.3 · ESCRITURA CON MONEDAS
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * La Fase 4.1 probó que la BASE se niega a guardar estados imposibles. Acá se
 * prueba el otro lado del mismo contrato: que la API deje ESCRIBIR dólares y el
 * monto de destino, y que rechace con un 4xx legible —nunca un 500— las
 * combinaciones que la base prohíbe.
 *
 * Los handlers de verdad se ejercen con `Request` reales y la base es
 * `finanzas_test` (ver el mock de `@/lib/prisma` arriba): un test que sólo
 * llamara al servicio no probaría el borde que la persona usa.
 * ═════════════════════════════════════════════════════════════════════════════ */
describeDb("Fase 4.3 · escritura con monedas", () => {
  beforeEach(async () => {
    await resetDatabase();
    // F4.4b: una cuenta sólo puede nacer en una moneda HABILITADA. Estos tests
    // ejercen el alta en dólares, así que habilitan las dos monedas primero.
    await db.appSettings.update({
      where: { id: 1 },
      data: { enabledCurrencies: ["ARS", "USD"] },
    });
    // `restoreMocks` del config de vitest limpia las implementaciones entre
    // tests: la sesión y el CSRF se reponen en cada uno.
    vi.mocked(dalModule.requireApiSession).mockResolvedValue({
      v: 1,
      iat: 0,
      exp: 0,
    });
    vi.mocked(csrfModule.assertSameOrigin).mockReturnValue(null);
  });

  afterAll(async () => {
    // La suite del dev no limpiaba al final de este bloque; los tests de
    // recurrencia de F4.3 dejan movimientos y ocurrencias. Se cierra igual que
    // los demás bloques para que `finanzas_test` quede sin residuos.
    await resetDatabase();
    await apiPrisma.$disconnect();
    await db.$disconnect();
  });

  /** Un `Request` con JSON, como el que manda la app. */
  function request(method: string, path: string, body?: unknown) {
    return new Request(`http://localhost:3000${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function createAccount(
    name: string,
    currency: "ARS" | "USD",
    kind: "CASH" | "BANK" = "CASH",
  ) {
    return db.account.create({ data: { name, kind, currency } });
  }

  describe("POST /api/accounts", () => {
    it("crea la cuenta en la moneda pedida y en pesos cuando no se manda", async () => {
      const enDolares = await postAccount(
        request("POST", "/api/accounts", {
          name: "Caja dólares",
          kind: "CASH",
          currency: "USD",
        }),
      );
      expect(enDolares.status).toBe(201);
      expect((await enDolares.json()).currency).toBe("USD");

      const sinCampo = await postAccount(
        request("POST", "/api/accounts", {
          name: "Caja pesos",
          kind: "CASH",
        }),
      );
      expect(sinCampo.status).toBe(201);
      expect((await sinCampo.json()).currency).toBe("ARS");

      const filas = await db.account.findMany({ orderBy: { name: "asc" } });
      expect(filas.map((fila) => [fila.name, fila.currency])).toEqual([
        ["Caja dólares", "USD"],
        ["Caja pesos", "ARS"],
      ]);
    });

    it("un `currency` vacío es el default; uno inválido es 400 y no crea nada", async () => {
      const vacio = await postAccount(
        request("POST", "/api/accounts", {
          name: "Caja",
          kind: "CASH",
          currency: "",
        }),
      );
      expect(vacio.status).toBe(201);
      expect((await vacio.json()).currency).toBe("ARS");
      await db.account.deleteMany();

      // Cuerpos hostiles: la comparación es exacta y estricta de tipo.
      const hostiles: unknown[] = ["EUR", "usd", "USD ", 3, true, ["USD"], {}];
      for (const currency of hostiles) {
        const res = await postAccount(
          request("POST", "/api/accounts", {
            name: "Caja",
            kind: "CASH",
            currency,
          }),
        );
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/ARS o USD/);
      }

      expect(await db.account.count()).toBe(0);
    });

    it("un préstamo también nace en la moneda pedida, con su cronograma", async () => {
      const res = await postAccount(
        request("POST", "/api/accounts", {
          name: "Préstamo dólares",
          kind: "LOAN",
          currency: "USD",
          principal: "1000",
          tnaPercent: "0",
          installmentCount: 3,
          firstInstallmentDate: "2026-12-15",
        }),
      );

      expect(res.status).toBe(201);
      const creado = await res.json();
      expect(creado.currency).toBe("USD");
      expect(
        await db.installment.count({ where: { accountId: creado.id } }),
      ).toBe(3);
    });

    it("dos «Efectivo» conviven si son de distinta moneda; la tercera choca con un 409 que dice en cuál", async () => {      const primera = await postAccount(
        request("POST", "/api/accounts", {
          name: "Efectivo",
          kind: "CASH",
          currency: "ARS",
        }),
      );
      const segunda = await postAccount(
        request("POST", "/api/accounts", {
          name: "Efectivo",
          kind: "CASH",
          currency: "USD",
        }),
      );
      expect(primera.status).toBe(201);
      expect(segunda.status).toBe(201);

      const repetidaEnPesos = await postAccount(
        request("POST", "/api/accounts", {
          name: "Efectivo",
          kind: "CASH",
          currency: "ARS",
        }),
      );
      expect(repetidaEnPesos.status).toBe(409);
      expect((await repetidaEnPesos.json()).error).toMatch(/en pesos/);

      const repetidaEnDolares = await postAccount(
        request("POST", "/api/accounts", {
          name: "Efectivo",
          kind: "CASH",
          currency: "USD",
        }),
      );
      expect(repetidaEnDolares.status).toBe(409);
      expect((await repetidaEnDolares.json()).error).toMatch(/en dólares/);

      // Nada de 500 y ninguna fila de más: siguen siendo DOS cuentas.
      expect(await db.account.count()).toBe(2);
    });
  });

  describe("PATCH /api/accounts", () => {
    it("corrige la moneda mientras la cuenta no tiene historia", async () => {
      const cuenta = await createAccount("Caja nueva", "ARS");

      const res = await patchAccount(
        request("PATCH", "/api/accounts", { id: cuenta.id, currency: "USD" }),
      );

      expect(res.status).toBe(200);
      expect((await res.json()).currency).toBe("USD");
      const fila = await db.account.findUnique({ where: { id: cuenta.id } });
      expect(fila?.currency).toBe("USD");
    });

    it("con historia responde 409 con el motivo y NO cambia la moneda", async () => {
      const cuenta = await createAccount("Caja usada", "ARS");
      await db.movement.create({
        data: {
          kind: "INCOME",
          amount: "1000",
          date: calendarToDb("2026-11-01"),
          accountId: cuenta.id,
        },
      });

      const res = await patchAccount(
        request("PATCH", "/api/accounts", { id: cuenta.id, currency: "USD" }),
      );

      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/no se puede cambiar su moneda/i);
      const fila = await db.account.findUnique({ where: { id: cuenta.id } });
      expect(fila?.currency).toBe("ARS");
    });

    it("una moneda inválida en la edición es 400 (no se ignora en silencio)", async () => {
      const cuenta = await createAccount("Caja", "ARS");

      for (const currency of ["EUR", null, ""]) {
        const res = await patchAccount(
          request("PATCH", "/api/accounts", { id: cuenta.id, currency }),
        );
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/ARS o USD/);
      }

      const fila = await db.account.findUnique({ where: { id: cuenta.id } });
      expect(fila?.currency).toBe("ARS");
    });

    it("renombrar respeta la moneda: «Efectivo» en dólares es libre si sólo existe en pesos", async () => {
      await createAccount("Efectivo", "ARS");
      const otra = await createAccount("Otra", "USD");

      const libre = await patchAccount(
        request("PATCH", "/api/accounts", { id: otra.id, name: "Efectivo" }),
      );
      expect(libre.status).toBe(200);
      expect((await libre.json()).currency).toBe("USD");

      // Ahora sí hay «Efectivo» en dólares: la segunda choca, y el mensaje dice
      // en qué moneda.
      const tercera = await createAccount("Tercera", "USD");
      const choque = await patchAccount(
        request("PATCH", "/api/accounts", { id: tercera.id, name: "Efectivo" }),
      );
      expect(choque.status).toBe(409);
      expect((await choque.json()).error).toMatch(/en dólares/);
    });
  });

  describe("POST /api/transactions · transferencias entre monedas", () => {
    it("ARS → USD sin `toAmount` es 400 y no guarda nada", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");
      const dolares = await createAccount("Caja dólares", "USD");

      const res = await postTransaction(
        request("POST", "/api/transactions", {
          kind: "TRANSFER",
          amount: "120000",
          date: "2026-11-01",
          accountId: pesos.id,
          toAccountId: dolares.id,
        }),
      );

      expect(res.status).toBe(400);
      // El mensaje es el de la API (nombra las dos monedas), no el genérico del
      // trigger: la base es la red, pero el borde tiene que explicar antes.
      expect((await res.json()).error).toMatch(
        /está en pesos y la de destino en dólares/,
      );
      expect(await db.movement.count()).toBe(0);
    });

    it("ARS → USD con `toAmount` es 201 y acredita EXACTAMENTE el monto de destino", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");
      const dolares = await createAccount("Caja dólares", "USD");

      const res = await postTransaction(
        request("POST", "/api/transactions", {
          kind: "TRANSFER",
          amount: "120000",
          toAmount: "100",
          date: "2026-11-01",
          accountId: pesos.id,
          toAccountId: dolares.id,
        }),
      );

      expect(res.status).toBe(201);
      const creado = await res.json();
      expect(creado.amount).toBe("120000.00");
      expect(creado.toAmount).toBe("100.00");

      const fila = await db.movement.findUnique({ where: { id: creado.id } });
      expect(fila?.toAmount?.toFixed(2)).toBe("100.00");

      // El saldo de la cuenta de destino sube 100 dólares, no 120.000.
      const balances = await getAccountBalances(db, { asOf: "2026-11-01" });
      const destino = balances.find((balance) => balance.id === dolares.id);
      const origen = balances.find((balance) => balance.id === pesos.id);
      expect(destino?.balance.toFixed(2)).toBe("100.00");
      expect(origen?.balance.toFixed(2)).toBe("-120000.00");
    });

    it("la lectura devuelve `toAmount` (string) y `null` donde no corresponde", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");
      const dolares = await createAccount("Caja dólares", "USD");
      const { gastos } = await seedCategories();

      await postTransaction(
        request("POST", "/api/transactions", {
          kind: "TRANSFER",
          amount: "120000",
          toAmount: "100",
          date: "2026-11-02",
          accountId: pesos.id,
          toAccountId: dolares.id,
        }),
      );
      await postTransaction(
        request("POST", "/api/transactions", {
          kind: "EXPENSE",
          amount: "5000",
          date: "2026-11-02",
          accountId: pesos.id,
          categoryName: gastos.name,
        }),
      );

      const res = await getTransactions(
        new Request(
          "http://localhost:3000/api/transactions?currency=ARS&from=2026-11-02&to=2026-11-02",
        ),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      const porTipo = new Map(
        (body.movements as { kind: string; toAmount: string | null }[]).map(
          (movement) => [movement.kind, movement.toAmount],
        ),
      );
      expect(porTipo.get("TRANSFER")).toBe("100.00");
      expect(porTipo.get("EXPENSE")).toBeNull();
    });

    it("misma moneda con `toAmount` es 400; sin él es 201 con `toAmount: null`", async () => {
      const banco = await createAccount("Banco pesos", "ARS", "BANK");
      const caja = await createAccount("Caja pesos", "ARS");

      const conMontoDeDestino = await postTransaction(
        request("POST", "/api/transactions", {
          kind: "TRANSFER",
          amount: "10000",
          toAmount: "10000",
          date: "2026-11-01",
          accountId: banco.id,
          toAccountId: caja.id,
        }),
      );
      expect(conMontoDeDestino.status).toBe(400);
      expect((await conMontoDeDestino.json()).error).toMatch(
        /el monto de destino no corresponde/,
      );

      const sinMontoDeDestino = await postTransaction(
        request("POST", "/api/transactions", {
          kind: "TRANSFER",
          amount: "10000",
          date: "2026-11-01",
          accountId: banco.id,
          toAccountId: caja.id,
        }),
      );
      expect(sinMontoDeDestino.status).toBe(201);
      expect((await sinMontoDeDestino.json()).toAmount).toBeNull();
      expect(await db.movement.count()).toBe(1);
    });

    it("`toAmount` en un gasto o un ingreso es 400, aunque el valor sea válido", async () => {
      const caja = await createAccount("Caja pesos", "ARS");
      const { gastos, sueldo } = await seedCategories();

      const gasto = await postTransaction(
        request("POST", "/api/transactions", {
          kind: "EXPENSE",
          amount: "5000",
          toAmount: "5",
          date: "2026-11-01",
          accountId: caja.id,
          categoryName: gastos.name,
        }),
      );
      expect(gasto.status).toBe(400);
      expect((await gasto.json()).error).toMatch(
        /sólo existe en una transferencia/,
      );

      const ingreso = await postTransaction(
        request("POST", "/api/transactions", {
          kind: "INCOME",
          amount: "5000",
          toAmount: "5",
          date: "2026-11-01",
          accountId: caja.id,
          categoryName: sueldo.name,
        }),
      );
      expect(ingreso.status).toBe(400);
      expect(await db.movement.count()).toBe(0);
    });

    it("un monto de destino hostil es 400 con mensaje, nunca 500", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");
      const dolares = await createAccount("Caja dólares", "USD");

      const hostiles: unknown[] = [
        0,
        -100,
        "0",
        "abc",
        [100],
        {},
        true,
        // 20 dígitos: no entra en NUMERIC(18,2). La base lo rechaza y el borde
        // lo traduce a 400 ("el monto es demasiado grande"), no a un 500.
        "12345678901234567890",
      ];

      for (const toAmount of hostiles) {
        const res = await postTransaction(
          request("POST", "/api/transactions", {
            kind: "TRANSFER",
            amount: "120000",
            toAmount,
            date: "2026-11-01",
            accountId: pesos.id,
            toAccountId: dolares.id,
          }),
        );
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBeTruthy();
      }

      expect(await db.movement.count()).toBe(0);
    });

    it("una cuenta inexistente es 400 con el nombre de la punta que falta", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");

      const sinDestino = await postTransaction(
        request("POST", "/api/transactions", {
          kind: "TRANSFER",
          amount: "1000",
          date: "2026-11-01",
          accountId: pesos.id,
          toAccountId: "no-existe",
        }),
      );
      expect(sinDestino.status).toBe(400);
      expect((await sinDestino.json()).error).toMatch(/destino no existe/);

      const sinOrigen = await postTransaction(
        request("POST", "/api/transactions", {
          kind: "TRANSFER",
          amount: "1000",
          date: "2026-11-01",
          accountId: "no-existe",
          toAccountId: pesos.id,
        }),
      );
      expect(sinOrigen.status).toBe(400);
      expect((await sinOrigen.json()).error).toMatch(/origen no existe/);
    });
  });

  describe("POST /api/transactions/batch · el lote entero o nada", () => {
    it("un ítem entre monedas sin `toAmount` rechaza el lote completo", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");
      const dolares = await createAccount("Caja dólares", "USD");

      const res = await postBatch(
        request("POST", "/api/transactions/batch", {
          movements: [
            {
              kind: "EXPENSE",
              amount: 2500,
              date: "2026-11-01",
              description: "Farmacia",
              accountId: pesos.id,
            },
            {
              kind: "TRANSFER",
              amount: 120000,
              date: "2026-11-01",
              description: "Compra de dólares",
              fromAccountId: pesos.id,
              toAccountId: dolares.id,
            },
          ],
        }),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/movimiento #2/i);
      expect(body.error).toMatch(/cuánto llega/);
      // Atomicidad: el gasto válido del ítem #1 tampoco se guardó.
      expect(await db.movement.count()).toBe(0);
    });

    it("con `toAmount` guarda el lote y el monto de destino llega a la fila", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");
      const dolares = await createAccount("Caja dólares", "USD");

      const res = await postBatch(
        request("POST", "/api/transactions/batch", {
          movements: [
            {
              kind: "TRANSFER",
              amount: 120000,
              toAmount: 100,
              date: "2026-11-01",
              description: "Compra de dólares",
              fromAccountId: pesos.id,
              toAccountId: dolares.id,
            },
          ],
        }),
      );

      expect(res.status).toBe(201);
      expect((await res.json()).count).toBe(1);

      const fila = await db.movement.findFirst();
      expect(fila?.kind).toBe("TRANSFER");
      expect(fila?.toAmount?.toFixed(2)).toBe("100.00");
    });

    it("`toAmount` en la misma moneda o en un gasto rechaza el lote sin escribir", async () => {
      const banco = await createAccount("Banco pesos", "ARS", "BANK");
      const caja = await createAccount("Caja pesos", "ARS");

      const mismaMoneda = await postBatch(
        request("POST", "/api/transactions/batch", {
          movements: [
            {
              kind: "TRANSFER",
              amount: 10000,
              toAmount: 10000,
              date: "2026-11-01",
              fromAccountId: banco.id,
              toAccountId: caja.id,
            },
          ],
        }),
      );
      expect(mismaMoneda.status).toBe(400);
      expect((await mismaMoneda.json()).error).toMatch(/no corresponde/);

      const enGasto = await postBatch(
        request("POST", "/api/transactions/batch", {
          movements: [
            {
              kind: "EXPENSE",
              amount: 1000,
              toAmount: 5,
              date: "2026-11-01",
              accountId: caja.id,
            },
          ],
        }),
      );
      expect(enGasto.status).toBe(400);
      expect((await enGasto.json()).error).toMatch(
        /sólo existe en una transferencia/,
      );

      expect(await db.movement.count()).toBe(0);
    });

    it("un ítem que no es un objeto es 400 con su número, no un 500", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");

      const res = await postBatch(
        request("POST", "/api/transactions/batch", {
          movements: [
            null,
            {
              kind: "EXPENSE",
              amount: 1000,
              date: "2026-11-01",
              accountId: pesos.id,
            },
          ],
        }),
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/movimiento #1/i);
      expect(await db.movement.count()).toBe(0);
    });

    it("un destino inexistente en el lote es 400 con el número de ítem", async () => {      const pesos = await createAccount("Caja pesos", "ARS");

      const res = await postBatch(
        request("POST", "/api/transactions/batch", {
          movements: [
            {
              kind: "TRANSFER",
              amount: 1000,
              toAmount: 1,
              date: "2026-11-01",
              fromAccountId: pesos.id,
              toAccountId: "no-existe",
            },
          ],
        }),
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/movimiento #1/i);
      expect(await db.movement.count()).toBe(0);
    });
  });

  describe("importación de CSV", () => {
    function csv(rows: string[]) {
      return [
        "fecha,tipo,monto,cuenta,cuenta_destino,categoria,descripcion",
        ...rows,
      ].join("\n");
    }

    it("rechaza las filas de una cuenta en dólares con un mensaje claro y no importa nada", async () => {
      await createAccount("Caja pesos", "ARS");
      await createAccount("Caja dólares", "USD");
      await seedCategories();

      const text = csv([
        "2026-08-01,gasto,100,Caja dólares,,Comida,Súper",
        "2026-08-02,gasto,200,Caja pesos,,Comida,Almacén",
      ]);

      const { preview } = await analyzeCsv(db, text);

      const filaUsd = preview.rows[0]!;
      expect(filaUsd.status).toBe("INVALID");
      expect(filaUsd.errors[0]).toMatch(/dólares/);
      // La de pesos sí es importable: el rechazo es por fila, no por archivo.
      expect(preview.rows[1]!.status).toBe("VALID");
      // Y el total sólo cuenta filas de pesos, con su unidad explícita.
      expect(preview.totals.currency).toBe("ARS");
      expect(preview.totals.expenses).toBe("200.00");

      // Con una fila inválida el commit entero se rechaza: no quedan filas a medias.
      await expect(
        importCsv(db, text, parseCsvExpected(preview.totals)),
      ).rejects.toMatchObject({ status: 422 });
      expect(await db.movement.count()).toBe(0);
    });

    it("una transferencia hacia una cuenta en dólares también se rechaza", async () => {
      await createAccount("Caja pesos", "ARS");
      await createAccount("Caja dólares", "USD");

      const text = csv([
        "2026-08-01,transferencia,1000,Caja pesos,Caja dólares,,Cambio",
      ]);

      const { preview } = await analyzeCsv(db, text);
      expect(preview.rows[0]!.status).toBe("INVALID");
      expect(preview.rows[0]!.errors.join(" ")).toMatch(/dólares/);
      expect(preview.totals.currency).toBeNull();
    });

    it("si «Efectivo» existe en pesos y en dólares, la fila resuelve la de pesos", async () => {
      await createAccount("Efectivo", "ARS");
      await createAccount("Efectivo", "USD");
      await seedCategories();

      const text = csv(["2026-08-01,gasto,100,Efectivo,,Comida,Súper"]);

      const { preview } = await analyzeCsv(db, text);
      expect(preview.rows[0]!.status).toBe("VALID");
      expect(preview.totals).toEqual({
        income: "0.00",
        expenses: "100.00",
        transfers: "0.00",
        count: 1,
        currency: "ARS",
      });

      const result = await importCsv(db, text, parseCsvExpected(preview.totals));
      expect(result.imported).toBe(1);
      expect(result.totals.currency).toBe("ARS");

      const movimiento = await db.movement.findFirst({
        include: { account: true },
      });
      expect(movimiento?.account.currency).toBe("ARS");
    });
  });

  describe("Recurrencia entre monedas (F4.3 abrió cuentas en USD)", () => {
    it("sin monto de destino, una regla cruzada es 400 y no se guarda", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");
      const dolares = await createAccount("Caja dA3lares", "USD");

      const res = await postRecurrenceRule(
        request("POST", "/api/recurrence/rules", {
          title: "Compra de dA3lares",
          kind: "TRANSFER",
          amount: "100000",
          accountId: pesos.id,
          toAccountId: dolares.id,
          freq: "MONTHLY",
          startDate: "2026-01-01",
          postingMode: "AUTO",
        }),
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(
        /cuánto llega a la cuenta de destino/,
      );
      expect(await db.recurrenceRule.count()).toBe(0);
    });

    it("una regla cruzada sembrada por fuera no tumba la corrida: se bloquea y las demás postean", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");
      const dolares = await createAccount("Caja dA3lares", "USD", "BANK");
      const banco = await createAccount("Banco pesos", "ARS", "BANK");
      const gastos = await db.category.create({
        data: { name: "Gastos rec", normalizedName: "gastos rec", kind: "EXPENSE" },
      });

      // Desde F4.6 la base NO deja crear esta fila: el trigger la rechaza. Se
      // siembra con el trigger apagado para representar un DATO VIEJO —una
      // regla anterior a esta fase— y verificar que el generador no tumba la
      // corrida entera cuando se encuentra con uno.
      await db.$executeRawUnsafe(
        'ALTER TABLE "RecurrenceRule" DISABLE TRIGGER "recurrence_currency_shape_check"',
      );
      let cruzadaId: string;
      try {
        const cruzada = await db.recurrenceRule.create({
          data: {
            title: "Cruzada",
            kind: "TRANSFER",
            amount: "1000",
            accountId: pesos.id,
            toAccountId: dolares.id,
            freq: "MONTHLY",
            startDate: calendarToDb("2026-01-01"),
            postingMode: "AUTO",
          },
        });
        cruzadaId = cruzada.id;
      } finally {
        await db.$executeRawUnsafe(
          'ALTER TABLE "RecurrenceRule" ENABLE TRIGGER "recurrence_currency_shape_check"',
        );
      }
      const valida = await db.recurrenceRule.create({
        data: {
          title: "Valida",
          kind: "EXPENSE",
          amount: "500",
          accountId: banco.id,
          categoryId: gastos.id,
          freq: "MONTHLY",
          startDate: calendarToDb("2026-01-01"),
          postingMode: "AUTO",
        },
      });

      const run = await runDueOccurrences(db, { today: "2026-03-01" });

      // La cruzada va a la bandeja con el motivo; NO aborta la transacción.
      expect(run.blocked.map((item) => item.ruleId)).toContain(cruzadaId);
      expect(run.blocked.find((item) => item.ruleId === cruzadaId)?.reason).toMatch(
        /monto de destino/,
      );
      expect(
        await db.movement.count({ where: { recurrenceRuleId: cruzadaId } }),
      ).toBe(0);
      expect(
        await db.recurrenceOccurrence.count({
          where: { ruleId: cruzadaId, status: "PENDING" },
        }),
      ).toBe(3);

      // La regla válida de la MISMA corrida sí postea sus tres ocurrencias.
      expect(
        await db.movement.count({ where: { recurrenceRuleId: valida.id } }),
      ).toBe(3);
    });
  });
});

/* ═════════════════════════════════════════════════════════════════════════════
 * FASE 4.4b · CONFIGURACIÓN DE MONEDAS Y PATRIMONIO POR MONEDA
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Dos contratos del borde:
 *
 *   · `/api/settings` decide qué monedas existen para la app. Una moneda con
 *     cuentas NO se puede apagar (409 con qué hacer), y la lista vacía,
 *     repetida o inventada es 400.
 *   · `/api/accounts` devuelve el patrimonio de CADA moneda. La respuesta no
 *     tiene ningún total mezclado: el panel pinta un bloque por moneda.
 * ═════════════════════════════════════════════════════════════════════════════ */
describeDb("Fase 4.4b · configuración de monedas y patrimonio por moneda", () => {
  beforeEach(async () => {
    await resetDatabase();
    vi.mocked(dalModule.requireApiSession).mockResolvedValue({
      v: 1,
      iat: 0,
      exp: 0,
    });
    vi.mocked(csrfModule.assertSameOrigin).mockReturnValue(null);
    // El estado de fábrica antes de cada caso: el PATCH de un test no puede
    // dejarle a otro una lista habilitada distinta.
    await db.appSettings.update({
      where: { id: 1 },
      data: { enabledCurrencies: ["ARS"] },
    });
  });

  function request(method: string, path: string, body?: unknown) {
    return new Request(`http://localhost:3000${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function createAccount(
    name: string,
    currency: "ARS" | "USD",
    kind: "CASH" | "BANK" | "CREDIT_CARD" = "CASH",
    openingBalance = "0",
  ) {
    return db.account.create({
      data: { name, kind, currency, openingBalance },
    });
  }

  describe("/api/settings", () => {
    it("GET de fábrica devuelve sólo pesos", async () => {
      const res = await getSettings();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabledCurrencies: ["ARS"] });
    });

    it("PATCH habilita dólares y lo persiste", async () => {
      const res = await patchSettings(
        request("PATCH", "/api/settings", {
          enabledCurrencies: ["ARS", "USD"],
        }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabledCurrencies: ["ARS", "USD"] });

      const fila = await db.appSettings.findUnique({ where: { id: 1 } });
      expect(fila?.enabledCurrencies).toEqual(["ARS", "USD"]);

      // Y el GET siguiente cuenta la misma historia.
      const leido = await getSettings();
      expect(await leido.json()).toEqual({ enabledCurrencies: ["ARS", "USD"] });
    });

    it("normaliza el orden para que dos cuerpos equivalentes den la misma fila", async () => {
      const res = await patchSettings(
        request("PATCH", "/api/settings", {
          enabledCurrencies: ["USD", "ARS"],
        }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabledCurrencies: ["ARS", "USD"] });
    });

    it("una lista vacía es 400 y no toca la configuración", async () => {
      const res = await patchSettings(
        request("PATCH", "/api/settings", { enabledCurrencies: [] }),
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/al menos una moneda/i);

      const fila = await db.appSettings.findUnique({ where: { id: 1 } });
      expect(fila?.enabledCurrencies).toEqual(["ARS"]);
    });

    it("una moneda repetida es 400", async () => {
      const res = await patchSettings(
        request("PATCH", "/api/settings", {
          enabledCurrencies: ["ARS", "ARS"],
        }),
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/repetida/i);
    });

    it("valores inválidos son 400: no se convierten ni se adivinan", async () => {
      const hostiles: unknown[] = [
        ["EUR"],
        ["ARS", "usd"],
        ["ARS", null],
        ["ARS", 3],
        "ARS",
        null,
        undefined,
      ];

      for (const enabledCurrencies of hostiles) {
        const res = await patchSettings(
          request("PATCH", "/api/settings", { enabledCurrencies }),
        );
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/lista de monedas|ARS o USD/);
      }

      const fila = await db.appSettings.findUnique({ where: { id: 1 } });
      expect(fila?.enabledCurrencies).toEqual(["ARS"]);
    });

    it("quitar pesos con cuentas en pesos es 409 con el motivo y la salida", async () => {
      await createAccount("Caja pesos", "ARS");
      await patchSettings(
        request("PATCH", "/api/settings", {
          enabledCurrencies: ["ARS", "USD"],
        }),
      );

      const res = await patchSettings(
        request("PATCH", "/api/settings", { enabledCurrencies: ["USD"] }),
      );

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/cuenta[s]? en pesos/);
      expect(body.error).toMatch(/Archivá|archivá/);
      expect(body.error).toMatch(/otra moneda/);

      // La configuración NO cambió: la fila sigue con las dos monedas.
      const fila = await db.appSettings.findUnique({ where: { id: 1 } });
      expect(fila?.enabledCurrencies).toEqual(["ARS", "USD"]);
    });

    it("quitar una moneda sin cuentas se puede", async () => {
      await patchSettings(
        request("PATCH", "/api/settings", {
          enabledCurrencies: ["ARS", "USD"],
        }),
      );

      const res = await patchSettings(
        request("PATCH", "/api/settings", { enabledCurrencies: ["ARS"] }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabledCurrencies: ["ARS"] });
    });

    it("cuenta las cuentas ARCHIVADAS: la plata sigue siendo de esa moneda", async () => {
      const cuenta = await createAccount("Vieja dólares", "USD");
      await db.account.update({
        where: { id: cuenta.id },
        data: { archived: true },
      });
      await patchSettings(
        request("PATCH", "/api/settings", {
          enabledCurrencies: ["ARS", "USD"],
        }),
      );

      const res = await patchSettings(
        request("PATCH", "/api/settings", { enabledCurrencies: ["ARS"] }),
      );

      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/cuenta[s]? en dólares/);
    });

    it("un PATCH que reenvía la lista actual no conflictúa por una moneda ya apagada", async () => {
      // Estado heredado (el alta de cuentas no valida la moneda habilitada: es
      // el diferido de F4.4b): hay una cuenta en dólares y los dólares YA están
      // apagados. Guardar la MISMA lista no apaga ninguna moneda, así que no
      // puede ser un 409; si lo fuera, el modal quedaría sin salida: la
      // persona no está quitando nada y el servidor le contesta "no podés
      // quitar dólares".
      await createAccount("Caja dólares", "USD");

      const mismo = await patchSettings(
        request("PATCH", "/api/settings", { enabledCurrencies: ["ARS"] }),
      );

      expect(mismo.status).toBe(200);
      expect(await mismo.json()).toEqual({ enabledCurrencies: ["ARS"] });

      // Y apagar de verdad una moneda habilitada sigue siendo un conflicto.
      await patchSettings(
        request("PATCH", "/api/settings", {
          enabledCurrencies: ["ARS", "USD"],
        }),
      );
      const quitar = await patchSettings(
        request("PATCH", "/api/settings", { enabledCurrencies: ["ARS"] }),
      );
      expect(quitar.status).toBe(409);
    });
  });

  describe("GET /api/accounts · netWorthByCurrency", () => {
    it("devuelve un bloque por moneda con activos, pasivos y neto, sin total mezclado", async () => {
      await createAccount("Banco pesos", "ARS", "BANK", "1000");
      await createAccount("Caja dólares", "USD", "CASH", "100");
      await createAccount("Visa dólares", "USD", "CREDIT_CARD", "-20");

      const res = await getAccounts(
        request("GET", "/api/accounts?asOf=2026-11-30"),
      );

      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.netWorthByCurrency).toEqual([
        {
          currency: "ARS",
          assets: "1000.00",
          liabilities: "0.00",
          net: "1000.00",
        },
        {
          currency: "USD",
          assets: "100.00",
          liabilities: "20.00",
          net: "80.00",
        },
      ]);

      // No existe ningún campo que sume las dos monedas: 1.080 sería una
      // mentira con unidad inventada.
      expect(body).not.toHaveProperty("netWorthTotal");
      expect(JSON.stringify(body)).not.toContain("1080.00");
    });

    it("`currency=USD` cambia el netWorth pedido pero NO recorta los bloques", async () => {
      await createAccount("Banco pesos", "ARS", "BANK", "1000");
      await createAccount("Caja dólares", "USD", "CASH", "100");

      const res = await getAccounts(
        request("GET", "/api/accounts?asOf=2026-11-30&currency=USD"),
      );

      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.netWorth).toEqual({
        assets: "100.00",
        liabilities: "0.00",
        net: "100.00",
      });
      expect(body.netWorthByCurrency.map((block: { currency: string }) => block.currency)).toEqual([
        "ARS",
        "USD",
      ]);
    });
  });
});

/* ═════════════════════════════════════════════════════════════════════════════
 * FASE 4.4 · PRESUPUESTOS POR MONEDA EN LA API
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * El presupuesto vive por `(categoryId, month, currency)`. Si el borde HTTP
 * ignorara la moneda, pedir `?currency=USD` devolvería los límites en pesos
 * (o peor: compararía gastos en dólares contra un límite en pesos). Acá se
 * ejerce el handler real con `finanzas_test`: se crean las dos monedas y se
 * verifica que cada pedido vea SÓLO la suya.
 * ═════════════════════════════════════════════════════════════════════════════ */
describeDb("Fase 4.4 · presupuestos por moneda en la API", () => {
  beforeEach(async () => {
    await resetDatabase();
    vi.mocked(dalModule.requireApiSession).mockResolvedValue({
      v: 1,
      iat: 0,
      exp: 0,
    });
    vi.mocked(csrfModule.assertSameOrigin).mockReturnValue(null);
  });

  afterAll(async () => {
    await resetDatabase();
    await apiPrisma.$disconnect();
    await db.$disconnect();
  });

  function request(method: string, path: string, body?: unknown) {
    return new Request(`http://localhost:3000${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  it("POST con ?currency=USD crea un presupuesto aparte del de ARS y lo actualiza en su moneda", async () => {
    const { gastos } = await seedCategories();

    const ars = await postBudget(
      request("POST", "/api/budgets", {
        categoryId: gastos.id,
        month: "2026-11",
        amount: 1000,
      }),
    );
    expect(ars.status).toBe(200);

    const usd = await postBudget(
      request("POST", "/api/budgets?currency=USD", {
        categoryId: gastos.id,
        month: "2026-11",
        amount: 100,
      }),
    );
    expect(usd.status).toBe(200);
    expect((await usd.json()).currency).toBe("USD");

    // Dos filas para el MISMO mes y categoría: la moneda es parte de la clave.
    let rows = await db.budget.findMany({ orderBy: { currency: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.currency)).toEqual(["ARS", "USD"]);
    expect(rows.map((row) => row.amount.toFixed(2))).toEqual(["1000.00", "100.00"]);

    // El segundo POST en USD actualiza ESA fila, no crea una tercera ni toca
    // el presupuesto en pesos.
    const usdActualizado = await postBudget(
      request("POST", "/api/budgets?currency=USD", {
        categoryId: gastos.id,
        month: "2026-11",
        amount: 150,
      }),
    );
    expect(usdActualizado.status).toBe(200);

    rows = await db.budget.findMany({ orderBy: { currency: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.currency === "USD")?.amount.toFixed(2)).toBe(
      "150.00",
    );
    expect(rows.find((row) => row.currency === "ARS")?.amount.toFixed(2)).toBe(
      "1000.00",
    );
  });

  it("GET con ?currency=USD devuelve sólo los presupuestos y gastos en dólares", async () => {
    const { gastos } = await seedCategories();
    const [pesos, dolares] = await Promise.all([
      db.account.create({
        data: { name: "Caja pesos", kind: "CASH", currency: "ARS" },
      }),
      db.account.create({
        data: { name: "Caja dólares", kind: "CASH", currency: "USD" },
      }),
    ]);

    await postBudget(
      request("POST", "/api/budgets", {
        categoryId: gastos.id,
        month: "2026-11",
        amount: 1000,
      }),
    );
    await postBudget(
      request("POST", "/api/budgets?currency=USD", {
        categoryId: gastos.id,
        month: "2026-11",
        amount: 100,
      }),
    );

    // Un gasto en cada moneda: sólo el de USD puede compararse contra el
    // presupuesto en USD. Si la consulta de gastos no filtrara, el consumo
    // sería 540 y el porcentaje 540 %.
    await db.movement.createMany({
      data: [
        {
          kind: "EXPENSE",
          amount: "500",
          date: calendarToDb("2026-11-05"),
          accountId: pesos.id,
          categoryId: gastos.id,
        },
        {
          kind: "EXPENSE",
          amount: "40",
          date: calendarToDb("2026-11-06"),
          accountId: dolares.id,
          categoryId: gastos.id,
        },
      ],
    });

    const res = await getBudgets(
      request("GET", "/api/budgets?month=2026-11&currency=USD"),
    );
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.currency).toBe("USD");
    expect(data.budgets).toHaveLength(1);
    expect(data.budgets[0].currency).toBe("USD");
    expect(data.budgets[0].budgetedAmount).toBe(100);
    expect(data.budgets[0].spentAmount).toBe(40);
    expect(data.budgets[0].percentageUsed).toBe(40);
    expect(data.budgets[0].status).toBe("ok");
  });

  it("una moneda inválida es 400 en GET y en POST, y no escribe nada", async () => {
    const { gastos } = await seedCategories();

    const getRes = await getBudgets(
      request("GET", "/api/budgets?month=2026-11&currency=EUR"),
    );
    expect(getRes.status).toBe(400);
    expect((await getRes.json()).error).toMatch(/ARS o USD/);

    const postRes = await postBudget(
      request("POST", "/api/budgets?currency=EUR", {
        categoryId: gastos.id,
        month: "2026-11",
        amount: 100,
      }),
    );
    expect(postRes.status).toBe(400);
    expect(await db.budget.count()).toBe(0);
  });

  it("un monto hostil es 400, nunca 500 ni un número inventado", async () => {
    const { gastos } = await seedCategories();

    const hostiles: unknown[] = [
      ["100"],
      { value: 100 },
      true,
      "1" + "0".repeat(20), // 21 dígitos: desborda DECIMAL(18,2)
      "100abc",
      "",
      null,
    ];

    for (const amount of hostiles) {
      const res = await postBudget(
        request("POST", "/api/budgets", {
          categoryId: gastos.id,
          month: "2026-11",
          amount,
        }),
      );
      expect(res.status, `amount=${JSON.stringify(amount)}`).toBe(400);
    }

    expect(await db.budget.count()).toBe(0);
  });
});

/* ═════════════════════════════════════════════════════════════════════════════
 * FASE 4.6 · EL MONTO DE DESTINO EN REGLAS Y PLANTILLAS
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `Movement.toAmount` existe desde F4.1. Una REGLA y una PLANTILLA ahora lo
 * tienen con la MISMA bicondicional —obligatorio si las monedas difieren,
 * prohibido si son iguales— y con el mismo mecanismo (CHECK + trigger con
 * locking reads), para que el invariante no viva sólo en la API.
 *
 * Los dos caminos que valen:
 *
 *   · la base rechaza por su cuenta, con marcadores propios de cada tabla;
 *   · la API rechaza antes con un 400 legible —y acepta la regla que ANTES
 *     rechazaba—, el generador COPIA el monto de destino al movimiento, y los
 *     saldos quedan exactos.
 * ═════════════════════════════════════════════════════════════════════════════ */
describeDb("Fase 4.6 · monto de destino en reglas y plantillas", () => {
  beforeEach(async () => {
    await resetDatabase();
    await db.appSettings.update({
      where: { id: 1 },
      data: { enabledCurrencies: ["ARS", "USD"] },
    });
    vi.mocked(dalModule.requireApiSession).mockResolvedValue({
      v: 1,
      iat: 0,
      exp: 0,
    });
    vi.mocked(csrfModule.assertSameOrigin).mockReturnValue(null);
  });

  afterAll(async () => {
    await resetDatabase();
    await apiPrisma.$disconnect();
    await db.$disconnect();
  });

  function request(method: string, path: string, body?: unknown) {
    return new Request(`http://localhost:3000${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function createAccount(
    name: string,
    currency: "ARS" | "USD",
    kind: "CASH" | "BANK" = "CASH",
  ) {
    return db.account.create({ data: { name, kind, currency } });
  }

  /* ────────────────────────────────────────────────────────────────────────
   * La base · RecurrenceRule
   * ──────────────────────────────────────────────────────────────────────── */
  describe("la base · RecurrenceRule", () => {
    it("rechaza una transferencia entre monedas SIN monto de destino", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");
      const dolares = await createAccount("Caja dólares", "USD");

      await expect(
        db.recurrenceRule.create({
          data: {
            title: "Cambio",
            kind: "TRANSFER",
            amount: "120000",
            accountId: pesos.id,
            toAccountId: dolares.id,
            freq: "MONTHLY",
            startDate: calendarToDb("2026-01-01"),
          },
        }),
      ).rejects.toThrow(/regla_transferencia_entre_monedas_sin_monto_destino/);
      expect(await db.recurrenceRule.count()).toBe(0);
    });

    it("rechaza el monto de destino en una transferencia de la MISMA moneda", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");
      const banco = await createAccount("Banco pesos", "ARS", "BANK");

      await expect(
        db.recurrenceRule.create({
          data: {
            title: "Traspaso",
            kind: "TRANSFER",
            amount: "10000",
            toAmount: "10000",
            accountId: pesos.id,
            toAccountId: banco.id,
            freq: "MONTHLY",
            startDate: calendarToDb("2026-01-01"),
          },
        }),
      ).rejects.toThrow(/regla_monto_destino_en_misma_moneda/);
    });

    it("rechaza un monto de destino que no es positivo (0 y negativo)", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");
      const dolares = await createAccount("Caja dólares", "USD");

      for (const toAmount of ["0", "-5"]) {
        await expect(
          db.recurrenceRule.create({
            data: {
              title: "Cambio",
              kind: "TRANSFER",
              amount: "120000",
              toAmount,
              accountId: pesos.id,
              toAccountId: dolares.id,
              freq: "MONTHLY",
              startDate: calendarToDb("2026-01-01"),
            },
          }),
          `toAmount=${toAmount}`,
        ).rejects.toThrow(/recurrence_to_amount_positive/);
      }
    });

    it("rechaza el monto de destino en un gasto", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");
      const { gastos } = await seedCategories();

      await expect(
        db.recurrenceRule.create({
          data: {
            title: "Alquiler",
            kind: "EXPENSE",
            amount: "1000",
            toAmount: "1",
            accountId: pesos.id,
            categoryId: gastos.id,
            freq: "MONTHLY",
            startDate: calendarToDb("2026-01-01"),
          },
        }),
      ).rejects.toThrow(/recurrence_to_amount_only_on_transfer/);
    });

    it("acepta ARS → USD con monto de destino, y la misma moneda sin él", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");
      const dolares = await createAccount("Caja dólares", "USD");
      const banco = await createAccount("Banco pesos", "ARS", "BANK");

      const cruzada = await db.recurrenceRule.create({
        data: {
          title: "Cambio",
          kind: "TRANSFER",
          amount: "120000",
          toAmount: "100",
          accountId: pesos.id,
          toAccountId: dolares.id,
          freq: "MONTHLY",
          startDate: calendarToDb("2026-01-01"),
        },
      });
      expect(cruzada.toAmount?.toFixed(2)).toBe("100.00");

      const misma = await db.recurrenceRule.create({
        data: {
          title: "Traspaso",
          kind: "TRANSFER",
          amount: "10000",
          accountId: pesos.id,
          toAccountId: banco.id,
          freq: "MONTHLY",
          startDate: calendarToDb("2026-01-01"),
        },
      });
      expect(misma.toAmount).toBeNull();
    });
  });

  /* ────────────────────────────────────────────────────────────────────────
   * La base · FavoriteTemplate
   * ──────────────────────────────────────────────────────────────────────── */
  describe("la base · FavoriteTemplate", () => {
    it("rechaza una transferencia entre monedas SIN monto de destino", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");
      const dolares = await createAccount("Caja dólares", "USD");

      await expect(
        db.favoriteTemplate.create({
          data: {
            name: "Cambio guardado",
            normalizedName: "cambio guardado",
            kind: "TRANSFER",
            amount: "120000",
            accountId: pesos.id,
            toAccountId: dolares.id,
          },
        }),
      ).rejects.toThrow(
        /plantilla_transferencia_entre_monedas_sin_monto_destino/,
      );
      expect(await db.favoriteTemplate.count()).toBe(0);
    });

    it("rechaza el monto de destino en una transferencia de la MISMA moneda", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");
      const banco = await createAccount("Banco pesos", "ARS", "BANK");

      await expect(
        db.favoriteTemplate.create({
          data: {
            name: "Traspaso guardado",
            normalizedName: "traspaso guardado",
            kind: "TRANSFER",
            amount: "10000",
            toAmount: "10000",
            accountId: pesos.id,
            toAccountId: banco.id,
          },
        }),
      ).rejects.toThrow(/plantilla_monto_destino_en_misma_moneda/);
    });

    it("rechaza un monto de destino que no es positivo (0 y negativo)", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");
      const dolares = await createAccount("Caja dólares", "USD");

      for (const toAmount of ["0", "-5"]) {
        await expect(
          db.favoriteTemplate.create({
            data: {
              name: `Cambio ${toAmount}`,
              normalizedName: `cambio ${toAmount}`,
              kind: "TRANSFER",
              amount: "120000",
              toAmount,
              accountId: pesos.id,
              toAccountId: dolares.id,
            },
          }),
          `toAmount=${toAmount}`,
        ).rejects.toThrow(/favorite_to_amount_positive/);
      }
    });

    it("rechaza el monto de destino en un gasto", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");

      await expect(
        db.favoriteTemplate.create({
          data: {
            name: "Café",
            normalizedName: "cafe",
            kind: "EXPENSE",
            amount: "5000",
            toAmount: "1",
            accountId: pesos.id,
          },
        }),
      ).rejects.toThrow(/favorite_to_amount_only_on_transfer/);
    });

    it("acepta ARS → USD con monto de destino, y la misma moneda sin él", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");
      const dolares = await createAccount("Caja dólares", "USD");
      const banco = await createAccount("Banco pesos", "ARS", "BANK");

      const cruzada = await db.favoriteTemplate.create({
        data: {
          name: "Cambio guardado",
          normalizedName: "cambio guardado",
          kind: "TRANSFER",
          amount: "120000",
          toAmount: "100",
          accountId: pesos.id,
          toAccountId: dolares.id,
        },
      });
      expect(cruzada.toAmount?.toFixed(2)).toBe("100.00");

      const misma = await db.favoriteTemplate.create({
        data: {
          name: "Mismo banco",
          normalizedName: "mismo banco",
          kind: "TRANSFER",
          amount: "10000",
          accountId: pesos.id,
          toAccountId: banco.id,
        },
      });
      expect(misma.toAmount).toBeNull();
    });
  });

  /* ────────────────────────────────────────────────────────────────────────
   * La API · reglas
   * ──────────────────────────────────────────────────────────────────────── */
  describe("POST/PATCH /api/recurrence/rules", () => {
    it("crea una regla ARS → USD con `toAmount` (antes era 400) y la devuelve", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");
      const dolares = await createAccount("Caja dólares", "USD");

      const res = await postRecurrenceRule(
        request("POST", "/api/recurrence/rules", {
          title: "Compra de dólares",
          kind: "TRANSFER",
          amount: "120000",
          toAmount: "100",
          accountId: pesos.id,
          toAccountId: dolares.id,
          freq: "MONTHLY",
          startDate: "2026-01-01",
          postingMode: "AUTO",
        }),
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.amount).toBe("120000.00");
      expect(body.toAmount).toBe("100.00");

      const fila = await db.recurrenceRule.findUnique({
        where: { id: body.id },
      });
      expect(fila?.toAmount?.toFixed(2)).toBe("100.00");
    });

    it("con `toAmount` en la MISMA moneda es 400 y no guarda nada", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");
      const banco = await createAccount("Banco pesos", "ARS", "BANK");

      const res = await postRecurrenceRule(
        request("POST", "/api/recurrence/rules", {
          title: "Traspaso",
          kind: "TRANSFER",
          amount: "10000",
          toAmount: "10000",
          accountId: pesos.id,
          toAccountId: banco.id,
          freq: "MONTHLY",
          startDate: "2026-01-01",
        }),
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(
        /monto de destino no corresponde/,
      );
      expect(await db.recurrenceRule.count()).toBe(0);
    });

    it("`toAmount` en un gasto es 400, aunque el valor sea válido", async () => {
      const banco = await createAccount("Banco pesos", "ARS", "BANK");

      const res = await postRecurrenceRule(
        request("POST", "/api/recurrence/rules", {
          title: "Alquiler",
          kind: "EXPENSE",
          amount: "1000",
          toAmount: "5",
          accountId: banco.id,
          categoryName: "Vivienda",
          freq: "MONTHLY",
          startDate: "2026-01-01",
        }),
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(
        /monto de destino sólo existe en una transferencia/,
      );
      expect(await db.recurrenceRule.count()).toBe(0);
    });

    it("un `toAmount` hostil es 400, nunca 500", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");
      const dolares = await createAccount("Caja dólares", "USD");

      const hostiles: unknown[] = [
        ["100"],
        { value: "100" },
        true,
        "0",
        "-5",
        "1" + "0".repeat(20), // 21 dígitos: desborda DECIMAL(18,2)
      ];

      for (const toAmount of hostiles) {
        const res = await postRecurrenceRule(
          request("POST", "/api/recurrence/rules", {
            title: "Compra",
            kind: "TRANSFER",
            amount: "120000",
            toAmount,
            accountId: pesos.id,
            toAccountId: dolares.id,
            freq: "MONTHLY",
            startDate: "2026-01-01",
          }),
        );
        expect(res.status, `toAmount=${JSON.stringify(toAmount)}`).toBe(400);
      }

      expect(await db.recurrenceRule.count()).toBe(0);
    });

    it("el parser del monto es el MISMO que el de POST /api/transactions", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");
      const dolares = await createAccount("Caja dólares", "USD");

      // El parser ignora letras y símbolos de moneda a propósito (regla 4 de
      // `parseMoneyInput`): "USD 1.234,56" es un monto válido. Dos caminos que
      // leen el mismo dato no pueden discrepar, así que la regla y el alta de
      // movimientos tienen que interpretarlo IGUAL.
      const crudo = "USD 1.234,56";

      const regla = await postRecurrenceRule(
        request("POST", "/api/recurrence/rules", {
          title: "Compra de dólares",
          kind: "TRANSFER",
          amount: "120000",
          toAmount: crudo,
          accountId: pesos.id,
          toAccountId: dolares.id,
          freq: "MONTHLY",
          startDate: "2026-01-01",
        }),
      );
      expect(regla.status).toBe(201);
      expect((await regla.json()).toAmount).toBe("1234.56");

      const movimiento = await postTransaction(
        request("POST", "/api/transactions", {
          kind: "TRANSFER",
          amount: "120000",
          toAmount: crudo,
          date: "2026-11-05",
          accountId: pesos.id,
          toAccountId: dolares.id,
        }),
      );
      expect(movimiento.status).toBe(201);
      expect((await movimiento.json()).toAmount).toBe("1234.56");
    });

    it("PATCH: volver a la misma moneda sin limpiar el monto es 400; con null pasa", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");
      const dolares = await createAccount("Caja dólares", "USD");
      const banco = await createAccount("Banco pesos", "ARS", "BANK");

      const creada = await postRecurrenceRule(
        request("POST", "/api/recurrence/rules", {
          title: "Compra",
          kind: "TRANSFER",
          amount: "120000",
          toAmount: "100",
          accountId: pesos.id,
          toAccountId: dolares.id,
          freq: "MONTHLY",
          startDate: "2026-01-01",
        }),
      );
      expect(creada.status).toBe(201);
      const { id } = await creada.json();

      // Cambiar SÓLO el destino a una cuenta en pesos deja `toAmount` en la
      // regla mezclada: la bicondicional lo rechaza.
      const sinLimpiar = await patchRule(
        request("PATCH", "/api/recurrence/rules", {
          id,
          toAccountId: banco.id,
        }),
      );
      expect(sinLimpiar.status).toBe(400);
      expect((await sinLimpiar.json()).error).toMatch(
        /monto de destino no corresponde/,
      );

      const limpiando = await patchRule(
        request("PATCH", "/api/recurrence/rules", {
          id,
          toAccountId: banco.id,
          toAmount: null,
        }),
      );
      expect(limpiando.status).toBe(200);
      expect((await limpiando.json()).toAmount).toBeNull();
    });

    it("PATCH: cambiar el tipo a gasto limpia solo el monto y el destino", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");
      const dolares = await createAccount("Caja dólares", "USD");

      const creada = await postRecurrenceRule(
        request("POST", "/api/recurrence/rules", {
          title: "Compra",
          kind: "TRANSFER",
          amount: "120000",
          toAmount: "100",
          accountId: pesos.id,
          toAccountId: dolares.id,
          freq: "MONTHLY",
          startDate: "2026-01-01",
        }),
      );
      const { id } = await creada.json();

      const res = await patchRule(
        request("PATCH", "/api/recurrence/rules", {
          id,
          kind: "EXPENSE",
          categoryName: "Vivienda",
        }),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.toAmount).toBeNull();
      expect(body.toAccount).toBeNull();
    });
  });

  /* ────────────────────────────────────────────────────────────────────────
   * La corrida · el movimiento posteado copia el monto de destino
   * ──────────────────────────────────────────────────────────────────────── */
  describe("la corrida", () => {
    it("una regla ARS → USD postea con los DOS montos y mueve los saldos exacto", async () => {
      const banco = await createAccount("Banco pesos", "ARS", "BANK");
      const cajaUsd = await createAccount("Caja dólares", "USD");

      const rule = await db.recurrenceRule.create({
        data: {
          title: "Compra de dólares",
          kind: "TRANSFER",
          amount: "120000",
          toAmount: "100",
          accountId: banco.id,
          toAccountId: cajaUsd.id,
          freq: "MONTHLY",
          startDate: calendarToDb("2026-01-01"),
          postingMode: "AUTO",
        },
      });

      // 01/01 y 01/02 vencidas: dos ocurrencias posteadas.
      const run = await runDueOccurrences(db, { today: "2026-02-01" });
      expect(run.posted).toBe(2);
      expect(run.blocked).toHaveLength(0);

      const movimientos = await db.movement.findMany({
        where: { recurrenceRuleId: rule.id },
        orderBy: { date: "asc" },
      });
      expect(movimientos).toHaveLength(2);
      for (const movimiento of movimientos) {
        expect(movimiento.amount.toFixed(2)).toBe("120000.00");
        expect(movimiento.toAmount?.toFixed(2)).toBe("100.00");
      }

      const balances = await getAccountBalances(db);
      expect(
        balances.find((balance) => balance.id === banco.id)?.balance.toFixed(2),
      ).toBe("-240000.00");
      expect(
        balances.find((balance) => balance.id === cajaUsd.id)?.balance.toFixed(2),
      ).toBe("200.00");
    });
  });

  /* ────────────────────────────────────────────────────────────────────────
   * La API · plantillas
   * ──────────────────────────────────────────────────────────────────────── */
  describe("POST /api/favorites", () => {
    it("guarda `toAmount` y la lista lo devuelve", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");
      const dolares = await createAccount("Caja dólares", "USD");

      const res = await postFavorite(
        request("POST", "/api/favorites", {
          name: "Compra de dólares",
          kind: "TRANSFER",
          amount: "120000",
          toAmount: "100",
          accountId: pesos.id,
          toAccountId: dolares.id,
        }),
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.amount).toBe("120000.00");
      expect(body.toAmount).toBe("100.00");

      const list = await listFavorites(db);
      expect(list.find((favorite) => favorite.id === body.id)?.toAmount).toBe(
        "100.00",
      );
    });

    it("entre monedas sin `toAmount` es 400; en la misma moneda con él, 400", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");
      const dolares = await createAccount("Caja dólares", "USD");
      const banco = await createAccount("Banco pesos", "ARS", "BANK");

      const sinDestino = await postFavorite(
        request("POST", "/api/favorites", {
          name: "Cambio",
          kind: "TRANSFER",
          amount: "120000",
          accountId: pesos.id,
          toAccountId: dolares.id,
        }),
      );
      expect(sinDestino.status).toBe(400);
      expect((await sinDestino.json()).error).toMatch(/cuánto llega/);

      const mismoDestino = await postFavorite(
        request("POST", "/api/favorites", {
          name: "Traspaso",
          kind: "TRANSFER",
          amount: "10000",
          toAmount: "10000",
          accountId: pesos.id,
          toAccountId: banco.id,
        }),
      );
      expect(mismoDestino.status).toBe(400);
      expect((await mismoDestino.json()).error).toMatch(
        /monto de destino no corresponde/,
      );

      expect(await db.favoriteTemplate.count()).toBe(0);
    });

    it("la plantilla guardada se usa: el movimiento copia `toAmount` y acredita exacto", async () => {
      const pesos = await createAccount("Caja pesos", "ARS");
      const dolares = await createAccount("Caja dólares", "USD");

      const res = await postFavorite(
        request("POST", "/api/favorites", {
          name: "Compra de dólares",
          kind: "TRANSFER",
          amount: "120000",
          toAmount: "100",
          accountId: pesos.id,
          toAccountId: dolares.id,
        }),
      );
      const favorite = await res.json();

      // El formulario prellena "100,00" desde `favorite.toAmount` (probado en
      // `quick-entry.test.ts`) y manda el mismo valor al guardar.
      const movimiento = await postTransaction(
        request("POST", "/api/transactions", {
          kind: "TRANSFER",
          amount: "120000",
          toAmount: favorite.toAmount,
          date: "2026-11-05",
          accountId: pesos.id,
          toAccountId: dolares.id,
          favoriteId: favorite.id,
        }),
      );

      expect(movimiento.status).toBe(201);
      const creado = await movimiento.json();
      expect(creado.toAmount).toBe("100.00");

      const fila = await db.movement.findUnique({ where: { id: creado.id } });
      expect(fila?.toAmount?.toFixed(2)).toBe("100.00");

      const balances = await getAccountBalances(db);
      expect(
        balances.find((balance) => balance.id === pesos.id)?.balance.toFixed(2),
      ).toBe("-120000.00");
      expect(
        balances.find((balance) => balance.id === dolares.id)?.balance.toFixed(
          2,
        ),
      ).toBe("100.00");
    });
  });
});
