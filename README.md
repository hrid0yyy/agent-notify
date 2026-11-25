# Agent Notify

Phone notifications, remote approvals, and urgent alarms for coding agents,
over your own Tailscale network.

Claude Code and OpenCode can reach you when they finish, fail, need a
permission, or need a decision. Approvals can be answered from the lock screen;
if you ignore an urgent request, the phone can ring and show a full-screen
alarm.

```
Claude Code hooks ─┐
OpenCode plugin  ──┼──▶ bridge (HTTP + WebSocket) ──▶ Android app
MCP notify/ask   ──┘          │
                              └──▶ pending answers ──▶ hook/plugin/MCP call
```

## Features

- **Task finished / failed notifications** from Claude Code and OpenCode.
- **Permission approvals** with Allow / Deny from the notification shade.
- **Free-text answers** for open-ended agent questions.
- **Urgent escalation:** after an unanswered request, the phone wakes, plays
  the alarm stream, vibrates, and shows a full-screen approval card over the
  lock screen.
- **One global alarm slot.** Normal notifications are unlimited, but only one
  agent can own the alarm at a time. Others are told `busy` and still get a
  normal notification.
- **Guardrails:** per-agent/project cooldowns, hourly/daily budgets, a maximum
  lease, a global gap, and an unanswered-alarm penalty.
- **Source labels:** project in the title, agent in the subtext, agent-colored
  icon.
- **Tailscale-only networking.** No public ports, no FCM, no cloud push service.
- **MCP tools** for explicit notifications and blocking questions:
  `notify_user` and `ask_user`.
- **One-click Windows installer** with bundled Node, autostart, agent hooks,
  APK installation, and a setup QR.

## Quick start (release bundle)

1. Download `agent-notify-<version>-windows.zip` from the private GitHub
   Releases page.
2. Extract it anywhere.
3. Double-click **`Setup.cmd`**.
4. Scan the setup QR with the phone camera, or let the installer configure the
   phone over ADB.
5. Allow notifications and disable battery optimization for Agent Notify and
   Tailscale.

See [SETUP.md](SETUP.md) for the full end-user guide.

## What Setup does

- Detects Tailscale and chooses a direct tailnet connection or an existing
  Tailscale Serve HTTPS endpoint.
- Copies the app to `%LOCALAPPDATA%\AgentNotify` so the extracted release can
  be moved or deleted afterward.
- Writes `~/.agent-notify/config.json` with a new token.
- Installs the OpenCode plugin and MCP server.
- Merges Claude Code hooks and installs its MCP server.
- Installs a hidden bridge supervisor at Windows logon.
- Starts the bridge and verifies its health.
- Installs the APK and sends the setup deep link when a phone is connected;
  otherwise it opens a setup QR in Paint.

The setup QR carries:

```text
agentnotify://setup?url=<bridge-url>&token=<token>
```

The app saves it and connects immediately. Keep that QR private.

## Phone app

- Foreground WebSocket with reconnect/backoff and boot restart.
- High-priority approval channel, quiet completion channel.
- Action buttons, free-text replies, private lock-screen body.
- Full-screen urgent alarm with **Snooze 5 minutes** and **Stop alarming**.
- Project-first titles: `agent-notify · Claude finished` with `Claude Code`
  underneath.
- Battery-optimization and full-screen-alarm shortcuts in the app.

## Agent integration

### Claude Code

Hooks are installed by Setup:

- `Stop` → finished
- `StopFailure` → error
- `Notification` → idle / permission / agent-needs-input
- `PermissionRequest` → Allow / Deny from the phone

Permission hooks wait up to 10 minutes (`permissionWaitSeconds` 600) while the
alarm escalates. The desktop prompt remains available.

### OpenCode

The global plugin reports:

- `session.execution.succeeded` → finished
- `session.execution.failed` → error
- `permission.asked` → Allow / Deny
- `permission.replied` → cancels the phone prompt if answered on desktop

### MCP

```json
{
  "question": "Deploy to production?",
  "options": ["Deploy", "Hold off"],
  "urgent": true,
  "escalate_after_seconds": 30
}
```

`ask_user` blocks until the phone answers or the timeout expires. If the alarm
slot is busy or the agent is over budget, the result includes a note such as:

```text
Alarm not armed: busy (held by claude-code/agent-notify). The question was
still delivered as a normal notification; retry after about 184s.
```

## Escalation

Defaults live in `~/.agent-notify/config.json`:

```json
{
  "afterSeconds": 120,
  "repeatSeconds": 60,
  "maxRings": 3,
  "ringDurationSeconds": 45,
  "leaseSeconds": 300,
  "cooldownSeconds": 600,
  "maxPerHour": 3,
  "maxPerDay": 10,
  "minGapSeconds": 30,
  "unansweredPenaltySeconds": 1800
}
```

- The first ring is after `afterSeconds`.
- The lease caps how long one request can own the global slot.
- `cooldownSeconds` and the hourly/daily limits are per agent + project.
- `unansweredPenaltySeconds` applies after an alarm exhausts its rings or lease
  without an answer.
- Snooze releases the slot; the question re-requests it when the snooze ends
  without consuming another budget credit.
- Set `"enabled": false` to disable alarms while keeping normal notifications.

## Networking

The bridge binds to the machine's Tailscale IPv4 address. The phone uses that
address, so it works from any network as long as both devices are on the same
tailnet. Traffic is encrypted by WireGuard. A bearer token protects the API in
addition to Tailscale ACLs.

If Tailscale Serve is enabled for port 8787, Setup uses the HTTPS
`*.ts.net` URL instead.

## Security

- Private tailnet only; do not expose the bridge publicly.
- Random bearer token in `~/.agent-notify/config.json` and the app.
- Do not share the setup QR; it contains the token.
- Notification bodies use private lock-screen visibility; the urgent alarm
  intentionally shows over the lock screen.
- Do not commit tokens, keystores, or local config.
- The release keystore is required for APK updates; back it up.

## Development

```powershell
npm install
npm run bridge                 # start the bridge
npm run test:event             # one notification
npm run test:alarm             # 10-second escalation test
npm run selftest               # bridge + WebSocket + ask round-trip
npm run selftest:alarm         # singleton lease/budget/expiry test
```

Android build:

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\openjdk\jdk-21.0.8"
cd android
C:\Users\USER\.local\gradle-8.14.8\bin\gradle.bat assembleDebug
```

## Release build

```powershell
.\Build-Release.ps1
# uses VERSION (1.0.0)

.\Build-Release.ps1 -Version 1.1.0
# builds and stores 1.1.0

.\Build-Release.ps1 -Version 1.1.0 -Publish
# builds and creates a draft private GitHub release
```

Artifacts land in `publish/`:

- `agent-notify-<version>-windows.zip`
- `agent-notify-<version>.apk`
- `SHA256SUMS.txt`
- `release-notes.md`

See [RELEASE.md](RELEASE.md) for signing, keystore backup, private-repo setup,
and the release checklist.

## Troubleshooting

- **App says Offline / retrying** — check Tailscale on both devices and the
  bridge health URL. Battery optimization is the usual culprit on Android.
- **No full-screen alarm** — grant Full-screen notifications in Android
  settings. The app shows the current status in its settings card.
- **Alarm is silent in DND** — alarm audio uses the alarm stream; Do Not
  Disturb must allow alarms, or the phone must grant notification-policy
  access.
- **`busy` alarm** — another agent owns the single alarm slot. The question is
  still in your normal notifications.
- **Agent waits a long time** — permission wait is 600 seconds by default so
  the alarm has time to escalate. Lower `permissionWaitSeconds` and the Claude
  hook timeout if you prefer faster failures.
- **Signature mismatch installing an APK** — uninstall the old app first; the
  release APK uses a dedicated signing key.

## Version

The current version is in [VERSION](VERSION). The Android app displays it at the
bottom of the settings screen.
