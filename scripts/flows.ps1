# ═════════════════════════════════════════════════════════════════════════════
# Suite completa de flows de interfaz
# ═════════════════════════════════════════════════════════════════════════════
#
#   powershell -File scripts/flows.ps1
#   powershell -File scripts/flows.ps1 -Flow flows/04-transferencia.yaml
#   powershell -File scripts/flows.ps1 -Password "mi-password"
#
# ─────────────────────────────────────────────────────────────────────────────
# POR QUÉ EXISTE
# ─────────────────────────────────────────────────────────────────────────────
# Correr la suite a mano son tres pasos y dos de ellos se pueden olvidar:
#
#   1. Sembrar la base con `node scripts/smoke.mjs --reset`
#   2. Correr Maestro con la contraseña en `--env`
#   3. Acordarse del ORDEN
#
# El paso 1 olvidado es el peor, porque los flows 03, 04, 08, 09 y 10 AGREGAN
# movimientos. Sin reset, la segunda corrida arranca con los movimientos de la
# primera y los totales no dan. El fallo aparece en una aserción de un número,
# lejos de la causa, y se pierden veinte minutos buscando un bug que no existe.
#
# Este script hace los tres pasos en orden, siempre.
#
# ─────────────────────────────────────────────────────────────────────────────
# REQUISITO: EL SERVIDOR TIENE QUE ESTAR CORRIENDO
# ─────────────────────────────────────────────────────────────────────────────
# No lo arranca él: elegir entre `npm run dev` y `npm start` es una decisión con
# consecuencias (ver flows/README.md, trampa 5), y arrancar procesos desde un
# script de test deja procesos huérfanos cuando algo sale mal. Lo verifica y
# avisa.

[CmdletBinding()]
param(
    # Ruta del flow o de la carpeta. Por defecto, la carpeta completa.
    [string]$Flow = "flows",

    # Contraseña de la app. Si no se pasa, se lee APP_PASSWORD de .env.
    [string]$Password,

    # Saltarse el sembrado (para correr un flow de sólo lectura sobre datos que
    # ya están como querés).
    [switch]$NoSeed,

    # Correr los flows contra la instancia de la PERSONA (:3000). Por defecto
    # el script se NIEGA: los flows AGREGAN movimientos y la app de la persona
    # tiene datos reales. Para correrlos ahí hay que decirlo explícitamente.
    [switch]$AllowPersonalInstance
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$Base = if ($env:FINANZAS_BASE) { $env:FINANZAS_BASE } else { "http://127.0.0.1:3000" }

# ─────────────────────────────────────────────────────────────────────────────
# 0. LA INSTANCIA DE LA PERSONA: LOS FLOWS NO CORREN AHÍ SIN PERMISO
#
# Los flows de Maestro AGREGAN movimientos a la app contra la que corren. La
# instancia de la persona (:3000, `finanzas_dev`) tiene datos reales: correr
# los flows ahí ensucia la base de la persona (y el sembrado previo la
# vacía). Ya pasó: la primera corrida del dev hizo 24 flows contra la base
# personal.
#
# Por defecto, este script se NIEGA a correr contra el :3000 y dice cómo
# hacerlo bien (contra la instancia de pruebas, :3101, que levanta
# `scripts/gates.ps1` con su propia base).
#
# Para correrlos contra la instancia de la persona hay que PASARLE el permiso
# explícito: `-AllowPersonalInstance`.
# ─────────────────────────────────────────────────────────────────────────────
if (-not $AllowPersonalInstance) {
    $puerto = ""
    try { $puerto = ([uri]$Base).Port } catch { $puerto = "" }
    if ($puerto -eq "3000" -or $Base -match ":3000(/|$)") {
        Write-Host ""
        Write-Host "ABORTE: los flows NO se corren contra el :3000 (la instancia de la persona)." -ForegroundColor Red
        Write-Host "  Los flows agregan movimientos y esa base tiene datos reales." -ForegroundColor Red
        Write-Host "" -ForegroundColor DarkGray
        Write-Host "  Para correrlos contra la instancia de pruebas (la que se usa):" -ForegroundColor Yellow
        Write-Host "    powershell -ExecutionPolicy Bypass -File scripts/gates.ps1" -ForegroundColor Yellow
        Write-Host "    (levanta :3101 contra finanzas_test, corre el smoke y TODOS los flows)" -ForegroundColor DarkGray
        Write-Host "" -ForegroundColor DarkGray
        Write-Host "  Si de verdad los querés correr contra la instancia de la persona:" -ForegroundColor Yellow
        Write-Host "    powershell -ExecutionPolicy Bypass -File scripts/flows.ps1 -AllowPersonalInstance" -ForegroundColor Yellow
        exit 1
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# 1. El servidor tiene que estar arriba
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "Comprobando el servidor en $Base" -ForegroundColor Cyan
try {
    Invoke-WebRequest -Uri "$Base/login" -UseBasicParsing -TimeoutSec 30 | Out-Null
    Write-Host "  responde" -ForegroundColor DarkGray
} catch {
    Write-Host ""
    Write-Host "El servidor no responde en $Base." -ForegroundColor Red
    Write-Host "Arrancalo con:" -ForegroundColor Yellow
    Write-Host "  npm run build ; npm start     # produccion (recomendado)"
    Write-Host "  npm run dev                   # desarrollo"
    exit 1
}

# ─────────────────────────────────────────────────────────────────────────────
# 2. La contraseña
# ─────────────────────────────────────────────────────────────────────────────
# Se busca en .env sólo si no vino por parámetro. Si el proyecto usa
# APP_PASSWORD_HASH no hay forma de recuperar la contraseña desde acá — el hash
# es de un solo sentido, que es exactamente el punto — así que se pide a mano.
if (-not $Password) {
    if (Test-Path ".env") {
        $match = Select-String -Path ".env" -Pattern '^\s*APP_PASSWORD\s*=\s*"?([^"\r\n]*)"?' |
            Select-Object -First 1
        if ($match) { $Password = $match.Matches[0].Groups[1].Value }
    }
}

if (-not $Password) {
    Write-Host ""
    Write-Host "No encontre APP_PASSWORD en .env." -ForegroundColor Red
    Write-Host "Pasalá por parametro:" -ForegroundColor Yellow
    Write-Host "  powershell -File scripts/flows.ps1 -Password `"tu-password`""
    exit 1
}

# ─────────────────────────────────────────────────────────────────────────────
# 3. Sembrar
# ─────────────────────────────────────────────────────────────────────────────
if (-not $NoSeed) {
    Write-Host ""
    Write-Host "Sembrando el escenario" -ForegroundColor Cyan
    node scripts/smoke.mjs --reset
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "El sembrado fallo." -ForegroundColor Red
        Write-Host "Si hubo 'FALLA', la causa esta en la aplicacion o en la base, no en" -ForegroundColor Yellow
        Write-Host "los flows. Arreglá eso primero: un flow que corre sobre datos mal" -ForegroundColor Yellow
        Write-Host "sembrados falla por el motivo equivocado." -ForegroundColor Yellow
        exit 1
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# 4. Correr los flows
# ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Corriendo $Flow" -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "maestro.ps1") test $Flow "--env" "APP_PASSWORD=$Password"
$exit = $LASTEXITCODE

Write-Host ""
if ($exit -eq 0) {
    Write-Host "Suite OK" -ForegroundColor Green
} else {
    Write-Host "La suite fallo (codigo $exit)" -ForegroundColor Red
    Write-Host "El detalle queda en el visor: http://127.0.0.1:9999/" -ForegroundColor DarkGray
}
exit $exit
