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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TRANSACTION_OPTIONS } from "./prisma";
import { addDays, calendarToDb, dbToCalendar } from "./dates";
import { MOVEMENTS_MAX_ROWS } from "./finance";
import { amortizationSchedule, money } from "./money";
import { getAccountBalances, getNetWorth } from "./balance";
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
  getDebtReport,
  getMonthReconciliation,
  getNetWorthSeries,
  movementBurn,
  movementBurnCandidates,
  movementCashFlow,
  movementCategoryBreakdown,
  movementDateBreakdown,
  movementTotals,
} from "./queries";

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

    it("rechaza un ingreso SIN categoría", async () => {
      const account = await db.account.create({
        data: { name: "Banco", kind: "BANK" },
      });

      await expect(
        db.movement.create({
          data: {
            kind: "INCOME",
            amount: "1000",
            date: calendarToDb("2026-10-15"),
            accountId: account.id,
          },
        }),
      ).rejects.toThrow();
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

  describe("Las cuentas de pasivo no reciben ingresos (trigger)", () => {
    it("rechaza un ingreso en un préstamo", async () => {
      // ÉSTE es el error que producía el 49% de ahorro falso: tratar el
      // desembolso del préstamo como un ingreso. La base no lo permite ni
      // siquiera si alguien escribe el código mal.
      const loan = await db.account.create({
        data: {
          name: "Préstamo",
          kind: "LOAN",
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

  describe("Los préstamos no se pueden crear a medias", () => {
    it("rechaza un préstamo sin tasa", async () => {
      // Sin tasa no se puede descomponer la cuota en capital e interés, y sin
      // esa descomposición volvemos al problema original.
      await expect(
        db.account.create({
          data: {
            name: "Préstamo",
            kind: "LOAN",
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

    const netWorth = await getNetWorth(db);
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
    const netWorth = await getNetWorth(db);

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
        principal: "500000",
        tnaPercent: "60",
        installmentCount: 12,
      },
    });

    const before = await getNetWorth(db);
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

    const after = await getNetWorth(db);
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

    const afterPurchase = await getNetWorth(db);
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

    const afterPayment = await getNetWorth(db);
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
    const totals = await movementTotals(db, where);
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
    const totals = await movementTotals(db, where);
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
    const byCategory = await movementCategoryBreakdown(db, where);
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
    const byDate = await movementDateBreakdown(db, where);
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
    const enOctubre = await categoriesInPeriod(db, "2026-10-01", "2026-10-31");
    expect(enOctubre.map((category) => category.name)).toEqual([
      "Compras",
      "Gastos",
      "Sueldo",
    ]);

    // El mismo selector visto desde septiembre: ahí la única es "Vieja". Es el
    // cruce de mes del bug B3, aplicado al selector.
    const enSeptiembre = await categoriesInPeriod(db, "2026-09-01", "2026-09-30");
    expect(enSeptiembre.map((category) => category.name)).toEqual(["Vieja"]);

    // Sin extremos de rango: todas las categorías usadas alguna vez.
    const todas = await categoriesInPeriod(db, null, null);
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
    expect(await movementCashFlow(db, septiembre)).toBe("500000.00");

    // Y la misma lectura desde el DTO que usa el panel: $ 0 de ingreso,
    // +500.000 de flujo. Las dos cosas son ciertas al mismo tiempo, y por eso
    // los dos números existen por separado.
    const totals = await movementTotals(db, septiembre);
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
    expect(await movementCashFlow(db, octubre)).toBe("0.00");

    // Pero el gasto consumido es real: la deuda subió. Si la compra contara en
    // el flujo, acá daría −50.000,00.
    const totals = await movementTotals(db, octubre);
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
    expect(await movementCashFlow(db, noviembre)).toBe("-50000.00");

    const totals = await movementTotals(db, noviembre);
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
    expect(await movementCashFlow(db, octubre)).toBe("0.00");

    // El movimiento sigue informado en `transfers`: la lista cuenta hechos, el
    // flujo mide liquidez.
    const totals = await movementTotals(db, octubre);
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
    const septiembre = await movementTotals(db, rango("2026-09-01", "2026-09-30"));
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
    const octubre = await movementTotals(db, rango("2026-10-01", "2026-10-31"));
    expect(octubre.income).toBe("800000.00");
    expect(octubre.expenses).toBe("675000.00");
    expect(octubre.cashFlow).toBe("143587.29");

    const ahorro = (Number(octubre.income) - Number(octubre.expenses)).toFixed(2);
    expect(ahorro).toBe("125000.00");
    expect(octubre.cashFlow).not.toBe(ahorro);

    // ── Y los dos meses suman el flujo del año ──────────────────────────────
    // 500.000,00 + 143.587,29 = 643.587,29. La liquidez no desaparece al
    // cambiar de período: sólo se reparte distinto.
    expect(await movementCashFlow(db, rango("2026-01-01", "2026-12-31"))).toBe(
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
    const serie = await getNetWorthSeries(db, { anchor: "2026-10-31" });

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
    const fotoDeOctubre = await getNetWorth(db, { asOf: "2026-10-31" });
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
    const serie = await getNetWorthSeries(db, { anchor: "2026-10-16" });
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
    const finDeMes = await getNetWorthSeries(db, { anchor: "2026-10-31" });
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
    expect(await getNetWorthSeries(db, { anchor: "2026-10-16" })).toEqual([]);
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
    const rec = await getMonthReconciliation(db, {
      month: "2026-10",
      anchor: "2026-10-31",
    });

    expect(rec).toEqual({
      month: "2026-10",
      netStart: "100000.00",
      netEnd: "410000.00",
      netDelta: "310000.00",
      saving: "310000.00",
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
    const sep = await getNetWorth(db, { asOf: "2026-09-30" });
    expect(sep.assets.toFixed(2)).toBe("600000.00");
    expect(sep.liabilities.toFixed(2)).toBe("500000.00");

    const rec = await getMonthReconciliation(db, {
      month: "2026-09",
      anchor: "2026-10-31",
    });

    expect(rec).toEqual({
      month: "2026-09",
      netStart: "100000.00",
      netEnd: "100000.00",
      netDelta: "0.00",
      saving: "0.00",
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
    const rec = await getMonthReconciliation(db, {
      month: "2026-08",
      anchor: "2026-10-31",
    });

    expect(rec).toEqual({
      month: "2026-08",
      netStart: "100000.00",
      netEnd: "100000.00",
      netDelta: "0.00",
      saving: "0.00",
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
    const al16 = await getMonthReconciliation(db, {
      month: "2026-10",
      anchor: "2026-10-16",
    });

    expect(al16).toEqual({
      month: "2026-10",
      netStart: "125000.00",
      netEnd: "115000.00",
      netDelta: "-10000.00",
      saving: "-10000.00",
      difference: "0.00",
      balanced: true,
      partial: true,
      cutAt: "2026-10-16",
    });

    // Y con el ancla a fin de mes —el mes cerró— el 17/10 entra en los DOS
    // lados: Δ y ahorro bajan juntos 10.000 + 999,99 y la identidad se mantiene.
    const al31 = await getMonthReconciliation(db, {
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
    const rec = await getMonthReconciliation(db, {
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

    const rec = await getMonthReconciliation(inflado as unknown as PrismaClient, {
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

    const report = await getDebtReport(db, {
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
    const al10 = await getDebtReport(db, {
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
    const report = await getDebtReport(db, {
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

    const report = await getDebtReport(db, {
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

    const report = await getDebtReport(db, {
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

    const report = await getDebtReport(db, {
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
    });

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
    });

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
      await movementBurn(db, { ...period, movementId: "no-existe" }),
    ).toBeNull();
    // Existe, pero es un ingreso: no hay gasto que repartir.
    expect(
      await movementBurn(db, { ...period, movementId: sueldoEnero.id }),
    ).toBeNull();
    // Existe y es un gasto, pero de OTRO período.
    expect(await movementBurn(db, { ...period, movementId: regalo.id })).toBeNull();

    // El mismo regalo SÍ tiene burn en su propio período: el `null` de arriba
    // es el período, no el gasto.
    const diciembre = await movementBurn(db, {
      from: "2026-12-01",
      to: "2026-12-31",
      movementId: regalo.id,
    });
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
    });

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
    });

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
    const totals = await movementTotals(db, {});
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
    expect((await movementTotals(db, {})).expenses).toBe("0.00");
    const balances = await getAccountBalances(db, {});
    expect(balances[0]?.balance.toFixed(2)).toBe("100000.00");

    // Aceptar la primera SÍ mueve la plata...
    const accepted = await acceptOccurrence(db, overview.pending[0].id);
    expect(accepted.created).toBe(true);
    expect((await movementTotals(db, {})).expenses).toBe("1000.00");

    // ...y la segunda sigue sin mover nada hasta su propio "aceptar".
    expect((await movementTotals(db, {})).expenseCount).toBe(1);
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
  });

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
    expect((await movementTotals(db, {})).expenses).toBe("800.00");

    // Borrar el movimiento reabre la ocurrencia en la MISMA transacción.
    await deleteMovement(db, movement.id);
    expect(await db.movement.count()).toBe(0);
    const reopened = await db.recurrenceOccurrence.findFirstOrThrow({
      where: { ruleId: rule.id },
    });
    expect(reopened.status).toBe("PENDING");
    expect(reopened.movementId).toBeNull();
    expect((await movementTotals(db, {})).expenses).toBe("0.00");

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
    expect((await movementTotals(db, {})).expenses).toBe("800.00");

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
    expect((await movementTotals(db, {})).expenses).toBe("400.00");
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
    const report = await getDebtReport(db, {
      month: "2026-10",
      anchor: "2026-10-31",
    });
    expect(report.rows).toEqual([]);
    expect(report.totalDebt).toBe("0.00");
    expect(report.dti).toMatchObject({ monthlyCommitment: "0.00", planCount: 0 });

    // El patrimonio tampoco cambia por prestar: el activo reemplaza a la plata.
    const worth = await getNetWorth(db, { asOf: "2026-10-31" });
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
      where: { normalizedName: "intereses" },
      update: {},
      create: { name: "Intereses", normalizedName: "intereses", kind: "INCOME" },
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
        principal: "1000",
        tnaPercent: "60",
        installmentCount: 1,
      },
    });
    expect(receivable.id).toBeTruthy();
  });
});
