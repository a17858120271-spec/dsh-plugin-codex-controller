# github-login-publish.ps1 - GitHub device-flow login (no gh CLI needed), then
# create the repo, push, and invite the co-maintainer.
#
#   .\dev\github-login-publish.ps1 [-Owner myctw-114] [-Repo dsh-plugin-codex-controller] [-Private]
#
# Prints a URL + one-time code. Open the URL, enter the code, approve. The script
# keeps polling until the token arrives, then runs publish.ps1 with it. The token
# lives only in this process (never written to disk or .git/config).

param(
  [string]$Owner = 'myctw-114',
  [string]$Repo = 'dsh-plugin-codex-controller',
  [string]$Collaborator = 'myctw-114',
  [switch]$Private
)

$ErrorActionPreference = 'Stop'
$ClientId = '178c6fc778ccc68e1d6a'   # GitHub CLI OAuth app (device flow enabled, public)
$log = Join-Path $PSScriptRoot 'github-login.log'

function Say([string]$line, [string]$color = 'Gray') {
  Write-Output $line
  Add-Content -Path $log -Value ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $line) -Encoding utf8
  if ($color -eq 'Red') { Write-Error $line -ErrorAction Continue }
}

"" | Set-Content -Path $log -Encoding utf8

try {
  $dev = Invoke-RestMethod 'https://github.com/login/device/code' -Method Post `
    -Body @{ client_id = $ClientId; scope = 'repo' } `
    -Headers @{ Accept = 'application/json' } -TimeoutSec 30

  Say '===================================================='
  Say ('OPEN : ' + $dev.verification_uri)
  Say ('CODE : ' + $dev.user_code)
  Say '===================================================='
  Say ('expires in {0}s, polling every {1}s' -f $dev.expires_in, $dev.interval)

  $interval = [int]$dev.interval
  if ($interval -lt 5) { $interval = 5 }
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
    switch ($res.error) {
      'authorization_pending' { continue }
      'slow_down' { $interval += 5; Say "slow_down -> interval ${interval}s"; continue }
      'expired_token' { Say 'device code expired before approval' 'Red'; exit 2 }
      'access_denied' { Say 'authorization denied by user' 'Red'; exit 3 }
      default { Say ("login error: " + $res.error + ' ' + $res.error_description) 'Red'; exit 4 }
    }
  }

  if (-not $token) { Say 'timed out waiting for approval' 'Red'; exit 5 }
  Say 'TOKEN OK - persisting credential, then publishing'

  # persist before publishing so a later failure never costs another login:
  # recoverable with  (\"protocol=https`nhost=github.com`nusername=x-access-token`n`n\" | git credential fill)
  $credLine = "protocol=https`nhost=github.com`nusername=x-access-token`npassword=$token`n`n"
  $credLine | git credential approve 2>$null
  Say 'credential stored (git credential approve)'

  & (Join-Path (Split-Path -Parent $PSScriptRoot) 'publish.ps1') `
    -Token $token -Owner $Owner -Repo $Repo -Collaborator $Collaborator -Private:$Private 2>&1 |
    ForEach-Object { Say $_ }

  Say 'DONE'
  exit 0
} catch {
  Say ("FAILED: " + $_.Exception.Message) 'Red'
  exit 1
}
