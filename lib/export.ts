/**
 * Serialización y formateo para exportación de datos a CSV y JSON.
 */

import type { MovementDTO } from "./finance";

/**
 * Escapa un campo para formato CSV (RFC 4180).
 * Si contiene comas, comillas dobles o saltos de línea, lo encierra entre comillas
 * y duplica las comillas internas.
 */
export function escapeCsvField(val: string | null | undefined): string {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Genera el contenido de un archivo CSV a partir de una lista de movimientos.
 * Compatible directamente con el importador de CSV del sistema.
 */
export function exportMovementsToCsv(movements: MovementDTO[]): string {
  const headers = [
    "fecha",
    "tipo",
    "monto",
    "cuenta",
    "cuenta_destino",
    "categoria",
    "descripcion",
  ];

  const rows = movements.map((m) => {
    return [
      escapeCsvField(m.date),
      escapeCsvField(m.kind),
      escapeCsvField(m.amount),
      escapeCsvField(m.account.name),
      escapeCsvField(m.toAccount?.name ?? ""),
      escapeCsvField(m.category?.name ?? ""),
      escapeCsvField(m.description ?? ""),
    ].join(",");
  });

  return [headers.join(","), ...rows].join("\r\n");
}
