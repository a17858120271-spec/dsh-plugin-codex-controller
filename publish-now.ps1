# publish-now.ps1 - one shot, run this yourself whenever you are at the keyboard.
#
#   Right-click > Run with PowerShell, or:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\publish-now.ps1
#
# What it does, in order:
#   1. asks GitHub for a device code and opens https://github.com/login/device
#   2. prints the 8-character code in a banner and waits (15 min window)
#   3. on approval: stores the token in the git credential manager
#   4. pushes main to the repo, then invites the co-maintainer
#
# Nothing is written to .git/config. The token only lives in this process and in
# the Windows credential store (needed for later pushes; remove with:
#   cmdkey /delete:git:https://github.com).

param(
  [string]$Owner = 'a17858120271-spec',
  [string]$Repo = 'dsh-plugin-codex-controller',
  [string]$Collaborator = 'myctw-114',
  [switch]$Private
)

$ErrorActionPreference = 'Continue'
$ClientId = '178c6fc778ccc68e1d6a'   # GitHub CLI OAuth app, device flow enabled
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Banner([string]$text, [string]$color = 'Cyan') {
  $line = '=' * 60
  Write-Host ''
  Write-Host $line -ForegroundColor $color
  Write-Host $text -ForegroundColor $color
  Write-Host $line -ForegroundColor $color
  Write-Host ''
}

try {
  $dev = Invoke-RestMethod 'https://github.com/login/device/code' -Method Post `
    -Body @{ client_id = $ClientId; scope = 'repo' } `
    -Headers @{ Accept = 'application/json' } -TimeoutSec 30

  try { Start-Process $dev.verification_uri } catch { }
  Banner ("CODE:  " + $dev.user_code + "`nURL :  " + $dev.verification_uri)
  Write-Host 'Browser should be open. Paste the code above, Continue -> Authorize.' -ForegroundColor Yellow
  Write-Host ('Waiting up to {0} minutes...' -f [int]([int]$dev.expires_in / 60)) -ForegroundColor DarkGray

  $interval = [Math]::Max(5, [int]$dev.interval)
  $deadline = (Get-Date).AddSeconds([int]$dev.expires_in)
  $token = $null
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds $interval
    $res = Invoke-RestMethod 'https://github.com/login/oauth/access_token' -Method Post `
      -Body @{
        client_id   = $ClientId
        device_code = $dev.device_code
        grant_type  = 'urn:ietf:params:oauth:grant-type:device_code'
      } -Headers @{ Accept = 'application/json' } -TimeoutSec 30
    if ($res.access_token) { $token = $res.access_token; break }
    if ($res.error -eq 'slow_down') { $interval += 5 }
    elseif ($res.error -eq 'expired_token') { break }
    elseif ($res.error -eq 'access_denied') { Write-Host 'Denied.' -ForegroundColor Red; break }
  }

  if (-not $token) {
    Banner 'No token. Re-run this script to get a fresh code.' 'Red'
    if ($Host.Name -eq 'ConsoleHost') { Read-Host 'Press Enter to close' | Out-Null }
    exit 2
  }

  Write-Host 'Authorized. Storing credential...' -ForegroundColor Green
  ("protocol=https`nhost=github.com`nusername=x-access-token`npassword=$token`n`n" | git credential approve 2>$null) | Out-Null

  & (Join-Path $here 'publish.ps1') -Token $token -Owner $Owner -Repo $Repo -Collaborator $Collaborator -Private:$Private
  $code = $LASTEXITCODE

  Banner ("Repository: https://github.com/$Owner/$Repo") 'Green'
  if ($Host.Name -eq 'ConsoleHost') { Read-Host 'Press Enter to close' | Out-Null }
  exit $code
} catch {
  Banner ('FAILED: ' + $_.Exception.Message) 'Red'
  if ($Host.Name -eq 'ConsoleHost') { Read-Host 'Press Enter to close' | Out-Null }
  exit 1
}
