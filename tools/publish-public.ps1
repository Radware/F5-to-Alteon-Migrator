<#
.SYNOPSIS
  Publish a sanitized snapshot of this repo to the PUBLIC Radware repo.

.DESCRIPTION
  Development happens in the PRIVATE repo (origin) with the full history,
  customer configs and lab details. The PUBLIC repo (radware) only ever
  receives squashed, sanitized snapshots - never the private history.

  This script is the ONLY supported way to publish. It:
    1. refuses to run with uncommitted changes,
    2. scans the tree for customer names, credentials and secrets,
    3. runs the full test suite,
    4. creates a single snapshot commit on top of the public branch,
    5. pushes it, and optionally publishes the npm package.

  A pre-push hook (.githooks/pre-push) blocks any direct push to the public
  remote, so this procedure cannot be bypassed by accident.

.EXAMPLE
  pwsh tools/publish-public.ps1 -Message "Update: bulk migration; v0.6.0"

.EXAMPLE
  pwsh tools/publish-public.ps1 -Message "v0.6.1" -Npm
#>
param(
  [string]$Message = "",
  [switch]$Npm,          # also run npm publish
  [switch]$DryRun        # run every check, push nothing
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo

function Fail($msg) { Write-Host "`nPUBLISH ABORTED: $msg`n" -ForegroundColor Red; exit 1 }
function Step($n, $msg) { Write-Host "[$n/5] $msg" -ForegroundColor Cyan }

# --- 1. clean tree -----------------------------------------------------------
Step 1 "Checking the working tree is clean"
$dirty = git status --porcelain
if ($dirty) {
  Write-Host $dirty
  Fail "uncommitted changes. Commit them to the PRIVATE repo first (git push origin main)."
}

# --- 2. sensitive-content scan ----------------------------------------------
Step 2 "Scanning for customer names, credentials and secrets"
node tools/scan-sensitive.js
if ($LASTEXITCODE -ne 0) { Fail "sensitive content found (see above). Nothing was pushed." }

# --- 3. tests ----------------------------------------------------------------
Step 3 "Running the test suite"
Push-Location node
npm test 2>&1 | Select-String -Pattern '# pass|# fail|not ok' | ForEach-Object { "      " + $_.Line.Trim() }
$testFailed = $LASTEXITCODE -ne 0
Pop-Location
if ($testFailed) { Fail "tests failed. Nothing was pushed." }

# --- 4. build the snapshot commit -------------------------------------------
Step 4 "Building the sanitized snapshot"
git fetch radware 2>&1 | Out-Null
$parent = (git rev-parse radware/main 2>$null)
$tree = (git rev-parse "HEAD^{tree}")
if (-not $Message) {
  $version = (Get-Content node/package.json | ConvertFrom-Json).version
  $Message = "Update: F5-to-Alteon Migrator v$version"
}
if ($parent) { $commit = ($Message | git commit-tree $tree -p $parent) }
else         { $commit = ($Message | git commit-tree $tree) }
Write-Host "      snapshot commit: $commit"
Write-Host "      message:         $Message"

if ($DryRun) {
  Write-Host "`nDRY RUN - all checks passed, nothing pushed.`n" -ForegroundColor Yellow
  exit 0
}

# --- 5. push (the hook allows it only through this script) -------------------
Step 5 "Pushing to the PUBLIC repo"
$env:RADWARE_PUBLISH = "1"
try {
  git push radware "${commit}:refs/heads/main"
  if ($LASTEXITCODE -ne 0) { Fail "push failed." }
} finally {
  Remove-Item Env:\RADWARE_PUBLISH -ErrorAction SilentlyContinue
}

Write-Host "`nPublished: https://github.com/Radware/F5-to-Alteon-Migrator" -ForegroundColor Green

if ($Npm) {
  Write-Host "`nPublishing the npm package..." -ForegroundColor Cyan
  Push-Location node
  npm publish --access public
  $npmFailed = $LASTEXITCODE -ne 0
  Pop-Location
  if ($npmFailed) { Fail "npm publish failed (the GitHub push already succeeded)." }
  Write-Host "Published: https://www.npmjs.com/package/@radware/f5-to-alteon" -ForegroundColor Green
}

Write-Host ""
