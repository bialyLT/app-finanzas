# Flows de Maestro — Testing de UI

Pruebas de interfaz automatizadas sobre un **navegador Chromium real**, usando
[Maestro](https://docs.maestro.dev) en modo web (declarando `url:` en vez de `appId:`).

## Requisitos previos

```powershell
npm run db:local:start     # 1. base de datos local
npm run build              # 2. compilar
npm start                  # 3. servir en el puerto 3000
```

**Servidor de producción, no `npm run dev`.**

`npm run dev` también funciona, pero el servidor de producción es mejor para
testear por tres razones concretas:

1. **Compila por adelantado.** En dev, Turbopack compila cada ruta en la primera
   request y tarda ~18 segundos (ver trampa 4). Eso obliga a poner
   `extendedWaitUntil` con timeouts enormes en cada flow.
2. **Consume mucha menos memoria.** Turbopack crece a medida que compila rutas.
3. **Es lo que ve el usuario.** Un test que corre contra otra cosa que la
   versión que se despliega está verificando código que nadie va a ejecutar.

Y Java 21 instalado (Maestro es una app de JVM):

```
C:\Users\Lourdes\AppData\Local\jdk21\jdk-21.0.12.1+1
```

## Cómo correrlos

Los flows están escritos para correrse **en orden**: cada uno parte del estado
que dejó el anterior. Antes de la suite hay que sembrar los datos:

```powershell
# 1. Sembrar el escenario (borra y recrea: es idempotente)
node scripts/smoke.mjs --reset

# 2. Un flow puntual
powershell -File scripts/maestro.ps1 test flows/02-panel.yaml --env APP_PASSWORD=tu-password

# 3. O todos, en orden
powershell -File scripts/maestro.ps1 test flows --env APP_PASSWORD=tu-password
```

### Por qué los datos se siembran aparte

Los flows 01, 02, 05, 06 y 07 **verifican**, no construyen. El escenario
(banco, tarjeta, préstamo al 60%, sueldo, gastos, cuota) lo arma
`scripts/smoke.mjs`, que además comprueba que cada número sea el esperado
calculado a mano.

Separarlo tiene una ventaja concreta: si un flow falla, la pregunta "¿el dato
estaba mal o la pantalla lo muestra mal?" se responde sola. El smoke test ya
certificó el dato.

Los flows 03, 04, 08, 09, 10, 12, 13 y 14 **sí** agregan movimientos (o posteos
de reglas), así que correrlos dos veces sin resetear hace que los totales no
coincidan. De ahí el `--reset`. Y por eso los flows **08, 09 y 10 van al final,
en ese orden**, y después la cierra la cadena **11 → 12 → 13 → 14 → 15** (el 15
es neto cero: crea y borra la misma regla). Los primeros parten de la suma que
dejan los anteriores (el “en rojo”, los montos extremos y el saldo a favor no
tienen lugar en el mes limpio del seed), y con ese estado acumulado el select
del burn tiene más gastos que el de categorías — la única combinación en la que
el driver puede tocar su opción (trampa 13).

El wrapper `scripts/maestro.ps1` se encarga de `JAVA_HOME`, de desactivar los
analytics anónimos de Maestro y de ponerle un techo de memoria a la JVM (ver
trampa 5). Sin él hay que configurar las tres cosas a mano.

También podés ver las corridas en vivo en el **Maestro Viewer**:
→ <http://127.0.0.1:9999/>

---

## Las dieciséis trampas

Esta carpeta existe porque cada una de estas cosas nos costó una sesión de
depuración. Están todas documentadas acá para que no vuelvan a pasar.

### 1. Nunca uses `localhost` en los flows: usá `127.0.0.1`

Chrome tiene el modo **HTTPS-First** activado por defecto y reescribe
`http://localhost` a `https://localhost`. El dev server de Next habla HTTP plano,
así que la navegación se queda esperando un handshake TLS que nunca ocurre, y el
flow muere por timeout con un mensaje que no explica absolutamente nada:

```
java.util.concurrent.TimeoutException
Command: [7e81f380..., get {url=http://localhost:3000}]
```

`127.0.0.1` está exento de esa reescritura. **Siempre la IP.**

### 2. `allowedDevOrigins` tiene que incluir `127.0.0.1`

Este es el peor de todos porque **el síntoma no se parece a la causa**.

Next.js trata `localhost` y `127.0.0.1` como orígenes distintos y bloquea los
recursos internos de desarrollo cuando llegan desde el que no arrancó el server:

```
⨯ Blocked cross-origin request to Next.js dev resource /_next/hmr from "127.0.0.1".
```

Como el runtime del cliente no carga, **React NUNCA HIDRATA**. La página se ve
perfecta — el HTML llega, los estilos están — pero es HTML inerte. Podés escribir
en los campos (eso lo hace el navegador solo), pero **los botones no hacen nada**
porque no hay ningún handler de React atado.

Consecuencia práctica: el flow parece que "encontró un bug en la app" cuando en
realidad es configuración del servidor. En nuestro caso: el `inputText` escribía
el texto en el campo, el clic en "Entrar" no producía ningún POST, y no aparecía
ningún mensaje de error. Todo apuntaba a la app. El problema estaba en
`next.config.ts`.

Está resuelto en `next.config.ts`:

```ts
allowedDevOrigins: ["127.0.0.1", "localhost", "100.67.117.77"],
```

Sólo afecta al servidor de desarrollo; en producción no aplica.

### 3. No declares una variable referenciándose a sí misma en `env:`

Esto **no funciona**:

```yaml
env:
  APP_PASSWORD: "${APP_PASSWORD}"     # ← AUTORREFERENCIA
```

Maestro no la resuelve contra el entorno del sistema: la deja como el string
literal `"${APP_PASSWORD}"`. El login falla con 401 y el mensaje que ves en
pantalla es **"Contraseña incorrecta."** — que te manda a buscar el problema en
la contraseña, cuando el problema es la interpolación.

Las credenciales se pasan desde afuera, con `--env`:

```powershell
scripts/maestro.ps1 test flows/01-acceso.yaml --env APP_PASSWORD=...
```

Así tampoco quedan escritas en un archivo versionado. Una credencial commiteada
sobrevive para siempre en el historial de git, aunque después la borres.

### 4. En dev, la primera visita a una ruta tarda ~18 segundos

Turbopack compila la ruta en el momento de la primera request:

```
GET / 200 in 18.4s (next.js: 18.1s)
```

`assertVisible` tiene un timeout corto y **se rinde antes de que la página
exista**. El screenshot del fallo muestra la pantalla CORRECTA (se toma después),
así que parece un bug de la app.

Para esperar condiciones lentas, usá `extendedWaitUntil` con timeout explícito:

```yaml
- extendedWaitUntil:
    visible: "Inicio"
    timeout: 90000
```

### 5. `DevToolsActivePort file doesn't exist` casi nunca es un problema de Chrome

Es el error más engañoso de todos:

```
Could not start a new session. Response code 500.
Message: session not created: DevToolsActivePort file doesn't exist
```

Suena a versión de Chrome desalineada con el driver, a un driver corrupto o a un
perfil bloqueado. En esta máquina no era ninguna de las tres: **no había memoria
para que Chrome arrancara.**

El detalle que lo delata es lo que queda en el perfil temporal de Chrome. Un
arranque normal deja `DevToolsActivePort`, `Local State`, `Default\`… Un arranque
que muere apenas empieza deja **un solo archivo**:

```
scoped_dir364_1459959237\
    CrashpadMetrics-active.pma      ← y nada más
```

`chrome.exe` llegó a inicializar Crashpad y murió. Si el equipo tiene poca RAM
libre, ésa es la causa.

Medido en esta máquina:

| | |
|---|---|
| RAM total | 3,83 GB |
| RAM libre en reposo | ~0,5 GB |
| JVM de Maestro, heap por defecto | ~960 MB (¼ de la RAM física) |
| Chrome + un renderer | ~400–600 MB |

La JVM reserva **un cuarto de la RAM física** por defecto, y pide ese heap justo
cuando Chrome está arrancando. Los dos juntos no entran.

Está resuelto en dos lugares:

1. `scripts/maestro.ps1` le pone `-Xmx384m` a la JVM. Maestro es un cliente HTTP
   que evalúa aserciones: no necesita más.
2. Los tests corren contra `npm start` y no contra `npm run dev`. Turbopack crece
   con cada ruta que compila; el servidor de producción se queda chico y estable.

Y hay un detalle que hace perder tiempo: **`RAM libre` en Windows no cuenta la
caché de archivos**, que el sistema libera bajo presión. Por eso el primer
síntoma no fue "Chrome murió" sino "la navegación tardó 195 segundos": Chrome
estaba paginando contra el archivo de paginación en vez de fallar de una.

Si algún día el error vuelve, antes de tocar el driver o la versión de Chrome,
mirá cuánta memoria libre hay.

### 6. Maestro compara contra el texto COMPLETO del elemento

No busca el patrón adentro del texto. El elemento en pantalla dice
`$ 800.000,00`, y esta aserción **falla**:

```yaml
- assertVisible: '800\.000,00'
```

Falla por el motivo equivocado, que es lo peor: el número está bien y el elemento
existe. Lo que no coincide es el patrón, porque `800.000,00` no es el texto
completo de `$ 800.000,00`.

La forma correcta:

```yaml
- assertVisible: '.*800\.000,00.*'
```

Y hay dos detalles que van con esto:

**El punto va escapado.** Maestro interpreta el texto como expresión regular, así
que un punto suelto significa "cualquier carácter" y `'.*50.000,00.*'` también da
por buena una pantalla que muestra `450.000,00`. Una aserción que pasa por el
motivo equivocado es peor que una que falla.

**Y no es sólo el punto: todo metacarácter del texto se escapa.** La app también
dice `¿Borrar la regla?` y `Próximas (proyección)`, y un `?`, un `(` o un `)`
sueltos cambian el patrón: `'.*¿Borrar la regla?.*'` matchearía `¿Borrar la
regl?` (el `?` vuelve opcional a la `a`), y un paréntesis desbalanceado mata la
regex sin decir por qué. Los patrones correctos del flow 15:
`'.*¿Borrar la regla\?.*'` y `'.*Próximas \(proyección\).*'`.

**Comillas simples en YAML.** En comillas dobles la barra invertida activa
secuencias de escape, y `"\."` no es una secuencia válida: YAML da error antes de
que Maestro llegue a ver el texto.

Y no hace falta pelear con el espacio duro: `Intl.NumberFormat("es-AR")` separa el
símbolo del número con **U+00A0**, no con un espacio común. Los `.*` de los
costados lo cubren sin nombrarlo.

El flow `00-diagnostico.yaml` es la sonda que verifica esto: si algún día esa
sonda falla, el comportamiento cambió y hay que sacar los comodines de todos los
flows.

**Corolario: un elemento con hijos es VARIOS nodos, no uno.** El título de la
reconciliación se arma así: `Reconciliación · octubre de 2026` más un `<span>`
con ` · en curso` cuando el mes está en curso. En el árbol hay DOS nodos: el
título (texto hasta "…de 2026") y el badge como su HIJO. Consecuencia directa:
un patrón que cruce los dos textos —`.*Reconciliación.*octubre de 2026.*en curso.*`—
**no matchea nada, jamás**, y un `assertNotVisible` con ese patrón pasa por el
motivo equivocado (vacío). Comprobado en los diagnósticos del 17/10: la captura
mostraba "EN CURSO" y la aserción que lo afirmaba fallaba igual; el dump de
jerarquía (`screen-hierarchy/*.json`) probó el desdoblamiento.

Para afirmar o negar la relación padre-hijo existe el selector relacional
`containsChild` (también `childOf`, `below`, `above`, `leftOf`, `rightOf`):

```yaml
# el badge está: el título CONTIENE un hijo "en curso"
- assertVisible:
    text: ".*Reconciliación.*octubre de 2026.*"
    containsChild: ".*en curso.*"

# el badge no está (mes cerrado): negación precisa, sin falsos vacíos
- assertNotVisible:
    text: ".*Reconciliación.*septiembre de 2026.*"
    containsChild: ".*en curso.*"
```

Ojo con el texto pelado: `" · en curso"` también vive en la celda de la serie
(`oct 2026 · en curso`, siempre la del mes de HOY), así que un
`assertNotVisible: ".*en curso.*"` o falla siempre o —peor— depende de qué haya
en pantalla. La relación padre-hijo es la única negación honesta.

### 7. `assertNotVisible` también aprueba lo que quedó fuera de la pantalla

Es la trampa más silenciosa de todas, porque **no falla: da confianza**.

```yaml
- scrollUntilVisible: { element: { text: ".*Kiosco.*" }, direction: DOWN }
- assertNotVisible: '.*310\.000,00.*'      # ← inútil
```

Esa aserción pasa siempre. No porque `310.000,00` no esté en la página, sino
porque después del scroll quedó fuera de la vista. Si un bug reintrodujera el
número viejo, el test seguiría verde.

La regla: **las aserciones negativas van antes de scrollear**, mientras el
elemento que se niega está de verdad en pantalla.

Lo mismo vale para las positivas: la pantalla de los tests mide 1018×597, así que
todo lo que esté debajo del pliegue —la lista de movimientos, el desglose por
categoría— necesita un `scrollUntilVisible` antes de poder afirmarse.

La forma de darse cuenta de que está pasando: un `assertNotVisible` que pasa
demasiado fácil. Si el elemento que negás está en el encabezado de la página y vos
venís de scrollear hacia abajo, sospechá.

**Corolario: el flash de la acción CONTIENE el nombre de lo que borraste.** En
`/recurrencia`, después de borrar, el flash dice `Regla “Proyección de prueba”
borrada.` — así que un `assertNotVisible` del nombre de la regla es imposible
mientras el flash esté en pantalla (y el refresh del borrado deja la página en el
tope, con el flash a la vista). La negación honesta no nombra la regla: usa sus
marcadores únicos —el chip `Todas las semanas`, la fecha `28 de feb de 2027`— y
se hace con la región A LA VISTA: se baja hasta el final de la lista (si la
tarjeta siguiera viva, entraría completa en pantalla con ambos textos). El patrón
vive en `flows/15-proyeccion-y-borrado.yaml`.

### 8. Maestro comparte el perfil de Chrome: las cookies persisten entre flows

Al correr la carpeta entera, los flows **no** arrancan cada uno de cero: comparten
el perfil del navegador, así que la sesión de uno sigue viva en el siguiente.

Esto rompió la suite de la forma más cara posible, porque **un solo descuido la
tumba entera en cascada**:

```
[Passed] 00  → inicia sesión para verificar los números… y la deja abierta
[Failed] 01  "Esta aplicación es privada" no visible   ← ya estaba adentro
[Failed] 02  Element not found: Id password            ← ya estaba adentro
[Failed] 03  Element not found: Id password            ← ya estaba adentro
[Failed] 04  Element not found: Id password            ← ya estaba adentro
[Failed] 05  Element not found: Id password            ← ya estaba adentro
```

Mirá los mensajes: **ninguno de los cinco dice la verdad sobre la causa.** El flow
01 falla en una aserción que sí es correcta, y los otros cuatro fallan buscando un
campo de contraseña en un formulario al que nunca llegaron (el proxy ya los había
redirigido al panel — ver la regla "usuario autenticado que entra a `/login`" en
`proxy.ts`).

Se arregla con una regla simple: **cada flow construye su sesión desde cero, no la
hereda.**

```yaml
- openLink: "${BASE}"

# Si venimos de otro flow, la sesión sigue abierta. Se cierra.
- runFlow:
    when:
      visible: "Salir"
    commands:
      - tapOn: "Salir"

- extendedWaitUntil:
    visible: "Entrar"
    timeout: 60000

- tapOn: { id: "password" }
- inputText: "${APP_PASSWORD}"
- tapOn: "Entrar"
```

Y el que necesita lo contrario —el flow 01, que verifica que SIN sesión no se vea
ningún dato— cierra sesión al terminar, con el mismo condicional del otro lado.
Así el flow siguiente encuentra el estado que espera.

**Por qué un condicional y no un `tapOn` a secas**: `tapOn` falla si el elemento
no existe, y hace bien — un toque que no encuentra su blanco casi siempre
significa que la pantalla no es la que creés. Acá puede faltar legítimamente
(cuando el flow corre solo, no hay sesión que cerrar), así que la condición se
escribe explícita en vez de tolerarse.

Un flow que corre solo arranca siempre sin sesión: cada invocación de la CLI
levanta un perfil nuevo. Eso es lo que hace que `flows/01-acceso.yaml` pase cuando
se lo corre solo y falle dentro de la suite si el anterior dejó la sesión abierta.

### 9. Un elemento recortado por un contenedor con scroll NO existe para Maestro

El modal del formulario es `max-h-[92vh] overflow-y-auto`. En una ventana de
1019×597 el contenido llegaba hasta el campo "Detalle" y los botones quedaban más
abajo, **recortados por el contenedor**.

Chrome le informa a Maestro un rectángulo de **tamaño CERO** para un elemento
recortado. No "fuera de la vista": tamaño cero. Y Maestro filtra los nodos de
tamaño cero antes de buscar, así que la búsqueda falla con

```
Element not found: Id matching regex: tx-submit
```

que dice que el botón no existe. Existe, está en el DOM, y un usuario lo alcanza
scrolleando. Lo que no hay es un rectángulo.

**Cómo distinguirlo de un elemento simplemente fuera de la vista**: mirá la
jerarquía. Si el elemento está en la jerarquía y `tapOn` no lo encuentra, es
posición. Si **no** está en la jerarquía, es esto: está recortado.

Y se arregló **en la app, no en el test**:

- Un `scrollUntilVisible` no sirve. Maestro no puede scrollear un contenedor
  interno cuyo contenido no ve.
- Y sobre todo: el problema no era del test. En una pantalla baja el botón de
  guardar no se ve, y nada indica que haya que scrollear. Un usuario que toca
  "Nuevo gasto", llena cinco campos y no encuentra cómo confirmar, abandona.

El pie de los dos modales quedó `sticky bottom-0` (el fondo opaco es parte del
arreglo: sin él, los campos pasan por detrás del botón y se leen los dos textos
superpuestos). El mismo defecto estaba en `AccountForm`, con el mismo arreglo.

**La lección, que es la más importante de todas**: cuando un test no encuentra
un control, la primera pregunta no es cómo hacer que el test lo encuentre, sino
**por qué un usuario tendría problemas para encontrarlo**. Acá la respuesta era
"los tiene".

**Caso hermano (Fase 6): el pliegue de la página.** Con la serie mensual de patrimonio, el bloque nuevo estiró el panel y los botones de acción quedaron **debajo de la ventana** de 1018×597. A diferencia del modal recortado, acá el usuario llega scrolleando: el problema no era de la app, era del test. El árbol web de Maestro ve la ventana, y `tapOn` no scrollea nunca — un control debajo del pliegue "no existe" para el driver aunque exista para cualquier persona. El patrón que quedó en 03/04/08/09/10: `scrollUntilVisible` hasta el botón con `centerElement: true` antes de tocarlo, y después del submit, cerrar el modal y volver arriba anclando en una línea superior (trampa 12).

**Caso hermano 2 (Fase 3): la fila de acciones de la ÚLTIMA tarjeta.** En `/recurrencia`, la tercera tarjeta activa —la recién creada— tiene su fila de botones (Editar / Pausar / Archivar / Borrar) justo debajo del pliegue: el árbol sólo traía los Borrar de las tarjetas 1 y 2 y el `tapOn` moría con "not found". La sutileza tiene tres capas: (a) el ancla natural que uno elegiría —el toggle "Ver archivadas"— vive ARRIBA de la lista, así que scrollear "hasta" ella deja la tarjeta al fondo, fuera de la vista; (b) el único nodo anclable que queda DEBAJO del objetivo es el link "Volver al panel", que cierra la lista — se scrollea hasta él SIN `centerElement` (a esa altura el centro es inalcanzable; trampa 12, corolario); (c) el objetivo en sí no tiene texto único (es `rec-delete-N`), así que se lo elige por RELACIÓN con el dato que sí es único: `id: "rec-delete-.*"` con `below: '.*28 de feb de 2027.*'`. El patrón completo vive en `flows/15-proyeccion-y-borrado.yaml`.

---

### 10. `scrollUntilVisible` tiene que apuntar al DATO, no al título de la sección

Este costó una corrida entera y el mensaje de error era una trampa perfecta:

```
Assertion is false: ".*Alquiler.*" is visible
```

Suena a que la categoría no está en el desglose. Estaba: 250 píxeles más abajo.

**Qué pasaba.** La página de análisis tiene, entre el título "En qué se fue" y la
lista de categorías, un **gráfico de torta de 256 píxeles** (`h-64`). El flow
hacía:

```yaml
- scrollUntilVisible:
    element:
      text: ".*En qué se fue.*"    # ← el TÍTULO
    direction: DOWN
```

`scrollUntilVisible` frena **apenas el elemento asoma** por el borde inferior de
la pantalla. El título asoma, el scroll se detiene, y la lista de categorías
—que empieza 256 píxeles más abajo— queda entera debajo del pliegue.

**La regla**: anclá el scroll en el dato que vas a verificar, nunca en el encabezado
que lo introduce. El encabezado está arriba del dato por definición, así que
scrollear hasta él garantiza que el dato todavía no se ve.

**Y el corolario, que ahorra aserciones**: si vas a verificar una lista que entra
en una pantalla, alcanza con scrollear hasta su **último** elemento. Todo lo que
está por encima de él, dentro de la pantalla, queda visible también. Anclar en el
**primero** no sirve: puede quedar justo en el borde inferior y dejar afuera a
todos los siguientes.

```yaml
# El desglose tiene 6 filas de ~25px: entran en una pantalla de 597.
# Con una sola aserción de scroll queda todo visible.
- scrollUntilVisible:
    element:
      text: ".*Kiosco.*"      # la ÚLTIMA fila, no el título
    direction: DOWN
```

Si la lista crece y deja de entrar en una pantalla, esto se rompe ruidosamente
—fallan las aserciones de arriba— y ése es el momento de pasar a un scroll por
fila, en orden de arriba abajo.

---

### 11. Los servidores MCP de Maestro pelean con el CLI por el archivo de sesiones

El peor de todos, porque **el error apunta a otro lado**.

**Qué pasa.** Maestro guarda el estado de sus sesiones en un único archivo:
`~/.maestro/sessions`. Todo proceso de Maestro le escribe un heartbeat cada 5
segundos, y en Windows ese archivo se **bloquea** mientras se escribe.

Cuando una herramienta levanta el **servidor MCP** de Maestro (`maestro.cli.AppKt
mcp`) y no lo baja, ese proceso sigue latiendo ahí para siempre. Con uno o dos
servidores MCP vivos, la corrida del **CLI** se pasa minutos peleando por el
archivo:

```
[ERROR] Failed to record heartbeat
java.io.IOException: El proceso no tiene acceso al archivo porque otro proceso
                     tiene bloqueada una parte del archivo
[ INFO] Open ${BASE} FAILED
```

**Por qué es tan caro.** El flow falla en el **primer `openLink`**, así que parece
un problema de Chrome, del servidor o del proxy — y los tres están perfectos. Y en
vez de tardar un minuto en pasar, tarda **seis en fallar**, así que tampoco se
parece a un fallo de driver.

**Cómo se diagnostica.** Dos comandos, en este orden:

```powershell
# 1. ¿Cuántos procesos de Maestro hay vivos, y desde cuándo?
Get-CimInstance Win32_Process -Filter "Name = 'java.exe'" |
    Where-Object { $_.CommandLine -like "*maestro*" } |
    Select-Object ProcessId, CreationDate, CommandLine

# 2. El detalle real del flow, que la consola NO muestra:
Get-ChildItem "$env:USERPROFILE\.maestro\tests" |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
```

El segundo es el importante: **`~/.maestro/tests/<fecha>/<flow>/logs/maestro.log`
tiene el error de verdad.** La consola resume; el log dice. Y como la consola ya
viene llena de banners de colores y avisos de Maestro Cloud, uno no sospecha que
falta información.

**Cómo se evita.** `scripts/maestro.ps1` mata los servidores MCP huérfanos antes
de arrancar. No avisa y sigue: un aviso que dice "esto va a fallar" es peor que
sacar el obstáculo de en medio.

Y la consecuencia para el diseño de los tests: **nunca corras Maestro en
paralelo** — ni dos flows a la vez, ni el CLI mientras un agente usa el MCP. No es
sólo la RAM de la trampa 5: es que comparten un archivo.

---

### 12. Un `scrollUntilVisible` hacia arriba puede frenar DEBAJO del header pegajoso

El header de la app es `sticky top-0 z-40` y semi-transparente. Un
`scrollUntilVisible` hacia arriba frena **apenas el elemento entra al viewport**;
si entra pegado al borde superior, queda **detrás del header**. Maestro lo
considera visible, el `tapOn` se lo come el header, y el error aparece en el
paso SIGUIENTE —"Element not found" sobre el popup que nunca abrió—, que manda a
buscar el problema al lugar equivocado:

```
Tap on ".*Todas las categorías.*"... COMPLETED   ← "exitoso"… contra el header
Tap on "Ropa"... FAILED: Element not found       ← el popup nunca se abrió
```

**La solución**: anclar el scroll en una línea que está ARRIBA del objetivo
—por ejemplo la línea del rango del período, en `/analisis`— con
`centerElement: true`. Así el objetivo queda centrado en el viewport, lejos
del header:

```yaml
- scrollUntilVisible:
    element:
      text: ".*2026-10-01.*2026-10-31.*"
    direction: UP
    centerElement: true
```

La regla general: después de un scroll hacia arriba, un `tapOn` que dice
"COMPLETED" no prueba que tocó lo que creías. Si el paso siguiente falla porque
"no existe" el efecto de lo que tocaste, sospechá del header antes que del
elemento.

**El corolario de la reconciliación visible (Fase 6)**: `centerElement` sólo se
puede cumplir si el elemento PUEDE llegar al centro del viewport. La PRIMERA
fila de la página —el selector de mes del panel— tiene su techo en `y ≈ 97` con
la página en `scrollTop = 0`, así que pedirle el centro (~278) es imposible:
Maestro reintenta hasta el timeout y FALLA con

```
No visible element found: id: btn-next-month
```

que miente: el botón está visible al 100%. Peor todavía, la carrera según dónde
caiga el reloj respecto del timeout hace que a veces "complete" tras unos
reintentos y a veces falle — el mismo comando, distinto resultado.

Por eso, para volver ARRIBA de todo se ancla en el `id` del selector
(`btn-next-month`) y se lo deja **sin** `centerElement`: el scroll termina en el
tope real de la página y el selector queda despejado debajo del header. Y el
ancla por TEXTO de esa fila quedó además **ambigua** cuando la reconciliación
agregó su título —"Reconciliación · octubre de 2026"— más abajo: el scroll se
satisface ahí, con las tarjetas de arriba fuera de la vista. Las dos cosas juntas
rompieron los flows 02, 03, 04, 08, 09 y 10 en la ronda de la reconciliación; el
patrón corregido vive en `flows/02-panel.yaml` y el porqué completo, también.

**El corolario del fondo de la página** es la simetría del anterior. El link
"Volver al panel" de `/recurrencia` es de los últimos contenidos de la página:
está tan cerca del borde inferior que la página ya no da scroll para llevarlo al
centro, así que pedirle `centerElement` muere por timeout igual que el selector
de mes pegado al techo. Para bajar hasta el final se ancla en él SIN
`centerElement` — no se lo toca, sólo marca hasta dónde bajar (el patrón de
borrado del flow 15).

---

### 13. Las `<option>` de un `<select>` se tocan por ÍNDICE — y otro select puede robarse el tap

El driver web de Maestro toca las opciones de un `<select>` con un modelo de
coordenadas **sintéticas**: la opción `k` vive en `[100000, 100000 + 20·k]` y el
tap va al **PRIMER `<option>` del DOM** cuyas coordenadas contengan ese punto.
Con dos selects en la misma página, el de ARRIBA se roba los taps del de abajo
mientras los índices se solapen.

Síntoma: el `tapOn` de una opción dice **COMPLETED**, pero quien la recibió fue la
opción homóloga del OTRO select (y si el punto no cae en ningún nodo `synthetic`,
el tap retorna sin error y no hace nada). El fallo aparece en la aserción
siguiente, por un motivo que no es el real — la misma familia que las trampas
6/7/12.

Cómo se diseña con esto: si un flow tiene que ELEGIR una opción de un select que
comparte página con otro, usá un índice que el primer select no tenga (el flow 11
lo aprovecha: al final de la suite octubre tiene más gastos que categorías, así el
índice alto del burn queda libre) o mové la elección a un flow donde ese índice
esté libre.

Dos límites del driver que van de la mano: `pressKey` en web **sólo mapea ENTER y
BACKSPACE** (las flechas no existen en ese camino) e `inputText` sobre un select
escribe el `value` **sin disparar `change`** — no selecciona nada.

**Corolario de carga**: elegir dispara el refetch con `Cargando…`; la página se
encoge y el navegador deja el scroll ARRIBA, así que el resultado que vive al
fondo queda fuera del viewport y un `extendedWaitUntil` no lo encuentra: la espera
se ancla con `scrollUntilVisible` al **texto del resultado** (patrón del flow 11).

---

### 14. Un `type="date"` borrado con backspace queda en `badInput` — y el submit no vuelve a dispararse

Este no salió de un flow de la app: salió de un banco de pruebas, y costó
entender que **el formulario estaba bien y el input no**.

**Qué pasa.** Un `<input type="date">` no es un campo de texto: Chrome lo maneja
por segmentos (`dd/mm/aaaa`). Sus segmentos son independientes y el backspace
limpia sólo el que está seleccionado — al enfocar con un clic, el primero.
Después de borrar, el campo queda mostrando pedazos (`mm/31/2027`), con dos
consecuencias feas: (1) el navegador reporta `""` como valor (React ya cree que
no hay fecha), pero los segmentos siguen ahí y la validación nativa marca
`validity.badInput`; (2) al guardar, el navegador FRENA el submit y muestra su
burbuja en inglés — `Please enter a valid value...`, sigue el idioma del
navegador, no el de la app. El usuario toca "Guardar" y no pasa NADA: ni POST,
ni flash, ni error. Y sin teclado no hay recuperación: el backspace sobre un
segmento ya vacío no avanza al siguiente.

**Cómo se diagnostica.** Misma familia de siempre — el síntoma está a dos pasos
de la causa. Si un submit dice COMPLETED y no pasa nada, mirá el screenshot del
paso y buscá la burbuja del navegador; si el form tiene un `type="date"` y el
flujo lo tocó con `eraseText`, es esto.

**El arreglo es de la app**, en `lib/date-input.ts`:
`clearDateInputIfEmptied` actúa sólo cuando el valor reportado quedó en `""` y
el navegador marcó `badInput` —la transición de borrado, inequívoca— y reasigna
`value = ""`, con lo que el setter descarta los segmentos y el campo vuelve a
ser válido. No puede dispararse TIPEando: cada dígito suelto de una fecha en
construcción también deja `""` + `badInput`, y ahí vaciar sería romper el campo
debajo de los dedos. Se usa en los tres componentes con fecha
(`RecurrenceRuleForm`, `TransactionForm` y `AccountForm` — cuatro inputs), y la
regresión vive en `flows/15-proyeccion-y-borrado.yaml`: edita una regla, borra
la fecha de fin con `eraseText: 20` y guarda con ENTER.

### 15. El pie fijo del modal tapa el último campo — y un label inline de dos líneas no se toca por su centro

Dos síntomas mudos del mismo modal (el alta de compra en cuotas de la Fase 5),
descubiertos en la ronda de la UI de tarjetas:

**El tap del último campo cae en el pie.** El modal es `max-h-[92vh]` con
`overflow-y-auto` y el pie es `sticky bottom-0`. En una ventana de 1034×557 el
contenido superaba los 512px de `92vh` y el último campo (la categoría) quedaba
debajo del pie. El chequeo de visibilidad de Maestro **no sabe de solapamientos**
—compara contra el viewport y reporta `Visibility Percent: 1.0`— y el tap
"Tap on id: plan-category … COMPLETED" en realidad tocó el botón **Cancelar** del
pie: el modal se cerró y el paso siguiente falló por un motivo que no era el real
(el preview "nunca aparecía"). La evidencia estaba en el log: label en
`[310,464][441,480]` (centro y≈472) y los botones del pie en y 466..510.

**El `inputText` de un label de DOS líneas se escribe en el vacío.** Con el form
en dos columnas, "Precio de contado (opcional)" quedó en dos líneas. `tapOn` por
`id` resuelve el LABEL (el `resource-id` vive en el `<label>` y su `htmlFor` es
el que enfoca el input), calcula el centro de sus bounds — y ese centro cae en el
hueco entre los dos fragmentos de línea de un label INLINE: el clic golpea el div
contenedor, no hay transferencia de foco, y `inputText` tipea donde no hay
campo. Todos los comandos dicen COMPLETED y el campo queda vacío; se diagnostica
en la jerarquía porque el input muestra su **placeholder** y no un valor
(`text=[108.000]` cuando el placeholder es `108.000`).

**Se arregla en la app, no en el test** (la lección de la trampa 9): todos los
campos viven ARRIBA del pie —dos columnas, la categoría abre la columna derecha,
la vista previa —que no se toca— va debajo— y todos los labels son `block`, así
el label es un rectángulo sólido y cualquier tap adentro activa el control. Y no
se scrollea NADA adentro del modal: los gestos sobre el backdrop lo cierran
(`onClick=onClose`) y Maestro igual no puede scrollear un contenedor interno —
comprobado: cinco `Swiping UP from center` seguidos dejaron los bounds idénticos
(el mismo swipe sí scrollea la página cuando no hay modal). Corolario para los
flows: un `tapOn` que dice COMPLETED no prueba que tocó lo que creías; si el
efecto no aparece, mirá screenshot y jerarquía ANTES de culpar a la lógica.

**Caso hermano (Fase 5): el alta de tarjeta desde el formulario de cuentas.**
Ahí el formulario CAMBIA DE FORMA al elegir el tipo tarjeta —aparecen cierre,
vencimiento y límite debajo—, así que todos los campos que ya existían se
DESPLAZAN. El flow fija primero lo que no depende del tipo (nombre y saldo
inicial) y recién después elige "Tarjeta": ningún tap posterior queda apuntando
a una coordenada que el cambio movió. La sonda que lo recorrió entera confirmó
también que los diálogos nativos no hacen falta en este formulario (las
validaciones son inline: "El día de cierre y el de vencimiento van juntos") y el
patrón vive en `flows/20-tarjeta-desde-cero.yaml`.

**Segunda puerta (Fase 7 r1, 2026-10-19): el desplegable abierto EMPUJA campos
vivos bajo la banda.** En el alta rápida, elegir una sugerencia de categoría
dejaba abiertas la lista de sugerencias y el aviso «✓»: la fila de fecha bajaba
~72px y el chip «Ayer» (centro y≈504) caía dentro de la banda muerta del pie —
ventana real medida en esta máquina: ~1019×557, con el pie del modal arrancando
en **y≈441**—. El tap «COMPLETED» no cambiaba la fecha: **sin foco, sin error,
no-op silencioso**. La misma ronda encontró la otra puerta del mecanismo: la
NOTA de la transferencia (su label matcheaba bajo la banda → tap muerto →
`description: ""`; el flow 04 fallaba al final buscando la nota perdida). Ambas
se arreglaron en la app — reordenar «Nota» por tipo y colapsar las ayudas al
aceptar la sugerencia (ya cumplieron su función) —, y la lección quedó fina:
**la geometría del modal se juzga por ESTADO** (en reposo y con las ayudas
desplegadas), y un COMPLETED sobre un punto tapado no deja rastro: si el efecto
no aparece, medí el punto de toque contra la banda del pie antes de culpar al
flow.

---

### 16. Un diálogo nativo (`window.confirm` / `window.alert`) TUMBA al driver

En la web no hay nodo para el diálogo modal del navegador: nadie lo contesta. Y
el driver no falla en el paso que lo abre — muere en el SIGUIENTE, con un error
que no menciona diálogos:

```
Tap on id: Eliminar movimiento... RUNNING
03:43:56 [ INFO] ... Tapping on element: ... resource-id=Eliminar movimiento   ← el tap sí pegó
          (35 segundos de nada: el hilo de JS del navegador está bloqueado)
03:44:31 [ERROR] maestro.drivers.CdpWebDriver.invokeSuspend: Failed to execute JS
03:44:31 [ERROR] maestro.orchestra.Orchestra.executeCommands:
         [Command execution] CommandFailed: null cannot be cast to non-null type kotlin.Int
03:45:31 [ WARN] ...captureScreenshot: Failed to capture screenshot screenshots/step-022-...
```

El `window.confirm("¿Eliminar este movimiento?")` congela el hilo de JS
esperando una respuesta; el próximo comando del driver (`execute JS`, con el que
serializa el árbol) no puede correr, el puente CDP revienta con un cast nulo y
ni siquiera alcanza a sacar el screenshot de diagnóstico. Evidencia completa:
`~/.maestro/tests/2026-10-18_034222` (sonda "confirm nativo + fecha"), paso
`step-022-tapOnElement-Eliminar_movimiento`.

**Se arregla en la app** con el patrón que ya usaban `/recurrencia` y
`/tarjetas`: confirmación en dos pasos EN LÍNEA en la propia fila —el botón de
borrar se convierte en `¿Eliminar?` + `Sí, borrar` / `Mejor no`, con ids
`mov-delete-*`, `mov-delete-confirm-*` y `mov-delete-cancel-*`— y el error es
una franja inline (`mov-delete-notice-*`), no `window.alert`. Un solo
`deleteBusyId` deshabilita los dos botones mientras guarda: sin dobles borrados.

Moraleja para el diagnóstico: si un `tapOn` dice COMPLETED y el paso siguiente
muere con `Failed to execute JS` y/o `null cannot be cast to non-null type
kotlin.Int`, buscá un diálogo nativo en la app antes de culpar al driver —
`window.confirm` y `window.alert` no tienen lugar en una UI testeable.

---

## Convenciones

- **Textos sin emoji en las aserciones.** El emoji se renderiza distinto según la
  plataforma y la aserción termina fallando por el ícono y no por el
  comportamiento que querés verificar.
- **Seleccioná por `id` cuando puedas.** El input de contraseña se toma con
  `tapOn: { id: "password" }` en vez de por texto: el texto puede cambiar, el `id`
  no.
- **Dos regiones con los mismos textos: selectores relativos (`below` / `above`).**
  Cuando la misma página tiene dos tarjetas o secciones que repiten etiquetas
  ("Correr el cierre", "Utilización: …"), un `tapOn` o un `assert` por texto
  pelado resuelve a la PRIMERA región del árbol —la de arriba— aunque el flow
  esté hablando de la de abajo. La salida es anclar cada interacción con
  `below: '.*<dato único de la región>.*'` (también `above`): el alcance se
  evalúa contra TODO el árbol, así que un `assertNotVisible` scopeado ignora los
  mismos textos que estén ARRIBA del ancla, y el `tapOn` scopeado pega en la
  región correcta. Dos límites que salieron del banco de pruebas (sonda 94b): el
  ancla y el objetivo tienen que estar serializados A LA VEZ —con ventana de
  ~597 px, si están a más de una pantalla el alcance no se puede evaluar— y el
  ancla tiene que ser única en TODA la página, no sólo en su región. El patrón
  vive en `flows/20-tarjeta-desde-cero.yaml` (cada trato con "Alfa Test" va
  scopeado debajo de su nombre).
- **El `name:` de un flow no lleva dos puntos.** Maestro arma la ruta de sus
  artefactos con el `name:` del flow, y en Windows `:` es ilegal en un nombre de
  archivo: el flow muere ANTES de arrancar con un stack trace de Java que no dice
  "nombre inválido":

  ```
  java.nio.file.InvalidPathException: Illegal char <:> at index 15:
      93 · sonda cola: saldo inicial, plan retroactivo, dobles toques y pago
  ```

  La consola lo muestra como error de PowerShell (`NativeCommandError`), que
  manda a buscar el problema al lugar equivocado. Un ` - ` o un `—` cumplen la
  misma función. (Sonda 93, 2026-10-18: renombrada, corrida limpia después.)
- **Cada flow corre con estado de navegador limpio al inicio del run.** Si un flow
  depende de estar logueado, hacé el login dentro del flow.
- **El saldo de una cuenta es apertura + los movimientos firmados con fecha ≤ HOY.**
  Los movimientos con fecha FUTURA que haya en la base no cuentan para el saldo
  mostrado (verificado contra la base al calcular a mano los números de los flujos
  de recurrencia). Si un saldo no cierra, revisá primero si estás sumando
  movimientos futuros.
- **Los flows son documentación viva.** Si encontrás un bug, escribí el flow que
  lo reproduce ANTES de arreglarlo. Después queda como test de regresión.

## Estado de los flows

| Flow | Qué verifica | Estado |
|---|---|---|
| `00-diagnostico.yaml` | **No verifica la app: verifica que se pueda testear.** Que Chrome arranque, que navegue, que React hidrate, y de paso sondea cómo matchea Maestro | ✅ Pasa (1m 10s) |
| `01-acceso.yaml` | Que la app esté cerrada sin sesión, que rechace contraseña incorrecta, que acepte la correcta y que el login deje de estar accesible | ✅ Pasa (35s) |
| `02-panel.yaml` | Los números del mes (ingresos 800.000 · gastos 490.000 · quedó 310.000 · ahorro 38,75% · patrimonio 410.000), la **tarjeta "Flujo de caja"** con sus tres caras (octubre +328.587,29 conviviendo con "Te quedó" +310.000; septiembre +500.000 sin ser ingreso; agosto $ 0,00 con "Sin transferencias"), los saldos por cuenta, la **reconciliación visible** (ΔPatrimonio +310.000 = Ahorro del mes +310.000, "cuadra al centavo"), la **tarjeta Deudas** (deuda viva 518.587,29 = Visa 50.000 + Préstamo 468.587,29; barra de progreso 6,28% = capital devuelto 31.412,71 / 500.000; «1 de 12 cubiertas · faltan 11»; interés pagado 25.000,00; DTI 7,05% = 56.412,71 / 800.000; "sin plan de cuotas" en la Visa; en septiembre «0 de 12 cubiertas» y DTI "no se puede calcular"), y que el desembolso del préstamo no aparezca como ingreso | ✅ Pasa (3m) |
| `02b-tarjetas.yaml` | El ciclo de una tarjeta real sobre el seed: configurar cierre 15 / vence 5 / límite 500.000 (la deuda de 50.000 de la Ropa pasa a 10,00% del límite y el período en curso a noviembre), "Correr el cierre" (resumen de octubre 50.000 / mínimo 2.500 "Sin pagar"), pagarlo en dos pasos con el Banco Galicia preseleccionado y el paso intermedio cancelado primero (deuda 0, "Pagado"), el 409 VERBATIM al cambiar el cierre con un resumen pagado ("Borrá primero el pago…" — el cierre NO cambia) y que el pago es transferencia, no gasto (panel 490.000 con 2 transferencias) | ✅ Pasa (2m 23s) |
| `02c-cuotas.yaml` | La compra en cuotas de punta a punta: "Heladera" de 120.000 en 12 cuotas con contado 108.000 → vista previa con cuota 10.000,00, sobreprecio 12.000,00 y **tasa implícita 1,66% por mes — TEA 21,83%** ("el interés está en el precio", §3.3); la compra del 18/10 cae en el período de noviembre ("Cuota 1 de 12", nada facturado); deuda 120.000 / utilización 24,00% / período 10.000 con mínimo 500; compromisos 60.000 a 6 meses y 120.000 a 12; el gasto cuenta UNA vez (panel 610.000 = 490.000 + 120.000); el borrado en dos pasos se lleva el gasto Y las cuotas; y la EXTENSIÓN: el escape del 409 del 02b recorrido de verdad — borrar el pago del resumen desde /inicio (dos pasos en línea, trampa 16), el resumen se reabre solo, el cambio de cierre ahora se guarda y al final se restaura el 15 (estado = seed) | ✅ Pasa (4m 11s) |
| `02d-carga-rapida.yaml` | La carga rápida de la Fase 7 de punta a punta: el gasto SIN categoría (el campo opcional de verdad), el monto 12.345,67 en formato argentino con su vista previa, el chip "Hoy", los tres tipos a la vista y el banco preseleccionado — y después las dos redes: recargar lo MISMO (cuenta recordada, monto y día) avisa del duplicado antes de guardar y "Volver" no guarda nada, y el toast de deshacer (persistente) revierte con su DELETE exacto: los totales vuelven a 490.000 · 310.000 · 410.000, el 502.345,67 desaparece y el toast se va — flow neto cero | ✅ Pasa (3m 0s) |
| `03-cargar-gasto.yaml` | Cargar un gasto desde el formulario y que los cinco totales se muevan exacto | ✅ Pasa (1m 17s) |
| `04-transferencia.yaml` | Transferir 50.000 entre cuentas propias y que **nada de lo que mide el mes cambie** | ✅ Pasa (1m 22s) |
| `05-analisis.yaml` | El desglose por categoría, que el interés aparezca y el capital no, y que las transferencias estén aparte | ✅ Pasa (40s) |
| `06-analisis-filtros.yaml` | Los filtros server-side de `/analisis`: categoría y texto achican los tres bloques con números exactos, el selector no se auto-filtra, el estado vacío habla de los filtros y "Limpiar ✕" vuelve a todo | ✅ Pasa (2m 29s) |
| `07-analisis-periodos.yaml` | Semana / Mes / Año, la ida y vuelta entre meses con los MISMOS números, los meses vacíos y que el cartel viejo de truncado no exista en ningún estado, y la tarjeta del burn viva con su selector limpio (la elección completa vive en el flow 11) | ✅ Pasa (1m 56s) |
| `08-panel-mes-en-rojo.yaml` | Un mes que no cierra en positivo: un gasto de 400.000 deja gastos 900.000, "Te quedó" −100.000,00 y flujo −81.412,71 — dos negativos DISTINTOS, cada uno con su signo; la tasa −12,50%; las transferencias no cambian | ✅ Pasa (1m 18s) |
| `09-montos-extremos.yaml` | La aritmética exacta al centavo: un gasto de $ 0,01 (punto decimal) mueve los tres números en 0,01; uno de 9.999.999,99 (formato argentino completo) los lleva a 10.900.000,00 · −10.100.000,00 · −10.081.412,71 y la tasa a −1.262,50% | ✅ Pasa (1m 58s) |
| `10-pago-de-mas.yaml` | Pagar la tarjeta de MÁS: la Visa pasa a "a favor $ 50.000,00" (con el código viejo decía "debe -$ 50.000,00"), el banco queda −9.631.412,71 y el flujo −10.181.412,71 con 3 transferencias; gastos y "Te quedó" intactos | ✅ Pasa (1m 26s) |
| `11-burn-mensualizado.yaml` | La elección COMPLETA del burn sobre el estado del final de la suite: el centavo de $ 0,01 repartido (`0,01 ÷ 12 = $ 0,00`), las dos vistas exactas (caja 10.900.000,00 / −10.100.000,00 contra burn 10.899.999,99 / −10.099.999,99), los dos pies del resultado, y que la selección sea EFÍMERA: volver por el encabezado deja el selector limpio y las vistas negadas con el select centrado | ✅ Pasa (1m 38s) |
| `12-bandeja-y-archivo.yaml` | Las validaciones del alta que dicen QUÉ falta (nombre → monto → categoría), la vista previa de los extremos (0,01 y 9.999.999,99), la ocurrencia de HOY que **no es plata** hasta aceptarla (el panel sigue en 10.900.000,00), el doble toque que no duplica (10.905.000,00 · −10.105.000,00 · −10.186.412,71 · banco −9.636.412,71) y que archivar no borra: la tarjeta archivada sólo ofrece Reactivar y Borrar | ✅ Pasa (2m 59s) |
| `13-auto-y-409.yaml` | El posteo AUTOMÁTICO: una regla mensual ancla 31 desde enero materializa y postea 9 fechas sola, el clamp de febrero (28) y el regreso al 31 en marzo, septiembre con el asiento exacto (−1.234,56 y flujo 498.765,44 con 1 transferencia) y octubre intacto; más el 409: una regla con historia no se borra (el aviso manda a archivarla) y archivarla no toca la historia | ✅ Pasa (4m 10s) |
| `14-pausa-saltos-y-transfer.yaml` | El ciclo de vida completo: una regla futura nace sin ocurrencias; pausada no materializa aunque haya vencidas; reactivarla materializa las 4 de golpe y saltarlas una por una no las revive; INCOME no ofrece préstamos ni tarjetas y TRANSFER no pide categoría y sí destino; aceptar la transferencia mueve la caja (flujo −10.186.712,71, banco −9.647.823,75, Visa a favor 50.300,00, 4 transferencias) sin tocar gastos ni "Te quedó" | ✅ Pasa (4m 10s) |
| `15-proyeccion-y-borrado.yaml` | La proyección de una regla futura: ancla 31 con clamp (31 ene → 28 feb → 31 mar), corte por fin y tope, y el descargo de que no es plata — el panel no se mueve; la edición mensual→semanal que limpia el ancla (B1), borra fin y tope con `eraseText` (**regresión del arreglo de `lib/date-input.ts`**, el bug U1 de la ronda del tester) y guarda con ENTER; y el borrado SIN historial (sin 409: flash "borrada." y la tarjeta se va con sus marcadores únicos negados) — flujo neto cero | ✅ Pasa (3m 6s) |
| `18-cuotas-modal-adversarial.yaml` | El modal de compra en cuotas atacado a propósito: la cascada de validaciones (descripción → total → cuotas → categoría, cada submit dice QUÉ falta), los campos elegidos por los **labels `block` vía ids `plan-*`** (el `tapOn` por texto pegaría en el fondo de la página — el caso está documentado en el encabezado del flow), el estado limpio al reabrir, la fecha fijada a mano, el datalist de categorías, el doble toque en "Registrar compra" (UNA sola compra de 100.000, el panel lo delata), el encabezado de la tarjeta con scroll UP ("debe 49.700,00" = 100.000 − 50.300 a favor; utilización 9,94%), el panel en 11.005.000 / −10.205.000 con 4 transferencias y el borrado en dos pasos que deshace todo (a favor 50.300 de vuelta) — flujo neto cero | ✅ Pasa (2m 46s) |
| `19-resumen-pago.yaml` | Pagar el resumen de octubre sobre una tarjeta con SALDO A FAVOR: el pago engorda el crédito (50.300 + 50.000 = 100.300), el doble toque en "Confirmar pago" (guarda del botón + idempotencia de la API), el origen preseleccionado (el flash del pago lo nombra: Banco Galicia), el documento queda "Pagado", la utilización 0,00% y el panel con la caja movida por la transferencia (−50.000: flujo −10.236.712,71, banco −9.697.823,75, 5 transferencias) sin tocar gastos ni "Te quedó" | ✅ Pasa (1m 4s) |
| `20-tarjeta-desde-cero.yaml` | Una tarjeta desde CERO y cuotas retroactivas: alta con saldo inicial −25.000 (el orden del formulario, validado por sondas: el monto sobrevive el cambio de tipo), el medio par cierre/vencimiento (error exacto y la cuenta NO se crea), el doble toque al submit (las deudas lo delatan: 393.287,29 y no 418.287,29), sin límite ⇒ "Utilización: no se sabe" (no un 0% inventado), la compra retroactiva del 30/09 en 5 cuotas (la cuota 1 cae en el octubre ya cerrado → "Cuota 2 de 5"; el cierre emite 2.000 / mínimo 100), el borrado que devuelve la deuda a 25.000 y el cierre #3 que recalcula el impago a 0,00 — "1 actualizado(s)", MISMO documento | ✅ Pasa (3m 51s) |
| `21-prestamo-desde-cero.yaml` | La UI de préstamos nueva, dirección "recibí": el alta guiada de 500.000 al 60% en 12 con la vista previa del servidor (cuota 56.412,71), la primera cuota computada al **día 20 del mes anterior** (nunca "hoy" literal: la 1 siempre vencida, la 2 siempre en el mes en curso), el **DESEMBOLSO como paso 2 explícito** que registra la transferencia (sin él la deuda viva mentiría — el aviso `loan-warning` tiene que NO estar), el split exacto de la cuota 1 en el bloque de pago (interés 25.000,00 + capital 31.412,71) con el refetch al tope y su flash, el progreso de la tarjeta scopeado debajo del nombre propio (debe 468.587,29 · "Cubriste 1 de 12" · "Próxima cuota 2 de 12" ya en el mes en curso), la cancelación anticipada en DOS pasos en línea (capital pendiente 468.587,29, sin interés de las cuotas que faltan) y el cierre: debe 0,00, chip "Cubierto" (sin scoping — vive en la MISMA fila del título, la trampa que dejó este flow), "Cubriste 12 de 12" al 100%, "No queda ninguna cuota por pagar" y el cronograma con la 1 PAGADA y las 11 CUBIERTAS; la sección de deudas vuelve al seed (468.587,29) | ✅ Pasa (4m 4s) |
| `22-prestamo-a-cobrar.yaml` | La dirección "presté" (`OWED_TO_ME`, el espejo del LOAN): la dirección se elige ANTES de cargar ("¿De qué cuenta salió?"), el paso 2 del desembolso se **posterga a propósito** ("Ahora no") y se recorre el CAMINO DE RECUPERACIÓN — el aviso de que "te deben" miente, el desembolso desde la PROPIA tarjeta con el monto del contrato (100.000,00: el principal, no la deuda viva que recién creado vale 0 — el bug del card-disburse de esta ronda), "te deben" 0,00 → 100.000,00, la cuota vencida del RECEIVABLE que NO entra en "Compromisos próximos" ("Sin cuotas vencidas"), el cobro de la cuota 1 con split exacto (interés 5.000,00 + capital 14.701,75) y el progreso final: te deben 85.298,25 · "Cobraste 1 de 6" | ✅ Pasa (3m 32s) |

**Suite completa (00–15 + 02d + 18 + 19 + 20 + 21 + 22): 24 flows.** La última
corrida ENTERA —**24/24 · Suite OK en 53m 55s**— corrió el 2026-10-19 sobre el
build de la ronda de carga rápida (dir `~/.maestro/tests/2026-10-19_011717`),
con el seed del smoke (599 ok · 0 fallas), e incluye el `21` y el `22` de la
ronda de préstamos. El orden es el de la carpeta:
`00, 01, 02, 02b, 02c, 02d, 03…15, 18, 19, 20, 21, 22`. Los flujos 16 y 17 de la
ronda anterior ya no existen como tales: su contenido vive en `02b` y `02c`
(renombrados para correr pegados al 02, el único momento en que el estado es el
del seed; el 02c además ganó el escape del 409 recorrido de verdad). El 18, el
19 y el 20 son nuevos: el modal de cuotas roto a propósito, el pago del resumen
sobre saldo a favor, y la tarjeta desde cero con cuotas retroactivas. El `21` y
el `22` son los nuevos de la ronda de préstamos: el alta guiada con desembolso
explícito, el pago y la cancelación anticipada, y el camino de recuperación del
desembolso postergado con el cobro. El `02d` es el nuevo de la ronda de carga
rápida (Fase 7): el gasto SIN categoría, el chip Hoy, el toast de deshacer y el
aviso de duplicado — flujo neto cero.

**Límites de calendario** (lo que primero vence primero): el `20` vale hasta el
10/11/2026 — cuando cierre el período de noviembre, su cierre #2 emitiría DOS
resúmenes (las cuotas 1 y 2) y el flash diría "2 resúmenes nuevos" —; el `02b`
y el `14` valen hasta el 16/11/2026; el `02d` vale hasta el 31/10/2026 (carga un
gasto fechado HOY contra los totales de octubre, el mes sembrado). El `21` y el `22` no tienen límite
propio: computan su fecha en el momento (día 20 del mes anterior), así que la
cuota 1 está vencida y la cuota 2 cae en el mes en curso cualquier día del año.

Los tiempos no son decorativos: cuando había servidores MCP vivos peleando por
`~/.maestro/sessions` (trampa 11), el flow 00 tardaba **5m51s en fallar** y los
demás corrían entre 10 y 18 segundos más lentos cada uno. Un flow que tarda el
doble de lo normal es un síntoma, no una casualidad.
