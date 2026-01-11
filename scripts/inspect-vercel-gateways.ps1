param(
  [string[]]$Paths = @("/payment-gateway-stable.html", "/payment-gateway.html"),
  [string]$Project = "id-scanner-project",
  [int]$TimeoutSec = 12,
  [ValidateSet("table", "json", "csv")]
  [string]$Output = "table",
  [string]$OutFile = "",
  [switch]$IncludeProductionAlias
)

$ErrorActionPreference = "Stop"

function Get-Deployments {
  # Vercel CLI can print informational lines to stderr; don't treat those as failures.
  $old = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $out = npx vercel ls --yes 2>$null
  } finally {
    $ErrorActionPreference = $old
  }
  $urls = @()
  foreach ($line in $out) {
    if ($line -match "^https://.+\.vercel\.app$") {
      if ($line -like "*$Project-*") {
        $urls += $line.Trim()
      }
    }
  }
  return $urls
}

function Get-PageInfo([string]$Base, [string]$Path) {
  $u = "$Base$Path"
  try {
    $content = (Invoke-WebRequest -UseBasicParsing $u -TimeoutSec $TimeoutSec).Content
    [pscustomobject]@{
      base = $Base
      path = $Path
      len = $content.Length
      hasVerifyBluetooth = $content.Contains("/verify-bluetooth")
      hasPostMessage = $content.Contains("postMessage")
      hasRemoteDiagnostics = $content.Contains("REMOTE DIAGNOSTICS")
      hasTapToStart = ($content -match "Tap to start scanning")
      hasFocusBarcode = ($content -match "Focus on (the )?barcode")
      hasCustomerHint = ($content -match "Customer profile saved in Lightspeed")
    }
  } catch {
    [pscustomobject]@{
      base = $Base
      path = $Path
      len = 0
      hasVerifyBluetooth = $false
      hasPostMessage = $false
      hasRemoteDiagnostics = $false
      hasTapToStart = $false
      hasFocusBarcode = $false
      hasCustomerHint = $false
      error = $_.Exception.Message
    }
  }
}

$bases = Get-Deployments
if (-not $bases -or $bases.Count -eq 0) {
  throw "No deployments found for project: $Project"
}

if ($IncludeProductionAlias) {
  $bases = @("https://$Project.vercel.app") + $bases
}

$rows = @()
foreach ($b in $bases) {
  foreach ($p in $Paths) {
    $rows += Get-PageInfo -Base $b -Path $p
  }
}

$sorted = $rows | Sort-Object base, path

if ($Output -eq "json") {
  $json = $sorted | ConvertTo-Json -Depth 4
  if ($OutFile) { $json | Out-File -Encoding utf8 -FilePath $OutFile }
  else { $json }
  exit 0
}

if ($Output -eq "csv") {
  if (-not $OutFile) { throw "csv output requires -OutFile" }
  $sorted | Export-Csv -NoTypeInformation -Encoding utf8 -Path $OutFile
  Write-Output "Wrote CSV: $OutFile"
  exit 0
}

$sorted |
  Format-Table -AutoSize base, path, len, hasVerifyBluetooth, hasPostMessage, hasRemoteDiagnostics, hasTapToStart, hasFocusBarcode, hasCustomerHint, error
