#!/usr/bin/env node
/**
 * Agent Notify setup.
 *
 * Development:
 *   node scripts/setup.mjs
 *   node scripts/setup.mjs --apply
 *
 * End-user release bundle:
 *   node scripts/setup.mjs --release
 *
 * --release also installs the autostart supervisor, starts the bridge, and
 * installs/configures the phone over ADB or shows a setup QR.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  installAntigravityIntegration,
  installGeminiIntegration,
} from "../lib/integrations.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = ROOT;
let APP_ROOT = ROOT;
const CONFIG_DIR = path.join(os.homedir(), ".agent-notify");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const releaseMode = has("--release");
const apply = has("--apply") || releaseMode;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tailnetInfo() {
  const info = { dns: "", ip: "", serve: false };
  try {
    const raw = execFileSync("tailscale", ["status", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    info.dns = JSON.parse(raw).Self?.DNSName?.replace(/\.$/, "") || "";
  } catch {
    // Tailscale may not be installed or logged in.
  }
  try {
    info.ip = execFileSync("tailscale", ["ip", "-4"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split(/\r?\n/)[0];
  } catch {
    // fall through
  }
  try {
    const status = execFileSync("tailscale", ["serve", "status"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    info.serve = status.includes("8787") && !status.includes("No serve config");
  } catch {
    info.serve = false;
  }
  return info;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function backup(file) {
  if (!fs.existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(file, `${file}.bak-agent-notify-${stamp}`);
}

function commandExists(command) {
  try {
    if (process.platform === "win32") {
      execFileSync("where", [command], { stdio: "ignore" });
    } else {
      execFileSync("which", [command], { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
}

function windowsStartupDir() {
  return path.join(
    process.env.APPDATA ||
      path.join(os.homedir(), "AppData", "Roaming"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
  );
}

function bridgeSupervisorRunning() {
  if (process.platform !== "win32") return false;
  try {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "if (Get-CimInstance Win32_Process -Filter \"Name='wscript.exe'\" | Where-Object { $_.CommandLine -like '*AgentNotifyBridge.vbs*' }) { 'yes' } else { 'no' }",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return output === "yes";
  } catch {
    return false;
  }
}

function installAutostart() {
  if (process.platform !== "win32") return;
  const startup = windowsStartupDir();
  fs.mkdirSync(startup, { recursive: true });
  const vbsPath = path.join(startup, "AgentNotifyBridge.vbs");
  const installedNode = path.join(APP_ROOT, "runtime", "node.exe");
  const nodeExe = (fs.existsSync(installedNode) ? installedNode : process.execPath)
    .replaceAll('"', '""');
  const root = APP_ROOT.replaceAll('"', '""');
  const vbs = `' Agent Notify bridge supervisor (generated)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "${root}"
Do
  sh.Run """${nodeExe}"" ""bridge\\start.mjs""", 0, True
  WScript.Sleep 5000
Loop
`;
  fs.writeFileSync(vbsPath, vbs, "ascii");
  console.log(`Startup supervisor: ${vbsPath}`);

  const trayScript = path.join(APP_ROOT, "tray", "AgentNotifyTray.ps1");
  if (fs.existsSync(trayScript)) {
    const trayVbsPath = path.join(startup, "AgentNotifyTray.vbs");
    const trayVbs = `' Agent Notify tray (generated)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "${root}"
sh.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""tray\\AgentNotifyTray.ps1""", 0, False
`;
    fs.writeFileSync(trayVbsPath, trayVbs, "ascii");
    console.log(`Tray supervisor: ${trayVbsPath}`);
  }
}

function stopTray() {
  if (process.platform !== "win32") return;
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*AgentNotifyTray.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ],
      { stdio: "ignore" },
    );
  } catch {
    // Best effort.
  }
}

function startTray() {
  if (process.platform !== "win32") return;
  stopTray();
  const startup = path.join(
    process.env.APPDATA ||
      path.join(os.homedir(), "AppData", "Roaming"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
  );
  const trayVbs = path.join(startup, "AgentNotifyTray.vbs");
  if (fs.existsSync(trayVbs)) {
    spawn("wscript.exe", [trayVbs], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    console.log("Tray started.");
    return;
  }
  const trayScript = path.join(APP_ROOT, "tray", "AgentNotifyTray.ps1");
  if (!fs.existsSync(trayScript)) return;
  spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-WindowStyle",
      "Hidden",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      trayScript,
    ],
    { detached: true, stdio: "ignore", windowsHide: true },
  ).unref();
  console.log("Tray started.");
}

async function isHealthy() {
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(1200),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureBridge() {
  if (await isHealthy()) {
    console.log(`Bridge already running: ${url}`);
    return true;
  }

  if (process.platform === "win32") {
    const supervisor = path.join(windowsStartupDir(), "AgentNotifyBridge.vbs");
    if (fs.existsSync(supervisor)) {
      if (bridgeSupervisorRunning()) {
        console.log("Bridge supervisor is already running.");
      } else {
        spawn("wscript.exe", [supervisor], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        }).unref();
        console.log("Bridge supervisor started.");
      }
      for (let i = 0; i < 40; i += 1) {
        await sleep(500);
        if (await isHealthy()) {
          console.log(`Bridge started: ${url}`);
          return true;
        }
      }
      console.error(
        `Bridge did not become healthy at ${url}. The supervisor will keep retrying; check Tailscale.`,
      );
      return false;
    }
  }

  const installedNode = path.join(APP_ROOT, "runtime", "node.exe");
  const child = spawn(
    fs.existsSync(installedNode) ? installedNode : process.execPath,
    [path.join(APP_ROOT, "bridge", "start.mjs")],
    {
      cwd: APP_ROOT,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref();
  for (let i = 0; i < 30; i += 1) {
    await sleep(500);
    if (await isHealthy()) {
      console.log(`Bridge started: ${url}`);
      return true;
    }
  }
  console.error(`Bridge did not become healthy at ${url}`);
  return false;
}

function findApk() {
  const directories = [path.join(SOURCE_ROOT, "app"), path.join(SOURCE_ROOT, "dist")];
  for (const directory of directories) {
    if (!fs.existsSync(directory)) continue;
    const apk = fs
      .readdirSync(directory)
      .filter((name) => name.toLowerCase().endsWith(".apk"))
      .map((name) => path.join(directory, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (apk) return apk;
  }
  return null;
}

function findAdbSerial() {
  if (!commandExists("adb")) return null;
  try {
    const output = execFileSync("adb", ["devices"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = output
      .split(/\r?\n/)
      .find((candidate) => /\tdevice\b/.test(candidate) && !candidate.includes("offline"));
    return line?.split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

function setupUri() {
  const params = new URLSearchParams({ url, token });
  return `agentnotify://setup?${params.toString()}`;
}

async function showSetupQr() {
  const uri = setupUri();
  const qrPath = path.join(CONFIG_DIR, "setup-qr.png");
  try {
    const QRCode = (await import("qrcode")).default;
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    await QRCode.toFile(qrPath, uri, {
      width: 760,
      margin: 2,
      color: { dark: "#000000", light: "#FFFFFF" },
    });
    console.log(`\nScan this QR with the phone camera:\n  ${qrPath}`);
    if (process.platform === "win32") {
      spawn("mspaint.exe", [qrPath], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    console.log("\nCould not generate a QR image; enter the settings manually.");
  }
  console.log(`\nManual setup:`);
  console.log(`  Bridge URL : ${url}`);
  console.log(`  Token      : ${token}`);
}

async function installAndConfigurePhone(apk) {
  const serial = findAdbSerial();
  if (!serial) return false;
  console.log(`Phone found over ADB: ${serial}`);
  let installed = false;
  try {
    const output = execFileSync(
      "adb",
      ["-s", serial, "install", "-r", apk],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    installed = /Success/i.test(output);
    console.log(output.trim());
  } catch (error) {
    const detail = String(error.stderr || error.message || "");
    if (detail.includes("UPDATE_INCOMPATIBLE") || detail.includes("signatures")) {
      console.error(
        "The existing app was signed with a different key. Uninstall the old Agent Notify app, then run setup again.",
      );
    } else {
      console.error(`ADB install failed: ${detail.trim()}`);
    }
  }
  if (!installed) return false;
  for (const args of [
    ["shell", "pm", "grant", "dev.hridoy.agentnotify", "android.permission.POST_NOTIFICATIONS"],
    ["shell", "cmd", "deviceidle", "whitelist", "+dev.hridoy.agentnotify"],
    ["shell", "cmd", "appops", "set", "dev.hridoy.agentnotify", "USE_FULL_SCREEN_INTENT", "allow"],
  ]) {
    try {
      execFileSync("adb", ["-s", serial, ...args], { stdio: "ignore" });
    } catch {
      // Permission names differ across Android releases; the app can still ask.
    }
  }
  try {
    const uri = setupUri();
    execFileSync(
      "adb",
      [
        "-s",
        serial,
        "shell",
        `am start -a android.intent.action.VIEW -d '${uri}'`,
      ],
      { stdio: "inherit" },
    );
    console.log("Phone configured from the setup deep link.");
    return true;
  } catch (error) {
    console.error(`Could not open the setup deep link: ${error.message}`);
    return false;
  }
}

function installClaudeMcp() {
  if (!commandExists("claude")) return;
  try {
    execFileSync("claude", ["mcp", "remove", "agent-notify", "-s", "user"], {
      stdio: "ignore",
    });
  } catch {
    // Not installed yet.
  }
  try {
    execFileSync(
      "claude",
      ["mcp", "add", "--scope", "user", "agent-notify", "--", node, mcpScript],
      { stdio: "inherit" },
    );
  } catch (error) {
    console.error(`Could not add Claude Code MCP automatically: ${error.message}`);
    console.error(
      `Run: claude mcp add --scope user agent-notify -- "${node}" "${mcpScript}"`,
    );
  }
}

const existing = readJson(CONFIG_PATH, {});
const tailnet = tailnetInfo();
const detectedUrl = tailnet.serve && tailnet.dns
  ? `https://${tailnet.dns}`
  : tailnet.ip
    ? `http://${tailnet.ip}:8787`
    : "";
const url = (
  valueOf("--url") ||
  detectedUrl ||
  existing.url ||
  "http://127.0.0.1:8787"
).replace(/\/+$/, "");
const token = has("--rotate")
  ? randomBytes(32).toString("hex")
  : existing.token || randomBytes(32).toString("hex");
const permissionWaitSeconds = Math.max(
  Number(existing.permissionWaitSeconds || 0),
  600,
);
const escalationDefaults = {
  enabled: true,
  afterSeconds: 120,
  repeatSeconds: 60,
  maxRings: 3,
  ringDurationSeconds: 45,
  leaseSeconds: 300,
  cooldownSeconds: 600,
  maxPerHour: 3,
  maxPerDay: 10,
  minGapSeconds: 30,
  unansweredPenaltySeconds: 1800,
  quietHours: {
    enabled: false,
    start: "22:00",
    end: "08:00",
    allowUrgent: true,
  },
};

writeJson(CONFIG_PATH, {
  url,
  token,
  port: existing.port || 8787,
  permissionWaitSeconds,
  escalation: {
    ...escalationDefaults,
    ...(existing.escalation || {}),
    quietHours: {
      ...escalationDefaults.quietHours,
      ...(existing.escalation?.quietHours || {}),
    },
  },
});

if (releaseMode && process.platform === "win32") {
  const localAppData =
    process.env.LOCALAPPDATA ||
    path.join(os.homedir(), "AppData", "Local");
  const target = path.join(localAppData, "AgentNotify");
  if (path.resolve(target) !== path.resolve(ROOT)) {
    if (fs.existsSync(target)) {
      const escaped = target.replaceAll("'", "''");
      try {
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            `Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" | Where-Object { $_.CommandLine -like '*AgentNotifyBridge.vbs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${escaped}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
          ],
          { stdio: "ignore" },
        );
        await sleep(500);
      } catch {
        // Best effort. A locked file will surface as a copy error below.
      }
    }
    try {
      for (const item of [
        "runtime",
        "node_modules",
        "bridge",
        "mcp",
        "hooks",
        "lib",
        "opencode",
        "scripts",
        "tray",
      ]) {
        const source = path.join(ROOT, item);
        if (fs.existsSync(source)) {
          fs.cpSync(source, path.join(target, item), {
            recursive: true,
            force: true,
          });
        }
      }
      for (const file of ["package.json", "package-lock.json"]) {
        const source = path.join(ROOT, file);
        if (fs.existsSync(source)) {
          fs.mkdirSync(target, { recursive: true });
          fs.copyFileSync(source, path.join(target, file));
        }
      }
      APP_ROOT = target;
      console.log(`Application files installed: ${APP_ROOT}`);
    } catch (error) {
      console.error(
        `Could not install application files to ${target}: ${error.message}`,
      );
      console.error(
        "Close Agent Notify and any coding agent sessions, then run setup again.",
      );
      process.exit(1);
    }
  } else {
    APP_ROOT = target;
  }
}

// Always install the current plugin file so edits in the repo take effect.
const pluginSource = path.join(APP_ROOT, "opencode", "agent-notify.js");
const pluginTarget = path.join(
  os.homedir(),
  ".config",
  "opencode",
  "plugins",
  "agent-notify.js",
);
fs.mkdirSync(path.dirname(pluginTarget), { recursive: true });
fs.copyFileSync(pluginSource, pluginTarget);

const installedNode = path.join(APP_ROOT, "runtime", "node.exe");
const node = fs.existsSync(installedNode) ? installedNode : process.execPath;
const hookScript = path.join(APP_ROOT, "hooks", "claude-hook.mjs");
const geminiHookScript = path.join(APP_ROOT, "hooks", "gemini-hook.mjs");
const antigravityHookScript = path.join(APP_ROOT, "hooks", "antigravity-hook.mjs");
const mcpScript = path.join(APP_ROOT, "mcp", "server.mjs");

function claudeHooks() {
  const command = (event, timeout) => ({
    hooks: [{ type: "command", command: node, args: [hookScript, event], timeout }],
  });
  return {
    Stop: [command("Stop", 15)],
    StopFailure: [command("StopFailure", 15)],
    Notification: [
      {
        matcher:
          "permission_prompt|idle_prompt|agent_needs_input|agent_completed|elicitation_dialog|elicitation_url_dialog",
        hooks: [
          {
            type: "command",
            command: node,
            args: [hookScript, "Notification"],
            timeout: 15,
          },
        ],
      },
    ],
    PermissionRequest: [command("PermissionRequest", permissionWaitSeconds + 30)],
  };
}

if (apply) {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  if (fs.existsSync(path.dirname(settingsPath))) {
    const settings = readJson(settingsPath, {});
    backup(settingsPath);
    settings.hooks ||= {};
    for (const [event, groups] of Object.entries(claudeHooks())) {
      const current = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
      settings.hooks[event] = current
        .filter((group) => !JSON.stringify(group).includes("agent-notify"))
        .concat(groups);
    }
    writeJson(settingsPath, settings);
    console.log(`Claude Code hooks installed: ${settingsPath}`);
    installClaudeMcp();
  }

  const opencodePath = path.join(
    os.homedir(),
    ".config",
    "opencode",
    "opencode.json",
  );
  const opencode = readJson(opencodePath, null);
  if (opencode) {
    backup(opencodePath);
    opencode.mcp ||= {};
    opencode.mcp.servers ||= {};
    opencode.mcp.servers["agent-notify"] = {
      type: "local",
      command: [node, mcpScript],
      disabled: false,
      timeout: { execution: 900_000 },
    };
    writeJson(opencodePath, opencode);
    console.log(`OpenCode MCP server installed: ${opencodePath}`);
  }

  const gemini = installGeminiIntegration({
    node,
    mcpScript,
    hookScript: geminiHookScript,
  });
  if (gemini.installed) {
    console.log(`Gemini CLI integration installed: ${gemini.path}`);
  } else if (gemini.reason && !/not detected/i.test(gemini.reason)) {
    console.error(`Gemini CLI integration failed: ${gemini.reason}`);
  }

  const antigravity = installAntigravityIntegration({
    node,
    mcpScript,
    hookScript: antigravityHookScript,
  });
  if (antigravity.installed) {
    console.log(`Antigravity integration installed: ${antigravity.path}`);
    for (const hookPath of antigravity.hooks || []) {
      console.log(`Antigravity hooks: ${hookPath}`);
    }
  } else if (antigravity.reason && !/not detected/i.test(antigravity.reason)) {
    console.error(`Antigravity integration failed: ${antigravity.reason}`);
  }
}

if (has("--serve")) {
  try {
    const output = execFileSync("tailscale", ["serve", "--bg", "8787"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (output.trim()) console.log(output.trim());
    console.log(
      "Tailscale Serve is proxying https://<this-host>.<tailnet>.ts.net -> 127.0.0.1:8787",
    );
  } catch (error) {
    console.error(`tailscale serve failed: ${error.stderr || error.message}`);
    console.error("Run: tailscale serve --bg 8787");
  }
}

if (releaseMode) {
  installAutostart();
  const healthy = await ensureBridge();
  startTray();
  const apk = findApk();
  let phoneConfigured = false;
  if (apk) {
    phoneConfigured = await installAndConfigurePhone(apk);
  }
  if (!phoneConfigured) {
    await showSetupQr();
  }

  console.log(`
Agent Notify is ready
---------------------
config : ${CONFIG_PATH}
bridge : ${url}${healthy ? "  (running)" : "  (NOT running)"}
plugin : ${pluginTarget}
phone  : ${phoneConfigured ? "installed and configured" : "scan the QR above"}

The bridge also starts automatically at logon.
`);
} else {
  console.log(`
Agent Notify configured
-----------------------
config : ${CONFIG_PATH}
bridge : ${url}
plugin : ${pluginTarget}
hook   : ${hookScript}
mcp    : ${mcpScript}

Run the bridge in one terminal:
  cd "${ROOT}"
  npm run bridge

Then in the Android app, use:
  Bridge URL : ${url}
  Token      : ${token}

Claude Code MCP:
  claude mcp add --scope user agent-notify -- "${node}" "${mcpScript}"

Gemini CLI MCP:
  ${path.join(os.homedir(), ".gemini", "settings.json")}  (mcpServers.agent-notify)

Antigravity MCP:
  ${path.join(os.homedir(), ".gemini", "config", "mcp_config.json")}  (mcpServers.agent-notify)

Useful:
  npm run test:event              # one test notification
  node scripts/test-event.mjs --ask   # test Allow / Deny buttons
  npm run test:alarm                 # test the alarm
`);

  if (!apply) {
    console.log(`Claude Code hooks snippet (or re-run with --apply):\n`);
    console.log(JSON.stringify({ hooks: claudeHooks() }, null, 2));
  }
}
