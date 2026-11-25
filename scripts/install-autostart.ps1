# Installs a hidden per-user startup supervisor for the Agent Notify bridge.
# No admin rights required. Remove it with .\uninstall-autostart.ps1.
$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Node = (Get-Command node -ErrorAction Stop).Source
$Startup = [Environment]::GetFolderPath("Startup")
$VbsPath = Join-Path $Startup "AgentNotifyBridge.vbs"

$escapedRoot = $Root.Replace('"', '""')
$escapedNode = $Node.Replace('"', '""')

$vbs = @"
' Agent Notify bridge supervisor (generated)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$escapedRoot"
Do
  sh.Run """$escapedNode"" ""bridge\start.mjs""", 0, True
  WScript.Sleep 5000
Loop
"@

Set-Content -Path $VbsPath -Value $vbs -Encoding ASCII
Write-Output "Installed startup supervisor: $VbsPath"
Write-Output "It starts the bridge hidden at logon and restarts it if it exits."
