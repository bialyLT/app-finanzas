-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "closingDay" INTEGER,
ADD COLUMN     "creditLimit" DECIMAL(18,2),
ADD COLUMN     "dueDay" INTEGER;

-- CreateTable
CREATE TABLE "CardPlan" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "totalAmount" DECIMAL(18,2) NOT NULL,
    "installments" INTEGER NOT NULL,
    "purchaseDate" DATE NOT NULL,
    "cashPrice" DECIMAL(18,2),
    "movementId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardPlanItem" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "periodYear" INTEGER NOT NULL,
    "periodMonth" INTEGER NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardPlanItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Statement" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "periodYear" INTEGER NOT NULL,
    "periodMonth" INTEGER NOT NULL,
    "closingDate" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "totalDue" DECIMAL(18,2) NOT NULL,
    "minimumDue" DECIMAL(18,2) NOT NULL,
    "paidMovementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Statement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CardPlan_movementId_key" ON "CardPlan"("movementId");

-- CreateIndex
CREATE INDEX "CardPlan_accountId_purchaseDate_idx" ON "CardPlan"("accountId", "purchaseDate");

-- CreateIndex
CREATE INDEX "CardPlanItem_periodYear_periodMonth_idx" ON "CardPlanItem"("periodYear", "periodMonth");

-- CreateIndex
CREATE UNIQUE INDEX "CardPlanItem_planId_number_key" ON "CardPlanItem"("planId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Statement_paidMovementId_key" ON "Statement"("paidMovementId");

-- CreateIndex
CREATE INDEX "Statement_accountId_dueDate_idx" ON "Statement"("accountId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "Statement_accountId_periodYear_periodMonth_key" ON "Statement"("accountId", "periodYear", "periodMonth");

-- AddForeignKey
ALTER TABLE "CardPlan" ADD CONSTRAINT "CardPlan_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardPlan" ADD CONSTRAINT "CardPlan_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "Movement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardPlanItem" ADD CONSTRAINT "CardPlanItem_planId_fkey" FOREIGN KEY ("planId") REFERENCES "CardPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Statement" ADD CONSTRAINT "Statement_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Statement" ADD CONSTRAINT "Statement_paidMovementId_fkey" FOREIGN KEY ("paidMovementId") REFERENCES "Movement"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════
-- INVARIANTES DE LAS TARJETAS Y LAS CUOTAS — FASE 5
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Mismo criterio que las migraciones anteriores: el estado imposible no se
-- puede guardar. Las validaciones de la API existen para dar mensajes claros;
-- las de acá existen para que ni un script, ni una consola SQL, ni un camino
-- futuro de la app puedan dejar la base describiendo algo que no es.
--
-- ───────────────────────────────────────────────────────────────────────────
-- Account · los parámetros de la tarjeta
-- ───────────────────────────────────────────────────────────────────────────
-- `closingDay`/`dueDay` son ANCLAS de día del mes (1..31, se clampean a fin de
-- mes al calcular) y van juntos o no van: un cierre sin vencimiento no
-- describe un resumen. El límite es positivo: un límite de 0 no es un límite.
-- Todo esto sólo tiene sentido en una cuenta CREDIT_CARD: cargar el día de
-- cierre de una cuenta de efectivo sería una promesa vacía.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "Account"
  ADD CONSTRAINT "account_card_days_range" CHECK (
    ("closingDay" IS NULL AND "dueDay" IS NULL)
    OR
    ("closingDay" BETWEEN 1 AND 31 AND "dueDay" BETWEEN 1 AND 31)
  );

ALTER TABLE "Account"
  ADD CONSTRAINT "account_card_params_only_on_cards" CHECK (
    "kind" = 'CREDIT_CARD'
    OR
    ("closingDay" IS NULL AND "dueDay" IS NULL AND "creditLimit" IS NULL)
  );

ALTER TABLE "Account"
  ADD CONSTRAINT "account_credit_limit_positive" CHECK (
    "creditLimit" IS NULL OR "creditLimit" > 0
  );

-- ───────────────────────────────────────────────────────────────────────────
-- CardPlan · la compra en cuotas
-- ───────────────────────────────────────────────────────────────────────────
-- Monto positivo (el signo lo da el gasto que la compra crea), cuotas >= 1 y
-- precio de contado positivo si está. El tope de 600 es un backstop contra
-- basura (la API acepta hasta 120: una tarjeta no financia a 600 cuotas).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "CardPlan"
  ADD CONSTRAINT "cardplan_amount_positive" CHECK ("totalAmount" > 0);

ALTER TABLE "CardPlan"
  ADD CONSTRAINT "cardplan_installments_range" CHECK ("installments" BETWEEN 1 AND 600);

ALTER TABLE "CardPlan"
  ADD CONSTRAINT "cardplan_cash_price_positive" CHECK ("cashPrice" IS NULL OR "cashPrice" > 0);

-- ───────────────────────────────────────────────────────────────────────────
-- CardPlanItem · una cuota en un período de resumen
-- ───────────────────────────────────────────────────────────────────────────
-- Número desde 1, mes de cierre 1..12 y monto positivo. El reparto
-- `totalAmount ÷ N` garantiza que los items sumen EXACTO el total (lo hace el
-- servicio): la base se ocupa de que ninguna cuota suelta sea un disparate.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "CardPlanItem"
  ADD CONSTRAINT "cardplanitem_number_positive" CHECK ("number" >= 1);

ALTER TABLE "CardPlanItem"
  ADD CONSTRAINT "cardplanitem_period_month_range" CHECK ("periodMonth" BETWEEN 1 AND 12);

ALTER TABLE "CardPlanItem"
  ADD CONSTRAINT "cardplanitem_amount_positive" CHECK ("amount" > 0);

-- ───────────────────────────────────────────────────────────────────────────
-- Statement · el resumen
-- ───────────────────────────────────────────────────────────────────────────
-- Mes 1..12; el vencimiento SIEMPRE posterior al cierre (la semántica de
-- `dueDay` es "el primer día de vencimiento después del cierre"); y el mínimo
-- nunca negativo ni mayor que el total. NOTA: `paidMovementId` es SET NULL a
-- propósito — borrar el pago deshace el pago y el resumen vuelve a quedar
-- impago; no se agrega ningún CHECK de "pagado" porque el impago es un estado
-- legal y frecuente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "Statement"
  ADD CONSTRAINT "statement_period_month_range" CHECK ("periodMonth" BETWEEN 1 AND 12);

ALTER TABLE "Statement"
  ADD CONSTRAINT "statement_due_after_closing" CHECK ("dueDate" > "closingDate");

ALTER TABLE "Statement"
  ADD CONSTRAINT "statement_amounts_nonnegative" CHECK (
    "totalDue" >= 0 AND "minimumDue" >= 0 AND "minimumDue" <= "totalDue"
  );

