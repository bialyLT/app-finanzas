/**
 * Detección de posibles movimientos duplicados en el proceso de revisión.
 */

import { formatMoney } from "../format";
import { money } from "../money";
import type { ResolvedMovement } from "./resolve";

export interface ExistingMovementRecord {
  id: string;
  kind: string;
  amount: string; // formato decimal string desde DB
  date: string; // AAAA-MM-DD
  description: string;
  accountId: string;
}

export interface PossibleDuplicateMatch {
  id: string;
  reason: string;
}

export function findPossibleDuplicates(
  candidate: ResolvedMovement,
  existing: ExistingMovementRecord[],
): PossibleDuplicateMatch | null {
  if (!candidate.amount || !candidate.date) return null;

  const candidateAmountStr = money(candidate.amount).toFixed(2);
  const targetAccountId =
    candidate.kind === "TRANSFER"
      ? candidate.fromAccountId
      : candidate.accountId;

  if (!targetAccountId) return null;

  for (const record of existing) {
    if (record.date !== candidate.date) continue;
    if (record.accountId !== targetAccountId) continue;
    if (record.kind !== candidate.kind) continue;

    if (record.amount === candidateAmountStr) {
      return {
        id: record.id,
        reason: `Ya existe un movimiento de ${formatMoney(
          record.amount,
        )} en esta misma fecha y cuenta ("${record.description}").`,
      };
    }
  }

  return null;
}
