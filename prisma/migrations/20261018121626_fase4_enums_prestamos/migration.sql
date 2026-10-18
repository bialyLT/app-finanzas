-- ═══════════════════════════════════════════════════════════════════════════
-- PRÉSTAMOS — FASE 4 · PARTE 1: LOS ENUMS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ───────────────────────────────────────────────────────────────────────────
-- POR QUÉ ESTA MIGRACIÓN ES SOLO DE ENUMS (y está separada de la siguiente)
-- ───────────────────────────────────────────────────────────────────────────
-- Postgres no deja USAR un valor recién agregado a un enum dentro de la MISMA
-- transacción que lo agregó ("unsafe use of new value"). Prisma ejecuta cada
-- migración adentro de una transacción, así que:
--
--   · acá se AGREGA el valor 'RECEIVABLE' y se CREA el tipo AmortizationSystem;
--   · en la migración siguiente se USA 'RECEIVABLE' en los CHECKs nuevos.
--
-- Sin la separación, el CHECK `loan_parameters_only_on_loans` (que tiene que
-- nombrar al valor nuevo) explotaría con "unsafe use of new value of enum type
-- AccountKind". Es el mismo motivo por el que la Fase 5 dividió sus CHECKs.
--
-- `AmortizationSystem` es un tipo NUEVO: sus valores se pueden usar de
-- inmediato, pero se crea acá igual para que los dos enums del contrato de
-- préstamos vivan juntos y la parte 2 pueda referenciarlo sin ceremonia.
-- ═══════════════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "AmortizationSystem" AS ENUM ('FRENCH', 'GERMAN', 'AMERICAN', 'INTEREST_ONLY', 'IMPORTED');

-- AlterEnum
-- La cuenta espejo de LOAN: un préstamo que DISTE (te deben). Es un ACTIVO.
ALTER TYPE "AccountKind" ADD VALUE 'RECEIVABLE';
