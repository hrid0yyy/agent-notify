param([switch]$SelfTest)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ConfigPath = Join-Path $env:USERPROFILE ".agent-notify\config.json"
if (-not (Test-Path $ConfigPath)) {
    Write-Error "Missing $ConfigPath. Run Setup first."
    exit 1
}

$Config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$Base = $Config.url.TrimEnd("/")
$Base = $Base -replace '^ws://', 'http://' -replace '^wss://', 'https://'
$Headers = @{ Authorization = "Bearer $($Config.token)" }
$LogPath = Join-Path $env:USERPROFILE ".agent-notify\tray.log"
$script:Status = $null
$script:Tray = $null
$script:Timer = $null
$script:HeaderItem = $null
$script:AtDeskItem = $null
$script:AwayItem = $null
$script:NotificationsItem = $null
$script:AlarmMenu = $null
$script:AlarmOff = $null
$script:AlarmOn = $null
$script:Alarm30 = $null

function Write-Log {
    param([string]$Message)
    try {
        Add-Content -Path $LogPath -Value "$(Get-Date -Format o) $Message"
    } catch {
        # Logging must never break the tray.
    }
}

function Invoke-Bridge {
    param(
        [string]$Method = "Get",
        [string]$Path,
        [hashtable]$Body = @{}
    )
    $params = @{
        Uri = "$Base$Path"
        Method = $Method
        Headers = $Headers
        TimeoutSec = 5
    }
    if ($Method -ne "Get") {
        $params.ContentType = "application/json"
        $params.Body = ($Body | ConvertTo-Json -Compress)
    }
    Invoke-RestMethod @params
}

function New-DotIcon {
    param([System.Drawing.Color]$Color)
    $bitmap = New-Object System.Drawing.Bitmap 32, 32
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $brush = New-Object System.Drawing.SolidBrush $Color
    $graphics.FillEllipse($brush, 3, 3, 26, 26)
    $inner = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(210, 11, 17, 23))
    $graphics.FillEllipse($inner, 12, 12, 8, 8)
    $brush.Dispose()
    $inner.Dispose()
    $graphics.Dispose()
    $handle = $bitmap.GetHicon()
    $icon = [System.Drawing.Icon]::FromHandle($handle)
    $bitmap.Dispose()
    return $icon
}

$Icons = @{
    Desk = New-DotIcon ([System.Drawing.Color]::FromArgb(125, 139, 148))
    Away = New-DotIcon ([System.Drawing.Color]::FromArgb(111, 211, 199))
    Alarm = New-DotIcon ([System.Drawing.Color]::FromArgb(242, 122, 112))
    Offline = New-DotIcon ([System.Drawing.Color]::FromArgb(80, 92, 101))
}

function Get-Status {
    try {
        $script:Status = Invoke-Bridge -Path "/status"
    } catch {
        $script:Status = $null
    }
}

if ($SelfTest) {
    Get-Status
    if ($script:Status) {
        $script:Status | ConvertTo-Json -Depth 5
        exit 0
    }
    Write-Error "Bridge not reachable at $Base"
    exit 1
}

$mutex = New-Object System.Threading.Mutex($false, "Local\AgentNotifyTray")
if (-not $mutex.WaitOne(0)) {
    exit 0
}
Write-Log "Tray started (pid $PID)"

function Update-Tray {
    Get-Status
    if (-not $script:Tray) { return }

    if (-not $script:Status) {
        $script:Tray.Icon = $Icons.Offline
        $script:Tray.Text = "Agent Notify - bridge offline"
        $script:HeaderItem.Text = "Agent Notify - offline"
        $script:NotificationsItem.Text = "Notifications: bridge offline"
        $script:AlarmMenu.Enabled = $false
        return
    }

    $presence = $script:Status.presence
    $alarmMode = $script:Status.alarmMode
    $atDesk = $presence -eq "desk"
    $pending = $script:Status.pending

    if ($script:Status.activeAlarm) {
        $script:Tray.Icon = $Icons.Alarm
        $script:Tray.Text = "Agent Notify - alarm active"
        $script:HeaderItem.Text = "Agent Notify - alarm active"
    } elseif ($atDesk) {
        $script:Tray.Icon = $Icons.Desk
        $script:Tray.Text = "Agent Notify - at desk, muted"
        $script:HeaderItem.Text = "Agent Notify - at desk, muted"
    } else {
        $script:Tray.Icon = $Icons.Away
        $script:Tray.Text = "Agent Notify - away, $pending pending"
        $script:HeaderItem.Text = "Agent Notify - away, $pending pending"
    }

    $script:AtDeskItem.Checked = $atDesk
    $script:AwayItem.Checked = -not $atDesk
    $script:NotificationsItem.Text = if ($atDesk) {
        "Notifications and questions: Off at desk"
    } else {
        "Notifications and questions: On"
    }

    $script:AlarmMenu.Enabled = -not $atDesk
    $alarmLabel = switch ($alarmMode) {
        "on" { "On" }
        "timed" { "30 minutes" }
        default { "Off" }
    }
    $script:AlarmMenu.Text = "Urgent alarms: $alarmLabel"
    $script:AlarmOff.Checked = ($alarmMode -eq "off")
    $script:AlarmOn.Checked = ($alarmMode -eq "on")
    $script:Alarm30.Checked = ($alarmMode -eq "timed")
}

function Set-Presence {
    param([string]$Mode)
    try {
        Invoke-Bridge -Method Post -Path "/presence" -Body @{ mode = $Mode } | Out-Null
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            "Could not reach the bridge at $Base.",
            "Agent Notify",
            "OK",
            "Warning"
        ) | Out-Null
    }
    Update-Tray
}

function Set-Alarm {
    param([string]$Mode, [int]$Minutes = 0)
    try {
        Invoke-Bridge -Method Post -Path "/alarm" -Body @{
            mode = $Mode
            minutes = $Minutes
        } | Out-Null
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            "Alarms cannot be enabled while at the desk.",
            "Agent Notify",
            "OK",
            "Warning"
        ) | Out-Null
    }
    Update-Tray
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$script:HeaderItem = New-Object System.Windows.Forms.ToolStripMenuItem
$script:HeaderItem.Text = "Agent Notify"
$script:HeaderItem.Enabled = $false
[void]$menu.Items.Add($script:HeaderItem)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$script:AtDeskItem = New-Object System.Windows.Forms.ToolStripMenuItem
$script:AtDeskItem.Text = "At desk - mute everything"
$script:AtDeskItem.Add_Click({ Set-Presence "desk" })
[void]$menu.Items.Add($script:AtDeskItem)

$script:AwayItem = New-Object System.Windows.Forms.ToolStripMenuItem
$script:AwayItem.Text = "Away - notifications on"
$script:AwayItem.Add_Click({ Set-Presence "away" })
[void]$menu.Items.Add($script:AwayItem)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$script:NotificationsItem = New-Object System.Windows.Forms.ToolStripMenuItem
$script:NotificationsItem.Text = "Notifications and questions: On"
$script:NotificationsItem.Enabled = $false
[void]$menu.Items.Add($script:NotificationsItem)

$script:AlarmMenu = New-Object System.Windows.Forms.ToolStripMenuItem
$script:AlarmMenu.Text = "Urgent alarms: Off"

$script:AlarmOff = New-Object System.Windows.Forms.ToolStripMenuItem
$script:AlarmOff.Text = "Off"
$script:AlarmOff.Add_Click({ Set-Alarm "off" 0 })
[void]$script:AlarmMenu.DropDownItems.Add($script:AlarmOff)

$script:AlarmOn = New-Object System.Windows.Forms.ToolStripMenuItem
$script:AlarmOn.Text = "On"
$script:AlarmOn.Add_Click({ Set-Alarm "on" 0 })
[void]$script:AlarmMenu.DropDownItems.Add($script:AlarmOn)

$script:Alarm30 = New-Object System.Windows.Forms.ToolStripMenuItem
$script:Alarm30.Text = "On for 30 minutes"
$script:Alarm30.Add_Click({ Set-Alarm "timed" 30 })
[void]$script:AlarmMenu.DropDownItems.Add($script:Alarm30)

[void]$menu.Items.Add($script:AlarmMenu)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$openItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openItem.Text = "Open config folder"
$openItem.Add_Click({ Start-Process explorer.exe (Join-Path $env:USERPROFILE ".agent-notify") })
[void]$menu.Items.Add($openItem)

$quitItem = New-Object System.Windows.Forms.ToolStripMenuItem
$quitItem.Text = "Quit"
$quitItem.Add_Click({
    Write-Log "Tray quit (pid $PID)"
    if ($script:Tray) { $script:Tray.Visible = $false; $script:Tray.Dispose() }
    if ($script:Timer) { $script:Timer.Stop(); $script:Timer.Dispose() }
    [System.Windows.Forms.Application]::Exit()
})
[void]$menu.Items.Add($quitItem)

$script:Tray = New-Object System.Windows.Forms.NotifyIcon
$script:Tray.Icon = $Icons.Offline
$script:Tray.Text = "Agent Notify"
$script:Tray.Visible = $true
$script:Tray.ContextMenuStrip = $menu
$script:Tray.Add_MouseDoubleClick({ Start-Process explorer.exe (Join-Path $env:USERPROFILE ".agent-notify") })

$script:Timer = New-Object System.Windows.Forms.Timer
$script:Timer.Interval = 2000
$script:Timer.Add_Tick({
    try {
        Update-Tray
    } catch {
        Write-Log "Timer error: $($_.Exception.Message)"
    }
})
$script:Timer.Start()

$hostForm = New-Object System.Windows.Forms.Form
$hostForm.ShowInTaskbar = $false
$hostForm.WindowState = "Minimized"
$hostForm.Opacity = 0
$hostForm.Show()
Update-Tray
[System.Windows.Forms.Application]::Run($hostForm)
