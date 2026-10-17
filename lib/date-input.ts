/**
 * Terminar de vaciar un `<input type="date">` cuando quedó a medias.
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────
 *
 * Un input de fecha no se vacía "de a uno": sus segmentos (día, mes, año) son
 * independientes y el backspace limpia SOLO el que está seleccionado — que al
 * enfocar con un clic es el primero. Después de borrar una fecha con el
 * teclado el campo queda mostrando pedazos (`mm/31/2027`, o `dd/mm/aaaa` según
 * el idioma del navegador), con dos consecuencias feas:
 *
 * 1. El navegador REPORTA `""` como valor de un campo incompleto, así que
 *    React ya recibió el vacío y el estado de la app cree que no hay fecha.
 *    Pero los segmentos siguen ahí y la validación nativa marca el campo
 *    inválido (`validity.badInput`).
 * 2. Al guardar, el navegador frena el submit y muestra su propia burbuja — en
 *    INGLÉS, porque sigue el idioma del navegador y no el de la app: "Please
 *    enter a valid value. The field is incomplete or has an invalid date."
 *    El usuario toca "Guardar" y no pasa NADA, con un mensaje que no es de
 *    esta app.
 *
 * ── QUÉ HACE ─────────────────────────────────────────────────────────────────
 *
 * Cuando el valor reportado quedó en `""` pero el nodo sigue con segmentos a
 * medias, asigna `value = ""`: el setter de los inputs de fecha descarta los
 * segmentos y deja el campo válido y vacío (medido sobre Chrome real: tras
 * esto el submit vuelve a dispararse y la burbuja nativa desaparece).
 *
 * Sin esta línea el campo queda a medias PARA SIEMPRE: React no lo reescribe
 * (su valor ya era `""`, no hay cambio de prop que sincronizar), y con teclado
 * no hay forma de recuperarlo — el backspace sobre un segmento ya vacío no
 * avanza hacia los otros.
 *
 * Se usa en TODOS los inputs de fecha de la app (recurrencia, gastos, cuotas),
 * porque el problema es del navegador, no de una pantalla.
 *
 * ── POR QUÉ NO SÍNCRONO CON EL ESTADO ───────────────────────────────────────
 *
 * La alternativa —"si hay badInput, vaciar siempre"— rompería TIPEar: cada
 * dígito suelto de una fecha en construcción también deja el valor en `""`
 * con `badInput`, así que el campo se borraría debajo de los dedos del
 * usuario. Este guardado sólo actúa en la transición a vacío, que es
 * inequívocamente "esto se está borrando".
 */
export function clearDateInputIfEmptied(input: HTMLInputElement): void {
  if (input.value === "" && input.validity.badInput) {
    input.value = "";
  }
}
