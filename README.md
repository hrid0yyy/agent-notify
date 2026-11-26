# Agent Notify

Phone notifications, remote approvals, and urgent alarms for coding agents,
over your own Tailscale network.

Claude Code, OpenCode, Gemini CLI, and Antigravity (`agy`) can reach you when
they finish, fail, need a permission, or need a decision. Approvals can be
answered from the lock screen; if you ignore an urgent request, the phone can
ring and show a full-screen alarm.

```
Claude Code hooks     ─┐
OpenCode plugin       ─┤
Gemini / Antigravity  ─┼──▶ bridge (HTTP + WebSocket) ──▶ Android app
MCP notify/ask        ─┘          │
                                  └──▶ pending answers ──▶ hook/plugin/MCP call
```

## Features

- **Task finished / failed notifications** from Claude Code, OpenCode, Gemini
  CLI, and Antigravity.
- **Permission approvals** with Allow / Deny from the notification shade.
- **Free-text answers** for open-ended agent questions.
- **Presence control:** **At desk** mutes the phone completely; **Away**
  delivers notifications and questions. Switch from the phone app or the
  Windows tray.
- **Alarm control:** while Away, urgent alarms are **Off / On / 30 min**.
  At desk they are forced off and cannot be enabled.
- **Windows tray:** presence, alarm mode, pending state, and quick access to
  the config folder.
- **Urgent escalation:** after an unanswered request, the phone wakes, plays
  the alarm stream, vibrates, and shows a full-screen approval card over the
  lock screen.
- **One global alarm slot.** Normal notifications are unlimited, but only one
  agent can own the alarm at a time. Others are told `busy` and still get a
  normal notification.
- **At desk / Away** from the phone or tray; At desk mutes everything and
  resets alarms to Off.
- **Away** keeps notifications and questions on; only alarms need a choice.
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

1. Download `agent-notify-<version>-windows.zip` from the
   [latest release](https://github.com/hrid0yyy/agent-notify/releases/latest).
2. Extract it anywhere.
3. Double-click **`Setup.cmd`**.
4. On the setup page that opens, scan QR 1 to install the app and QR 2 to pair,
   then tap **Connect** on the phone. With ADB connected, the installer does
   the install for you and you only tap **Connect**.
5. Allow notifications and disable battery optimization for Agent Notify and
   Tailscale.

See [SETUP.md](SETUP.md) for the full end-user guide.

## Set it up with an agent

Copy this prompt into Claude Code, OpenCode, Gemini CLI, Antigravity (`agy`),
Codex, or any agent with PowerShell access on your Windows machine:

> Set up Agent Notify on this Windows machine.
>
> 1. Download the newest `agent-notify-*-windows.zip` from
>    https://github.com/hrid0yyy/agent-notify/releases/latest and extract it to
>    a temporary folder.
> 2. Run
>    `powershell.exe -NoProfile -ExecutionPolicy Bypass -File setup.ps1`
>    from the extracted folder. Do not use `Setup.cmd`; it pauses on errors.
>    Setup checks Tailscale first. If it says Tailscale is missing, ask me
>    before installing it, then rerun with `setup.ps1 --install-tailscale`. If it
>    opens a Tailscale sign-in page, tell me to sign in and wait.
> 3. If an Android phone is connected over ADB, let Setup install the APK and
>    tell me to tap **Connect** on the phone. Otherwise, Setup opens a page with
>    two QR codes: tell me to scan the first to install the app and the second
>    to pair, then tap **Connect**. Wait until I confirm.
> 4. Verify the bridge health URL that Setup prints, and confirm that the
>    bridge and tray are running.
> 5. Tell me the bridge URL, which agent integrations were installed, and
>    anything that still needs my input.
>
> Do not print the token or the QR contents in chat. Do not remove existing
> agent settings; only add the `agent-notify` entries. Keep the generated
> config and backups in place.

The agent handles the download, install, agent config files, bridge health, and
phone handoff. You still sign in to Tailscale (on the PC and in the Tailscale
app on the phone, same account), scan the QR codes, approve the Android
install, and tap **Connect** on the phone.

## What Setup does

- Checks Tailscale before changing anything: offers to install it with winget
  if missing, opens the sign-in page if logged out, and stops with clear steps
  if it still is not connected.
- Detects Tailscale and chooses a direct tailnet connection or an existing
  Tailscale Serve HTTPS endpoint.
- Copies the app to `%LOCALAPPDATA%\AgentNotify` so the extracted release can
  be moved or deleted afterward.
- Writes `~/.agent-notify/config.json` with a new token.
- Installs the OpenCode plugin and MCP server.
- Merges Claude Code hooks and installs its MCP server.
- Adds the Gemini CLI MCP server and its `AfterAgent` / `Notification` hooks.
- Adds the Antigravity MCP server and its `Stop` hook.
- Installs a hidden bridge supervisor and the Windows tray at logon.
- Starts the bridge and tray, then verifies the bridge health.
- Installs the APK and sends the setup deep link when a phone is connected;
  otherwise it opens a setup page with an install QR (APK download) and a
  pairing QR. Either way the app asks you to confirm before pairing.

The setup QR carries:

```text
agentnotify://setup?url=<bridge-url>&token=<token>
```

The app saves it and connects immediately. Keep that QR private.

## Presence and alarms

**Presence** is the master switch:

- **At desk** — notifications, questions, hooks, and alarms are all off.
  Alarm mode is reset to **Off** and the controls are disabled.
  `ask_user` returns immediately with “ask in the conversation.”
- **Away** — notifications and questions are on automatically. There is no
  toggle and no per-call approval. Alarms are the only setting.

**Alarms** have exactly three states while Away:

- **Off** — urgent requests become normal notifications; the agent is told the
  alarm was not armed.
- **On** — alarms stay enabled until you turn them off.
- **On for 30 minutes** — expires automatically.

At desk, alarms are forced off and cannot be enabled. Switching At desk always
resets the alarm setting to Off. Switching back to Away leaves alarms Off until
you choose otherwise.

Use the phone app or the Windows tray. Agents cannot change presence or alarm
mode.

Agents are instructed not to use Agent Notify on their own; only when the user
asks. Hooks (`Stop`, `Notification`, `PermissionRequest`, Gemini `AfterAgent`,
Antigravity `Stop`, OpenCode execution events) simply follow **Away / At desk**.

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

### Gemini CLI

Setup adds the MCP server and two hooks to `~/.gemini/settings.json`:

- `AfterAgent` → finished
- `Notification` → permission prompts and other Gemini alerts

Gemini permission notifications are informational; answer them in the terminal.
Use the `ask_user` MCP tool when you want an answer from the phone.

### Antigravity

Setup adds the MCP server to `~/.gemini/config/mcp_config.json` and a `Stop`
hook to `~/.gemini/config/hooks.json` (and the CLI hooks file when present):

- `Stop` → finished, paused with background work, or stopped with an error

Antigravity hooks are observational. Use the `ask_user` MCP tool for questions
that need a phone answer.

### MCP

```json
{
  "question": "Deploy to production?",
  "options": ["Deploy", "Hold off"],
  "urgent": true,
  "escalate_after_seconds": 30
}
```

`notify_user` and `ask_user` work whenever you are Away; they are suppressed or
fail fast at the desk. `ask_user` blocks until the phone answers or the timeout
expires. If the alarm slot is busy, alarms are off, or the agent is over
budget, the result includes a note such as:

```text
Alarm not armed: busy (held by claude-code/agent-notify). The question was
still delivered as a normal notification; retry after about 184s.
```

When alarms are Off, the note is simply: “The alarm was not armed because alarms
are off.”

## Escalation

Escalation only runs while you are **Away** and alarms are **On** or **On for
30 minutes**. At desk, or with alarms Off, an urgent request becomes a normal
notification.

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
# builds and creates a draft GitHub release
```

Artifacts land in `publish/`:

- `agent-notify-<version>-windows.zip`
- `agent-notify-<version>.apk`
- `SHA256SUMS.txt`
- `release-notes.md`

See [RELEASE.md](RELEASE.md) for signing, keystore backup, repository setup,
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
