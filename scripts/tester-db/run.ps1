# Batería del tester de base de datos — Fases 4.2 y 4.3
#
# Levanta la app contra `finanzas_test`, corre todas las baterías y baja el
# server. No toca `finanzas_dev` ni Neon: el DSN sale de `DATABASE_URL_TEST` y
# cada script lo verifica antes de abrir una conexión.
#
#     powershell -ExecutionPolicy Bypass -File scripts/tester-db/run.ps1
#
# Requisitos:
#   · PostgreSQL local en :5433 con `finanzas_test` migrada
#     (`npm run db:local:start` + `npm run db:test:setup`).
#   · Un build fresco (`.next/BUILD_ID` más nuevo que `lib/` y `app/`).
#     Si no lo está, el script ABORTA: correr una batería contra código viejo
#     daría un verde que no existe (lección D15).
#   · `APP_PASSWORD` en `.env` para autenticar contra la app.

param(
  [int]$Port = 3101,
  [string]$Only = ""
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repo

function Read-DotEnvValue([string]$name) {
  if (-not (Test-Path ".env")) { return $null }
  $line = Get-Content ".env" | Where-Object { $_ -match "^\s*$([regex]::Escape($name))\s*=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line -replace "^\s*$([regex]::Escape($name))\s*=\s*", "").Trim().Trim('"').Trim("'")
}

# El DSN se toma EXPLÍCITO de DATABASE_URL_TEST (entorno o .env). Nunca se
# deduce con un regex sobre DATABASE_URL (lección D17).
$testUrl = $env:DATABASE_URL_TEST
if (-not $testUrl) { $testUrl = Read-DotEnvValue "DATABASE_URL_TEST" }
if (-not $testUrl) { Write-Host "  Falta DATABASE_URL_TEST." -ForegroundColor Red; exit 2 }

if ($testUrl -notmatch "/finanzas_test(\?|$)") {
  Write-Host "  DATABASE_URL_TEST no apunta a /finanzas_test. Abortado." -ForegroundColor Red
  exit 2
}
if ($testUrl -match "neon\.tech|\.aws\.|\.azure\.|supabase\.co|render\.com|railway\.app|planetscale|finanzas_dev") {
  Write-Host "  DATABASE_URL_TEST apunta a una base prohibida. Abortado." -ForegroundColor Red
  exit 2
}

# ── El build tiene que ser más nuevo que el código ───────────────────────────
$buildId = Join-Path $repo ".next\BUILD_ID"
if (-not (Test-Path $buildId)) {
  Write-Host "  No hay build en .next. Corré 'npm run build' primero." -ForegroundColor Red
  exit 2
}
$buildTime = (Get-Item $buildId).LastWriteTime
$newest = Get-ChildItem lib, app -Recurse -File -Include *.ts, *.tsx |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($newest -and $newest.LastWriteTime -gt $buildTime) {
  Write-Host "  El build es más viejo que $($newest.FullName)." -ForegroundColor Red
  Write-Host "  Corré 'npm run build' (con el server de :3000 parado) y volvé a intentarlo." -ForegroundColor Yellow
  exit 2
}

$baseUrl = "http://127.0.0.1:$Port"
$env:DATABASE_URL = $testUrl
$env:APP_URL = $baseUrl
$env:TESTER_BASE_URL = $baseUrl

Write-Host ""
Write-Host "Base : $($testUrl -replace '://[^@]*@', '://***@')" -ForegroundColor Cyan
Write-Host "App  : $baseUrl" -ForegroundColor Cyan
Write-Host ""

# ── Limpieza previa (si quedó algo de una corrida interrumpida) ──────────────
node scripts/tester-db/00-limpieza.mjs
if ($LASTEXITCODE -ne 0) { Write-Host "  La limpieza previa falló. Abortado." -ForegroundColor Red; exit 2 }

$serverOut = Join-Path $env:TEMP "tester-db-f43-server.out.log"
$serverErr = Join-Path $env:TEMP "tester-db-f43-server.err.log"
$server = Start-Process -FilePath "node" `
  -ArgumentList @("node_modules\next\dist\bin\next", "start", "-p", "$Port") `
  -WorkingDirectory $repo -PassThru -NoNewWindow `
  -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr

$ready = $false
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Milliseconds 500
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { $ready = $true; break }
}
if (-not $ready) {
  Write-Host "  La app no levantó en :$Port." -ForegroundColor Red
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  exit 2
}
Write-Host "  app lista en :$Port" -ForegroundColor Green

$batteries = @(
  "01-transferencias-moneda.mjs",
  "02-invariantes-base.mjs",
  "03-concurrencia.mjs",
  "04-endpoints-borde.mjs",
  "05-deudas-cross-currency.mjs",
  "06-plata-declarada.mjs",
  "07-volumen-explain.mjs",
  "08-escritura-monedas.mjs",
  "09-concurrencia-escritura.mjs"
)
if ($Only) { $batteries = $batteries | Where-Object { $_ -like "*$Only*" } }

$failed = @()
try {
  foreach ($battery in $batteries) {
    Write-Host ""
    Write-Host "════ $battery ════" -ForegroundColor Cyan
    node "scripts/tester-db/$battery"
    if ($LASTEXITCODE -ne 0) { $failed += $battery }
  }
} finally {
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  Write-Host ""
  Write-Host "── Limpieza final ──" -ForegroundColor Cyan
  node scripts/tester-db/00-limpieza.mjs
}

Write-Host ""
if ($failed.Count -gt 0) {
  Write-Host "FALLARON: $($failed -join ', ')" -ForegroundColor Red
  exit 1
}
Write-Host "Todas las baterías en verde." -ForegroundColor Green
exit 0

