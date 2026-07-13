$ErrorActionPreference = 'Stop'
$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

# Download + verify + extract the official self-contained cordless CLI into this package's tools dir.
$packageArgs = @{
  packageName    = 'cordless'
  unzipLocation  = $toolsDir
  url64bit       = 'https://github.com/naveenneog/cordless/releases/download/v0.8.3/cordless-cli-windows-x64.zip'
  checksum64     = 'D49D1693280F7D93B5229BC4D58BCF53C0F120E67580D48C9079FE954DBF1A4D'
  checksumType64 = 'sha256'
}
Install-ChocolateyZipPackage @packageArgs

# Chocolatey auto-shims every .exe in the package onto PATH. We only want cordless.exe (at the tools
# root) — tell shimgen to IGNORE the node-pty helper exes bundled under resources\ (OpenConsole.exe,
# winpty-agent.exe) so they don't leak onto PATH.
Get-ChildItem -Path (Join-Path $toolsDir 'resources') -Recurse -Filter '*.exe' -ErrorAction SilentlyContinue |
  ForEach-Object { New-Item -Path ($_.FullName + '.ignore') -ItemType File -Force | Out-Null }

Write-Host ''
Write-Host 'cordless is installed. Start it and pair your phone:' -ForegroundColor Green
Write-Host '    cordless           # opens the dashboard with a pairing QR'
Write-Host '    cordless install   # (optional) start the daemon automatically at login'
Write-Host ''
Write-Host 'Docs: https://naveenneog.github.io/cordless/'
