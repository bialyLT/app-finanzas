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
# El paso 1 olvidado es el peor, porque los flows 03 y 04 AGREGAN movimientos.
# Sin reset, la segunda corrida arranca con los movimientos de la primera y los
# totales no dan. El fallo aparece en una aserción de un número, lejos de la
# causa, y se pierden veinte minutos buscando un bug que no existe.
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
    [switch]$NoSeed
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$Base = if ($env:FINANZAS_BASE) { $env:FINANZAS_BASE } else { "http://127.0.0.1:3000" }

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
