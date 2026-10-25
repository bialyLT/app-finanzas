# Sistema de diseño · «C · Noche»

> La app se ve como el **spike de estilos «C · Noche»** que eligió la persona
> (2026-10-21). Este documento es la fuente de verdad: si una clase del markup
> contradice lo que está acá, el markup está mal.
>
> El candado mecánico es `npm run check:estilo`
> (`scripts/check-estilo-propio.mjs`): falla si reaparece la paleta de fábrica,
> un emoji como icono, un radio fuera de escala, un color suelto, un gradiente,
> una fuente fuera del tema, un `dark:` en un color o un **cuerpo de letra
> fuera de la escala**; y comprueba que el `@theme` declare los quince tokens,
> la familia elegida (Archivo / IBM Plex Mono) y los cinco pasos tipográficos.

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

## 3 · La tipografía

### 3.1 · La fuente: Archivo (interfaz) + IBM Plex Mono (código)

La app usaba **Geist**, que es la fuente por defecto de **Next.js** y de
**Vercel**: la tipografía la había elegido el framework, igual que antes la
había elegido el navegador (Arial). Desde la F0b la fuente es una **decisión**:

| | Familia | Dónde | Por qué |
|---|---|---|---|
| Interfaz | **Archivo** (Omnibus-Type, 2019) | `font-sans`, todo el texto y los montos | grotesca de voz técnica/institucional; eje variable 100-900 (el **800** es real); cifras **tabulares** de verdad |
| Código / datos crudos | **IBM Plex Mono** | `font-mono` (el textarea del CSV) | monoespaciada: los separadores alinean |

Los criterios de aceptación, en orden, y cómo los cumple (medidos en el
navegador con `node scripts/medir-fuente.mjs --candidatas`, 2026-10-22):

1. **Cifras tabulares REALES.** Con `font-variant-numeric: tabular-nums` los
   dígitos `0`, `1` y `8` avanzan **exactamente lo mismo** en los tres pesos
   que usa la app (tabla en §3.3). Sin `tnum` no sirve: los montos bailan.
2. **Peso 800 real.** Archivo es variable en `wght` 100-900 y `next/font`
   sirve el eje completo: `font-extrabold` no se sintetiza.
3. **Legible a 12/13/14 px** sobre `#07111F` y sobre `#F7F8FA`: la altura de
   x de Archivo (0,52 em) y sus contraformas abiertas sostienen el texto
   chico; los ratios de contraste de §1.2 no cambian (son del color, no de la
   fuente).
4. **No parece «la fuente de un framework»**: no es la default de ningún
   framework ni de ningún sistema operativo.
5. **Self-hospedable**: `next/font/google` descarga el `.woff2` en el BUILD y
   lo sirve desde `/_next/static/media`: en runtime el navegador no le pide
   nada a Google.

Las otras tres candidatas se midieron igual (y por eso el orden no fue una
corazonada): **DM Sans no tiene cifras tabulares** (`0`/`1`/`8` = 0,6951 /
0,3220 / 0,5900 em en peso 800: con `tnum` **no cambian**, o sea que el
`tnum` no existe); **Public Sans** y **Figtree** sí las tienen (0,70 / 0,70 /
0,70) y quedan como el fallback documentado si algún día hay que reemplazar
Archivo. La preferencia del brief pasó los cinco criterios, así que no hubo
que bajar a los fallbacks.

### 3.2 · La escala: cinco pasos con nombre

En el `@theme` de `app/globals.css` (`--text-*` + `--text-*--line-height` +
`--leading-*` + `--font-weight-*`). El markup usa **los tokens**, no los
tamaños de fábrica de Tailwind:

| Token | Cuerpo | Interlineado | Uso |
|---|---|---|---|
| `text-xs` | 12 px | 1,3333 | metadatos, etiquetas, unidades, fechas |
| `text-sm` | 14 px | 1,4286 | texto secundario, tablas, fichas |
| `text-base` | 16 px | 1,5 | texto normal |
| `text-lg` | 18 px | 1,5556 | subtítulos, títulos de modal |
| `text-xl` | **24 px (tope)** | 1,25 | las cifras grandes del panel y del análisis |

El **tope de 24 px** de `text-xl` es el que manda en el modelo de medidas
(§3.3): `factorMonto` asume que una cifra grande nunca pasa de ese cuerpo. El
candado `check:estilo` ahora **falla** con un `text-2xl`, un `text-3xl` o un
arbitrario `text-[15px]`, y también si el `@theme` deja de declarar la escala
o si `--text-xl` deja de valer `1.5rem`.

**Qué se migró** (la ronda anterior tenía 139 tamaños de fábrica y 54
arbitrarios):

| Antes | Ahora | Cuántos | Efecto |
|---|---|---|---|
| `text-2xl` (24 px) | `text-xl` (24 px) | 15 | mismo cuerpo; el interlineado pasa de 32 a 30 px |
| `text-xl` (20 px) | `text-lg` (18 px) | 10 | títulos de modal 2 px más chicos (la caja de línea no cambia: 28 px) |
| `text-[11px]` | `text-xs` (12 px) | 49 | 1 px más grande (y legible) |
| `text-[10px]` | `text-xs` (12 px) | 5 | 2 px más grande |

`text-xs`, `text-sm`, `text-base` y `text-lg` conservan los valores de
Tailwind: no movieron nada.

### 3.3 · Las cifras tabulares (la evidencia) y el modelo de medidas

**El instrumento**: `scripts/medir-fuente.mjs` mide en el DOM (no en canvas:
canvas no tiene `font-variant-numeric`) el avance de cada glifo con cuerpo de
100 px, con y sin `tabular-nums`, en los pesos de la app.

**La prueba de que el `tnum` es real** (avance de un dígito, en px con cuerpo
de 100 px; «sin» = `font-variant-numeric: normal`):

| Fuente | peso | «0» sin | «1» sin | «8» sin | «0» con `tnum` | «1» con `tnum` | «8» con `tnum` | ¿tabular? |
|---|---|---|---|---|---|---|---|---|
| **Archivo** | 400 | 57,3125 | 52,1094 | 57,4063 | **56,8125** | **56,8125** | **56,8125** | **sí** |
| **Archivo** | 700 | 59,5 | 59,6094 | 59,6094 | **59,8125** | **59,8125** | **59,8125** | **sí** |
| **Archivo** | 800 | 62,5 | 62,5 | 62,5 | **62,7031** | **62,7031** | **62,7031** | **sí** |
| Public Sans | 800 | 65,9531 | 43,8125 | 68,1563 | 70 | 70 | 70 | sí |
| DM Sans | 800 | 69,5 | 32,2031 | 59 | 69,5 | 32,2031 | 59 | **NO** |
| Figtree | 800 | 65,2031 | 42,6094 | 61,1094 | 63,6094 | 63,6094 | 63,6094 | sí |

(Por eso DM Sans quedó descartada: su `tnum` no existe y el «1» mide menos de
la mitad que el «0».)

**La tabla de avances de Archivo con `tabular-nums`** (em = px / 100), que es
la que calibra `lib/format.ts`:

| Glifo | peso 400 | peso 700 (fichas) | peso 800 (tarjetas) |
|---|---|---|---|
| dígito (0-9) | 0,568125 | 0,598125 | 0,627031 |
| `.` y `,` | 0,277031 | 0,307031 | 0,318125 |
| `$` | 0,510000 | 0,556094 | 0,579063 |
| espacio (y NBSP) | 0,209063 | 0,196094 | 0,189063 |
| `+` y `−` | 0,625000 | 0,641094 | 0,649063 |
| `-` (guion) | 0,333125 | 0,333125 | 0,333125 |

**El modelo, antes y después.** Con Geist los dígitos eran proporcionales y
el ancho de un monto dependía de qué dígitos tuviera; el modelo usaba un
avance **medio por carácter** con un margen del 5 % (tarjetas, 0,62) y un
0,60 + 0,60 por signo (fichas). Con Archivo tabular el ancho es la **suma de
los glifos**, y el modelo lo calcula así: `factorMonto` suma el avance de cada
carácter y aplica **un solo margen del 5 %**.

| Monto | Ancho medido (em) | Por carácter | Modelo viejo (Geist) | Modelo nuevo (Archivo) |
|---|---|---|---|---|
| `$ 000.000,00` (800) | 6,4206 | 0,5351 | 0,5895 | **0,5351** |
| `$ 800.000,00` (800) | 6,4206 | 0,5351 | 0,5861 | **0,5351** (idéntico al de ceros) |
| `+$ 800.000,00` (800) | 7,0697 | 0,5438 | 0,5861 | **0,5438** |
| `$ 1.234.567.890,12` (800) | 9,5650 | 0,5314 | 0,5099 | **0,5314** |
| `$ 100.000,00` (700) | 6,1512 | 0,5126 | 0,5578 | **0,5126** |
| `$ 000.000,00` (700) | 6,1512 | 0,5126 | 0,5803 | **0,5126** |
| `+$ 310.000,00` (700) | 6,7923 | 0,5225 | 0,57 | **0,5225** |

El factor es `1 / (ancho del texto × 1,05)` (con el ancho calculado glifo por
glifo, no un promedio). Números nuevos, con el efecto en la app:

| Caso | factor viejo | factor nuevo | Cuerpo a 195 px (tarjeta) / 64 px (ficha) |
|---|---|---|---|
| `$ 800.000,00` · tarjeta | 0,13441 | **0,14833** | 28,9 px → **tope de 24 px** (igual que antes) |
| `$ 1.234.567.890,12` · tarjeta | 0,08961 | **0,09957** | 17,5 px → **19,4 px** (185,8 px de ancho en 195) |
| `$ 100.000,00` · ficha a 320 px | 0,13889 | **0,15483** | 8,89 px → **9,91 px** (61,0 px de ancho en 64) |
| `+$ 310.000,00` · ficha a 320 px | — | **0,14021** | 8,97 px (60,7 px de ancho en 64) |

**El efecto neto**: los montos de todos los días se ven **exactamente igual**
(el tope de 24 px y el de 14 px mandan); los montos largos se ven **más
grandes** que antes (19,4 px en vez de 17,5) y siguen entrando; las fichas
angostas a 320 px suben de 8,9 a 9,9 px y siguen entrando. Los tests de
`lib/format.test.ts` verifican las tres cosas con la tabla medida arriba
(ancho real ≤ caja, margen entre 4 y 6 %, y que con cifras tabulares el ancho
no dependa de los dígitos).

**Dónde se aplican las cifras tabulares**: en los montos, no en los textos.
La utilidad `monto` (y las que la incluyen: `monto-tarjeta`, `monto-ficha`,
`monto-ficha--chico`) pide `font-variant-numeric: tabular-nums`; el markup la
usa en las cuatro tarjetas del panel, las del análisis, las fichas del
patrimonio y de la reconciliación, el patrimonio neto, el total de deudas y
las filas de movimientos.

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

// DESPUÉS — la fuente sale del @theme (Archivo, la elige el design system)
<body className="font-sans" />
```

Y tampoco alcanza con «una fuente cualquiera»: la familia es una **decisión**
del sistema (§3.1). `--font-sans: var(--font-geist-sans)` —la fuente por
defecto de Next— es una falla del candado: el `@theme` tiene que mapear
`font-sans` a `var(--font-archivo)`.

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
`from-*`, `via-*`, `to-*`), una fuente fuera del tema, un `dark:` en un color
o un **cuerpo de letra fuera de la escala** (`text-2xl`, `text-3xl`, un
`text-[15px]`); y además comprueba que el `@theme` declare los quince tokens,
**que cada token tenga valor en los dos esquemas** (un token sin valor es un
token muerto: la utilidad compila a un `var(--token)` sin definir), **que la
familia del tema sea la elegida** (`--font-sans: var(--font-archivo)` /
`--font-mono: var(--font-plex-mono)`) y **que la escala de cinco pasos esté
declarada con el tope de 24 px** (`--text-xl: 1.5rem`, el número con el que
está calibrado `factorMonto`).

Los números de la tipografía (avances, márgenes, el factor de cada monto) se
miden con `node scripts/medir-fuente.mjs --candidatas` (antes de elegir) y
`node scripts/medir-fuente.mjs --url http://127.0.0.1:3101` (la fuente real
que sirve el build).

---

## 7 · Las primitivas (F1)

Las piezas de `components/ui/` son de Radix, **la piel es del proyecto**. No
se corrió `npx shadcn init`: el CLI reescribe `app/globals.css` con su propio
tema (sus `:root`/`.dark` y sus colores en oklch) y eso destruye los tokens de
F0a/F0b. En su lugar:

- `components.json` escrito a mano (formato estándar, para que un futuro
  `shadcn add` encuentre los alias), `"cssVariables": true`, sin colores.
- `lib/utils.ts` con el `cn()` de siempre (`clsx` + `tailwind-merge`).
- Las dependencias mínimas: `class-variance-authority`, `clsx`,
  `tailwind-merge` y los `@radix-ui/react-*` de cada primitiva.
- Los `components/ui/*` adaptados a mano, con los tokens de §1 y los radios de
  §2 (`rounded-md` 6, `rounded-lg` 8, `rounded-full`, `rounded-none`; shadcn
  trae `rounded-sm`/`rounded-xl` y acá se normalizaron).

### 7.1 · El puente de tokens

`@theme inline` declara **alias** (nunca colores nuevos) para el vocabulario
de shadcn:

| Token de shadcn | Apunta a | Token de shadcn | Apunta a |
|---|---|---|---|
| `background` / `foreground` | `--surface` / `--fg` | `accent` / `accent-foreground` | `--surface-3` / `--fg` |
| `card` / `card-foreground` | `--surface-2` / `--fg` | `destructive` / `destructive-foreground` | `--danger` / `--primary-fg` |
| `popover` / `popover-foreground` | `--surface-2` / `--fg` | `border` / `input` | `--line` |
| `primary` / `primary-foreground` | `--primary` / `--primary-fg` | `ring` | `--focus` |
| `secondary` / `secondary-foreground` | `--surface-3` / `--fg` | `muted` / `muted-foreground` | `--surface-3` / `--fg-muted` |

El archivo sigue con **30 valores hex** (15 en `:root`, 15 en el bloque
oscuro): el puente no agregó ni uno. `destructive-foreground` es
`primary-fg` y está medido sobre `--danger`: 6,26:1 en Noche y 6,47:1 en
claro. El único alias que no es un calco es `input` → `--line` (el borde
decorativo): los controles de la app usan `--line-strong` (≥ 3:1) en su
componente y el alias queda para las piezas que todavía no pasaron por F2.

### 7.2 · Las piezas y sus reglas

`button` (variantes default/secondary/outline/ghost/destructive/link; tamaños
sm/default/lg/icon) · `input` · `label` · `card` · `badge` (default, secondary,
outline y los cuatro estados con su tinte al 10 % y borde al 40 %) ·
`separator` · `dialog` · `sheet` · `select` · `tabs` · `table` ·
`dropdown-menu` · `tooltip`.

- **Foco:** `focus-visible:ring-2 ring-ring ring-offset-2
  ring-offset-background` (el anillo es `--focus`).
- **`dark:` en colores:** ninguno. El alias ya resuelve por esquema.
- **Sin animaciones de entrada** (son F3): sólo `transition-colors` y
  `data-[state=…]`. Nada de `tw-animate-css`.
- **Targets táctiles:** no se declaran en las variantes. La capa base fuerza
  44 px en `button`/`input`/`select`/`textarea` con `any-pointer: coarse`;
  `h-9` fija `height`, no `min-height`, así que el piso sigue ganando en un
  teléfono y el escritorio conserva la densidad.
- **El pie del modal no se pierde:** `Dialog`/`Sheet` son columnas flex
  (`Header` y `Footer` `flex-none`; `DialogBody`/`SheetBody` `flex-1 min-h-0
  overflow-y-auto`). El pie queda fuera del scroller; en F2 se migran los
  modales con esa estructura.
- **La tabla scrollea por dentro:** `Table` envuelve el `<table>` en un
  contenedor `overflow-x-auto`; el documento no se va de ancho.
- **`Button` es `type="button"` por defecto** (dentro de un `<form>` un botón
  sin `type` es un submit; el que envía lo dice).
- **`toast` no entra en F1**: la app tiene su toast de deshacer propio y el de
  shadcn está deprecado. Se decide en F2.

### 7.3 · Cómo se verifica

`components/ui/primitives.test.tsx` renderiza con `react-dom/server` las
piezas que no usan portal (button, badge, card, input, label, separator,
table) y verifica la piel, las variantes de `cva`, que el HTML no traiga
radios fuera de escala / `dark:` en color / hex, y que el puente de tokens
siga apuntando a los tokens del proyecto con 30 hex y ni uno más. Las piezas
con portal (dialog, sheet, select, dropdown-menu, tooltip) se cubren con
typecheck + build; su geometría se mide en F2. `npm run check:estilo` escanea
también `components/ui/**` (un `rounded-xl` o un hex en una primitiva es una
falla) y `npm run check:css` admite, en el nivel superior, sólo los bloques de
tokens (`:root`, `.dark`, con variables y sin reglas anidadas) además de
`@layer base`.
