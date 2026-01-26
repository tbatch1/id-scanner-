$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$secretsPath = Join-Path $root ".secrets.local.json"
$envPath = Join-Path $root ".env"

function Read-JsonFile([string]$path) {
  if (!(Test-Path $path)) { return @{} }
  try { return (Get-Content $path -Raw | ConvertFrom-Json -AsHashtable) } catch { return @{} }
}

function Write-JsonFile([string]$path, [hashtable]$obj) {
  $obj | ConvertTo-Json -Depth 10 | Set-Content -Path $path -Encoding UTF8
}

function Set-EnvLine([string]$filePath, [string]$key, [string]$value) {
  $lines = @()
  if (Test-Path $filePath) { $lines = Get-Content $filePath }
  $pattern = "^\s*$([regex]::Escape($key))\s*="
  $updated = $false
  $out = foreach ($line in $lines) {
    if ($line -match $pattern) { $updated = $true; "$key=$value" } else { $line }
  }
  if (-not $updated) { $out += "$key=$value" }
  $out | Set-Content -Path $filePath -Encoding UTF8
}

Write-Host ""
Write-Host "Local Lightspeed setup (keeps secrets out of git)"
Write-Host "------------------------------------------------"
Write-Host ""

$secrets = Read-JsonFile $secretsPath

$clientId = Read-Host "LIGHTSPEED_CLIENT_ID (from Lightspeed app settings)"
$clientSecret = Read-Host "LIGHTSPEED_CLIENT_SECRET (from Lightspeed app settings)"
$domainPrefix = Read-Host "LIGHTSPEED_DOMAIN_PREFIX (your subdomain prefix, like 'yourshop')"
$redirectUri = Read-Host "LIGHTSPEED_REDIRECT_URI (press Enter for http://localhost:4000/api/auth/callback)"
if ([string]::IsNullOrWhiteSpace($redirectUri)) { $redirectUri = "http://localhost:4000/api/auth/callback" }

$secrets["LIGHTSPEED_CLIENT_ID"] = $clientId
$secrets["LIGHTSPEED_CLIENT_SECRET"] = $clientSecret
$secrets["LIGHTSPEED_DOMAIN_PREFIX"] = $domainPrefix
$secrets["LIGHTSPEED_REDIRECT_URI"] = $redirectUri
$secrets["LIGHTSPEED_OAUTH_SCOPES"] = "sales:read sales:write customers:read customers:write webhooks"

Write-JsonFile $secretsPath $secrets

Set-EnvLine $envPath "LIGHTSPEED_USE_MOCK" "false"
Set-EnvLine $envPath "LIGHTSPEED_ENABLE_WRITE" "true"

Write-Host ""
Write-Host "Saved:"
Write-Host " - $secretsPath"
Write-Host " - $envPath"
Write-Host ""
Write-Host "Next:"
Write-Host " 1) Start server:   npm run dev"
Write-Host " 2) OAuth login:    http://localhost:4000/api/auth/login"
Write-Host " 3) Check status:   http://localhost:4000/api/auth/status"
Write-Host ""
Write-Host "Tokens will be stored in: $root\\.lightspeed_oauth_tokens.local.json"

