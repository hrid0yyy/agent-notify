# Removes the startup supervisor. The currently running bridge is not killed.
$ErrorActionPreference = "Stop"
$Startup = [Environment]::GetFolderPath("Startup")
$VbsPath = Join-Path $Startup "AgentNotifyBridge.vbs"
if (Test-Path $VbsPath) {
    Remove-Item $VbsPath -Force
    Write-Output "Removed $VbsPath"
} else {
    Write-Output "Startup supervisor was not installed."
}
