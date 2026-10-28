/**
 * Esquemas de validación Zod y tipos de dominio para la captura de movimientos
 * por voz, texto y comprobantes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PRINCIPIO DE AISLAMIENTO
 * ─────────────────────────────────────────────────────────────────────────────
 * El modelo de IA o la transcripción produce un JSON crudo que se valida acá
 * antes de ingresar al sistema. Ningún dato no verificado llega a la base.
 *
 * Los nombres devueltos (cuentas, categorías) son strings que luego el servidor
 * resuelve contra la base de datos de la persona.
 */

import { z } from "zod";

/** Tipos canónicos de movimientos en el sistema. */
export const MovementKind = z.enum(["INCOME", "EXPENSE", "TRANSFER"]);
export type MovementKind = z.infer<typeof MovementKind>;

/** Campos susceptibles a aclaración por ambigüedad o falta de datos. */
export const ClarificationField = z.enum([
  "account",
  "fromAccount",
  "toAccount",
  "category",
  "currency",
  "amount",
  "date",
  "installments",
  "loanSplit",
]);
export type ClarificationField = z.infer<typeof ClarificationField>;

/** Esquema de una aclaración requerida para que la persona resuelva en UI. */
export const ClarificationSchema = z.object({
  field: ClarificationField,
  reason: z.string().min(1, "La razón de la aclaración no puede estar vacía."),
  options: z.array(z.string()).optional(),
});
export type Clarification = z.infer<typeof ClarificationSchema>;

/** Movimiento parseado propuesto por el motor de interpretación. */
export const ParsedMovementSchema = z.object({
  kind: MovementKind,
  amount: z.number().positive().nullable(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener formato AAAA-MM-DD."),
  description: z.string().max(200),
  categoryName: z.string().nullable(),
  accountName: z.string().nullable(),
  fromAccountName: z.string().nullable(),
  toAccountName: z.string().nullable(),
  installments: z.number().int().min(1).nullable(),
  sourceText: z.string(),
  clarifications: z.array(ClarificationSchema),
});
export type ParsedMovement = z.infer<typeof ParsedMovementSchema>;

/** Lote completo devuelto por el endpoint de interpretación. */
export const ParsedBatchSchema = z.object({
  movements: z.array(ParsedMovementSchema),
  unparsedText: z.string().nullable(),
});
export type ParsedBatch = z.infer<typeof ParsedBatchSchema>;
