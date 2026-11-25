param(
    [string]$Version,
    [switch]$SkipTests,
    [switch]$Publish,
    [switch]$NoRuntime
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$VersionFile = Join-Path $Root "VERSION"

if (-not $Version) {
    if (Test-Path $VersionFile) {
        $Version = (Get-Content $VersionFile -Raw).Trim()
    } else {
        $Version = "1.0.0"
    }
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Version must be semantic: MAJOR.MINOR.PATCH (got '$Version')"
}
Set-Content -Path $VersionFile -Value $Version -Encoding ASCII

$parts = $Version.Split(".") | ForEach-Object { [int]$_ }
$VersionCode = ($parts[0] * 10000) + ($parts[1] * 100) + $parts[2]
Write-Host "Building Agent Notify $Version (versionCode $VersionCode)" -ForegroundColor Cyan

$Node = (Get-Command node -ErrorAction Stop).Source
$Npm = (Get-Command npm -ErrorAction Stop).Source

$JavaHome = $env:JAVA_HOME
if (-not $JavaHome -or -not (Test-Path (Join-Path $JavaHome "bin\java.exe"))) {
    $candidates = @(
        "C:\Program Files\Android\openjdk\jdk-21.0.8",
        "C:\Program Files\Android\Android Studio\jbr"
    )
    $JavaHome = $candidates | Where-Object { Test-Path (Join-Path $_ "bin\java.exe") } | Select-Object -First 1
}
if (-not $JavaHome) { throw "No JDK found. Set JAVA_HOME." }
$env:JAVA_HOME = $JavaHome
$env:Path = "$JavaHome\bin;$env:Path"

$Sdk = $env:ANDROID_HOME
if (-not $Sdk -or -not (Test-Path $Sdk)) {
    $Sdk = Join-Path $env:LOCALAPPDATA "Android\Sdk"
}
if (-not (Test-Path $Sdk)) { throw "Android SDK not found. Set ANDROID_HOME." }
$env:ANDROID_HOME = $Sdk
$env:ANDROID_SDK_ROOT = $Sdk

$Gradle = $null
$localGradle = Join-Path $env:USERPROFILE ".local\gradle-8.14.8\bin\gradle.bat"
if (Test-Path $localGradle) {
    $Gradle = $localGradle
} elseif (Test-Path (Join-Path $Root "android\gradlew.bat")) {
    $Gradle = Join-Path $Root "android\gradlew.bat"
}
if (-not $Gradle) { throw "Gradle not found." }

$KeystoreDir = Join-Path $env:USERPROFILE ".agent-notify"
$Keystore = Join-Path $KeystoreDir "agent-notify-release.jks"
$KeystoreProps = Join-Path $KeystoreDir "keystore.properties"
New-Item -ItemType Directory -Force -Path $KeystoreDir | Out-Null

if (-not (Test-Path $Keystore)) {
    Write-Host "Generating a new release keystore..." -ForegroundColor Yellow
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] 32
    $rng.GetBytes($bytes)
    $password = [Convert]::ToBase64String($bytes)
    $keytool = Join-Path $JavaHome "bin\keytool.exe"
    & $keytool -genkeypair -v `
        -keystore $Keystore `
        -alias agentnotify `
        -keyalg RSA -keysize 2048 -validity 10000 `
        -storepass $password -keypass $password `
        -dname "CN=Agent Notify, OU=Agent Notify, O=Agent Notify, L=Local, ST=Local, C=US"
    if ($LASTEXITCODE -ne 0) { throw "keytool failed" }
    @"
storeFile=$Keystore
storePassword=$password
keyAlias=agentnotify
keyPassword=$password
"@ | Set-Content -Path $KeystoreProps -Encoding ASCII
    Write-Host "Keystore created: $Keystore" -ForegroundColor Green
    Write-Host "BACK THIS UP. Losing it prevents future APK updates." -ForegroundColor Yellow
}

if (-not (Test-Path $KeystoreProps)) {
    throw "Keystore exists but $KeystoreProps is missing; restore the properties backup."
}
$props = @{}
Get-Content $KeystoreProps | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') { $props[$matches[1].Trim()] = $matches[2] }
}
$env:AGENT_NOTIFY_KEYSTORE = $props["storeFile"]
$env:AGENT_NOTIFY_KEYSTORE_PASSWORD = $props["storePassword"]
$env:AGENT_NOTIFY_KEY_ALIAS = $props["keyAlias"]
$env:AGENT_NOTIFY_KEY_PASSWORD = $props["keyPassword"]
if (-not $env:AGENT_NOTIFY_KEYSTORE -or -not $env:AGENT_NOTIFY_KEYSTORE_PASSWORD) {
    throw "Keystore properties are incomplete."
}

Push-Location $Root
try {
    & $Node (Join-Path $Root "scripts\set-version.mjs") $Version
    Write-Host "Installing dependencies..." -ForegroundColor Cyan
    & $Npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }

    if (-not $SkipTests) {
        Write-Host "Running bridge self-test..." -ForegroundColor Cyan
        & $Npm run selftest
        if ($LASTEXITCODE -ne 0) { throw "selftest failed" }
        Write-Host "Running alarm self-test..." -ForegroundColor Cyan
        & $Npm run selftest:alarm
        if ($LASTEXITCODE -ne 0) { throw "alarm selftest failed" }
    }
} finally {
    Pop-Location
}

Write-Host "Building signed release APK..." -ForegroundColor Cyan
Push-Location (Join-Path $Root "android")
try {
    & $Gradle --no-daemon `
        "-PagentNotifyVersionName=$Version" `
        "-PagentNotifyVersionCode=$VersionCode" `
        assembleRelease
    if ($LASTEXITCODE -ne 0) { throw "Gradle release build failed" }
} finally {
    Pop-Location
}

$Apk = Join-Path $Root "android\app\build\outputs\apk\release\app-release.apk"
if (-not (Test-Path $Apk)) { throw "Release APK not found at $Apk" }

$PublishRoot = Join-Path $Root "publish"
if (Test-Path $PublishRoot) {
    $escapedPublish = [regex]::Escape($PublishRoot)
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -match $escapedPublish } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    Start-Sleep -Milliseconds 800
    Remove-Item -Recurse -Force $PublishRoot
}
$Bundle = Join-Path $PublishRoot "agent-notify-$Version"
New-Item -ItemType Directory -Force -Path $Bundle | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Bundle "app") | Out-Null

foreach ($item in @("bridge", "mcp", "hooks", "lib", "opencode", "scripts")) {
    Copy-Item -Recurse -Force (Join-Path $Root $item) (Join-Path $Bundle $item)
}
foreach ($file in @("README.md", "SETUP.md", "RELEASE.md", "THIRD_PARTY_NOTICES.md", "VERSION", "config.example.json", "package.json", "package-lock.json")) {
    $source = Join-Path $Root $file
    if (Test-Path $source) { Copy-Item -Force $source (Join-Path $Bundle $file) }
}
Copy-Item -Force $Apk (Join-Path $Bundle "app\agent-notify-$Version.apk")

if (-not $NoRuntime) {
    $Runtime = Join-Path $Bundle "runtime"
    New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
    Copy-Item -Force $Node (Join-Path $Runtime "node.exe")
}

Write-Host "Installing production dependencies into the bundle..." -ForegroundColor Cyan
Push-Location $Bundle
try {
    & $Npm ci --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci --omit=dev failed in bundle" }
} finally {
    Pop-Location
}

$setupPs1 = @'
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = Join-Path $Root "runtime\node.exe"
if (-not (Test-Path $Node)) {
    $Node = (Get-Command node -ErrorAction Stop).Source
}
& $Node (Join-Path $Root "scripts\setup.mjs") --release
'@
Set-Content -Path (Join-Path $Bundle "setup.ps1") -Value $setupPs1 -Encoding ASCII

$setupCmd = @'
@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
if errorlevel 1 pause
'@
Set-Content -Path (Join-Path $Bundle "Setup.cmd") -Value $setupCmd -Encoding ASCII

$uninstallCmd = @'
@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall.ps1"
pause
'@
Set-Content -Path (Join-Path $Bundle "Uninstall.cmd") -Value $uninstallCmd -Encoding ASCII

$testCmd = @'
@echo off
setlocal
if exist "%~dp0runtime\node.exe" (
  set "NODE=%~dp0runtime\node.exe"
) else (
  set "NODE=node"
)
"%NODE%" "%~dp0scripts\test-event.mjs"
pause
'@
Set-Content -Path (Join-Path $Bundle "Test.cmd") -Value $testCmd -Encoding ASCII

$testAlarmCmd = @'
@echo off
setlocal
if exist "%~dp0runtime\node.exe" (
  set "NODE=%~dp0runtime\node.exe"
) else (
  set "NODE=node"
)
"%NODE%" "%~dp0scripts\test-event.mjs" --alarm
pause
'@
Set-Content -Path (Join-Path $Bundle "Test-Alarm.cmd") -Value $testAlarmCmd -Encoding ASCII

$zip = Join-Path $PublishRoot "agent-notify-$Version-windows.zip"
Write-Host "Creating $zip ..." -ForegroundColor Cyan
Compress-Archive -Path (Join-Path $Bundle "*") -DestinationPath $zip -CompressionLevel Optimal

$apkCopy = Join-Path $PublishRoot "agent-notify-$Version.apk"
Copy-Item -Force $Apk $apkCopy

$hashLines = @()
foreach ($file in @($zip, $apkCopy)) {
    $hash = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLower()
    $hashLines += "$hash  $([IO.Path]::GetFileName($file))"
}
Set-Content -Path (Join-Path $PublishRoot "SHA256SUMS.txt") -Value ($hashLines -join "`r`n") -Encoding ASCII

$notes = @"
# Agent Notify $Version

## Install

1. Download ``agent-notify-$Version-windows.zip``.
2. Extract it anywhere.
3. Double-click ``Setup.cmd``.
4. Setup copies the app to ``%LOCALAPPDATA%\AgentNotify``, installs autostart,
   configures Claude Code / OpenCode, starts the bridge, and sets up the phone
   over ADB or with a QR.
5. Allow notifications, then disable battery optimization for Agent Notify and Tailscale.

## Assets

- ``agent-notify-$Version-windows.zip`` - self-contained Windows bundle (Node runtime included)
- ``agent-notify-$Version.apk`` - Android APK
- ``SHA256SUMS.txt``

Keep the release keystore backed up. Losing it prevents future APK updates from installing over existing versions.
"@
Set-Content -Path (Join-Path $PublishRoot "release-notes.md") -Value $notes -Encoding ASCII

Write-Host ""
Write-Host "Release built:" -ForegroundColor Green
Write-Host "  Bundle : $Bundle"
Write-Host "  Zip    : $zip"
Write-Host "  APK    : $apkCopy"
Write-Host "  Hashes : $(Join-Path $PublishRoot 'SHA256SUMS.txt')"
Write-Host "  Notes  : $(Join-Path $PublishRoot 'release-notes.md')"

if ($Publish) {
    Write-Host ""
    Write-Host "Creating draft GitHub release v$Version..." -ForegroundColor Cyan
    Push-Location $Root
    try {
        & gh auth status | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "gh is not authenticated" }
        & gh release create "v$Version" `
            $zip $apkCopy (Join-Path $PublishRoot "SHA256SUMS.txt") `
            --draft `
            --title "Agent Notify $Version" `
            --notes-file (Join-Path $PublishRoot "release-notes.md")
        if ($LASTEXITCODE -ne 0) { throw "gh release create failed" }
        Write-Host "Draft release created. Review it, then publish from GitHub." -ForegroundColor Green
    } finally {
        Pop-Location
    }
}
