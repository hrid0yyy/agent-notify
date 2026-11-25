# Removes the per-user autostart entry and stops the Agent Notify bridge.
# Application data, config, and the Android app are left in place.
$ErrorActionPreference = "Stop"

$Startup = [Environment]::GetFolderPath("Startup")
foreach ($name in @("AgentNotifyBridge.vbs", "AgentNotifyTray.vbs")) {
    $vbs = Join-Path $Startup $name
    if (Test-Path $vbs) {
        Remove-Item -Force $vbs
        Write-Output "Removed $vbs"
    }
}

$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*agent-notify*bridge\start.mjs*" -or $_.CommandLine -like "*agent-notify*bridge/start.mjs*" }
foreach ($proc in $procs) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Output "Stopped bridge process $($proc.ProcessId)"
}

$trayProcs = Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like "*AgentNotifyTray.ps1*" }
foreach ($proc in $trayProcs) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Output "Stopped tray process $($proc.ProcessId)"
}

$Installed = Join-Path $env:LOCALAPPDATA "AgentNotify"
if (Test-Path $Installed) {
    Remove-Item -Recurse -Force $Installed -ErrorAction SilentlyContinue
    Write-Output "Removed installed files: $Installed"
}

Write-Output ""
Write-Output "Agent Notify bridge autostart removed."
Write-Output "Config kept at $env:USERPROFILE\.agent-notify\config.json"
Write-Output "To remove the Android app: adb uninstall dev.hridoy.agentnotify"
