# install.ps1 — idempotent install / repair of dsh-plugin-codex-controller.
#
#   .\install.ps1                 # link into the desktop profile + register bundle
#   .\install.ps1 -Profile web    # other profile
#   .\install.ps1 -Verify         # only run the compatibility self-check
#   .\install.ps1 -Restore        # remove the plugin row/junction (uses *.bak files)
#
# Run it after a DSH update that rebuilt the profile, after moving this folder,
# or when in doubt. Safe to re-run: every step checks before acting.

param(
  [string]$Profile = "desktop",
  [switch]$Verify,
  [switch]$Restore
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome "profiles\$Profile"
$pkgPath = Join-Path $profileDir 'package.json'
$linkPath = Join-Path $profileDir 'node_modules\dsh-plugin-codex-controller'
$pkgName = 'dsh-plugin-codex-controller'

if (-not (Test-Path $pkgPath)) { throw "profile not found: $pkgPath" }

if ($Verify) {
  Write-Host "== compatibility self-check ==" -ForegroundColor Cyan
  & node (Join-Path $repo 'dev\compat-test.mjs') doctor $repo
  exit $LASTEXITCODE
}

if ($Restore) {
  $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
  $pkg.dependencies.PSObject.Properties.Remove($pkgName) | Out-Null
  $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles | Where-Object { $_ -ne $pkgName })
  $json = $pkg | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($pkgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  if (Test-Path $linkPath) { (Get-Item $linkPath).Delete() }
  Write-Host "removed $pkgName from profile '$Profile'. Restart the app." -ForegroundColor Yellow
  exit 0
}

# 1) link the plugin into the profile's node_modules
New-Item -ItemType Directory -Force (Split-Path -Parent $linkPath) | Out-Null
if (Test-Path $linkPath) {
  $item = Get-Item $linkPath -Force
  if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') { $item.Delete() }
  else { Remove-Item $linkPath -Recurse -Force }
}
New-Item -ItemType Junction -Path $linkPath -Target $repo | Out-Null
Write-Host "linked: $linkPath -> $repo" -ForegroundColor Green

# 2) register dependency + bundle row (idempotent)
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$rel = [System.IO.Path]::GetRelativePath($profileDir, $repo) -replace '\\', '/'
if (-not ($pkg.dependencies.PSObject.Properties.Name -contains $pkgName)) {
  $pkg.dependencies | Add-Member -NotePropertyName $pkgName -NotePropertyValue ("link:" + $rel) -Force
}
if (-not ($pkg.dsh.profile.bundles -contains $pkgName)) {
  $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles) + $pkgName
}
$json = $pkg | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($pkgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "registered in $pkgPath" -ForegroundColor Green

Write-Host ""
Write-Host "next: restart the DSH desktop app (the node half is not hot-reloaded)." -ForegroundColor Cyan
Write-Host "panel: Settings -> Codex 控制器    tools: codex_prompt / codex_open / codex_send / codex_status / codex_read / codex_doctor" -ForegroundColor DarkGray
