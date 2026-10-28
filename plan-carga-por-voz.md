# Plan de trabajo: carga de movimientos por voz, texto y comprobantes

## 1. Objetivo

Que la persona cuente en lenguaje natural lo que movió durante el día ("gasté 4500 en el súper con la Galicia, 1200 de nafta en efectivo, me pagaron 150 mil del freelance en Mercado Pago") y la app proponga los movimientos ya estructurados. **Nada se guarda sin confirmación explícita.**

Entradas soportadas (todas pasan por el mismo motor y la misma pantalla de confirmación):

1. Voz (Web Speech API del navegador, costo 0).
2. Texto escrito (fallback si no hay voz, y también para dictado del teclado del celular).
3. Comprobante (captura o PDF) leído con un modelo con visión.

## 2. Decisiones ya tomadas y alineadas con la app

| Tema | Decisión alineada con el contexto del repo |
|---|---|
| Stack | Next.js 16 (App Router) + TypeScript + Tailwind CSS v4 + Prisma + PostgreSQL 17 |
| Voz a texto | Web Speech API (`es-AR`), sin costo. Whisper queda suspendido |
| Interpretación | LLM con salida estructurada, detrás de una interfaz `AiProvider` intercambiable. Proveedor inicial: Gemini Flash vía `fetch` REST nativo (modelo configurable por `AI_MODEL`, key por `GEMINI_API_KEY`) |
| Confirmación | Siempre obligatoria. Sin auto-guardado |
| Uso | Cargas sueltas durante el día y resumen del día, con el mismo motor |
| Monedas | **Moneda única: ARS.** La app no maneja multimoneda en su modelo ni tablas. Si la persona menciona dólares u otra divisa, el motor marca una aclaración de que sólo se opera en ARS |
| Costo | Lo más cercano a 0. Capa gratuita de Gemini |
| Usuarios | Monousuario. Sesión con cookie HMAC-SHA256 y CSRF con `Origin` (`lib/auth/dal.ts` + `lib/auth/csrf.ts`). Todas las cuentas pertenecen a la persona |
| Sistema de diseño | Estilo semántico propio «C · Noche» (`docs/design-system.md`). Cero colores de fábrica (`zinc-*`, `blue-*`), iconos Lucide sin emojis, touch targets ≥ 44px (`npm run check:estilo`, `npm run check:css`, auditoría responsive) |

## 3. Modelo de dominio (ya existente, NO modificar su semántica)

- Tipos de movimiento: `INCOME`, `EXPENSE`, `TRANSFER`. **No existen más.**
- `Account` con `AccountKind`: `CASH`, `BANK`, `CREDIT_CARD`, `LOAN`, `RECEIVABLE`. Nombre único por cuenta.
- Las tarjetas son cuentas con día de cierre, vencimiento y límite. Las compras en cuotas generan un `CardPlan` (`lib/card-service.ts`).
- Categorías: `name` legible, `normalizedName` único global, y tipo `INCOME` o `EXPENSE`.
  - Invariante crítico: una `TRANSFER` no lleva categoría.
  - Invariante crítico: el tipo de la categoría debe coincidir con el del movimiento (`movement_category_kind_check`).
- `RecurrenceRule`: gastos e ingresos periódicos (diaria, semanal, mensual, anual). El sistema los proyecta y los postea o avisa. Fuera del alcance de la v1.

### Reglas de oro que el motor debe respetar

1. **Compra con tarjeta** = `EXPENSE` con la tarjeta como cuenta de origen (aumenta la deuda). Si es en cuotas, se crea `CardPlan`.
2. **Pago del resumen de la tarjeta** = `TRANSFER` de banco/efectivo hacia la cuenta tarjeta. **Nunca** un `EXPENSE` (duplicaría el gasto).
3. **Desembolso de un préstamo** = `TRANSFER` de la cuenta `LOAN` al banco.
4. **Cuota de préstamo** = `TRANSFER` (capital) del banco al `LOAN` **más** un `EXPENSE` (interés). Si la persona dice solo "pagué la cuota de 100 mil" sin desglose, el motor **no inventa el reparto**: marca "falta aclarar".
5. Un `TRANSFER` nunca tiene la misma cuenta de origen y destino.
6. **Moneda**: cualquier monto interpretado se asigna a ARS. Si se pide otra moneda, se marca aclaración.

## 4. Arquitectura

```
[Voz / Texto / Comprobante]
        │
        ▼
 POST /api/parse   ──►  AiProvider (Gemini via REST fetch, intercambiable)
        │                    ▲
        │            contexto: cuentas activas (nombre + kind),
        │            categorías activas (nombre + kind), fecha local hoy (AAAA-MM-DD)
        ▼
 Validación servidor (Zod + reglas de oro + normalización de nombres)
        │
        ▼
 ParsedBatch { movements[], clarifications[], unparsedText }
        │
        ▼
 Pantalla de confirmación (ReviewSheet con tokens «C · Noche»)
        │  (persona aprueba / edita)
        ▼
 POST /api/movements/batch  ──►  Servicio transaccional (reutiliza prisma.movement y createCardPlan)
```

Principio clave: **el LLM nunca escribe en la base de datos.** Solo propone. El guardado reutiliza la lógica de negocio existente, para que todas las invariantes (saldos, `CardPlan`, constraints de base) se apliquen igual que en la carga manual.

## 5. Contrato de datos

```ts
// src/features/voice-capture/schema.ts
import { z } from "zod";

export const MovementKind = z.enum(["INCOME", "EXPENSE", "TRANSFER"]);

export const ClarificationSchema = z.object({
  field: z.enum([
    "account", "fromAccount", "toAccount", "category",
    "currency", "amount", "date", "installments", "loanSplit",
  ]),
  reason: z.string(),                      // en español, legible para la persona
  options: z.array(z.string()).optional(), // opciones sugeridas si las hay
});

export const ParsedMovementSchema = z.object({
  kind: MovementKind,
  amount: z.number().positive().nullable(),        // null si no se pudo determinar
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),   // fecha de calendario AAAA-MM-DD
  description: z.string().max(200),
  categoryName: z.string().nullable(),             // solo INCOME/EXPENSE
  accountName: z.string().nullable(),              // INCOME/EXPENSE
  fromAccountName: z.string().nullable(),          // TRANSFER
  toAccountName: z.string().nullable(),            // TRANSFER
  installments: z.number().int().min(1).nullable(),// solo EXPENSE con tarjeta de crédito
  sourceText: z.string(),                          // fragmento original transcripto
  clarifications: z.array(ClarificationSchema),
});

export const ParsedBatchSchema = z.object({
  movements: z.array(ParsedMovementSchema),
  unparsedText: z.string().nullable(),
});
```

Los nombres de cuentas y categorías devueltos por el LLM se **resuelven en el servidor** contra las listas reales (con `cleanName` y `normalizeCategoryName` de `lib/finance.ts`). Si no matchea, el campo queda `null` y se genera una aclaración. Nunca se crea una cuenta o categoría nueva desde el motor sin confirmación de la persona.

## 6. Fases y tareas

### Fase 0: Reconocimiento (CERRADA)
- **T0.1 Mapear el sistema existente**: Completado en `docs/voice-capture-recon.md`. Respuestas a las 5 preguntas del modelo de datos, cuentas, tarjetas, auth y estilo propio.

### Fase 1: Contrato y motor de interpretación
- **T1.1 Esquemas Zod y tipos de dominio**: Instalación de `zod`, definición de esquemas en `lib/voice-capture/schema.ts`. Tests unitarios de validación en `lib/voice-capture/schema.test.ts`.
- **T1.2 Interfaz `AiProvider`**:
  ```ts
  export interface AiProvider {
    parseMovements(input: ParseInput): Promise<unknown>;
  }
  ```
  - `GeminiProvider`: llamada HTTP directa a la API REST de Gemini (`generativelanguage.googleapis.com`) usando `fetch` nativo de Node.js, `responseMimeType: "application/json"`, timeout de 15s y 1 reintento ante error 5xx / 429.
  - `MockProvider`: para tests unitarios y CI sin requerir credenciales externas.
- **T1.3 Constructor de prompt (`buildPrompt`)**:
  - Contexto mínimo y seguro: fecha de hoy (`todayCalendar()`), cuentas activas (nombre + `AccountKind`), categorías activas (nombre + tipo). **Cero saldos, cero números de cuenta, cero datos sensibles.**
  - Reglas del lenguaje: jerga rioplatense ("lucas", "palos", "mangos"), números hablados, fechas relativas ("ayer", "el viernes pasado"), reglas de oro y regla estricta de no adivinar.
  - Tests unitarios de armado de prompt.
- **T1.4 Validador y resolvedor de servidor (`resolveBatch`)**:
  - Valida contra `ParsedBatchSchema`.
  - Resuelve cuentas contra la base de datos (por nombre normalizado).
  - Resuelve categorías existentes asegurando compatibilidad con el tipo de movimiento.
  - Aplica reglas de oro:
    - Pago de tarjeta marcado como gasto se transforma a `TRANSFER` o genera aclaración.
    - Transferencia con cuenta origen = destino genera aclaración.
    - Cuota de préstamo sin desglose genera aclaración `loanSplit`.
    - Mención de moneda extranjera genera aclaración indicando que la app opera en ARS.
    - Fecha futura o inválida genera aclaración.
  - Tests unitarios exhaustivos de resolución y casos borde.
- **T1.5 Endpoint `POST /api/parse`**:
  - Headers: requiere sesión (`requireApiSession`) y validación CSRF (`assertSameOrigin`).
  - Rate limiting básico en memoria por IP.
  - Body: `{ text: string }`.
  - Manejo de errores con mensajes claros en español rioplatense sin exponer la API key.
  - Tests de integración de ruta con `MockProvider`.

### Fase 2: Captura de voz y texto
- **T2.1 Hook `useSpeechCapture`**:
  - Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`), idioma `es-AR`.
  - Soporte para transcripción continua e intermedia.
  - Estados: `idle | listening | processing | error | unsupported`.
  - Manejo de permisos denegados o API no disponible con fallback automático a texto.
  - Tests unitarios con mock de `SpeechRecognition`.
- **T2.2 Componente `VoiceCaptureModal` + botón de acceso**:
  - Botón de micrófono integrado en la interfaz respetando el estilo «C · Noche» (sin colores de fábrica, iconos `lucide-react`, touch target ≥ 44px).
  - Panel con área de transcripción en vivo editable antes de enviar.
  - Selector de modo (voz / texto escrito).
  - Tests y verificación con `check:estilo`.
- **T2.3 Conexión con `/api/parse`**:
  - Estados de carga, spinner accesible, mensajes de error y reintento sin perder el texto ingresado.

### Fase 3: Confirmación y guardado
- **T3.1 Componente `ReviewSheet` (Confirmación editable)**:
  - Tarjetas editables por cada movimiento propuesto (`sourceText`, tipo, monto, cuenta, categoría, fecha).
  - Selectores desplegables alimentados de las cuentas y categorías reales del usuario.
  - Visualización destacada de aclaraciones pendientes que impiden el guardado del movimiento hasta ser resueltas.
  - Posibilidad de descartar movimientos o agregar uno nuevo.
  - Cumplimiento de tokens semánticos «C · Noche» y mobile responsive.
- **T3.2 Endpoint `POST /api/movements/batch`**:
  - Autenticado (`requireApiSession`) y protegido contra CSRF (`assertSameOrigin`).
  - Revalida el lote completo en servidor.
  - Servicio transaccional `saveMovementBatch` dentro de `prisma.$transaction`:
    - Movimientos simples (`INCOME`, `EXPENSE`, `TRANSFER`).
    - Compras en cuotas vía `createCardPlan` de `lib/card-service.ts`.
  - Manejo de clave de idempotencia (`batchKey`).
  - Tests de integración: si un movimiento falla, la transacción aborta sin guardar parciales.
- **T3.3 Cierre del flujo y feedback**:
  - Notificación de guardado exitoso ("Se guardaron 3 movimientos").
  - Refresco de balances y listas.
  - Opción inmediata de deshacer lote si fuera necesario.

### Fase 4: Comprobantes (Visión / Documentos)
- **T4.1 Carga de imagen o PDF**:
  - Input para arrastrar o tomar foto desde el celular. Límite de tamaño (ej. 5MB) y validación de tipos MIME.
- **T4.2 Integración multimodal en `AiProvider`**:
  - Soporte de base64/imagen en `GeminiProvider` para extraer los datos de la factura/ticket al mismo esquema `ParsedBatch`.
- **T4.3 Advertencia de duplicados**:
  - Detección de movimientos existentes en la misma fecha, cuenta y monto similar para advertir a la persona antes de confirmar.

### Fase 5: Evaluación y dataset rioplatense (Calidad)
- **T5.1 Dataset de evaluación (`tests/voice-capture/dataset.json`)**:
  - 50+ casos reales en rioplatense: "lucas", "palos", "me transferí de Galicia a Mercado Pago", cuotas de tarjeta, cuota de préstamo, fechas relativas ("ayer", "el sábado"), ruidos de dictado.
- **T5.2 Runner de evaluación (`scripts/eval-parse.mjs`)**:
  - Evalúa la precisión del prompt contra el modelo real: exactitud en montos, tipos y cero falsos gastos en pagos de tarjeta.

## 7. Gates obligatorios de calidad

Para dar por cerrada cualquier tarea o PR:
1. `npm run typecheck` (`tsc --noEmit`) sin errores.
2. `npm run check:estilo` sin violaciones (746 checks del sistema «C · Noche»).
3. `npm run check:css` sin CSS a mano.
4. `scripts/responsive/audit-mobile.mjs`: sin scroll horizontal y targets táctiles ≥ 44px (`any-pointer: coarse`).
5. `npm test` en verde (tests unitarios y de integración de la funcionalidad).
6. Sin credenciales ni claves en código (`GEMINI_API_KEY` exclusivamente en `.env` no versionado).
7. Textos y mensajes de UI exclusivamente en español rioplatense.

## 8. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| El modelo interpreta mal un monto o concepto | Confirmación obligatoria en `ReviewSheet` con `sourceText` visible |
| Pago de tarjeta interpretado como gasto | Regla de oro en prompt + validación forzada en `resolveBatch` + cero tolerancia en evaluación |
| Navegador sin soporte de Web Speech | Fallback transparente a cuadro de texto editable |
| Agotamiento de cuota de IA gratuita | Rate limit en `/api/parse`, error legible y arquitectura con `AiProvider` intercambiable |
| Datos financieros sensibles expuestos | Sólo se envían nombres de cuentas y categorías; nunca saldos, números de cuenta ni transacciones previas |
| Inconsistencias en guardado | Todo el lote se guarda dentro de un `prisma.$transaction` atómico |
| Ruptura del diseño propio de la app | Validado en cada paso con `npm run check:estilo` y `check:css` |
