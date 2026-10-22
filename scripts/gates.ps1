# ═════════════════════════════════════════════════════════════════════════════
# GATES QUE NO TOCAN LOS DATOS DE LA PERSONA
# ═════════════════════════════════════════════════════════════════════════════
#
#   powershell -ExecutionPolicy Bypass -File scripts/gates.ps1
#   npm run gates
#
# ─────────────────────────────────────────────────────────────────────────────
# EL PROBLEMA QUE ESTE SCRIPT RESUELVE
#
# `finanzas_dev` (la base del server en :3000) TIENE DATOS REALES: la cuenta
# "Efectivo" con su saldo inicial, las categorías, la regla de recurrencia y los
# movimientos de la persona. Y los gates SIEMBRAN:
#
#   · `node scripts/smoke.mjs --reset` borra movimientos, reglas, categorías y
#     cuentas antes de sembrar el escenario;
#   · los flows de Maestro AGREGAN movimientos.
#
# O sea: correr los gates contra el server de :3000 borra los datos de la
# persona. Este script levanta una SEGUNDA instancia de la app (en :3101)
# apuntando a `finanzas_test` y corre TODO contra ahí. `finanzas_dev` y el
# server de :3000 no se tocan: no se siembran, no se limpian y no se bajan.
#
# ─────────────────────────────────────────────────────────────────────────────
# EL ORDEN DE LAS COSAS
#
#   0. Se leen las DOS bases de `.env` y se comprueba que no sean la misma.
#   1. Se comprueba que el BUILD exista y no esté viejo (si está viejo, los
#      gates correrían contra el código anterior: peor que no correrlos).
#   2. Se aplican las migraciones a `finanzas_test` (Prisma, no a mano).
#   3. Se levanta la segunda instancia en :3101, apuntando a `finanzas_test`.
#   4. Corre el SMOKE contra :3101 (siembra y verifica la base de tests).
#   5. Corren los FLOWS contra :3101.
#   6. Se baja la segunda instancia SIEMPRE (incluso si algo falló).
#   7. Se imprime el estado de `finanzas_dev` ANTES y DESPUÉS: la prueba de que
#      los datos de la persona quedaron intactos.
#
# ─────────────────────────────────────────────────────────────────────────────
# LO QUE NO HACE
#
#   · No compila: `npm run build` necesita el server de :3000 parado (en
#     Windows, `next build` falla con EPERM si el server tiene los archivos de
#     `.next` abiertos). El script avisa si el build está viejo y sigue.
#   · No crea bases a mano: si `finanzas_test` no existe, lo dice y que lo
#     cree Prisma (`prisma migrate deploy`).
#   · No toca `finanzas_dev`: ni una escritura, ni un `deleteMany`.

[CmdletBinding()]
param(
    # Puerto de la segunda instancia.
    [int]$Port = 3101,

    # Correr sólo el smoke (para iterar rápido). Los flows son largos.
    [switch]$SkipFlows
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# La salida de este script tiene acentos y líneas de caja: sin esto, la
# consola los muestra como signos de pregunta (la página de códigos no es
# UTF-8) y el reporte queda ilegible.
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
    # Si la consola no lo permite, se sigue: es cosmetics, no lógica.
}

$logDir = Join-Path $env:TEMP "opencode"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$serverLog = Join-Path $logDir "gates-server-$Port.log"

$serverProcess = $null
$exitCode = 0

# ─────────────────────────────────────────────────────────────────────────────
# Utilidades
# ─────────────────────────────────────────────────────────────────────────────

function Read-DotEnvValue($name) {
    if (-not (Test-Path ".env")) { return $null }
    $line = Get-Content ".env" |
        Where-Object { $_ -match "^\s*$name\s*=" } |
        Select-Object -First 1
    if (-not $line) { return $null }
    $value = ($line -split "=", 2)[1].Trim()
    return $value.Trim('"').Trim("'")
}

function Get-DatabaseName($url) {
    try {
        $path = ([uri]$url).AbsolutePath.Trim("/")
        if ($path) { return $path }
    } catch {
        # Una URL que no se puede parsear no sirve para el reporte: se muestra
        # el final, que es lo que identifica la base de todos modos.
    }
    return (($url -split "/")[-1] -split "\?")[0]
}

function Wait-ForServer($base, $seconds = 300) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            # ─────────────────────────────────────────────────────────────────
            # POR QUÉ 30 SEGUNDOS Y NO 5, Y POR QUÉ 5 MINUTOS DE VENTANA
            # ─────────────────────────────────────────────────────────────────
            # El PRIMER request a una instancia recién arrancada es lentísimo
            # en esta máquina: medido, 23,1 segundos (la app acaba de compilar
            # y el disco está paginando). Con un timeout de 5 segundos el gate
            # se rendía siempre: el servidor ya estaba listening ("Ready in
            # 27.0s") y el gate igual decía "La instancia de pruebas no
            # respondió en 90 s", sin una sola línea de error en el log.
            #
            # Y la VENTANA también: con la RAM justa (0,3-0,5 GB libres) el
            # servidor tarda hasta 61 segundos en levantar ("Ready in 61s") y
            # el primer request, otros 23. Con 90 segundos de ventana no
            # alcanzaba ni a empezar.
            #
            # El dato está en el mismo manual de las trampas: la primera
            # navegación tarda entre 90 y 400 segundos con la RAM justa. Un
            # timeout de 5 segundos no mide eso: mide el arranque.
            # ─────────────────────────────────────────────────────────────────
            $response = Invoke-WebRequest -Uri "$base/login" -UseBasicParsing -TimeoutSec 30
            if ($response.StatusCode -eq 200) { return $true }
        } catch {
            # Todavía no está: se sigue esperando.
        }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Stop-Server($process, $base) {
    if (-not $process) { return }
    Write-Host ""
    Write-Host "Bajando la instancia de pruebas ($base)" -ForegroundColor Cyan
    # `taskkill /T` baja el árbol entero: `next start` levanta un proceso
    # hijo y el nodo principal no siempre se va solo.
    & taskkill /PID $process.Id /T /F 2>&1 | Out-Null
    Start-Sleep -Seconds 1
}

function Invoke-Native {
    <#
      Corre un comando nativo y devuelve su código de salida.

      ───────────────────────────────────────────────────────────────────────
      POR QUÉ ESTE ENVOLTORIO
      Un comando nativo que escribe en su ERROR STANDARD (Prisma escribe
      "Environment variables loaded from .env" ahí) genera un error record en
      PowerShell, y con `$ErrorActionPreference = "Stop"` eso ABORTA el script
      aunque el comando haya salido con 0. Acá el error standard se mezcla con
      la salida (se muestra, que es lo que interesa: el reporte) y el código de
      salida es lo que decide.
      ───────────────────────────────────────────────────────────────────────
    #>
    param([string]$File, [string[]]$Arguments)

    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $File @Arguments 2>&1 | ForEach-Object { Write-Host $_ }
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Get-NativeOutput {
    <#
      Corre un comando nativo y devuelve su SALIDA (sin mostrarla).
      Mismo motivo que `Invoke-Native`: el error standard no puede abortar el
      script.
    #>
    param([string]$File, [string[]]$Arguments)

    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        return (& $File @Arguments 2>&1 | Out-String)
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Copy-FlowsForTest {
    <#
      Copia los flows a una carpeta temporal con el BASE apuntando a la
      instancia de pruebas.

      ───────────────────────────────────────────────────────────────────────────
      POR QUÉ HAY QUE COPIARLOS Y NO SOBRESCRIBIRLOS
      Cada flow declara su propia variable:

          appId: ...
          url: http://127.0.0.1:3000
          env:
            BASE: "http://127.0.0.1:3000"

      Y el `env:` de un flow GANA contra el `--env` de la línea de comandos
      (verificado: con `--env BASE=http://127.0.0.1:3101` el flow siguió
      abriendo el :3000 y asserts los números de la base personal). O sea: para
      correr los flows contra otra instancia hay que cambiar el flow, no la
      variable de entorno.

      Acá se COPIAN a una carpeta temporal y se reescribe el puerto. Los flows
      del repo no se tocan (son zona compartida con el tester) y un flow que
      seguiría apuntando al :3000 después de reescribir (porque tiene el
      :3000 metido en otro lugar) se OMITE con un aviso, en vez de correr
      contra la instancia de la persona.
      ───────────────────────────────────────────────────────────────────────────
      POR QUÉ EL DIAGNÓSTICO VA APARTE
      El flow 00 verifica QUE SE PUEDA TESTEAR (no la aplicación). Es el
      primero que corre y por lo tanto el que paga el arranque en frío de
      Chrome contra una instancia recién arrancada: medido, esa primera
      navegación tarda entre 90 y 400 segundos según la RAM libre y se va al
      timeout (el síntoma de la trampa 5 de flows/README.md: la pantalla queda
      en about:blank). El segundo intento, con el navegador y la página ya en
      caché, mide lo que el flow quiere medir.

      Corriéndolo aparte, la suite no lo tiene de primero y no paga ese costo.
      ───────────────────────────────────────────────────────────────────────────
    #>
    param([string]$Origen, [string]$Destino, [int]$Puerto)

    if (Test-Path $Destino) { Remove-Item $Destino -Recurse -Force }
    $diagnostico = Join-Path $Destino "diagnostico"
    $suite = Join-Path $Destino "suite"
    New-Item -ItemType Directory -Path $diagnostico | Out-Null
    New-Item -ItemType Directory -Path $suite | Out-Null

    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $viejo = "http://127.0.0.1:3000"
    $nuevo = "http://127.0.0.1:$Puerto"
    $omitidos = @()

    foreach ($file in Get-ChildItem -Path $Origen -Filter *.yaml -File) {
        $texto = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
        $texto = $texto.Replace($viejo, $nuevo)

        # ─────────────────────────────────────────────────────────────────────
        # UN FLOW QUE APUNTA AL :3000 NO SE CORRE EN LOS GATES
        #
        # Si después de reescribir el puerto todavía queda un ":3000" en una
        # línea que NO es un comentario, el flow tiene el :3000 metido en otro
        # lugar (una URL escrita a mano, un `openLink` con la URL de la
        # instancia de la persona, `localhost:3000`...). Ese flow correría
        # contra la instancia de la persona: se OMITE y se avisa, porque la
        # alternativa (correrlo contra :3000) tocaría los datos reales.
        #
        # POR QUÉ ":3000" Y NO "127.0.0.1:3000"
        #
        # La reescritura sólo arranca con "http://127.0.0.1:3000". Un flow que
        # dice "http://localhost:3000" (o con la IP de la máquina) NO se
        # reescribe y, con el chequeo anterior, se copiaba y se CORRÍA contra
        # la instancia de la persona. El puerto es lo que identifica a la
        # instancia, no el nombre de host.
        #
        # Y POR QUÉ SE IGNORAN LOS COMENTARIOS
        #
        # El flow 01 documenta un comando de ejemplo con "localhost:3000" y no
        # lo ejecuta: sin esta excepción, ese flow se omitiría siempre y la
        # suite no podría correr nunca. Un comentario no abre ninguna
        # conexión.
        # ─────────────────────────────────────────────────────────────────────
        $sinComentarios = ($texto -split "`r?`n" | Where-Object { $_ -notmatch "^\s*#" }) -join "`n"
        if ($sinComentarios -match ":3000") {
            $omitidos += $file.Name
            continue
        }

        # El diagnóstico del driver es el que empieza por "00-": va a su propia
        # carpeta para poder correrlo con un reintento, aparte de la suite.
        $destinoFlow = if ($file.Name -like "00-*") { $diagnostico } else { $suite }
        [System.IO.File]::WriteAllText(
            (Join-Path $destinoFlow $file.Name), $texto, $utf8
        )
    }

    if ($omitidos.Count -gt 0) {
        Write-Host "  flows OMITIDOS (apuntan al :3000, la instancia de la persona):" -ForegroundColor Yellow
        $omitidos | ForEach-Object { Write-Host "    · $_" -ForegroundColor Yellow }
    }
    return @{
        Diagnostico = $diagnostico
        Suite       = $suite
        Omitidos    = $omitidos
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# 0 · LAS DOS BASES
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "══════════════════════════════════════════════════════════════" -ForegroundColor DarkGray
Write-Host " GATES CONTRA UNA INSTANCIA Y UNA BASE DE PRUEBAS AISLADAS" -ForegroundColor Cyan
Write-Host "══════════════════════════════════════════════════════════════" -ForegroundColor DarkGray

$devUrl = Read-DotEnvValue "DATABASE_URL"
$testUrl = Read-DotEnvValue "DATABASE_URL_TEST"

if (-not $devUrl) {
    Write-Host "Falta DATABASE_URL en .env" -ForegroundColor Red
    exit 1
}
if (-not $testUrl) {
    Write-Host "Falta DATABASE_URL_TEST en .env" -ForegroundColor Red
    Write-Host "Copiá .env.example a .env y completá la cadena de la base de tests." -ForegroundColor Yellow
    exit 1
}

$devDb = Get-DatabaseName $devUrl
$testDb = Get-DatabaseName $testUrl

# La contraseña de la app (la misma que lee `scripts/flows.ps1`): hace falta
# para correr el diagnóstico del driver por separado.
$Password = Read-DotEnvValue "APP_PASSWORD"
if (-not $Password) {
    Write-Host "Falta APP_PASSWORD en .env" -ForegroundColor Red
    exit 1
}

if ($devUrl -eq $testUrl) {
    Write-Host "DATABASE_URL y DATABASE_URL_TEST apuntan a la MISMA base." -ForegroundColor Red
    Write-Host "Los gates la vaciarían. Corregí .env antes de seguir." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Base de la persona  (:3000) : $devDb   ← NO se toca" -ForegroundColor Yellow
Write-Host "Base de pruebas     (:$Port) : $testDb   ← se siembra y se borra" -ForegroundColor Green

# El estado de la base de la persona, ANTES de que corra nada.
$devStateBefore = Get-NativeOutput -File "node" -Arguments @("scripts/db-state.mjs")

# ─────────────────────────────────────────────────────────────────────────────
# 1 · EL BUILD TIENE QUE ESTAR AL DÍA
# ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "1 · Build" -ForegroundColor Cyan

$buildId = Join-Path $repoRoot ".next\BUILD_ID"
if (-not (Test-Path $buildId)) {
    Write-Host "No hay build en .next." -ForegroundColor Red
    Write-Host "  Pará el server de :3000, corré `npm run build` y volvé a intentarlo." -ForegroundColor Yellow
    exit 1
}

$buildTime = (Get-Item $buildId).LastWriteTime
$newest = Get-ChildItem -Recurse -File -Path app, components, lib, prisma |
    Where-Object { $_.Extension -in @(".ts", ".tsx", ".mjs", ".css", ".prisma") } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if ($newest -and $newest.LastWriteTime -gt $buildTime) {
    Write-Host "El build está VIEJO: cambió $($newest.Name) después del build." -ForegroundColor Red
    Write-Host "  Los gates correrían contra el código anterior." -ForegroundColor Yellow
    Write-Host "  Pará el server de :3000, corré `npm run build` y volvé a intentarlo." -ForegroundColor Yellow
    exit 1
}
Write-Host "  build al día ($($buildTime.ToString('yyyy-MM-dd HH:mm')))" -ForegroundColor DarkGray

# ─────────────────────────────────────────────────────────────────────────────
# 2 · MIGRACIONES EN LA BASE DE PRUEBAS (las hace Prisma, no a mano)
# ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "2 · Migraciones en $testDb" -ForegroundColor Cyan
$migrateCode = Invoke-Native -File "node" -Arguments @("scripts/db-test-setup.mjs")
if ($migrateCode -ne 0) {
    Write-Host "Las migraciones no se pudieron aplicar." -ForegroundColor Red
    Write-Host "  Si la base no existe, creala (o que Prisma la cree) y volvé a intentarlo." -ForegroundColor Yellow
    exit 1
}

# ─────────────────────────────────────────────────────────────────────────────
# 3 · LA SEGUNDA INSTANCIA
# ─────────────────────────────────────────────────────────────────────────────
$testBase = "http://127.0.0.1:$Port"

Write-Host ""
Write-Host "3 · Instancia de pruebas en $testBase" -ForegroundColor Cyan

$enUso = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($enUso) {
    Write-Host "El puerto $Port ya está ocupado." -ForegroundColor Red
    # QUÉ lo ocupa: casi siempre es otra corrida de este mismo script (el
    # tester corriendo los gates en paralelo) o una instancia de pruebas que
    # quedó viva. Sin este dato, el mensaje no dice nada.
    foreach ($conexion in $enUso) {
        $proceso = Get-CimInstance Win32_Process -Filter "ProcessId=$($conexion.OwningProcess)" -ErrorAction SilentlyContinue
        if ($proceso) {
            Write-Host "  · PID $($proceso.ProcessId): $($proceso.CommandLine)" -ForegroundColor DarkGray
        }
    }
    Write-Host "  Bajá lo que lo ocupe (o usá otro puerto con -Port) y volvé a intentarlo." -ForegroundColor Yellow
    exit 1
}

# El entorno del proceso hijo: la base de pruebas y la URL pública que
# corresponde a ESE puerto (la cookie de sesión decide si va con `Secure`
# mirando APP_URL).
$env:DATABASE_URL = $testUrl
$env:APP_URL = $testBase

$serverProcess = Start-Process -FilePath "node" `
    -ArgumentList @("node_modules\next\dist\bin\next", "start", "-p", "$Port") `
    -WorkingDirectory $repoRoot `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput $serverLog `
    -RedirectStandardError "$serverLog.err"

if (-not (Wait-ForServer $testBase)) {
    Write-Host "La instancia de pruebas no respondió en 90 s." -ForegroundColor Red
    if (Test-Path $serverLog) { Get-Content $serverLog -Tail 30 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray } }
    if (Test-Path "$serverLog.err") { Get-Content "$serverLog.err" -Tail 30 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray } }
    Stop-Server $serverProcess $testBase
    exit 1
}
Write-Host "  respondiendo en $testBase (base: $testDb)" -ForegroundColor DarkGray

try {
    # ─────────────────────────────────────────────────────────────────────────
    # 4 · EL SMOKE
    # ─────────────────────────────────────────────────────────────────────────
    Write-Host ""
    Write-Host "4 · Smoke contra $testBase" -ForegroundColor Cyan
    $env:SMOKE_BASE_URL = $testBase
    $smokeCode = Invoke-Native -File "node" -Arguments @("scripts/smoke.mjs", "--reset")
    if ($smokeCode -ne 0) {
        Write-Host ""
        Write-Host "El smoke falló." -ForegroundColor Red
        $exitCode = 1
    } else {
        Write-Host "Smoke OK" -ForegroundColor Green
    }

    # ─────────────────────────────────────────────────────────────────────────
    # 5 · LOS FLOWS
    # ─────────────────────────────────────────────────────────────────────────
    if (-not $SkipFlows -and $exitCode -eq 0) {
        Write-Host ""
        Write-Host "5 · Flows de Maestro contra $testBase" -ForegroundColor Cyan
        $env:FINANZAS_BASE = $testBase

        # ─────────────────────────────────────────────────────────────────────
        # EL OBSTÁCULO DE `~/.maestro/sessions` (trampa documentada)
        #
        # Los servidores MCP de Maestro retienen el archivo de sesiones: con dos
        # vivos, la corrida del CLI se pasa cinco minutos peleando por el
        # archivo y falla en el PRIMER `openLink` (el síntoma: la pantalla queda
        # en about:blank y el flow se muere por timeout). Es el error que
        # `scripts/maestro.ps1` ya matea, pero con un filtro más ANCHO
        # (cualquier proceso java con "maestro" en la línea de comandos), porque
        # el servidor MCP que levanta el agente no siempre matchea el filtro
        # viejo.
        #
        # Se hace acá, antes de la corrida, y no se avisa: un aviso que dice
        # "esto va a fallar" es peor que sacar el obstáculo de en medio.
        # ─────────────────────────────────────────────────────────────────────
        $stray = Get-CimInstance Win32_Process -Filter "Name = 'java.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like "*maestro*" }
        if ($stray) {
            Write-Host "  matando $($stray.Count) servidor(es) MCP de Maestro (retienen ~/.maestro/sessions)" -ForegroundColor DarkGray
            $stray | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            Start-Sleep -Milliseconds 800
        }

        # ─────────────────────────────────────────────────────────────────────
        # LA RAM DE LA JVM DE MAESTRO (y por qué hay que bajarla acá)
        #
        # Esta máquina tiene 3,83 GB de RAM. Durante los gates hay DOS
        # servidores de Next (el de la persona en :3000 y el de pruebas en
        # :3101), la JVM de Maestro y Chrome: con el heap por defecto (384 MB)
        # no entra y Chrome muere al arrancar ("session not created:
        # DevToolsActivePort file doesn't exist"), que es la trampa 5 de
        # flows/README.md.
        #
        # La JVM de Maestro es un cliente HTTP que evalúa aserciones: 192 MB
        # alcanzan de sobra. Con poco RAM libre se le da menos; con RAM
        # sobrante, el default.
        # ─────────────────────────────────────────────────────────────────────
        $libreGb = [math]::Round(
            (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB, 2
        )
        $env:MAESTRO_JVM_HEAP = if ($libreGb -lt 1.2) { "192m" } else { "384m" }
        Write-Host "  RAM libre: $libreGb GB · heap de la JVM de Maestro: $env:MAESTRO_JVM_HEAP" -ForegroundColor DarkGray

        # ─────────────────────────────────────────────────────────────────────
        # CALENTAR LAS PÁGINAS ANTES DE LOS FLOWS
        #
        # La primera navegación de Chrome a una instancia recién arrancada paga
        # el arranque de Chrome (y, con la RAM justa, el paginado de disco):
        # medido, esa primera navegación tarda entre 150 y 200 segundos y el
        # `openLink` se va al timeout — el flow 00 (el diagnóstico del driver)
        # es el que la paga, porque es el primero.
        #
        # Con las rutas calentadas beforehand, la navegación de los flows es la
        # de verdad (la app responde en 91 ms con la base ya sembrada).
        # ─────────────────────────────────────────────────────────────────────
        Write-Host "  calentando las rutas de la instancia de pruebas…" -ForegroundColor DarkGray
        foreach ($ruta in @("/", "/login", "/analisis", "/prestamos", "/recurrencia", "/tarjetas")) {
            try {
                Invoke-WebRequest -Uri "$testBase$ruta" -UseBasicParsing -TimeoutSec 120 | Out-Null
            } catch {
                Write-Host "  ⚠ no se pudo calentar $ruta" -ForegroundColor Yellow
            }
        }

        # Los flows con el BASE de la instancia de pruebas (copia temporal: los
        # flows del repo declaran su propio `env: BASE` y ese gana contra el
        # `--env` de la línea de comandos).
        $flows = Copy-FlowsForTest `
            -Origen (Join-Path $repoRoot "flows") `
            -Destino (Join-Path $logDir "gates-flows") `
            -Puerto $Port
        if (-not $flows) {
            Write-Host "No se pudo preparar la copia de los flows. Abortado." -ForegroundColor Red
            $exitCode = 1
        } elseif ($flows.Omitidos.Count -gt 0) {
            # ─────────────────────────────────────────────────────────────────
            # ABORTE: UN FLOW APUNTA AL :3000 (LA INSTANCIA DE LA PERSONA)
            #
            # Ese flow NO se copia y NO se corre (correrlo tocaría los datos
            # reales de la persona: es el error que hizo que la primera
            # corrida del dev corriera 24 flows contra la base personal).
            #
            # Pero OMITIRLO NO ES SUFICIENTE: si el gate quedara verde, el
            # reporte diría "25 flows" sin que ese flow se haya corrido, y un
            # gate verde con un flow que falta es una mentira. Por eso la
            # corrida de flows ABORTA y el gate queda en rojo: la persona ve
            # el motivo y lo arregla.
            #
            # El abortar es del GATE, no de la seguridad: el flow peligroso no
            # se corre en ningún caso, y la comparación del estado de
            # `finanzas_dev` (el paso 7) se hace igual.
            # ─────────────────────────────────────────────────────────────────
            Write-Host ""
            Write-Host "ABORTE: hay flows que apuntan al :3000 (la instancia de la persona)." -ForegroundColor Red
            Write-Host "  No se van a correr: tocarían los datos reales." -ForegroundColor Red
            Write-Host "  Y el gate FALLA: el suite queda incompleto y un gate verde" -ForegroundColor Red
            Write-Host "  con un flow que no se corrió sería una mentira." -ForegroundColor Red
            $exitCode = 1
        } else {
            Write-Host "  copia de los flows en $($flows.Suite) (BASE: $testBase)" -ForegroundColor DarkGray

            # ─────────────────────────────────────────────────────────────────
            # EL DIAGNÓSTICO DEL DRIVER, APARTE Y CON UN REINTENTO
            #
            # El flow 00 no verifica la aplicación: verifica que se pueda
            # testear. Como es el primero, paga el arranque en frío de Chrome
            # contra una instancia recién arrancada, y con la RAM justa esa
            # navegación se va al timeout (trampa 5). Se lo corre solo y, si
            # falla, se reintenta una vez: el segundo intento, con el navegador
            # y la página ya en caché, mide lo que el flow quiere medir.
            #
            # Si los DOS intentos fallan, es un AVISO y no un fallo del gate:
            # los 24 flows que verifican la aplicación son los que mandan, y si
            # el driver estuviera roto, fallarían todos.
            # ─────────────────────────────────────────────────────────────────
            $diagnosticoCode = 1
            for ($intento = 1; $intento -le 2; $intento++) {
                Write-Host "  diagnóstico del driver (intento $intento de 2)" -ForegroundColor DarkGray
                $diagnosticoCode = Invoke-Native -File "powershell" -Arguments @(
                    "-ExecutionPolicy", "Bypass",
                    "-File", "scripts/maestro.ps1",
                    "test", $flows.Diagnostico,
                    "--env", "APP_PASSWORD=$Password"
                )
                if ($diagnosticoCode -eq 0) { break }
                if ($intento -eq 1) {
                    Write-Host "  el diagnóstico falló: se reintenta (arranque en frío de Chrome)" -ForegroundColor Yellow
                }
            }
            if ($diagnosticoCode -ne 0) {
                Write-Host "AVISO: el diagnóstico del driver falló en los dos intentos." -ForegroundColor Yellow
                Write-Host "  Suele ser la trampa 5 (RAM): con menos RAM libre, Chrome tarda demasiado en arrancar." -ForegroundColor Yellow
            }

            # `flows.ps1` siembra con el smoke: el `SMOKE_BASE_URL` de arriba hace
            # que esa siembra también vaya a la instancia de pruebas. Sin esto, los
            # flows vaciarían `finanzas_test` y sembrarían en :3000.
            $flowsCode = Invoke-Native -File "powershell" -Arguments @(
                "-ExecutionPolicy", "Bypass",
                "-File", "scripts/flows.ps1",
                "-Flow", $flows.Suite
            )
            if ($flowsCode -ne 0) {
                Write-Host ""
                Write-Host "Los flows fallaron." -ForegroundColor Red
                $exitCode = 1
            } else {
                Write-Host "Flows OK" -ForegroundColor Green
            }
        }
    } elseif ($SkipFlows) {
        Write-Host ""
        Write-Host "5 · Flows salteados (-SkipFlows)" -ForegroundColor DarkGray
    }
} finally {
    # ─────────────────────────────────────────────────────────────────────────
    # 6 · BAJAR LA INSTANCIA DE PRUEBAS (siempre)
    # ─────────────────────────────────────────────────────────────────────────
    Stop-Server $serverProcess $testBase

    # El entorno del script: se restaura lo que se cambió, por si alguien lo
    # corre dentro de su propia sesión.
    $env:DATABASE_URL = $devUrl
    $env:APP_URL = "http://127.0.0.1:3000"
    Remove-Item Env:\SMOKE_BASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:\FINANZAS_BASE -ErrorAction SilentlyContinue
}

# ─────────────────────────────────────────────────────────────────────────────
# 7 · LA PRUEBA: ¿QUEDÓ INTACTA LA BASE DE LA PERSONA?
# ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "══════════════════════════════════════════════════════════════" -ForegroundColor DarkGray
Write-Host " LA BASE DE LA PERSONA, ANTES Y DESPUÉS" -ForegroundColor Cyan
Write-Host "══════════════════════════════════════════════════════════════" -ForegroundColor DarkGray

$devStateAfter = Get-NativeOutput -File "node" -Arguments @("scripts/db-state.mjs")

Write-Host "── ANTES ──────────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host $devStateBefore.TrimEnd()
Write-Host ""
Write-Host "── DESPUÉS ───────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host $devStateAfter.TrimEnd()

$igual = ($devStateBefore.Trim() -eq $devStateAfter.Trim())
Write-Host ""
if ($igual) {
    Write-Host "✓ finanzas_dev quedó INTACTA: mismo estado antes y después de los gates." -ForegroundColor Green
} else {
    Write-Host "✗ finanzas_dev CAMBIÓ durante los gates. Eso no puede pasar." -ForegroundColor Red
    $exitCode = 1
}

Write-Host ""
Write-Host "Base de la persona  (:3000) : $devDb   ← sin tocar" -ForegroundColor Yellow
Write-Host "Base de pruebas     (:$Port) : $testDb   ← sembrada y verificada" -ForegroundColor Green

if ($exitCode -eq 0) {
    Write-Host ""
    Write-Host "GATES OK" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "GATES CON FALLAS" -ForegroundColor Red
}
exit $exitCode
