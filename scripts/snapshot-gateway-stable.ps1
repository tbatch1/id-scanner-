param(
  [string]$Source = "frontend/payment-gateway-stable.html",
  [string]$OutDir = "frontend/archives"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $Source)) {
  throw "Source file not found: $Source"
}

if (-not (Test-Path $OutDir)) {
  New-Item -ItemType Directory -Path $OutDir | Out-Null
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dest = Join-Path $OutDir ("payment-gateway-stable.known-good.$stamp.html")

Copy-Item -Force $Source $dest
Write-Output "Saved snapshot: $dest"

