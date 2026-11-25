# Removes the per-user autostart entry and stops the Agent Notify bridge.
# Application data, config, and the Android app are left in place.
$ErrorActionPreference = "Stop"

$Startup = [Environment]::GetFolderPath("Startup")
$Vbs = Join-Path $Startup "AgentNotifyBridge.vbs"
if (Test-Path $Vbs) {
    Remove-Item -Force $Vbs
    Write-Output "Removed $Vbs"
}

$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*agent-notify*bridge\start.mjs*" -or $_.CommandLine -like "*agent-notify*bridge/start.mjs*" }
foreach ($proc in $procs) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Output "Stopped bridge process $($proc.ProcessId)"
}

Write-Output ""
Write-Output "Agent Notify bridge autostart removed."
Write-Output "Config kept at $env:USERPROFILE\.agent-notify\config.json"
Write-Output "To remove the Android app: adb uninstall dev.hridoy.agentnotify"
