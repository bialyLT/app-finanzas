# ─────────────────────────────────────────────────────────────────────────────
# Administrador del PostgreSQL local de desarrollo.
#
# Uso:
#   npm run db:local:start
#   npm run db:local:stop
#   npm run db:local:status
#   npm run db:local:reset     (BORRA todos los datos y vuelve a aplicar el esquema)
#
# ─────────────────────────────────────────────────────────────────────────────
# POR QUÉ EXISTE ESTE SCRIPT
# ─────────────────────────────────────────────────────────────────────────────
# En Windows, arrancar Postgres con `pg_ctl start` desde una terminal de PowerShell
# tiene un problema real: el proceso `postgres.exe` hereda los handles de consola
# de quien lo lanza. Cuando esa terminal se cierra (o el proceso que lo lanzó
# muere), los backends nuevos fallan al inicializar y el servidor se cae con:
#
#     server process was terminated by exception 0xC0000142
#
# `0xC0000142` es STATUS_DLL_INIT_FAILED: no es corrupción de datos, es el
# proceso quedándose sin handles válidos.
#
# Por eso acá se arranca con `Start-Process` y redirección EXPLÍCITA de stdout y
# stderr a archivos. Así el servidor no comparte la consola con nadie y sobrevive
# a que cierres la terminal.
#
# Nota: NO se usa un servicio de Windows ni se instala nada en el sistema. Todo
# vive en una carpeta de usuario y se puede borrar sin dejar rastro.
# ─────────────────────────────────────────────────────────────────────────────

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("start", "stop", "status", "reset")]
    [string]$Command = "status",

    [int]$Port = 5433,
    [string]$DbName = "finanzas_dev",
    [string]$TestDbName = "finanzas_test"
)

$ErrorActionPreference = "Stop"

# El binario y los datos viven fuera del repo: no son código fuente.
$PgRoot  = if ($env:PG_LOCAL_ROOT) { $env:PG_LOCAL_ROOT } else { Join-Path $env:LOCALAPPDATA "pg17" }
$PgBin   = Join-Path $PgRoot "pgsql\bin"
$DataDir = Join-Path $PgRoot "data"

function Assert-PostgresPresent {
    if (-not (Test-Path (Join-Path $PgBin "postgres.exe"))) {
        throw "No se encontró PostgreSQL en '$PgBin'.`nDefiní PG_LOCAL_ROOT o corré la instalación inicial (ver README)."
    }
}

function Test-ServerUp {
    try {
        & (Join-Path $PgBin "pg_isready.exe") -h localhost -p $Port -q 2>$null | Out-Null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Start-LocalServer {
    Assert-PostgresPresent

    if (Test-ServerUp) {
        Write-Host "El servidor ya está corriendo en el puerto $Port." -ForegroundColor Yellow
        return
    }

    # Un postmaster.pid viejo de un cierre sucio impide el arranque.
    $pidFile = Join-Path $DataDir "postmaster.pid"
    if (Test-Path $pidFile) {
        $alive = Get-Process -Name postgres -ErrorAction SilentlyContinue
        if (-not $alive) {
            Write-Host "Limpiando postmaster.pid huérfano…" -ForegroundColor DarkGray
            Remove-Item $pidFile -Force
        }
    }

    Write-Host "Arrancando PostgreSQL (puerto $Port)…" -ForegroundColor Cyan

    # Clave: Start-Process + redirección explícita => sin handles de consola
    # compartidos => el servidor sobrevive a esta terminal.
    Start-Process -FilePath (Join-Path $PgBin "postgres.exe") `
        -ArgumentList "-D", "`"$DataDir`"" `
        -RedirectStandardOutput (Join-Path $DataDir "stdout.log") `
        -RedirectStandardError (Join-Path $DataDir "stderr.log") `
        -WindowStyle Hidden | Out-Null

    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-ServerUp) {
            Write-Host "PostgreSQL listo en localhost:$Port" -ForegroundColor Green
            return
        }
    }

    Write-Host "El servidor no respondió. Últimas líneas del log:" -ForegroundColor Red
    Get-Content (Join-Path $DataDir "stderr.log") -Tail 15 -ErrorAction SilentlyContinue
    throw "No se pudo arrancar PostgreSQL."
}

function Stop-LocalServer {
    Assert-PostgresPresent

    if (-not (Test-ServerUp)) {
        Write-Host "El servidor no estaba corriendo." -ForegroundColor Yellow
        # Puede quedar un postmaster zombi que no acepta conexiones.
        $stuck = Get-Process -Name postgres -ErrorAction SilentlyContinue
        if ($stuck) {
            Write-Host "Matando $($stuck.Count) proceso(s) postgres atascado(s)…" -ForegroundColor DarkYellow
            $stuck | Stop-Process -Force
        }
        return
    }

    Write-Host "Deteniendo PostgreSQL…" -ForegroundColor Cyan
    # `-m fast` desconecta clientes y hace un shutdown limpio (no como -m immediate,
    # que obliga a recuperar desde WAL en el próximo arranque).
    & (Join-Path $PgBin "pg_ctl.exe") -D $DataDir -m fast stop 2>&1 | Out-Null

    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        if (-not (Test-ServerUp)) {
            Write-Host "PostgreSQL detenido." -ForegroundColor Green
            return
        }
    }
    Write-Host "Advertencia: el servidor sigue respondiendo." -ForegroundColor Red
}

function Show-Status {
    Assert-PostgresPresent

    $up = Test-ServerUp
    Write-Host ""
    Write-Host "  PostgreSQL local" -ForegroundColor White
    Write-Host "  ────────────────────────────────────────────"
    Write-Host "  Binarios : $PgBin"
    Write-Host "  Datos    : $DataDir"
    Write-Host "  Puerto   : $Port"
    if ($up) {
        Write-Host "  Estado   : CORRIENDO" -ForegroundColor Green
        $version = & (Join-Path $PgBin "psql.exe") -h localhost -p $Port -U postgres -t -A -c "select version();" 2>$null
        Write-Host "  Versión  : $version"
        Write-Host ""
        Write-Host "  Bases de datos:" -ForegroundColor White
        & (Join-Path $PgBin "psql.exe") -h localhost -p $Port -U postgres -t -A -c "select '    ' || datname from pg_database where datname like 'finanzas%' order by 1;" 2>$null
    } else {
        Write-Host "  Estado   : DETENIDO" -ForegroundColor Red
        Write-Host ""
        Write-Host "  Arrancalo con: npm run db:local:start" -ForegroundColor DarkGray
    }
    Write-Host ""
}

function Reset-Database {
    Assert-PostgresPresent

    if (-not (Test-ServerUp)) { Start-LocalServer }

    Write-Host ""
    Write-Host "Esto BORRA por completo '$DbName' y '$TestDbName' del servidor local." -ForegroundColor Red
    Write-Host "Es una base de DESARROLLO: los datos de producción (Neon) no se tocan." -ForegroundColor DarkGray
    Write-Host ""

    foreach ($db in @($DbName, $TestDbName)) {
        & (Join-Path $PgBin "dropdb.exe") -h localhost -p $Port -U postgres --if-exists $db 2>&1 | Out-Null
        & (Join-Path $PgBin "createdb.exe") -h localhost -p $Port -U postgres $db 2>&1 | Out-Null
        Write-Host "  Base '$db' recreada." -ForegroundColor Green
    }

    Write-Host ""
    Write-Host "Aplicando el esquema con prisma migrate…" -ForegroundColor Cyan
    npx prisma migrate deploy
    if ($LASTEXITCODE -ne 0) {
        Write-Host "prisma migrate deploy falló; probando prisma db push…" -ForegroundColor Yellow
        npx prisma db push
    }
    Write-Host ""
    Write-Host "Base local lista." -ForegroundColor Green
}

switch ($Command) {
    "start"  { Start-LocalServer }
    "stop"   { Stop-LocalServer }
    "status" { Show-Status }
    "reset"  { Reset-Database }
}
