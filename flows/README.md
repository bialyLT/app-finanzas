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

Los flows 03, 04, 08, 09 y 10 **sí** agregan movimientos, así que correrlos
dos veces sin resetear hace que los totales no coincidan. De ahí el `--reset`.
Y por eso los flows **08, 09 y 10 van al final, en ese orden**: parten de la
suma que dejan los anteriores (el “en rojo”, los montos extremos y el saldo a
favor no tienen lugar en el mes limpio del seed).

El wrapper `scripts/maestro.ps1` se encarga de `JAVA_HOME`, de desactivar los
analytics anónimos de Maestro y de ponerle un techo de memoria a la JVM (ver
trampa 5). Sin él hay que configurar las tres cosas a mano.

También podés ver las corridas en vivo en el **Maestro Viewer**:
→ <http://127.0.0.1:9999/>

---

## Las doce trampas

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

**Comillas simples en YAML.** En comillas dobles la barra invertida activa
secuencias de escape, y `"\."` no es una secuencia válida: YAML da error antes de
que Maestro llegue a ver el texto.

Y no hace falta pelear con el espacio duro: `Intl.NumberFormat("es-AR")` separa el
símbolo del número con **U+00A0**, no con un espacio común. Los `.*` de los
costados lo cubren sin nombrarlo.

El flow `00-diagnostico.yaml` es la sonda que verifica esto: si algún día esa
sonda falla, el comportamiento cambió y hay que sacar los comodines de todos los
flows.

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

---

## Convenciones

- **Textos sin emoji en las aserciones.** El emoji se renderiza distinto según la
  plataforma y la aserción termina fallando por el ícono y no por el
  comportamiento que querés verificar.
- **Seleccioná por `id` cuando puedas.** El input de contraseña se toma con
  `tapOn: { id: "password" }` en vez de por texto: el texto puede cambiar, el `id`
  no.
- **Cada flow corre con estado de navegador limpio al inicio del run.** Si un flow
  depende de estar logueado, hacé el login dentro del flow.
- **Los flows son documentación viva.** Si encontrás un bug, escribí el flow que
  lo reproduce ANTES de arreglarlo. Después queda como test de regresión.

## Estado de los flows

| Flow | Qué verifica | Estado |
|---|---|---|
| `00-diagnostico.yaml` | **No verifica la app: verifica que se pueda testear.** Que Chrome arranque, que navegue, que React hidrate, y de paso sondea cómo matchea Maestro | ✅ Pasa (39s) |
| `01-acceso.yaml` | Que la app esté cerrada sin sesión, que rechace contraseña incorrecta, que acepte la correcta y que el login deje de estar accesible | ✅ Pasa (30s) |
| `02-panel.yaml` | Los números del mes (ingresos 800.000 · gastos 490.000 · quedó 310.000 · ahorro 38,75% · patrimonio 410.000), la **tarjeta "Flujo de caja"** con sus tres caras (octubre +328.587,29 conviviendo con "Te quedó" +310.000; septiembre +500.000 sin ser ingreso; agosto $ 0,00 con "Sin transferencias"), los saldos por cuenta, y que el desembolso del préstamo no aparezca como ingreso | ✅ Pasa (1m 42s) |
| `03-cargar-gasto.yaml` | Cargar un gasto desde el formulario y que los cinco totales se muevan exacto | ✅ Pasa (46s) |
| `04-transferencia.yaml` | Transferir 50.000 entre cuentas propias y que **nada de lo que mide el mes cambie** | ✅ Pasa (52s) |
| `05-analisis.yaml` | El desglose por categoría, que el interés aparezca y el capital no, y que las transferencias estén aparte | ✅ Pasa (41s) |
| `06-analisis-filtros.yaml` | Los filtros server-side de `/analisis`: categoría y texto achican los tres bloques con números exactos, el selector no se auto-filtra, el estado vacío habla de los filtros y "Limpiar ✕" vuelve a todo | ✅ Pasa (2m 33s) |
| `07-analisis-periodos.yaml` | Semana / Mes / Año, la ida y vuelta entre meses con los MISMOS números, los meses vacíos y que el cartel viejo de truncado no exista en ningún estado | ✅ Pasa (1m 18s) |
| `08-panel-mes-en-rojo.yaml` | Un mes que no cierra en positivo: un gasto de 400.000 deja gastos 900.000, "Te quedó" −100.000,00 y flujo −81.412,71 — dos negativos DISTINTOS, cada uno con su signo; la tasa −12,50%; las transferencias no cambian | ✅ Pasa (48s) |
| `09-montos-extremos.yaml` | La aritmética exacta al centavo: un gasto de $ 0,01 (punto decimal) mueve los tres números en 0,01; uno de 9.999.999,99 (formato argentino completo) los lleva a 10.900.000,00 · −10.100.000,00 · −10.081.412,71 y la tasa a −1.262,50% | ✅ Pasa (1m 8s) |
| `10-pago-de-mas.yaml` | Pagar la tarjeta de MÁS: la Visa pasa a "a favor $ 50.000,00" (con el código viejo decía "debe -$ 50.000,00"), el banco queda −9.631.412,71 y el flujo −10.181.412,71 con 3 transferencias; gastos y "Te quedó" intactos | ✅ Pasa (56s) |

**Suite completa: 11/11 en 12m 29s.** Los tiempos no son decorativos: cuando había
servidores MCP vivos peleando por `~/.maestro/sessions` (trampa 11), el flow 00
tardaba **5m51s en fallar** y los demás corrían entre 10 y 18 segundos más
lentos cada uno. Un flow que tarda el doble de lo normal es un síntoma, no una
casualidad.
