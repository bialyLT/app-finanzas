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
import { movementTotals } from "./queries";

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
