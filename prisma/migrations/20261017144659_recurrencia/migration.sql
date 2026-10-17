-- CreateEnum
CREATE TYPE "RecurFreq" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "PostingMode" AS ENUM ('AUTO', 'NOTIFY');

-- CreateEnum
CREATE TYPE "RecurrenceRuleStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RecurrenceOccurrenceStatus" AS ENUM ('PENDING', 'POSTED', 'SKIPPED');

-- AlterTable
ALTER TABLE "Movement" ADD COLUMN     "recurrenceRuleId" TEXT;

-- CreateTable
CREATE TABLE "RecurrenceRule" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "MovementKind" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "accountId" TEXT NOT NULL,
    "toAccountId" TEXT,
    "categoryId" TEXT,
    "freq" "RecurFreq" NOT NULL,
    "interval" INTEGER NOT NULL DEFAULT 1,
    "dayOfMonth" INTEGER,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "count" INTEGER,
    "postingMode" "PostingMode" NOT NULL DEFAULT 'NOTIFY',
    "status" "RecurrenceRuleStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurrenceRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurrenceOccurrence" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "dueDate" DATE NOT NULL,
    "status" "RecurrenceOccurrenceStatus" NOT NULL DEFAULT 'PENDING',
    "postedAt" TIMESTAMP(3),
    "skippedAt" TIMESTAMP(3),
    "movementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurrenceOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecurrenceRule_status_idx" ON "RecurrenceRule"("status");

-- CreateIndex
CREATE UNIQUE INDEX "RecurrenceOccurrence_movementId_key" ON "RecurrenceOccurrence"("movementId");

-- CreateIndex
CREATE INDEX "RecurrenceOccurrence_status_dueDate_idx" ON "RecurrenceOccurrence"("status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "RecurrenceOccurrence_ruleId_dueDate_key" ON "RecurrenceOccurrence"("ruleId", "dueDate");

-- CreateIndex
CREATE INDEX "Movement_recurrenceRuleId_date_idx" ON "Movement"("recurrenceRuleId", "date");

-- AddForeignKey
ALTER TABLE "Movement" ADD CONSTRAINT "Movement_recurrenceRuleId_fkey" FOREIGN KEY ("recurrenceRuleId") REFERENCES "RecurrenceRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurrenceRule" ADD CONSTRAINT "RecurrenceRule_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurrenceRule" ADD CONSTRAINT "RecurrenceRule_toAccountId_fkey" FOREIGN KEY ("toAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurrenceRule" ADD CONSTRAINT "RecurrenceRule_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurrenceOccurrence" ADD CONSTRAINT "RecurrenceOccurrence_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "RecurrenceRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurrenceOccurrence" ADD CONSTRAINT "RecurrenceOccurrence_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "Movement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═════════════════════════════════════════════════════════════════════════════
-- INVARIANTES DE LA RECURRENCIA
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ─────────────────────────────────────────────────────────────────────────────
-- POR QUÉ UNA REGLA TIENE LAS MISMAS REGLAS DE FORMA QUE UN MOVIMIENTO
-- ─────────────────────────────────────────────────────────────────────────────
-- Una regla es la PROMESA de un movimiento: dice "el 1 de cada mes sale el
-- alquiler". Si la regla pudiera describir algo que `Movement` rechaza —una
-- transferencia sin destino, un ingreso sin categoría, un monto en cero— el
-- error aparecería MESES DESPUÉS, en el momento del posteo, lejísimos de la
-- causa: la regla que se cargó mal. El usuario vería que "la app no funciona"
-- sin ninguna pista de qué arreglar.
--
-- Con las mismas restricciones en la regla, el estado imposible no se puede
-- guardar y el generador no tiene nada que defender. Mismo criterio que
-- `movement_shape_by_kind`: se define qué ES cada tipo, no qué no es.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "RecurrenceRule"
  ADD CONSTRAINT "recurrence_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "RecurrenceRule"
  ADD CONSTRAINT "recurrence_shape_by_kind" CHECK (
    (
      "kind" = 'TRANSFER'
      AND "toAccountId" IS NOT NULL
      AND "categoryId" IS NULL
    )
    OR
    (
      "kind" IN ('INCOME', 'EXPENSE')
      AND "toAccountId" IS NULL
      AND "categoryId" IS NOT NULL
    )
  );

ALTER TABLE "RecurrenceRule"
  ADD CONSTRAINT "recurrence_transfer_to_other_account" CHECK (
    "toAccountId" IS NULL OR "toAccountId" <> "accountId"
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Las restricciones que sólo tienen sentido en una regla
-- ─────────────────────────────────────────────────────────────────────────────

-- "Cada 0 meses" no es una recurrencia: es una división por cero esperando en
-- el generador. Y un intervalo negativo iría hacia atrás, generando fechas
-- anteriores al inicio de la regla.
ALTER TABLE "RecurrenceRule"
  ADD CONSTRAINT "recurrence_interval_positive" CHECK ("interval" >= 1);

-- El ancla del día del mes sólo existe en MONTHLY y YEARLY (en DAILY y WEEKLY
-- no hay "día del mes" que anclar), y tiene que ser un día que exista en algún
-- mes: 1..31. El clamp a fin de mes lo hace el motor.
ALTER TABLE "RecurrenceRule"
  ADD CONSTRAINT "recurrence_dayofmonth_range" CHECK (
    "dayOfMonth" IS NULL
    OR ("freq" IN ('MONTHLY', 'YEARLY') AND "dayOfMonth" BETWEEN 1 AND 31)
  );

-- Una regla que termina antes de empezar no tiene ninguna ocurrencia: es una
-- fila que no puede hacer nada y que el usuario no va a entender por qué está.
ALTER TABLE "RecurrenceRule"
  ADD CONSTRAINT "recurrence_end_after_start" CHECK (
    "endDate" IS NULL OR "endDate" >= "startDate"
  );

ALTER TABLE "RecurrenceRule"
  ADD CONSTRAINT "recurrence_count_positive" CHECK ("count" IS NULL OR "count" >= 1);

-- ─────────────────────────────────────────────────────────────────────────────
-- El estado de una ocurrencia define sus datos, y al revés
-- ─────────────────────────────────────────────────────────────────────────────
-- Se escribe como una definición POSITIVA de cada estado: así un estado
-- imposible ("POSteada sin movimiento", "saltada con movimiento") no se puede
-- guardar. Sin esto, un bug que cambia el status y se olvida del resto deja la
-- bandeja diciendo "hecho" sobre una ocurrencia que no tiene ningún movimiento
-- detrás — plata que la app afirma y no existe.
ALTER TABLE "RecurrenceOccurrence"
  ADD CONSTRAINT "occurrence_shape_by_status" CHECK (
    (
      "status" = 'PENDING'
      AND "movementId" IS NULL
      AND "postedAt" IS NULL
      AND "skippedAt" IS NULL
    )
    OR
    (
      "status" = 'POSTED'
      AND "movementId" IS NOT NULL
      AND "postedAt" IS NOT NULL
      AND "skippedAt" IS NULL
    )
    OR
    (
      "status" = 'SKIPPED'
      AND "movementId" IS NULL
      AND "postedAt" IS NULL
      AND "skippedAt" IS NOT NULL
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- LA GARANTÍA FINAL CONTRA EL DOBLE POSTEO
-- ─────────────────────────────────────────────────────────────────────────────
-- Las otras dos defensas son estructurales pero indirectas:
--
--   · `RecurrenceOccurrence_ruleId_dueDate_key` → una regla no puede tener dos
--     ocurrencias para la misma fecha.
--   · `RecurrenceOccurrence_movementId_key`      → un movimiento no puede
--     responder a dos ocurrencias.
--
-- Faltaba la mitad que cierra el argumento: que una REGLA no pueda tener dos
-- movimientos con la misma fecha. Con este índice parcial, postear dos veces la
-- misma ocurrencia —por un bug, por dos pedidos simultáneos, por un reintento—
-- es imposible a nivel de la BASE, no de la aplicación. Y no excluye ningún
-- caso legítimo: una regla produce exactamente un movimiento por fecha.
--
-- Es parcial (`WHERE recurrenceRuleId IS NOT NULL`) para no afectar a los
-- movimientos manuales: dos gastos manuales del mismo día son perfectamente
-- posibles y no tienen nada que ver con ninguna regla.
CREATE UNIQUE INDEX "Movement_recurrence_rule_date_key"
  ON "Movement" ("recurrenceRuleId", "date")
  WHERE "recurrenceRuleId" IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- El trigger de "un pasivo no recibe ingresos" también vale para las reglas
-- ─────────────────────────────────────────────────────────────────────────────
-- La regla que promete un ingreso hacia un préstamo es tan imposible como el
-- movimiento mismo, y por el mismo motivo: a un pasivo no le entra plata, se le
-- reduce la deuda.
--
-- La función se RENOMBRA porque ahora la usan dos tablas: el nombre viejo
-- (`check_movement_account_kind`) decía la verdad a medias. Los triggers ya
-- creados apuntan a la función por OID, así que el renombre no los afecta.
ALTER FUNCTION check_movement_account_kind() RENAME TO check_no_income_on_liability_account;

CREATE TRIGGER "recurrence_account_kind_check"
  BEFORE INSERT OR UPDATE ON "RecurrenceRule"
  FOR EACH ROW
  EXECUTE FUNCTION check_no_income_on_liability_account();
