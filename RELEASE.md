# Agent Notify — Release guide

Maintainer notes for building and publishing the private release.

## Prerequisites

- Windows 10/11
- Node.js 22+ (24 recommended)
- JDK 21
- Android SDK with platform 36 and build-tools
- `gh` authenticated to the repo
- Tailscale installed and online for the self-tests

The build script auto-detects:

- `JAVA_HOME`, or `C:\Program Files\Android\openjdk\jdk-21.0.8`, or Android
  Studio's JBR.
- `ANDROID_HOME`, or `%LOCALAPPDATA%\Android\Sdk`.
- A local Gradle 8.14.8 install, or `android\gradlew.bat`.

## Versioning

`VERSION` stores the current version, initially `1.0.0`.

```powershell
.\Build-Release.ps1
# uses the VERSION file

.\Build-Release.ps1 -Version 1.1.0
# builds 1.1.0 and updates VERSION
```

The Android `versionName` and `versionCode` are derived from the version:

- `1.0.0` → versionCode `10000`
- `1.2.3` → versionCode `10203`

## Release keystore

The first build creates:

```text
%USERPROFILE%\.agent-notify\agent-notify-release.jks
%USERPROFILE%\.agent-notify\keystore.properties
```

The keystore signs every APK. Back it up somewhere safe and private.

- **Never commit it.**
- **Never put it in `publish/`.**
- If it is lost, existing users cannot install an update over the app; they
  must uninstall first.

The build script passes the values to Gradle through environment variables:

```text
AGENT_NOTIFY_KEYSTORE
AGENT_NOTIFY_KEYSTORE_PASSWORD
AGENT_NOTIFY_KEY_ALIAS
AGENT_NOTIFY_KEY_PASSWORD
```

## Build

```powershell
.\Build-Release.ps1
```

The script:

1. Reads/updates `VERSION`.
2. Runs `npm ci`.
3. Runs `npm run selftest` and `npm run selftest:alarm` unless `-SkipTests`.
4. Builds a signed `assembleRelease` APK.
5. Stages `publish/agent-notify-<version>/`.
6. Bundles `runtime\node.exe` unless `-NoRuntime`.
7. Installs production `node_modules` into the bundle.
8. Adds `Setup.cmd`, `setup.ps1`, `Uninstall.cmd`, `Test.cmd`,
   `Test-Alarm.cmd`, the tray app, docs, config example, and the APK.
9. Creates the Windows zip, standalone APK, SHA256 checksums, and release
   notes.

Useful switches:

```powershell
.\Build-Release.ps1 -SkipTests
.\Build-Release.ps1 -NoRuntime       # smaller zip; requires Node on the user's PC
.\Build-Release.ps1 -Version 1.0.1
.\Build-Release.ps1 -Version 1.1.0 -Publish
```

## Publish to GitHub

The repository is private. Only people with repo access can download assets.

First-time setup:

```powershell
git init
git add .
git commit -m "Release 1.0.0"
gh repo create agent-notify --private --source . --remote origin --push
```

Then:

```powershell
.\Build-Release.ps1 -Version 1.0.0 -Publish
```

That creates a **draft** release `v1.0.0` with:

- `agent-notify-1.0.0-windows.zip`
- `agent-notify-1.0.0.apk`
- `SHA256SUMS.txt`

Review the draft on GitHub and publish it.

If you prefer to create the release manually:

```powershell
gh release create v1.0.0 `
  publish/agent-notify-1.0.0-windows.zip `
  publish/agent-notify-1.0.0.apk `
  publish/SHA256SUMS.txt `
  --draft `
  --title "Agent Notify 1.0.0" `
  --notes-file publish/release-notes.md
```

## What goes in git

Commit:

- Source, scripts, docs, Gradle files
- `VERSION`
- `package.json`, `package-lock.json`
- `.gitignore`

Never commit:

- `publish/`
- `dist/`
- `node_modules/`
- Android build output
- `android/local.properties`
- `*.jks`, `*.keystore`, `keystore.properties`
- `%USERPROFILE%\.agent-notify\config.json`
- tokens, QR codes, API keys

## Verifying the APK signature

```powershell
& "$env:LOCALAPPDATA\Android\Sdk\build-tools\35.0.0\apksigner.bat" verify --print-certs `
  publish\agent-notify-1.0.0.apk
```

The certificate should be the same across every release.

## GitHub Actions (optional)

The current flow builds and publishes locally. If you add CI later:

- Store the keystore as a base64 secret.
- Store the keystore properties as secrets.
- Use a Windows runner with the Android SDK.
- Build on tags matching `v*`.
- Upload the same assets to the release.

Because the repository is private, Actions minutes are consumed.

## Release checklist

- [ ] `VERSION` is correct.
- [ ] Keystore backup still exists.
- [ ] `npm run selftest` passes.
- [ ] `npm run selftest:alarm` passes.
- [ ] `.\Build-Release.ps1` succeeds.
- [ ] Zip contains `runtime\node.exe`, `app\*.apk`, `node_modules`, `Setup.cmd`.
- [ ] APK verifies against the expected certificate.
- [ ] `git status` has no secrets or build output.
- [ ] Commit and push.
- [ ] `-Publish` creates a draft release.
- [ ] Download the draft zip and APK, install, and test on a clean phone if
      possible.
- [ ] Publish the release.
