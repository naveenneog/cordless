# Registers the cordless daemon to start at logon via Windows Task Scheduler.
# Runs as the current user (NOT elevated) — a paired device has your shell access.
#
#   Register:    powershell -ExecutionPolicy Bypass -File install\register-task.ps1
#   Unregister:  Unregister-ScheduledTask -TaskName cordless -Confirm:$false
#   Inspect:     Get-ScheduledTask -TaskName cordless
#
# Note: Task Scheduler runs the daemon without a console, so node-pty may print a benign
# "AttachConsole failed" line the first time; PTY sessions still work.

$ErrorActionPreference = "Stop"

$repo  = Split-Path -Parent $PSScriptRoot            # ...\cordless
$node  = (Get-Command node -ErrorAction Stop).Source
$entry = Join-Path $repo "agent\src\index.js"

if (-not (Test-Path $entry)) { throw "Cannot find $entry — run this from the cordless repo." }

$action    = New-ScheduledTaskAction -Execute $node -Argument "`"$entry`" start" -WorkingDirectory $repo
$trigger   = New-ScheduledTaskTrigger -AtLogOn
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName "cordless" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Registered scheduled task 'cordless' (starts at logon, restarts on failure)."
Write-Host "Start it now with:  Start-ScheduledTask -TaskName cordless"
