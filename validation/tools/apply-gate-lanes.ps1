<#
.SYNOPSIS
  One apply-gate "lane": run validate4 on every file in a list, one after the
  other, against ONE lab Alteon, appending one result line per file to a log.

.DESCRIPTION
  Run one lane per lab device in parallel (detached), e.g. split the file list
  in two by size. Each file is gated on its own (stage + apply + revert apply).
  A 30 s pause between files keeps the device's connection protection from
  locking the session out. Reports land next to each config as
  <file>.v4report.json (+ .transcript.txt).

.EXAMPLE
  Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-File',
    'validation\tools\apply-gate-lanes.ps1','-TargetHost','<alteon-ip>',
    '-User','<user>','-Pass','<pass>','-ListFile','C:\work\lane-a.txt','-Log','C:\work\lane-a.log'
#>
param(
  [Parameter(Mandatory)] [string]$TargetHost,
  [Parameter(Mandatory)] [string]$User,
  [Parameter(Mandatory)] [string]$Pass,
  [Parameter(Mandatory)] [string]$ListFile,
  [Parameter(Mandatory)] [string]$Log,
  [int]$PauseSec = 30
)
$env:SETTLE_MS = '250'
Set-Location (Split-Path $PSScriptRoot -Parent)       # validation/
Add-Content $Log ("LANE START " + $TargetHost + " " + (Get-Date -Format o))
while (-not (Test-NetConnection $TargetHost -Port 22 -WarningAction SilentlyContinue -InformationLevel Quiet)) { Start-Sleep 60 }
Add-Content $Log ("SSH REACHABLE " + (Get-Date -Format o))
foreach ($f in Get-Content $ListFile) {
  if (-not $f.Trim()) { continue }
  if (-not (Test-Path $f)) { Add-Content $Log ("MISSING " + $f); continue }
  $rep = $f + '.v4report.json'
  # A run that sends nothing (VPN drop, lockout) is not a result: wait for
  # SSH to come back (and 20 more minutes, so a lockout can clear), then
  # rerun the SAME file. Without this, one outage voided every later file.
  for ($try = 1; $try -le 3; $try++) {
    $out = node validate4.js $TargetHost $User $Pass $f $rep 2>&1
    $done = ($out | Select-String 'DONE host=' | Select-Object -Last 1)
    $unsent = $done -and ($done.Line -match 'sent=0 ' -or $done.Line -match 'UNSENT=[1-9]')
    if ($done -and -not $unsent) { break }
    Add-Content $Log ($f + ' | RETRY ' + $try + ': ' + $(if ($done) { $done.Line.Trim() } else { 'NO-DONE-LINE' }) + ' - waiting for ' + $TargetHost + ':22 ' + (Get-Date -Format o))
    while (-not (Test-NetConnection $TargetHost -Port 22 -WarningAction SilentlyContinue -InformationLevel Quiet)) { Start-Sleep 60 }
    Start-Sleep 1200
  }
  if ($done) { Add-Content $Log ($f + ' | ' + $done.Line.Trim()) }
  else { Add-Content $Log ($f + ' | NO-DONE-LINE: ' + (($out | Select-Object -Last 2) -join ' / ')) }
  Start-Sleep $PauseSec
}
Add-Content $Log ("LANE ALL DONE " + $TargetHost)
