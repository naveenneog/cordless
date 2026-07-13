$ErrorActionPreference = 'SilentlyContinue'
$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$exe = Join-Path $toolsDir 'cordless.exe'

# Stop the running daemon so the exe isn't locked, and remove any login-autostart the user registered
# (its scheduled task points at this soon-to-be-removed exe). Config + paired devices in ~/.cordless
# are intentionally kept.
if (Test-Path $exe) {
  try { & $exe stop      | Out-Null } catch {}
  try { & $exe uninstall | Out-Null } catch {}
}

# The extracted files + the cordless shim are removed by Chocolatey automatically
# (tracked by Install-ChocolateyZipPackage).
