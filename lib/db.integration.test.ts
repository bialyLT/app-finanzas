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
import { calendarToDb } from "./dates";
import { MOVEMENTS_MAX_ROWS } from "./finance";
import { amortizationSchedule } from "./money";
import { getAccountBalances, getNetWorth } from "./balance";
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
});

/** Vacía las tablas respetando el orden de las claves foráneas. */
async function resetDatabase() {
  await db.movement.deleteMany();
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
