$ErrorActionPreference = "Stop"

$barcode = @(
  'DAQD1234567',
  'DCSDOE',
  'DACJOHN',
  'DBB19800101',
  'DBC1',
  'DAG123 MAIN ST',
  'DAICITY',
  'DAJTX',
  'DAK78701'
) -join "`n"

$saleId = Read-Host "Sale ID to test (must have loyalty customer attached in Lightspeed)"
if ([string]::IsNullOrWhiteSpace($saleId)) { throw "Sale ID required" }

Write-Host "Posting scan..."
$res = Invoke-WebRequest -Method Post -Uri "http://localhost:4000/api/sales/$saleId/verify-bluetooth" -ContentType "application/json" -Body (ConvertTo-Json @{
  barcodeData = $barcode
  registerId = "SMOKE"
  clerkId = "smoke-test"
}) -UseBasicParsing

Write-Host $res.Content

Write-Host ""
Write-Host "Polling status for loader logs..."
Start-Sleep -Milliseconds 1500

for ($i=0; $i -lt 10; $i++) {
  $status = Invoke-WebRequest -Uri "http://localhost:4000/api/sales/$saleId/status?t=$([DateTimeOffset]::Now.ToUnixTimeMilliseconds())" -UseBasicParsing | Select-Object -ExpandProperty Content | ConvertFrom-Json
  $logs = @($status.logs | Select-Object -Last 12)
  Write-Host ("--- poll {0} ---" -f ($i+1))
  foreach ($l in $logs) {
    $msg = if ($l.m) { $l.m } elseif ($l.message) { $l.message } else { "" }
    Write-Host ("[{0}] {1}" -f $l.type, $msg)
  }
  Start-Sleep -Milliseconds 1200
}

