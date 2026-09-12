export type MovementKind = "INCOME" | "EXPENSE";

export interface CategoryDTO {
  id: string;
  name: string;
  kind: MovementKind;
}

export interface MovementDTO {
  id: string;
  kind: MovementKind;
  amount: number;
  description: string | null;
  date: string;
  isFixed: boolean;
  categoryId: string;
  category: CategoryDTO;
}

export function formatMoney(n: number): string {
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2,
  }).format(n);
}

export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
