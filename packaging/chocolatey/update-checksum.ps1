# Refresh the Chocolatey package's version + SHA256 for a given cordless release.
#   pwsh update-checksum.ps1 -Version 0.8.3
# Downloads the release zip, hashes it, and rewrites cordless.nuspec + tools\chocolateyInstall.ps1
# + tools\VERIFICATION.txt in place.
param(
  [Parameter(Mandatory = $true)][string]$Version
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
$zipName = 'cordless-cli-windows-x64.zip'
$url = "https://github.com/naveenneog/cordless/releases/download/v$Version/$zipName"

$tmp = Join-Path $env:TEMP ("cordless-choco-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zip = Join-Path $tmp $zipName
Write-Host "Downloading $url ..."
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
$sha = (Get-FileHash $zip -Algorithm SHA256).Hash.ToUpper()
Remove-Item $tmp -Recurse -Force
Write-Host "SHA256: $sha"

function Replace-In($file, $pattern, $replacement) {
  $c = Get-Content $file -Raw
  $c = [regex]::Replace($c, $pattern, $replacement)
  Set-Content -Path $file -Value $c -NoNewline
}

# nuspec version
Replace-In (Join-Path $here 'cordless.nuspec') '<version>[^<]+</version>' "<version>$Version</version>"
Replace-In (Join-Path $here 'cordless.nuspec') 'releases/tag/v[0-9][0-9.]*' "releases/tag/v$Version"

# install script: version in URL + checksum
$install = Join-Path $here 'tools\chocolateyInstall.ps1'
Replace-In $install 'releases/download/v[0-9][0-9.]*/' "releases/download/v$Version/"
Replace-In $install "checksum64\s*=\s*'[0-9A-Fa-f]+'" "checksum64     = '$sha'"

# verification
$verify = Join-Path $here 'tools\VERIFICATION.txt'
Replace-In $verify 'releases/tag/v[0-9][0-9.]*' "releases/tag/v$Version"
Replace-In $verify 'releases/download/v[0-9][0-9.]*/' "releases/download/v$Version/"
Replace-In $verify '(?m)^  x64:\s+[0-9A-Fa-f]+' "  x64:  $sha"

Write-Host "Updated cordless.nuspec + tools\chocolateyInstall.ps1 + tools\VERIFICATION.txt to v$Version."
Write-Host "Next: choco pack $here\cordless.nuspec --outputdirectory `$env:TEMP\cordless-choco"
