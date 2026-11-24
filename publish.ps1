# publish.ps1 - create (or reuse) the GitHub repo, push this directory, invite a co-maintainer.
#
#   .\publish.ps1 -Token <PAT>                     # reuse/create repo under the token's account, push, invite
#   .\publish.ps1 -Token <PAT> -Owner <user>       # force a namespace (only valid for the token's own account)
#   .\publish.ps1 -Token <PAT> -TryTransfer        # also attempt an API transfer to -Owner (org targets only)
#   .\publish.ps1 -DryRun                          # show the calls, touch nothing
#
# Token needs: repo creation + contents write (classic "repo", or fine-grained
# Administration + Contents + Metadata read/write). The token is used in-process
# and is never written to .git/config.

param(
  [string]$Token = $env:GITHUB_TOKEN,
  [string]$Owner = '',                                     # '' = the authenticated account
  [string]$Repo = 'dsh-plugin-codex-controller',
  [string]$Collaborator = 'myctw-114',
  [string]$Description = 'Codex controller plugin for DeepSeek Harness: prompt drafting, refusal reframing, app-server JSON-RPC control plane, live progress panel.',
  [switch]$Private,
  [switch]$TryTransfer,
  [switch]$PersistCredential,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$api = 'https://api.github.com'

if ($DryRun) {
  Write-Host 'DRY RUN - no network calls' -ForegroundColor Yellow
  Write-Host "  1) GET  $api/repos/{owner}/$Repo  (reuse when present, else POST $api/user/repos)"
  Write-Host "  2) git push https://x-access-token:***@github.com/{owner}/$Repo.git main"
  Write-Host "  3) PUT  $api/repos/{owner}/$Repo/collaborators/$Collaborator  { permission=push }"
  exit 0
}

if (-not $Token) { throw 'no token: pass -Token <PAT> or set GITHUB_TOKEN' }

$headers = @{
  Authorization          = "Bearer $Token"
  Accept                 = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
  'User-Agent'           = 'dsh-codex-controller-publish'
}

function Api([string]$Method, [string]$Path, $Body) {
  $uri = "$api$Path"
  if ($null -eq $Body) { return Invoke-RestMethod -Uri $uri -Method $Method -Headers $headers -TimeoutSec 40 }
  $json = $Body | ConvertTo-Json -Depth 6 -Compress
  return Invoke-RestMethod -Uri $uri -Method $Method -Headers $headers -Body $json -ContentType 'application/json' -TimeoutSec 40
}

function RunGit([string[]]$GitArgs) {
  # git writes progress/warnings to stderr; under $ErrorActionPreference='Stop'
  # those lines become terminating errors, so scope the preference down here and
  # trust only the exit code.
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & git @GitArgs 2>&1 | Out-String
    return @{ code = $LASTEXITCODE; out = $out.Trim() }
  } finally {
    $ErrorActionPreference = $prev
  }
}

# git does not read the Windows/WinINET proxy. Detect the usual local client
# (Clash on 7890, V2Ray on 10809, plain 8080) or take HTTPS_PROXY from the env.
function Resolve-GitProxy {
  if ($env:HTTPS_PROXY) { return $env:HTTPS_PROXY }
  if ($env:https_proxy) { return $env:https_proxy }
  foreach ($port in 7890, 7897, 10809, 8080) {
    $listen = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($listen) { return "http://127.0.0.1:$port" }
  }
  return $null
}

$me = Api GET '/user' $null
Write-Host ("authenticated as {0}" -f $me.login) -ForegroundColor DarkGray
if (-not $Owner) { $Owner = $me.login }

# 1) repo: reuse when it already exists
$repoUrl = "https://github.com/$Owner/$Repo"
$exists = $false
try {
  $existing = Api GET "/repos/$Owner/$Repo" $null
  $exists = $true
  Write-Host "repo exists: $($existing.html_url)" -ForegroundColor Yellow
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  if ($code -ne 404) { throw }
}

if (-not $exists) {
  if ($Owner -ne $me.login) {
    throw "cannot create under '$Owner' with a token for '$($me.login)' - create it there, or run with -Owner $($me.login)"
  }
  $payload = @{
    name        = $Repo
    description = $Description
    private     = [bool]$Private
    has_issues  = $true
    has_wiki    = $false
    auto_init   = $false
  }
  $createdRepo = Api POST '/user/repos' $payload
  Write-Host "repo created: $($createdRepo.html_url)" -ForegroundColor Green
  if ($TryTransfer -and $Owner -ne $me.login) {
    try {
      $null = Api POST "/repos/$($me.login)/$Repo/transfer" @{ new_owner = $Owner }
      Write-Host "transfer requested -> $Owner" -ForegroundColor Green
      $repoUrl = "https://github.com/$Owner/$Repo"
    } catch {
      Write-Host "transfer failed (expected for user accounts): $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }
}

# 2) push main without persisting the token in .git/config
Push-Location $repoDir
try {
  $remoteUrl = $repoUrl.TrimEnd('/') + '.git'
  $remotes = @((& git remote 2>$null) -split "`r?`n" | Where-Object { $_ })
  if ($remotes -contains 'origin') {
    $r1 = RunGit @('remote', 'set-url', 'origin', $remoteUrl)
  } else {
    $r1 = RunGit @('remote', 'add', 'origin', $remoteUrl)
  }
  if ($r1.code -ne 0) { throw "git remote configuration failed: $($r1.out)" }
  Write-Host "origin -> $remoteUrl" -ForegroundColor DarkGray
  $branch = (& git symbolic-ref --short HEAD).Trim()
  if (-not $branch) { throw 'no current branch' }

  $gitProxy = Resolve-GitProxy
  $proxyArgs = @()
  if ($gitProxy) {
    $proxyArgs = @('-c', "http.proxy=$gitProxy", '-c', "https.proxy=$gitProxy")
    Write-Host "using proxy $gitProxy (git ignores the system proxy)" -ForegroundColor DarkGray
  }
  $pushUrl = "https://x-access-token:$Token@github.com/$Owner/$Repo.git"

  Write-Host "pushing $branch ..." -ForegroundColor DarkGray
  $push = RunGit (@('push', $pushUrl, $branch) + $proxyArgs)
  if ($push.code -ne 0) {
    # first push to an empty remote may need an explicit refspec
    $push = RunGit (@('push', $pushUrl, "${branch}:${branch}") + $proxyArgs)
  }
  if ($push.out) { Write-Host $push.out -ForegroundColor DarkGray }
  if ($push.code -ne 0) { throw "git push failed (exit $($push.code))" }
  Write-Host 'push ok' -ForegroundColor Green

  if ($PersistCredential) {
    $line = "protocol=https`nhost=github.com`nusername=x-access-token`npassword=$Token`n`n"
    $line | git credential approve 2>$null
    Write-Host 'credential stored for future pushes (git credential approve)' -ForegroundColor DarkGray
  }
} finally {
  Pop-Location
}

# 3) invite co-maintainer
if ($Collaborator -and $Collaborator -ne $Owner) {
  try {
    $inv = Api PUT "/repos/$Owner/$Repo/collaborators/$Collaborator" @{ permission = 'push' }
    Write-Host "invited $Collaborator (permission=push) - they must accept the invitation" -ForegroundColor Green
    if ($inv -and $inv.id) { Write-Host ("  invitation id: " + $inv.id) -ForegroundColor DarkGray }
  } catch {
    Write-Host "collaborator invite failed: $($_.Exception.Message)" -ForegroundColor Red
  }
} else {
  Write-Host "collaborator '$Collaborator' is the repo owner - nothing to invite" -ForegroundColor Yellow
}

Write-Host ''
Write-Host "done -> $repoUrl" -ForegroundColor Cyan
