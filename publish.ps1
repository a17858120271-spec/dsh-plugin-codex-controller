# publish.ps1 - create the GitHub repo, push this directory, invite a co-maintainer.
#
#   .\publish.ps1 -Token <PAT>                       # create (or reuse) + push + invite
#   .\publish.ps1 -Token <PAT> -Private              # private repo
#   .\publish.ps1 -DryRun                            # show the calls, touch nothing
#
# Token needs: classic PAT with "repo" scope, or fine-grained PAT with
# Administration: read/write (repo create) + Contents: read/write (push)
# + Metadata: read. The token is used in-process only and never written to
# .git/config or to disk.

param(
  [string]$Token = $env:GITHUB_TOKEN,
  [string]$Owner = 'myctw-114',
  [string]$Repo = 'dsh-plugin-codex-controller',
  [string]$Collaborator = 'myctw-114',
  [string]$Description = 'Codex controller plugin for DeepSeek Harness: prompt drafting, refusal reframing, app-server JSON-RPC control plane, live progress panel.',
  [switch]$Private,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$api = 'https://api.github.com'

if ($DryRun) {
  Write-Host 'DRY RUN - no network calls' -ForegroundColor Yellow
  Write-Host "  1) POST $api/user/repos  { name=$Repo, private=$([bool]$Private) }"
  Write-Host "  2) git push https://x-access-token:***@github.com/$Owner/$Repo.git main"
  Write-Host "  3) PUT  $api/repos/$Owner/$Repo/collaborators/$Collaborator  { permission=push }"
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
  if ($null -eq $Body) {
    return Invoke-RestMethod -Uri $uri -Method $Method -Headers $headers -TimeoutSec 40
  }
  $json = $Body | ConvertTo-Json -Depth 6 -Compress
  return Invoke-RestMethod -Uri $uri -Method $Method -Headers $headers -Body $json -ContentType 'application/json' -TimeoutSec 40
}

# who am I
$me = Api GET '/user' $null
Write-Host ("authenticated as {0} ({1})" -f $me.login, $me.name) -ForegroundColor DarkGray

# 1) repo: reuse if it exists
$created = $false
try {
  $existing = Api GET "/repos/$Owner/$Repo" $null
  Write-Host "repo exists: $($existing.html_url)" -ForegroundColor Yellow
} catch {
  if ($_.Exception.Response.StatusCode.value__ -ne 404) { throw }
  # create under the authenticated account (the only place a user token may create),
  # then move it to -Owner when that namespace belongs to somebody else
  $payload = @{
    name        = $Repo
    description = $Description
    private     = [bool]$Private
    has_issues  = $true
    has_wiki    = $false
    auto_init   = $false
  }
  $createdRepo = Api POST '/user/repos' $payload
  $created = $true
  Write-Host "repo created: $($createdRepo.html_url)" -ForegroundColor Green
  if ($me.login -ne $Owner) {
    try {
      $moved = Api POST "/repos/$($me.login)/$Repo/transfer" @{ new_owner = $Owner }
      Write-Host "transfer -> $Owner requested" -ForegroundColor Green
    } catch {
      Write-Host "transfer to $Owner failed: $($_.Exception.Message)" -ForegroundColor Red
      Write-Host "  repo stays at https://github.com/$($me.login)/$Repo - re-run with -Owner $($me.login) or move it manually" -ForegroundColor Yellow
      $Owner = $me.login
    }
  }
}

# 2) push main
Push-Location $repoDir
try {
  $remoteUrl = "https://x-access-token:$Token@github.com/$Owner/$Repo.git"
  git remote remove origin 2>$null | Out-Null
  git remote add origin "https://github.com/$Owner/$Repo.git"
  Write-Host 'pushing main...' -ForegroundColor DarkGray
  git push $remoteUrl main --force-with-lease 2>&1 | ForEach-Object { Write-Host "  $_" }
  if ($LASTEXITCODE -ne 0) { throw "git push failed (exit $LASTEXITCODE)" }
  Write-Host 'push ok' -ForegroundColor Green
} finally {
  Pop-Location
}

# 3) invite co-maintainer
if ($Collaborator -and $Collaborator -ne $Owner -and $Collaborator -ne $me.login) {
  try {
    $inv = Api PUT "/repos/$Owner/$Repo/collaborators/$Collaborator" @{ permission = 'push' }
    Write-Host "invited $Collaborator (permission=push) - pending their acceptance" -ForegroundColor Green
    if ($inv -and $inv.invitee) { Write-Host ("  invitation id: " + $inv.id) -ForegroundColor DarkGray }
  } catch {
    Write-Host "collaborator invite failed: $($_.Exception.Message)" -ForegroundColor Red
  }
} else {
  Write-Host "collaborator '$Collaborator' equals the repo owner - nothing to invite" -ForegroundColor Yellow
}

Write-Host ''
Write-Host "done -> https://github.com/$Owner/$Repo" -ForegroundColor Cyan
if ($created) { Write-Host 'first push created the default branch; repo settings kept issues on, wiki off' -ForegroundColor DarkGray }
