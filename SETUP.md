# Agent Notify — Setup

This guide is for the person installing Agent Notify. You do not need to be a
developer, but you do need access to the private GitHub repository that hosts
the release.

## What you need

- A Windows 10 or Windows 11 PC.
- An Android phone (Android 8 or newer).
- A Tailscale account.
- Access to the private `agent-notify` GitHub repo.

## 1. Install Tailscale on both devices

Install Tailscale on the PC and on the phone, then sign in with the **same
account** on both.

- PC: https://tailscale.com/download/windows
- Android: Play Store → Tailscale

On the phone, open Tailscale and leave it connected. For reliable notifications,
enable **Always-on VPN** in Android's VPN settings.

## 2. Download the release

1. Open the private `agent-notify` GitHub repository.
2. Open **Releases**.
3. Download `agent-notify-<version>-windows.zip`.
4. Extract it anywhere temporary, for example:

   ```text
   C:\Users\<you>\Downloads\AgentNotify
   ```

Setup copies the application to `%LOCALAPPDATA%\AgentNotify`; you can move or
delete the extracted download afterward.

## 3. Run Setup

Double-click **`Setup.cmd`**.

If Windows SmartScreen appears, choose **More info → Run anyway**. The installer
does not need administrator rights.

Setup will:

- Detect Tailscale and choose the right bridge address.
- Create a private token and `~/.agent-notify/config.json`.
- Install the OpenCode plugin and MCP server.
- Merge Claude Code hooks and install its MCP server.
- Install a hidden bridge supervisor at logon.
- Start the bridge and check its health.
- Install and configure the phone if ADB is available, or open a setup QR.

Keep the setup QR private: it contains the bridge token.

## 4. Set up the phone

### If Setup detected the phone over ADB

The APK is already installed and the app is configured. Open **Agent Notify**.

### If Setup showed a QR

1. Make sure the APK is installed. If not, open the `app` folder in the
   extracted release and tap `agent-notify-<version>.apk`.
2. Allow installs from your file manager/browser.
3. Open the phone camera and scan the QR shown in Paint.
4. The Agent Notify app opens with the bridge URL and token filled in.

If the camera does not open the app, use the manual values printed by Setup,
or read them from:

```text
C:\Users\<you>\.agent-notify\config.json
```

### Allow the required permissions

In the app:

1. Tap **Save & connect** if the app is not already connected.
2. Allow **notifications**.
3. Tap **Battery** and disable battery optimization for Agent Notify.
4. Tap **Allow full-screen alarms** (Android 14+).
5. In Android settings, also disable battery optimization for **Tailscale**.

The status card should say **Connected**.

> The persistent **Agent Notify · Connected** notification is the foreground
> service that keeps the connection alive. It is expected.

## 5. Test it

In the extracted release folder, double-click:

- **`Test.cmd`** — sends one normal notification.
- **`Test-Alarm.cmd`** — sends an urgent request that rings after 10 seconds.

For the alarm test, the screen should wake, show the urgent card over the lock
screen, and ring. Use **Stop alarming** when finished.

## Where things live

| Item | Location |
| --- | --- |
| Installed app files | `%LOCALAPPDATA%\AgentNotify` |
| Bridge config/token | `%USERPROFILE%\.agent-notify\config.json` |
| Bridge log | not written unless you run it manually |
| OpenCode plugin | `%USERPROFILE%\.config\opencode\plugins\agent-notify.js` |
| OpenCode config | `%USERPROFILE%\.config\opencode\opencode.json` |
| Claude Code hooks | `%USERPROFILE%\.claude\settings.json` |
| Autostart | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\AgentNotifyBridge.vbs` |
| Android app | package `dev.hridoy.agentnotify` |

## Updating

1. Download the newer zip from Releases.
2. Extract it anywhere.
3. Close Claude Code / OpenCode if Setup reports locked files.
4. Run **`Setup.cmd`** again.
5. The existing token and app configuration are preserved.

APK updates require the same release signing key. Official releases keep that
key stable.

## Uninstalling

1. Run **`Uninstall.cmd`** to remove autostart and stop the bridge.
2. Uninstall **Agent Notify** from Android.
3. Optional: delete `%USERPROFILE%\.agent-notify`.
4. Optional: remove the Agent Notify entries from Claude Code and OpenCode
   config files. Setup made timestamped backups next to them.

## Troubleshooting

### Setup says Tailscale was not found or is offline

Install Tailscale on the PC, sign in, and run Setup again. The phone must be on
the same tailnet.

### The phone is not detected over ADB

That is fine. Install the APK manually and scan the setup QR. USB debugging or
wireless ADB is optional.

### The APK will not install

- Allow installs from unknown apps for the file manager/browser.
- If you previously installed a debug build, uninstall the old app first; the
  signing key differs.

### QR does not open the app

Install the APK first, then scan again. If your camera app does not handle
custom URLs, open the app and enter the URL/token manually from
`%USERPROFILE%\.agent-notify\config.json`.

### App says Offline / retrying

- Tailscale must be connected on both devices.
- Disable battery optimization for Agent Notify and Tailscale.
- Check that the PC is awake and the bridge is running.

### No full-screen alarm

Grant **Full-screen notifications** for Agent Notify in Android settings. The
app shows the current status on its settings screen. Alarm audio still uses the
alarm stream, but Do Not Disturb may suppress it unless alarms are allowed.

### Alarm says another agent is busy

Only one urgent alarm can run at a time. The other agent's question is still
delivered as a normal notification. It can retry after the retry window.

### An agent is waiting a long time

Permission requests wait up to 10 minutes by default so the alarm has time to
ring. If you prefer faster failure, lower `permissionWaitSeconds` in
`%USERPROFILE%\.agent-notify\config.json` and the Claude Code hook timeout in
`%USERPROFILE%\.claude\settings.json`.

## Privacy and security

- The bridge is reachable only over your tailnet and requires a bearer token.
- Do not expose port 8787 to the public internet.
- Do not share the setup QR or `config.json`; they contain the token.
- The urgent alarm intentionally shows over the lock screen.
- The release keystore is not included in the download.
