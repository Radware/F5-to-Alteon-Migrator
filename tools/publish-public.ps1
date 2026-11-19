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
    4. creates a single snapshot commit on top of the public branch, with the
       private/ folder (lab credentials, customer context) removed,
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
  [switch]$DryRun,       # run every check, push nothing
  [switch]$AllowPublicOverwrite   # discard public-only changes on purpose (see tools/public-drift.js)
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
# Under 'Stop', PowerShell 5.1 turns ANY stderr line of a native command into a
# terminating error - and git fetch writes its progress to stderr whenever
# there is something new (e.g. a contributor merge on the public repo), which
# aborted step 4 with no message. Check the exit code instead.
$ErrorActionPreference = 'Continue'
git fetch radware 2>&1 | Out-Null
$fetchFailed = $LASTEXITCODE -ne 0
$parent = (git rev-parse --verify --quiet radware/main 2>$null)   # empty on a first-ever publish
$ErrorActionPreference = 'Stop'
if ($fetchFailed) { Fail "git fetch radware failed (network/VPN?). Nothing was pushed." }
# Collaborators may merge directly on the public repo. This release replaces
# the public tree, so refuse if it would erase public-only work.
if (-not $AllowPublicOverwrite) {
  node tools/public-drift.js
  if ($LASTEXITCODE -ne 0) { Fail "the public repo has changes that are not in the private repo (listed above). Nothing was pushed. Use -AllowPublicOverwrite only to discard them on purpose." }
}
# private/ (lab credentials, customer context, people) never leaves the dev
# repo: build the snapshot tree from a throwaway index with it removed, so the
# real index and working tree are untouched.
$tmpIndex = Join-Path ([IO.Path]::GetTempPath()) ("f5pub-" + [guid]::NewGuid().ToString() + ".idx")
$env:GIT_INDEX_FILE = $tmpIndex
try {
  git read-tree HEAD
  git rm -r -q --cached --ignore-unmatch -- private | Out-Null
  $tree = (git write-tree).Trim()
} finally {
  Remove-Item Env:\GIT_INDEX_FILE -ErrorAction SilentlyContinue
  Remove-Item $tmpIndex -Force -ErrorAction SilentlyContinue
}
if (-not $tree) { Fail "could not build the snapshot tree." }
$leaked = git ls-tree -r --name-only $tree | Where-Object { $_ -like 'private/*' }
if ($leaked) { Fail "the snapshot tree still contains private/ files - nothing was pushed." }
Write-Host "      private/ excluded from the snapshot"
if (-not $Message) {
  $version = (Get-Content node/package.json | ConvertFrom-Json).version
  $Message = "Update: F5-to-Alteon Migrator v$version"
}
# -m (not a pipe): piping a PowerShell string into git prepends a UTF-8 BOM,
# which then shows up at the start of the published commit message.
# The Source-Commit trailer lets tools/public-drift.js find this snapshot later.
$source = "Source-Commit: " + (git rev-parse HEAD).Trim()
if ($parent) { $commit = (git commit-tree $tree -p $parent -m $Message -m $source) }
else         { $commit = (git commit-tree $tree -m $Message -m $source) }
$commit = $commit.Trim()
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
