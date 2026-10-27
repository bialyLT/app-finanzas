# ─────────────────────────────────────────────────────────────────────────────
# Backup automático de la base de datos local (finanzas_dev).
#
# Genera un dump SQL timestamped en la carpeta 'backups/'.
# Uso:
#   npm run db:backup
# ─────────────────────────────────────────────────────────────────────────────

[CmdletBinding()]
param(
    [int]$Port = 5433,
    [string]$DbName = "finanzas_dev",
    [string]$OutputDir = "backups"
)

$PgRoot  = if ($env:PG_LOCAL_ROOT) { $env:PG_LOCAL_ROOT } else { Join-Path $env:LOCALAPPDATA "pg17" }
$PgBin   = Join-Path $PgRoot "pgsql\bin"
$DumpExe = Join-Path $PgBin "pg_dump.exe"

if (-not (Test-Path $DumpExe)) {
    Write-Error "No se encontró pg_dump en '$DumpExe'."
    exit 1
}

if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$OutputFile = Join-Path $OutputDir "backup-$DbName-$Timestamp.sql"

Write-Host "Generando backup de '$DbName' en '$OutputFile'…" -ForegroundColor Cyan

# Ejecutar sin -v para evitar mensajes informativos en stderr que PowerShell interpreta como error
& $DumpExe -h localhost -p $Port -U postgres -F p -b -f $OutputFile $DbName

if ($LASTEXITCODE -eq 0 -and (Test-Path $OutputFile)) {
    $Size = (Get-Item $OutputFile).Length
    Write-Host "Backup completado exitosamente ($Size bytes)." -ForegroundColor Green
} else {
    Write-Error "Falló la generación del backup."
    exit 1
}
