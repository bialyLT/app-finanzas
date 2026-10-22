# Sistema de diseño · «C · Noche»

> La app se ve como el **spike de estilos «C · Noche»** que eligió la persona
> (2026-10-21). Este documento es la fuente de verdad: si una clase del markup
> contradice lo que está acá, el markup está mal.
>
> El candado mecánico es `npm run check:estilo`
> (`scripts/check-estilo-propio.mjs`): falla si reaparece la paleta de fábrica,
> un emoji como icono, un radio fuera de escala, un color suelto, un gradiente,
> una fuente fuera del tema o un `dark:` en un color.

---

## 1 · Los tokens

Los tokens son **semánticos**: el nombre dice el PAPEL del color, no su
color. `text-fg-muted` es «el texto secundario»; `text-zinc-500` es «el gris
500 de Tailwind», que no dice nada.

Los viven en `app/globals.css`:

- el `@theme inline` declara los **nombres** (`--color-fg-muted: var(--fg-muted)`);
- los **valores** viven en `:root` (esquema claro) y se pisan con
  `@media (prefers-color-scheme: dark)` (esquema «Noche»).

Por eso el markup **no lleva `dark:` en ningún color**: el token ya es el del
esquema que está en pantalla.

### 1.1 · Los quince tokens

| Token | Para qué | Noche (oscuro) | Claro |
|---|---|---|---|
| `--surface` | fondo de página | `#07111F` | `#FBFAF7` |
| `--surface-2` | tarjeta / panel | `#0C1B2C` | `#FFFFFF` |
| `--surface-3` | elevada (hover, popover, fila activa, ficha) | `#112741` | `#F4F2ED` |
| `--line` | borde decorativo | `#17304A` | `#E4E1DA` |
| `--line-strong` | borde de **control** (input, botón, foco) | `#477398` | `#908C81` |
| `--fg` | texto principal | `#E6F0FA` | `#17161A` |
| `--fg-muted` | texto secundario | `#93A9BF` | `#57565F` |
| `--fg-subtle` | texto terciario / metadatos / iconos | `#7A8FA3` | `#6F6E75` |
| `--primary` | acción principal | `#22D3EE` | `#C2410C` |
| `--primary-fg` | texto sobre un color saturado | `#04202B` | `#FFFFFF` |
| `--success` | ingresos | `#34D399` | `#137438` |
| `--danger` | gastos | `#FB7185` | `#B91C1C` |
| `--warning` | avisos y pendientes | `#FBBF24` | `#A44C08` |
| `--transfer` | transferencias (ni ingreso ni gasto) | `#38BDF8` | `#0369A1` |
| `--focus` | anillo de foco | `#22D3EE` | `#C2410C` |

> `--primary-fg` es «el texto que va SOBRE un color saturado»: sirve para el
> botón primario y para los botones de estado (`bg-danger text-primary-fg`).
> En el esquema oscuro el texto sobre un color saturado es casi negro
> (`#04202B`); en el claro, blanco. Un solo token, dos esquemas.

### 1.2 · Los ratios de contraste (calculados, no opinados)

Texto ≥ **4,5:1**; borde de control ≥ **3:1**. Medido con la misma matemática
WCAG 2.1 que el spike (`spike-estilos/src/lib/contrast.ts`).

**Noche (oscuro)**

| Par | Ratio | Mín. | |
|---|---|---|---|
| `--fg` sobre `--surface` | 16,42:1 | 4,5 | ✔ |
| `--fg` sobre `--surface-2` | 15,06:1 | 4,5 | ✔ |
| `--fg` sobre `--surface-3` | 13,10:1 | 4,5 | ✔ |
| `--fg-muted` sobre `--surface` | 7,82:1 | 4,5 | ✔ |
| `--fg-muted` sobre `--surface-2` | 7,17:1 | 4,5 | ✔ |
| `--fg-muted` sobre `--surface-3` | 6,23:1 | 4,5 | ✔ |
| `--fg-subtle` sobre `--surface` | 5,67:1 | 4,5 | ✔ |
| `--fg-subtle` sobre `--surface-2` | 5,20:1 | 4,5 | ✔ |
| `--fg-subtle` sobre `--surface-3` | 4,52:1 | 4,5 | ✔ |
| `--primary-fg` sobre `--primary` | 9,32:1 | 4,5 | ✔ |
| `--primary` sobre `--surface` | 10,48:1 | 4,5 | ✔ |
| `--primary` sobre `--surface-2` | 9,61:1 | 4,5 | ✔ |
| `--primary` sobre `--surface-3` | 8,36:1 | 4,5 | ✔ |
| `--success` sobre `--surface` | 9,85:1 | 4,5 | ✔ |
| `--success` sobre `--surface-2` | 9,04:1 | 4,5 | ✔ |
| `--success` sobre `--surface-3` | 7,86:1 | 4,5 | ✔ |
| `--danger` sobre `--surface` | 7,04:1 | 4,5 | ✔ |
| `--danger` sobre `--surface-2` | 6,45:1 | 4,5 | ✔ |
| `--danger` sobre `--surface-3` | 5,61:1 | 4,5 | ✔ |
| `--warning` sobre `--surface` | 11,34:1 | 4,5 | ✔ |
| `--warning` sobre `--surface-2` | 10,41:1 | 4,5 | ✔ |
| `--warning` sobre `--surface-3` | 9,05:1 | 4,5 | ✔ |
| `--transfer` sobre `--surface` | 8,84:1 | 4,5 | ✔ |
| `--transfer` sobre `--surface-2` | 8,11:1 | 4,5 | ✔ |
| `--transfer` sobre `--surface-3` | 7,05:1 | 4,5 | ✔ |
| `--line-strong` sobre `--surface` | 3,76:1 | 3 | ✔ |
| `--line-strong` sobre `--surface-2` | 3,45:1 | 3 | ✔ |
| `--line-strong` sobre `--surface-3` | 3,00:1 | 3 | ✔ |
| `--focus` sobre `--surface` | 10,48:1 | 3 | ✔ |
| `--focus` sobre `--surface-2` | 9,61:1 | 3 | ✔ |
| `--focus` sobre `--surface-3` | 8,36:1 | 3 | ✔ |
| `--line` sobre `--surface` | 1,40:1 | — | decorativo (informativo) |
| `--line` sobre `--surface-2` | 1,29:1 | — | decorativo (informativo) |
| `--line` sobre `--surface-3` | 1,12:1 | — | decorativo (informativo) || `--line` sobre `--surface` | 1,40:1 | — | decorativo (informativo) |

**Claro**

| Par | Ratio | Mín. | |
|---|---|---|---|
| `--fg` sobre `--surface` | 17,25:1 | 4,5 | ✔ |
| `--fg` sobre `--surface-2` | 18,01:1 | 4,5 | ✔ |
| `--fg` sobre `--surface-3` | 16,10:1 | 4,5 | ✔ |
| `--fg-muted` sobre `--surface` | 6,93:1 | 4,5 | ✔ |
| `--fg-muted` sobre `--surface-2` | 7,24:1 | 4,5 | ✔ |
| `--fg-muted` sobre `--surface-3` | 6,47:1 | 4,5 | ✔ |
| `--fg-subtle` sobre `--surface` | 4,83:1 | 4,5 | ✔ |
| `--fg-subtle` sobre `--surface-2` | 5,04:1 | 4,5 | ✔ |
| `--fg-subtle` sobre `--surface-3` | 4,51:1 | 4,5 | ✔ |
| `--primary-fg` sobre `--primary` | 5,18:1 | 4,5 | ✔ |
| `--primary` sobre `--surface` | 4,96:1 | 4,5 | ✔ |
| `--primary` sobre `--surface-2` | 5,18:1 | 4,5 | ✔ |
| `--primary` sobre `--surface-3` | 4,63:1 | 4,5 | ✔ |
| `--success` sobre `--surface` | 5,62:1 | 4,5 | ✔ |
| `--success` sobre `--surface-2` | 5,86:1 | 4,5 | ✔ |
| `--success` sobre `--surface-3` | 5,24:1 | 4,5 | ✔ |
| `--danger` sobre `--surface` | 6,20:1 | 4,5 | ✔ |
| `--danger` sobre `--surface-2` | 6,47:1 | 4,5 | ✔ |
| `--danger` sobre `--surface-3` | 5,78:1 | 4,5 | ✔ |
| `--warning` sobre `--surface` | 5,56:1 | 4,5 | ✔ |
| `--warning` sobre `--surface-2` | 5,81:1 | 4,5 | ✔ |
| `--warning` sobre `--surface-3` | 5,19:1 | 4,5 | ✔ |
| `--transfer` sobre `--surface` | 5,68:1 | 4,5 | ✔ |
| `--transfer` sobre `--surface-2` | 5,93:1 | 4,5 | ✔ |
| `--transfer` sobre `--surface-3` | 5,30:1 | 4,5 | ✔ |
| `--line-strong` sobre `--surface` | 3,22:1 | 3 | ✔ |
| `--line-strong` sobre `--surface-2` | 3,36:1 | 3 | ✔ |
| `--line-strong` sobre `--surface-3` | 3,00:1 | 3 | ✔ |
| `--focus` sobre `--surface` | 4,96:1 | 3 | ✔ |
| `--focus` sobre `--surface-2` | 5,18:1 | 3 | ✔ |
| `--focus` sobre `--surface-3` | 4,63:1 | 3 | ✔ |
| `--line` sobre `--surface` | 1,25:1 | — | decorativo (informativo) |
| `--line` sobre `--surface-2` | 1,31:1 | — | decorativo (informativo) |
| `--line` sobre `--surface-3` | 1,17:1 | — | decorativo (informativo) |

### 1.3 · Los seis valores que se movieron

Con los valores del brief, cuatro tokens quedaban **por debajo** del mínimo.
Un token que no llega al mínimo **no entra**: se ajustó lo mínimo y se
recalculó.

| Token | Valor del brief | Valor nuevo | Por qué |
|---|---|---|---|
| `--fg-subtle` (noche) | `#6B8299` | `#7A8FA3` | daba 4,37:1 sobre la tarjeta (debajo de 4,5:1) |
| `--fg-subtle` (claro) | `#7A7880` | `#6F6E75` | daba 4,17:1 sobre el fondo |
| `--line-strong` (noche) | `#3E6485` | `#477398` | daba 2,78:1 sobre la tarjeta (el borde de control pide 3:1) |
| `--line-strong` (claro) | `#9A968C` | `#908C81` | daba 2,83:1 sobre el fondo |
| `--success` (claro) | `#15803D` | `#137438` | el texto del estado sobre **su propio tinte** al 10 % daba 4,39:1 (debajo de 4,5:1) |
| `--warning` (claro) | `#B45309` | `#A44C08` | ídem: 4,38:1 sobre su tinte al 10 % |

> Los dos últimos los ajustó el **tester** (ronda F10 · F0a): la tabla de
> ratios del dev medía el token contra las superficies, pero **no contra su
> propio tinte**, que es donde el patrón `bg-xxx/10` + `text-xxx` pone el
> texto. Con `#15803D` y `#B45309` los avisos del esquema claro quedaban en
> 4,39:1 y 4,38:1: por debajo del mínimo. Los dos valores nuevos están al
> 91 % de los viejos (el matiz no se mueve) y el peor par pasa a 4,52:1.

Los ratios nuevos están en las tablas de arriba.

### 1.4 · Los tintes

Un tinte (un fondo de aviso) es el token de estado **con opacidad**: el color
sale del token, no de otra paleta.

```
bg-danger/10    bg-warning/10    bg-success/10    bg-transfer/10
bg-danger/15    bg-warning/15    bg-success/15    bg-transfer/15   ← el hover
border-danger/40    border-warning/40    border-transfer/40
```

`bg-danger/10` en Tailwind v4 es `color-mix(in oklab, var(--color-danger) 10%, transparent)`:
el mismo color del token, al 10 %.

> **El tinte que lleva texto es el de 10 %, y el de 15 % es el del hover.**
> El 20 % queda libre para superficies sin texto: el texto de estado sobre su
> propio tinte al 20 % daba 4,32:1 en el esquema claro (por debajo de 4,5:1).
> Ojo con el orden en el CSS: `bg-warning/20` se compila **después** de
> `bg-warning/10`, así que en `bg-warning/20 bg-warning/10` gana el 20 % (el
> 10 % es código muerto).

Los ratios de los tintes (el texto del estado sobre su tinte, en las tres
superficies):

| Esquema | Par | Tinte | Ratio | Mín. | |
|---|---|---|---|---|---|
| Noche | `--success` sobre su tinte al 10 % de `--surface` | `rgb(12, 36, 43)` | 8,36:1 | 4,5 | ✔ |
| Noche | `--success` sobre su tinte al 10 % de `--surface-2` | `rgb(16, 45, 55)` | 7,49:1 | 4,5 | ✔ |
| Noche | `--success` sobre su tinte al 10 % de `--surface-3` | `rgb(21, 56, 74)` | 6,43:1 | 4,5 | ✔ |
| Noche | `--danger` sobre su tinte al 10 % de `--surface` | `rgb(31, 27, 41)` | 6,27:1 | 4,5 | ✔ |
| Noche | `--danger` sobre su tinte al 10 % de `--surface-2` | `rgb(36, 36, 53)` | 5,68:1 | 4,5 | ✔ |
| Noche | `--danger` sobre su tinte al 10 % de `--surface-3` | `rgb(40, 46, 72)` | 4,93:1 | 4,5 | ✔ |
| Noche | `--warning` sobre su tinte al 10 % de `--surface` | `rgb(31, 34, 32)` | 9,58:1 | 4,5 | ✔ |
| Noche | `--warning` sobre su tinte al 10 % de `--surface-2` | `rgb(36, 43, 43)` | 8,61:1 | 4,5 | ✔ |
| Noche | `--warning` sobre su tinte al 10 % de `--surface-3` | `rgb(40, 54, 62)` | 7,43:1 | 4,5 | ✔ |
| Noche | `--transfer` sobre su tinte al 10 % de `--surface` | `rgb(12, 34, 53)` | 7,56:1 | 4,5 | ✔ |
| Noche | `--transfer` sobre su tinte al 10 % de `--surface-2` | `rgb(16, 43, 64)` | 6,78:1 | 4,5 | ✔ |
| Noche | `--transfer` sobre su tinte al 10 % de `--surface-3` | `rgb(21, 54, 83)` | 5,82:1 | 4,5 | ✔ |
| Claro | `--success` sobre su tinte al 10 % de `--surface` | `rgb(228, 237, 228)` | 4,88:1 | 4,5 | ✔ |
| Claro | `--success` sobre su tinte al 10 % de `--surface-2` | `rgb(231, 241, 235)` | 5,08:1 | 4,5 | ✔ |
| Claro | `--success` sobre su tinte al 10 % de `--surface-3` | `rgb(222, 229, 219)` | 4,57:1 | 4,5 | ✔ |
| Claro | `--danger` sobre su tinte al 10 % de `--surface` | `rgb(244, 228, 225)` | 5,25:1 | 4,5 | ✔ |
| Claro | `--danger` sobre su tinte al 10 % de `--surface-2` | `rgb(248, 232, 232)` | 5,46:1 | 4,5 | ✔ |
| Claro | `--danger` sobre su tinte al 10 % de `--surface-3` | `rgb(238, 221, 216)` | 4,91:1 | 4,5 | ✔ |
| Claro | `--warning` sobre su tinte al 10 % de `--surface` | `rgb(242, 233, 223)` | 4,83:1 | 4,5 | ✔ |
| Claro | `--warning` sobre su tinte al 10 % de `--surface-2` | `rgb(246, 237, 230)` | 5,03:1 | 4,5 | ✔ |
| Claro | `--warning` sobre su tinte al 10 % de `--surface-3` | `rgb(236, 225, 214)` | 4,52:1 | 4,5 | ✔ |
| Claro | `--transfer` sobre su tinte al 10 % de `--surface` | `rgb(226, 236, 238)` | 4,92:1 | 4,5 | ✔ |
| Claro | `--transfer` sobre su tinte al 10 % de `--surface-2` | `rgb(230, 240, 246)` | 5,13:1 | 4,5 | ✔ |
| Claro | `--transfer` sobre su tinte al 10 % de `--surface-3` | `rgb(220, 228, 229)` | 4,61:1 | 4,5 | ✔ |

---

## 2 · La escala de radios

Cada radio dice algo. La escala es **corta** (cuatro valores) y cada uno tiene
un motivo.

| Radio | px | Dónde | Por qué |
|---|---|---|---|
| `rounded-md` | 6 | contenedores, tarjetas, inputs, tablas | las superficies son casi rectas: dan tono de herramienta seria, no de burbuja |
| `rounded-lg` | 8 | botones, chips, menús, casillas | los controles que se tocan |
| `rounded-full` | — | píldoras, avatares, el toggle | lo que ES una cápsula |
| `rounded-none` | 0 | barras, bloques de datos | los datos no son píldoras |

> **`rounded-lg` son 8 px, no 10.** Tailwind v4 define `--radius-lg: 0.5rem`
> (`node_modules/tailwindcss/theme.css`), y el radio base del estilo «C · Noche»
> del spike es `0.5rem` (`spike-estilos/src/lib/tokens.ts`, `radius: "0.5rem"`).
> Medido en el navegador: `getComputedStyle(el).borderRadius` = `8px`.

**Nada de `rounded-xl` genérico**: 151 usos de `rounded-xl` (el mismo radio en
todo) era parte del «aspecto de fábrica». Ahora hay 195 `rounded-md`, 89
`rounded-lg` y 38 `rounded-full` (y **cero** radios fuera de la escala: ni
`rounded-xl`, ni `rounded-2xl`, ni el `rounded` pelado de 4 px, ni un
`rounded-[10px]` arbitrario).

Las variantes direccionales (`rounded-t-md`, `rounded-t-lg`, `rounded-ss-md`) son
de la misma escala: el modal es una hoja en el teléfono (`rounded-t-md`) y un
diálogo en el escritorio (`sm:rounded-md`).

---

## 3 · La escala tipográfica

> **Pendiente de F0b** (tipografía, cifras tabulares y cambio de fuente, con
> la recalibración del modelo de medidas de `lib/format.ts`). Lo que hay hoy:

| Uso | Clase | Nota |
|---|---|---|
| Monto de tarjeta | `monto-tarjeta` | utilidad propia: el cuerpo acompaña al ancho de la tarjeta (container query) |
| Monto de ficha | `monto-ficha` | ídem, para la ficha de un mes |
| Cuerpo | `font-sans` | Geist, desde el `@theme` |
| Cifras | `tabular-nums` (pendiente) | llega con F0b |

---

## 4 · El set de iconos

**`lucide-react`**. Un grosor —el default de lucide, `strokeWidth: 2`— y cinco
tamaños, gobernados por clases: `size-4` (16), `size-5` (20), `size-6` (24),
`size-8` (32) y `size-10` (40).

> El grosor por defecto de lucide es **2**, no 1.75 (medido: el atributo
> `stroke-width` del SVG que renderiza la app es `2`; en
> `node_modules/lucide-react/dist/lucide-react.js` el default es
> `contextStrokeWidth = 2`). Los 32 px y los 40 px son para los estados vacíos
> y los títulos de sección: un icono de 16 px al lado de un texto de 24 px se
> pierde.

- Los iconos **heredan el color del texto**: no llevan color propio.
- Llevan `aria-hidden` cuando son decorativos (el texto al lado ya dice qué es).
- **Cero emoji.** Un emoji es un icono de otra tipografía, con otro grosor y
  otra escala: se ve como dos fuentes pegadas.

Los que se usan hoy:

| Dónde | Icono | Por qué ese |
|---|---|---|
| Ingreso | `Banknote` | el billete es el ingreso |
| Gasto | `Receipt` | el ticket es el gasto |
| Transferencia | `ArrowLeftRight` | plata entre bolsillos propios |
| Recurrencia | `RefreshCw` | lo que se repite |
| Préstamos (título, nav) | `Handshake` | un acuerdo: el préstamo |
| Me deben / Recibí un préstamo (entra plata) | `ArrowDownLeft` | **↓ entra** |
| Debo / Presté plata (sale plata) | `ArrowUpRight` | **↑ sale** |
| Tarjeta | `CreditCard` | la tarjeta |
| Configurar | `Settings` | la rueda de engranaje |
| Correr el cierre | `Play` | correr |
| Importar CSV | `Import` | el archivo **entra** a la app |
| Borrar | `Trash` | la papelera |
| Nota | `StickyNote` | el post-it |
| Búsqueda / vacío | `Search` | la lupa |
| Análisis | `ChartColumn` | el gráfico de columnas |
| Moneda (vacío) | `Coins` | las monedas |
| Aviso | `TriangleAlert` | el triángulo |
| Marca | `Wallet` | la billetera |
| La banderita (casilla) | `Check` | la marca del check |
| Plantilla (favorito) | `Star` | la estrella, llena cuando el panel está abierto |
| Menú del teléfono | `Menu` / `X` | abrir y cerrar |
| Plantilla (favorito) | `Star` | la estrella, rellena (`fill-current`) si está activa |

> **La flecha tiene un signo, y es el mismo en toda la app**: `↓` (abajo-izq.)
> es la plata que **entra** y `↑` (arriba-der.) es la plata que **sale**.
> Antes de esta ronda el emoji `💸` (plata que se va) marcaba «Debo» y el `🤲`
> (manos que reciben) marcaba «Me deben»: al traducirlos a iconos, los dos
> iconos de mano quedaron **al revés** entre sí y uno de ellos pasó a
> significar además «Préstamos». Un icono que significa dos cosas no es un
> icono: es un adorno.

---

## 5 · NO HAGAS ESTO

Lo que produce el aspecto de fábrica. Cada punto tiene el ejemplo real del
código (antes) y el token (después).

### 5.1 · No uses la paleta por defecto de Tailwind

```tsx
// ANTES — 762 clases `zinc-*` y 1378 clases de paleta de fábrica
<div className="bg-white dark:bg-zinc-900 border border-zinc-300 text-zinc-500" />

// DESPUÉS
<div className="bg-surface-2 border border-line-strong text-fg-muted" />
```

`zinc-50`, `zinc-900`, `emerald-600`, `rose-700`… son la paleta que **nadie
eligió**. Cada color tiene que ser un token con nombre.

### 5.2 · No uses un emoji como icono

```tsx
// ANTES
<span>🗑</span>
<button>📥 Importar CSV</button>

// DESPUÉS
<span><Trash className="size-4" aria-hidden /></span>
<button><Download className="size-4" aria-hidden /> Importar CSV</button>
```

### 5.3 · No uses un radio fuera de la escala

```tsx
// ANTES — 151 `rounded-xl`: el mismo radio en todo
<div className="rounded-xl" />
<button className="rounded-2xl" />

// DESPUÉS — el radio depende de qué es la cosa
<div className="rounded-md" />        {/* una tarjeta */}
<button className="rounded-lg" />     {/* un control que se toca */}
<span className="rounded-full" />    {/* una píldora */}
```

### 5.4 · No pongas un color suelto en el markup

```tsx
// ANTES
<div className="bg-[#07111F] text-[#E6F0FA]" />

// DESPUÉS
<div className="bg-surface text-fg" />
```

Un hex suelto no se puede cambiar de un lado y del otro, ni auditar.

### 5.5 · No uses gradientes

El estilo «C · Noche» es plano: el contraste lo hace la jerarquía de
superficies, no un degradado. `bg-gradient-*`, `from-*`, `via-*` y `to-*`
están prohibidos.

### 5.6 · No declares una fuente fuera del tema

```tsx
// ANTES — en el CSS global: `body { font-family: Arial }`
// (la app renderizaba en ARIAL y descargaba dos archivos de fuente al pedo)

// DESPUÉS — la fuente sale del @theme
<body className="font-sans" />
```

### 5.7 · No uses `shadow` como decoración

> **Pendiente de F1/F3.** Hoy quedan **44 sombras** (`shadow-sm` 31, `shadow-lg`
> 3, `shadow-2xl` 10) que en el esquema «Noche» casi no se ven: una sombra
> negra sobre `#0C1B2C` no se ve. No hacen daño (no ensucian: el «Noche» es
> plano por jerarquía de superficies, que es justo lo que quiere el spike),
> pero tampoco hacen nada. Cuando lleguen los componentes de Radix (F1), la
> sombra pasa a ser un token de elevación, no una clase suelta.

### 5.8 · No pongas `dark:` en los colores

El token ya es el del esquema. `dark:bg-surface-2` no existe: `bg-surface-2`
es `#0C1B2C` de noche y `#FFFFFF` de día.

```tsx
// ANTES
<div className="bg-zinc-50 dark:bg-black text-zinc-900 dark:text-zinc-100" />

// DESPUÉS
<div className="bg-surface text-fg" />
```

> El `dark:` en un color **prohíbe el candado**: `check:estilo` falla si
> encuentra `dark:` en una utilidad de color. (Lo que NO es un color —un
> `dark:hidden`, un `dark:block`— sigue permitido: el `dark:` de Tailwind
> sirve para lo que sea.)

---

## 6 · Cómo se verifica

```powershell
npm run check:estilo     # el candado de «cero default» (exit 1 si hay una violación)
npm run check:css        # el candado de «cero CSS a mano»
npm run typecheck
```

El gate de estilo falla si aparece **una sola** clase de la paleta de fábrica
(las 22 familias de Tailwind v4, `pink` incluida), un emoji como icono, un
radio fuera de escala (incluido el `rounded` pelado, el arbitrario y las
variantes lógicas de esquina), un color suelto (hex, `rgb()`, `oklch()` o un
estilo en línea), un gradiente (`bg-linear-*`, `bg-gradient-*`, `bg-radial-*`,
`from-*`, `via-*`, `to-*`), una fuente fuera del tema o un `dark:` en un
color; y además comprueba que el `@theme` declare los quince tokens **y que
cada token tenga valor en los dos esquemas** (un token sin valor es un token
muerto: la utilidad compila a un `var(--token)` sin definir).
