# Running cordless at login

Keep the agent daemon alive across reboots so your phone can always reach it. Pick your platform.
Always run as your **normal user** — never root/Administrator; a paired device has your shell access.

## Linux — systemd (user)

```bash
mkdir -p ~/.config/systemd/user
cp install/cordless.service ~/.config/systemd/user/cordless.service
# edit ExecStart if cordless isn't at ~/cordless
systemctl --user daemon-reload
systemctl --user enable --now cordless
loginctl enable-linger "$USER"        # keep running after you log out
journalctl --user -u cordless -f      # logs
```

## macOS — launchd

```bash
# edit the node path and the index.js path inside the plist first
cp install/com.naveenneog.cordless.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.naveenneog.cordless.plist
# stop: launchctl unload -w ~/Library/LaunchAgents/com.naveenneog.cordless.plist
```

## Windows — Task Scheduler

```powershell
powershell -ExecutionPolicy Bypass -File install\register-task.ps1
Start-ScheduledTask -TaskName cordless
# remove: Unregister-ScheduledTask -TaskName cordless -Confirm:$false
```

## Remote access

For access from anywhere, run [Tailscale](https://tailscale.com) on the dev box and phone, and add a
tailnet ACL that only lets your own devices reach TCP `7443`. On Windows, allow inbound `7443` on the
Tailscale interface. Then `cordless pair` prints a `*.ts.net` URL.
