# One-shot live validation against both lab Alteons (non-destructive).
# Prereq: Node.js on this machine; first-login already completed (admin/radware).
param(
  [string]$Pass = "radware",
  [string]$Config = "$PSScriptRoot\sample01_alteon_config.txt"
)
Set-Location $PSScriptRoot
if (-not (Test-Path "$PSScriptRoot\node_modules\ssh2")) {
  npm install ssh2@1 --ignore-scripts --no-audit --no-fund | Out-Null
}
New-Item -ItemType Directory -Force -Path "$PSScriptRoot\results" | Out-Null
node validate2.js 10.210.240.152 admin $Pass $Config results\report_34_0_12_0.json
node validate2.js 10.210.240.137 admin $Pass $Config results\report_34_5_7_0.json
Write-Host "`n=== 34.0.12.0 ==="; Get-Content results\report_34_0_12_0.json
Write-Host "`n=== 34.5.7.0 ===";  Get-Content results\report_34_5_7_0.json
