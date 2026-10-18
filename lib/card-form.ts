/**
 * Validación del par cierre/vencimiento del formulario de tarjeta.
 *
 * Vive acá y no dentro de cada componente porque los dos formularios que
 * editan la configuración de una tarjeta —el alta de cuenta y el modal de
 * `/tarjetas`— tienen que decir exactamente lo mismo: el contrato de la API es
 * que los dos días van juntos, enteros entre 1 y 31. Repetir la regla en dos
 * archivos es la forma conocida de que un día las dos copias no coincidan.
 *
 * Es una función pura y sin dependencias: se puede usar en componentes de
 * cliente (a diferencia de `lib/cards.ts`, que importa `lib/money.ts` y con él
 * el cliente de Prisma).
 *
 * @returns el mensaje de error, o `""` si el par está bien (o los dos vacíos).
 */
export function cardDaysError(closingDay: string, dueDay: string): string {
  const closing = closingDay.trim();
  const due = dueDay.trim();

  if (closing === "" && due === "") return "";
  if (closing === "" || due === "") {
    return "El día de cierre y el de vencimiento van juntos: cargá los dos (o ninguno de los dos).";
  }

  const closingNumber = Number(closing);
  const dueNumber = Number(due);
  const inRange = (value: number) =>
    Number.isInteger(value) && value >= 1 && value <= 31;

  if (
    !/^\d{1,2}$/.test(closing) ||
    !/^\d{1,2}$/.test(due) ||
    !inRange(closingNumber) ||
    !inRange(dueNumber)
  ) {
    return "El día de cierre y el de vencimiento tienen que ser números enteros entre 1 y 31.";
  }

  return "";
}
