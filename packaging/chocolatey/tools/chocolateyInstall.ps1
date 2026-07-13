$ErrorActionPreference = 'Stop'
$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

# Download + verify + extract the official self-contained cordless CLI into this package's tools dir.
$packageArgs = @{
  packageName    = 'cordless'
  unzipLocation  = $toolsDir
  url64bit       = 'https://github.com/naveenneog/cordless/releases/download/v0.9.0/cordless-cli-windows-x64.zip'
  checksum64     = 'B8A1D79BDBDBD00621731566B525CEC8259CFD01C0E081E02F971170D9B833D0'
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
Write-Host '    cordless start     # start the daemon in the background'
Write-Host '    cordless install   # (optional) start the daemon automatically at login'
Write-Host '    cordless help      # full command reference'
Write-Host ''
Write-Host 'Docs: https://naveenneog.github.io/cordless/'
