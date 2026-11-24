# get-token.ps1 - recover the GitHub token from the git credential store.
# Prints nothing when absent. Used to retry a publish without another device login.
$q = "protocol=https`nhost=github.com`nusername=x-access-token`n`n"
$out = $q | git credential fill 2>$null
if ($LASTEXITCODE -ne 0) { exit 1 }
$tok = ($out | Where-Object { $_ -match '^password=' }) -replace '^password=', ''
if (-not $tok) { exit 1 }
Write-Output $tok
