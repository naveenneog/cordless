# Chocolatey package for cordless

This folder builds the [Chocolatey](https://chocolatey.org) package for the **cordless CLI**. The
package doesn't bundle the binary — it downloads the official self-contained CLI zip from the matching
GitHub release, verifies its SHA256, extracts it, and lets Chocolatey shim `cordless.exe` onto `PATH`.

```
packaging/chocolatey/
  cordless.nuspec                 # package metadata (id, version, description, license, icon)
  tools/chocolateyInstall.ps1     # download + verify + unzip + ignore-shim the node-pty helper exes
  tools/chocolateyUninstall.ps1   # stop the daemon + remove autostart, then Chocolatey removes files
  tools/VERIFICATION.txt          # how to verify the download against the official release (required)
  tools/LICENSE.txt               # PolyForm Noncommercial 1.0.0 (required by the community repo)
  update-checksum.ps1             # bump version + refresh the SHA256 for a new release
```

## Build + test locally

```powershell
# 1. refresh version + checksum for the release you're packaging (downloads the zip, hashes it)
pwsh packaging/chocolatey/update-checksum.ps1 -Version 0.9.0

# 2. pack
choco pack packaging/chocolatey/cordless.nuspec --outputdirectory $env:TEMP\cordless-choco

# 3. install from the local source (downloads the real release zip, verifies, shims)
choco install cordless --source "$env:TEMP\cordless-choco" --yes

# 4. verify
cordless --version          # -> cordless 0.9.0
cordless                    # dashboard + pairing QR

# 5. uninstall
choco uninstall cordless --yes
```

Verified: the checksum matches, **only `cordless.exe` is shimmed** (the bundled node-pty helper exes —
`OpenConsole.exe`, `winpty-agent.exe` — get `.ignore` files so they don't leak onto `PATH`), and the
shimmed binary finds its `resources/` (node-pty) and spawns PTYs correctly.

### `cordless start` under the shim (first-run slowness, not a hang)

`cordless start` launches the daemon as a detached child whose stdio is redirected to
`~/.cordless/daemon.log` (not the shim's pipes), so the shim returns as soon as the launcher exits —
verified through a real shimgen shim, including with a custom `CORDLESS_HOME`: `start` returned, the
daemon ran under the right home, stayed up, and served PTY sessions. `cordless`, `cordless start`, and
`cordless install` are all safe under the shim.

The one thing to expect: the **very first** `cordless start` after install can take ~10–15s before it
returns, because Windows (Defender / SmartScreen) scans the ~100 MB self-contained exe before Node even
begins executing. That is the OS scanning the binary, not the launcher waiting on the daemon — it is a
one-time cost and subsequent runs are fast. (An earlier build tried a WMI job-object breakaway to
"fix" this; it turned out to be unnecessary and it dropped `CORDLESS_HOME`, so a plain detached spawn is
used instead.)

## Publishing

You need a Chocolatey account (<https://community.chocolatey.org>) and its API key
(<https://community.chocolatey.org/account>). There are two ways to publish.

### A. Via CI (recommended) — `.github/workflows/choco-publish.yml`

1. Add the API key as a repo secret named **`CHOCO_API_KEY`** (Settings → Secrets and variables →
   Actions → New repository secret), or with the CLI:

   ```powershell
   gh secret set CHOCO_API_KEY --repo naveenneog/cordless   # prompts for the value (never echoed)
   ```

2. Publish a version — either automatically (the workflow runs on every published GitHub release and
   waits for the CLI zip to finish uploading) or manually:

   ```powershell
   gh workflow run "Publish to Chocolatey" -f version=0.9.0
   ```

   The job re-computes the release zip's SHA256, packs, and `choco push`es with the secret. The key
   never leaves GitHub Actions.

### B. Manually (local)

```powershell
choco apikey add -s "https://push.chocolatey.org/" -k="<YOUR_API_KEY>"   # once, stored in choco config
pwsh packaging/chocolatey/update-checksum.ps1 -Version 0.9.0
choco pack packaging/chocolatey/cordless.nuspec --outputdirectory $env:TEMP\cordless-choco
choco push $env:TEMP\cordless-choco\cordless.0.9.0.nupkg --source https://push.chocolatey.org/
```

### Moderation notes for cordless

- The package goes through **automated + human moderation** (the first version of a new package id
  always gets a manual review, so allow some time).
- License is **PolyForm Noncommercial 1.0.0** (source-available, free for noncommercial use — *not*
  OSI-approved). Declare it honestly; `LICENSE.txt` + `VERIFICATION.txt` are included as required.
- The binary is downloaded from the official GitHub release with a pinned SHA256 (moderation checks
  `VERIFICATION.txt`).
- Bump `<version>` in the nuspec + the `url64bit`/`checksum64` in `chocolateyInstall.ps1` for every
  release (use `update-checksum.ps1`, or let the CI workflow do it).
