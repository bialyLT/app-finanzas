# ─────────────────────────────────────────────────────────────────────────────
# Wrapper de Maestro para usar desde la CLI (y desde subagentes por shell).
#
# Uso:
#   powershell -File scripts/maestro.ps1 test flows/login.yaml
#   powershell -File scripts/maestro.ps1 --version
#
# ─────────────────────────────────────────────────────────────────────────────
# POR QUÉ EXISTE
# ─────────────────────────────────────────────────────────────────────────────
# 1. Maestro necesita `JAVA_HOME`. Este script lo fija para que no dependas de
#    configurar variables de entorno del sistema.
#
# 2. Maestro trae ANALYTICS ANÓNIMOS ACTIVADOS POR DEFECTO: al arrancar, envía
#    datos de uso a sus servidores. Este wrapper lo desactiva con
#    `MAESTRO_CLI_NO_ANALYTICS=1`, así el testing queda 100% local.
#
# 3. El banner de "novedades" contamina stdout. Se desactiva también, porque
#    un subagente que parsea la salida se confunde con el ASCII art.
#
# 4. En vez de `maestro.bat` se invoca Java DIRECTAMENTE. El .bat agrega una
#    capa de cmd.exe en el medio que rompe el stdio de MCP y complica el
#    parseo de la salida.
#
# Sin este script, cada invocación depende de que el PATH y JAVA_HOME estén
# bien en la máquina, y de acordarse de desactivar los analytics.
# ─────────────────────────────────────────────────────────────────────────────

[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$MaestroArgs
)

$ErrorActionPreference = "Stop"

$JavaHome    = if ($env:MAESTRO_JAVA_HOME) { $env:MAESTRO_JAVA_HOME } else { Join-Path $env:LOCALAPPDATA "jdk21\jdk-21.0.12.1+1" }
$MaestroHome = if ($env:MAESTRO_HOME) { $env:MAESTRO_HOME } else { Join-Path $env:LOCALAPPDATA "maestro\maestro" }

$JavaExe = Join-Path $JavaHome "bin\java.exe"

if (-not (Test-Path $JavaExe)) {
    Write-Error "No se encontró Java en '$JavaExe'.`nInstalá un JDK 17+ o definí MAESTRO_JAVA_HOME."
    exit 1
}

if (-not (Test-Path (Join-Path $MaestroHome "lib"))) {
    Write-Error "No se encontró la librería de Maestro en '$MaestroHome\lib'.`nDefiní MAESTRO_HOME."
    exit 1
}

# Todo local: sin analytics, sin banner de novedades.
$env:JAVA_HOME = $JavaHome
$env:MAESTRO_CLI_NO_ANALYTICS = "1"
$env:MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED = "true"

# ─────────────────────────────────────────────────────────────────────────────
# SERVIDORES MCP DE MAESTRO HUÉRFANOS: SE MATAN ANTES DE ARRANCAR
# ─────────────────────────────────────────────────────────────────────────────
# El servidor MCP de Maestro (`maestro.cli.AppKt mcp`) y una corrida por CLI
# comparten el mismo almacén de sesiones: `~/.maestro/sessions`. Cada proceso le
# escribe un heartbeat cada 5 segundos y, en Windows, ese archivo se BLOQUEA
# mientras se escribe.
#
# Con dos servidores MCP vivos —cosa que pasa sola, porque un agente levanta uno
# por sesión y no siempre los baja— la corrida del CLI se pasa cinco minutos
# peleando por el archivo y termina fallando en el PRIMER `openLink`:
#
#     [ERROR] Failed to record heartbeat
#     java.io.IOException: El proceso no tiene acceso al archivo porque otro
#                          proceso tiene bloqueada una parte del archivo
#     [ INFO] Open ${BASE} FAILED
#
# El error que ve el usuario es "no pudo abrir la URL", así que uno se pone a
# mirar Chrome, el servidor y el proxy — los tres están perfectos. Y el flujo
# tarda 6 minutos en fallar en vez de 1 en pasar, así que además parece otra cosa.
#
# Se matan acá, y no se avisa para seguir, porque un aviso que dice "esto va a
# fallar" es peor que sacar el obstáculo de en medio.
$strayMcp = Get-CimInstance Win32_Process -Filter "Name = 'java.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*maestro.cli.AppKt mcp*" }

if ($strayMcp) {
    Write-Host "Cerrando $($strayMcp.Count) servidor(es) MCP de Maestro: retienen ~/.maestro/sessions" -ForegroundColor Yellow
    $strayMcp | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 800
}

# ─────────────────────────────────────────────────────────────────────────────
# TECHO DE MEMORIA PARA LA JVM
# ─────────────────────────────────────────────────────────────────────────────
# Por defecto la JVM reserva como máximo 1/4 de la RAM física. En una máquina de
# 4 GB eso son ~960 MB de heap que Maestro no necesita ni de lejos (es un
# cliente HTTP que corre aserciones), y que pide JUSTO en el momento en que
# Chrome está arrancando y compitiendo por la misma memoria.
#
# El síntoma cuando no alcanza es engañoso: Chrome muere al iniciar y Maestro
# reporta `session not created: DevToolsActivePort file doesn't exist`, que
# suena a un problema de Chrome o del driver. No lo es — es que no había RAM.
#
# Con el techo, Maestro ocupa una fracción y le deja el resto a Chrome. Se puede
# subir si hiciera falta:
#
#     $env:MAESTRO_JVM_HEAP = "768m"; powershell -File scripts/maestro.ps1 test ...
$JvmHeap = if ($env:MAESTRO_JVM_HEAP) { $env:MAESTRO_JVM_HEAP } else { "384m" }

if (-not $MaestroArgs -or $MaestroArgs.Count -eq 0) {
    Write-Host "Wrapper de Maestro. Ejemplos:" -ForegroundColor Cyan
    Write-Host "  powershell -File scripts/maestro.ps1 --version"
    Write-Host "  powershell -File scripts/maestro.ps1 test flows/login.yaml"
    Write-Host ""
    Write-Host "Requiere el servidor corriendo en http://127.0.0.1:3000" -ForegroundColor DarkGray
    Write-Host "  Produccion (recomendado para tests): npm run build  +  npm start" -ForegroundColor DarkGray
    Write-Host "  Desarrollo:                          npm run dev" -ForegroundColor DarkGray
    exit 1
}

# Replica exacta de lo que hace maestro.bat por dentro (ver línea 93 del .bat):
#   java --enable-native-access=ALL-UNNAMED -classpath <home>\lib\* maestro.cli.AppKt <args>
& $JavaExe "--enable-native-access=ALL-UNNAMED" `
    "-Xmx$JvmHeap" `
    "-classpath" "$MaestroHome\lib\*" `
    "maestro.cli.AppKt" `
    @MaestroArgs

exit $LASTEXITCODE
