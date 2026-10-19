# Importación de CSV — formato y contrato (Fase 7 ronda 2)

Entrada de datos históricos: se pega el texto de un CSV (vía principal de la
suite) o se elige un archivo `.csv`. La UI vive en un modal propio (botón
“📥 Importar CSV” y acción de la paleta `Ctrl+K`); **no** está dentro del
formulario de carga rápida.

El flujo es en dos pasos: **previsualizar** y recién después **confirmar**.
Nada se escribe hasta el segundo paso, y el commit es **todo o nada**.

Implementación: `lib/csv.ts` (forma de las filas, sin base),
`lib/csv-import.ts` (resolución contra cuentas/categorías, preview, commit,
conciliación), `app/api/import/csv/preview` y `app/api/import/csv`.

## 1. Formato del archivo

- **Codificación UTF-8**. Se tolera un BOM al principio (`\uFEFF`).
- **Separador: coma.** Fin de línea LF o CRLF (también mezclados).
- **Comillas dobles** para encerrar campos con coma, comilla o salto de línea.
  Una comilla adentro se escribe duplicada (`""`). Una comilla suelta adentro
  de un campo sin comillas es un error, no un carácter literal: un archivo
  corrupto no se adivina.
- Un salto de línea adentro de un campo entre comillas se conserva como `\n`
  dentro del valor (no parte la fila).
- Las líneas totalmente vacías se ignoran. Una línea con comas (`... ,,,`) es
  una fila y se clasifica como vacía en el preview.

### Encabezados

La primera fila con contenido es el encabezado. Los nombres se normalizan sin
acentos, mayúsculas, espacios, guiones ni guiones bajos, así que
`Cuenta Destino`, `cuenta_destino` y `CUENTA-DESTINO` son la misma columna.

| Columna canónica | Obligatoria | Alias aceptados |
| --- | --- | --- |
| `fecha` | sí | fecha, date, día, fechamovimiento |
| `tipo` | sí | tipo, type, clase, movimiento, tipomovimiento |
| `monto` | sí | monto, importe, amount, valor |
| `cuenta` | sí | cuenta, account, cuentaorigen, origen, fromaccount |
| `cuenta_destino` | solo TRANSFER | cuentadestino, destino, toaccount, cuentadedestino, hacia |
| `categoria` | no | categoria, category, rubro, etiqueta |
| `descripcion` | no | descripcion, description, detalle, nota, concepto, comentario |

- Una columna sin alias reconocido **se ignora** (tiene encabezado, así que la
  fila no está desalineada).
- Dos columnas que resuelven al mismo campo canónico → error de archivo.
- Falta alguna columna obligatoria → error de archivo (`400`): no se puede
  culpar a “la fila 7” de que no exista la columna `monto`.
- Si una fila trae **más celdas con datos que columnas tiene el encabezado**,
  el archivo está desalineado: esa fila se marca inválida (no se adivina a qué
  campo pertenece la celda de más).

### Valores

- **Fecha**: `YYYY-MM-DD` o `DD/MM/YYYY`. Tiene que existir en el calendario
  (2015-02-30 no es una fecha). Siempre se compara como fecha de calendario;
  nunca se convierte a UTC.
- **Tipo**: `INCOME`, `EXPENSE`, `TRANSFER` o sus nombres en castellano:
  ingreso(s)/entrada, gasto(s)/salida/egreso, transferencia(s)/transfe.
- **Monto**: estrictamente **positivo** (el signo lo da el tipo), hasta dos
  decimales, menor a 10^16. Se aceptan las dos formas locales:
  `1500`, `1.500,50`, `1500.50` y variantes equivalentes con `$` y espacios.
  No se aceptan letras (tampoco notación científica: `1e5` no es un monto),
  signos `+`/`-`, ni ceros. Los montos viajan y se comparan como string/Decimal,
  nunca como float.
- **Cuenta**: tiene que existir (comparación sin mayúsculas ni acentos).
  - Cuenta archivada → fila inválida (“desarchivala o cambiá la fila”).
  - Si hay **dos cuentas que solo difieren en mayúsculas/acentos** y el CSV no
    las distingue, la fila es inválida: no hay forma honesta de elegir una.
  - `INCOME` solo puede entrar a cuentas que reciben plata (misma regla que el
    formulario); una tarjeta de crédito no es destino válido.
- **cuenta_destino**: obligatoria en `TRANSFER` y **distinta** de la cuenta de
  origen. En `INCOME`/`EXPENSE` no se admite (la plata entra o sale de la única
  cuenta indicada).
- **categoria**: opcional. Se resuelve contra las existentes sin acentos ni
  mayúsculas; si no existe, **se crea** (política resolver-o-crear, igual que
  el formulario). Bordes:
  - La categoría existe con el tipo contrario al de la fila → inválida.
  - El mismo nombre aparece como ingreso y como gasto dentro del archivo →
    inválido: hay que desambiguar antes de importar.
  - En `TRANSFER` no se admite categoría.
  - Máximo 40 caracteres de nombre.
- **descripcion**: opcional, máximo 200 caracteres.
- **NUL bytes**: un `\u0000` nunca es texto; se rechaza el archivo entero
  (`400`) con mensaje accionable (suele ser un binario renombrado a `.csv`).

### Límites

| Límite | Valor | Respuesta |
| --- | --- | --- |
| Tamaño del texto | 256 KB en bytes UTF-8 | `413` |
| Filas de datos (sin encabezado) | 500 | `422` |
| Descripción por fila | 200 caracteres | fila inválida |
| Nombre de categoría | 40 caracteres | fila inválida |

## 2. Preview

`POST /api/import/csv/preview` con `{ "text": "..." }`. Requiere sesión
(`401` si no). Es lectura: no exige `Origin` y no escribe nada.

Devuelve por fila un estado y los totales de lo importable:

| Estado | Significado |
| --- | --- |
| `VALID` | pasa todas las validaciones y se va a importar |
| `INVALID` | cualquier error de forma, fecha, monto, tipo, cuenta o categoría |
| `DUPLICATE` | es válida, pero ya existe (en la base o antes en el mismo archivo): se omite |
| `EMPTY` | no tiene ningún dato |

Se acumulan **todos** los errores de una fila (no se corta en el primero) para
poder corregir el archivo de una vez. Una fila inválida nunca se marca
duplicada: el mensaje útil es el error.

El resumen trae cantidad de filas por estado, `totals` por tipo
(`income`/`expenses`/`transfers`, dos decimales) y `categoriesToCreate`
(solo las que alguna fila válida va a usar).

### Duplicados

Se considera duplicada una fila con la **misma clave completa**: tipo, fecha,
monto, cuenta, cuenta destino, categoría y descripción normalizada (sin
acentos ni mayúsculas). Es deliberadamente conservador: dos cafés idénticos el
mismo día con la misma descripción se marcan como duplicados y **se omite el
segundo**. Se prefiere avisar de más a duplicar historia en silencio. Para
importar los dos, alcanza con distinguirlos (por ejemplo, en la descripción).

La comparación contra la base consulta **sólo las fechas presentes en el
archivo** (hasta 500), no todo el histórico. Los duplicados se avisan y se
omiten; nunca se saltean en silencio.

## 3. Commit

`POST /api/import/csv` con

```json
{
  "text": "fecha,tipo,monto,cuenta\n...",
  "expected": { "count": 2, "income": "100000.00", "expenses": "1500.00", "transfers": "2000.00" }
}
```

`expected` es el resumen que la persona vio en el preview. La ruta exige sesión
(`401`) y `Origin` (`403`). Pasos:

1. Recalcular el preview con el texto recibido.
2. Rechazar si hay filas inválidas (`422`) o si no queda nada nuevo por
   importar (`422`, todas duplicadas o vacías).
3. Comparar con `expected`: si no coincide, `409` (“volvé a previsualizar”).
4. Abrir **una transacción**, recalcular otra vez adentro y verificar que los
   estados y totales sigan siendo los aprobados (`409` si cambiaron).
5. Crear las categorías nuevas (`upsert` por nombre normalizado; si una cambió
   de tipo en el medio, `409`).
6. Insertar los movimientos.
7. **Conciliar al centavo**: leer de la base los movimientos recién insertados,
   agruparlos por tipo y comparar cantidad y suma contra el preview. Cualquier
   diferencia → rollback completo y `409`.

Respuesta `201`:

```json
{
  "imported": 3,
  "skippedDuplicates": 1,
  "totals": { "income": "100000.00", "expenses": "1500.00", "transfers": "2000.00", "count": 3 },
  "categoriesCreated": [{ "name": "Comida", "kind": "EXPENSE" }]
}
```

## 4. Errores

| Status | Cuándo |
| --- | --- |
| `400` | JSON inválido, falta `text`, CSV vacío, NUL, encabezados/archivo mal formados, `expected` inválido |
| `401` | sin sesión |
| `403` | commit sin `Origin` válido (anti-CSRF) |
| `409` | el estado cambió entre preview y commit, o la conciliación no cerró (rollback; no se guardó nada) |
| `413` | el texto supera 256 KB |
| `422` | más de 500 filas, hay filas inválidas, no queda nada nuevo para importar |
| `503` | falla inesperada (infra): mensaje explícito de que **no se guardó nada** |

La ruta nunca responde `500` sin explicación: el contrato es que la persona
sepa que no se guardó nada y pueda reintentar.

## 5. Ejemplo mínimo

```csv
fecha,tipo,monto,cuenta,cuenta_destino,categoria,descripcion
2026-08-03,EXPENSE,1500,Cuenta principal,,Comida,"Súper, verdulería"
04/08/2026,INCOME,100000,Efectivo,,Sueldo,Quincena
2026-08-07,TRANSFER,2000,Efectivo,Banco Galicia,,Paso al banco
```

Resultado esperado: 3 filas válidas; se importan ingresos `100000.00`, gastos
`1500.00` y transferencias `2000.00`; se crean solo las categorías nuevas
(`Comida`, `Sueldo`) si no existían.

## 6. Notas de operación

- El generador de recurrencia puede materializar vencimientos cuando el panel
  recarga sus datos después de importar; es contexto, no un efecto de la
  importación en sí.
- La importación **no** toca la configuración de recurrencia de la Fase 3 ni
  los totales de tarjetas por sí sola: solo agrega movimientos comunes.
- Idempotencia práctica: volver a pegar el mismo archivo omite todas las filas
  ya importadas (duplicadas) y responde `422` si no queda ninguna nueva.
