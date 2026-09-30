# Starts Docker Desktop on this Windows PC when it won't start by itself.
#
# Docker Desktop sometimes crashes on launch with "rename ...\sailor-ingest.sock ...: The file cannot be accessed
# by the system". Socket files left over from the last run can't be replaced or deleted. Renaming the folders that
# hold them gets round it: Docker makes fresh ones. This script does that, starts Docker, and waits for it.
#
#   powershell -ExecutionPolicy Bypass -File scripts\docker-unstick.ps1

$ErrorActionPreference = "Stop"

function Test-Docker { docker info *> $null; return $LASTEXITCODE -eq 0 }

if (Test-Docker) { Write-Host "Docker is already running."; exit 0 }

Write-Host "Stopping Docker Desktop..."
Get-Process -Name "Docker Desktop", "com.docker.backend" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3

$stamp = Get-Date -Format "yyyyMMddHHmmss"
foreach ($dir in @("$env:LOCALAPPDATA\Docker\run", "$env:LOCALAPPDATA\docker-secrets-engine")) {
    if (Test-Path $dir) {
        $name = (Split-Path $dir -Leaf) + "-stale-$stamp"
        Rename-Item $dir $name
        Write-Host "Moved aside $dir"
    }
}

Write-Host "Starting Docker Desktop..."
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 5
    if (Test-Docker) { Write-Host "Docker is running."; exit 0 }
}
Write-Host "Docker still isn't up after 5 minutes. Check Docker Desktop for an error message."
exit 1
