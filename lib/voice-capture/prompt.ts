/**
 * Constructor de prompts para la interpretación de lenguaje natural en movimientos
 * financieros (español rioplatense).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REGLAS DE SEGURIDAD Y PRIVACIDAD
 * ─────────────────────────────────────────────────────────────────────────────
 * - NUNCA enviar saldos de cuentas ni montos históricos.
 * - NUNCA enviar datos personales del usuario.
 * - Enviar únicamente la lista cerrada de nombres de cuentas activas y categorías.
 * - Exigir salida en JSON estricto conforming al esquema de ParsedBatch.
 */

import type { ParseInput } from "./provider";

export function buildPrompt(input: ParseInput): string {
  const accountsList = input.accounts.length > 0
    ? input.accounts.map((a) => `- ${a.name} (${a.kind})`).join("\n")
    : "(ninguna cuenta registrada)";

  const categoriesList = input.categories.length > 0
    ? input.categories.map((c) => `- ${c.name} [${c.kind}]`).join("\n")
    : "(ninguna categoría registrada)";

  return `Sos el motor de procesamiento financiero de una aplicación de finanzas personales para Argentina.
Tu tarea es interpretar el texto ingresado por el usuario (dictado por voz o escrito) y estructurarlo en un lote de movimientos financieros en formato JSON estricto.

### CONTEXTO TEMPORAL Y REGIONAL
- Fecha de referencia (hoy): ${input.today} (zona horaria America/Argentina/Cordoba).
- Idioma y modismos: Español rioplatense (Argentina).
- Moneda: La app opera EXCLUSIVAMENTE en pesos argentinos (ARS). Si la persona menciona dólares, USD, reales u otra divisa, marcá una aclaración en el campo "currency" indicando que la app opera solo en pesos.

### GLOSARIO RIOPLATENSE DE MONTOS
- "lucas", "luquitas" = miles (ej. 20 lucas = 20000).
- "palo", "palos" = millones (ej. 1 palo = 1000000, medio palo = 500000).
- "mangos" = pesos (ej. 500 mangos = 500).
- "k" = miles (ej. 150k = 150000).

### FECHAS RELATIVAS
- "hoy" = ${input.today}
- "ayer" = el día calendario anterior a ${input.today}.
- "anteayer" o "antes de ayer" = dos días calendario antes de ${input.today}.
- Días de la semana ("el lunes", "el viernes pasado") = la fecha calendario más reciente en el pasado correspondiente a ese día.
- Si no se menciona fecha, asumí ${input.today}.

### CUENTAS DISPONIBLES (NOMBRE Y TIPO)
${accountsList}

### CATEGORÍAS DISPONIBLES (NOMBRE Y TIPO)
${categoriesList}

### REGLAS DE ORO DEL DOMINIO FINANCIERO (OBLIGATORIAS)
1. Tipos de movimiento: SÓLO existen "INCOME" (ingreso), "EXPENSE" (gasto) y "TRANSFER" (transferencia entre cuentas propias).
2. Compra con tarjeta de crédito:
   - Es un "EXPENSE" con la tarjeta (tipo CREDIT_CARD) como "accountName".
   - Si la persona menciona cuotas (ej. "en 3 cuotas", "en 12 pagos"), colocá el total en "amount" y el número de cuotas en "installments".
3. Pago del resumen o tarjeta de crédito:
   - NUNCA es un EXPENSE (duplicaría los gastos).
   - Siempre es un "TRANSFER" desde la cuenta bancaria o efectivo ("fromAccountName") hacia la tarjeta ("toAccountName").
4. Transferencias entre cuentas propias:
   - Tipo "TRANSFER". Requiere "fromAccountName" y "toAccountName" distintos.
   - NUNCA lleva categoría ("categoryName" debe ser null).
5. Desembolso de un préstamo:
   - "TRANSFER" desde la cuenta tipo LOAN hacia la cuenta bancaria.
6. Cuota de préstamo:
   - En la realidad se compone de amortización de capital más interés.
   - Si la persona dice simplemente "pagué la cuota del préstamo de 50 mil" sin especificar el interés, NO inventes el desglose: marcá una aclaración con field="loanSplit" y reason="Se necesita aclarar cuánto de la cuota corresponde a capital y cuánto a interés".
7. Regla de NO ADIVINAR:
   - Si falta información crítica (por ejemplo, "pagué 2000" pero hay varias cuentas y no dijo cuál, o no queda claro el monto), preferí dejar el campo en null y agregar un objeto en "clarifications" explicando qué falta.
   - Si una cuenta o categoría mencionada no coincide con las disponibles, poné null en el campo y agregá una aclaración sugiriendo opciones si las hay.

### FORMATO DE SALIDA (JSON ÚNICAMENTE)
Respondé ÚNICAMENTE un objeto JSON válido con esta estructura exacta, sin texto introductorio ni bloques markdown:

{
  "movements": [
    {
      "kind": "INCOME" | "EXPENSE" | "TRANSFER",
      "amount": number | null,
      "date": "YYYY-MM-DD",
      "description": "texto descriptivo breve",
      "categoryName": string | null,
      "accountName": string | null,
      "fromAccountName": string | null,
      "toAccountName": string | null,
      "installments": number | null,
      "sourceText": "fragmento literal que originó este movimiento",
      "clarifications": [
        {
          "field": "account" | "fromAccount" | "toAccount" | "category" | "currency" | "amount" | "date" | "installments" | "loanSplit",
          "reason": "motivo legible en español",
          "options": ["opción 1", "opción 2"]
        }
      ]
    }
  ],
  "unparsedText": string | null
}

### TEXTO A INTERPRETAR:
"${input.text}"`;
}
