-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "categoryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Budget_month_idx" ON "Budget"("month");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_categoryId_month_key" ON "Budget"("categoryId", "month");

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Invariante: el monto presupuestado tiene que ser estrictamente positivo (> 0).
ALTER TABLE "Budget" ADD CONSTRAINT "budget_amount_positive" CHECK ("amount" > 0);

