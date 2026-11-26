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
 * --release also checks Tailscale (signs in if needed), installs the autostart
 * supervisor, starts the bridge, and installs/configures the phone over ADB or
 * shows a setup page with install and pairing QR codes.
 *
 * --install-tailscale lets Setup install Tailscale with winget when it is
 * missing, without asking (for agents running Setup non-interactively).
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

const TAILSCALE_DOWNLOAD = "https://tailscale.com/download/windows";

/**
 * Path to the Tailscale CLI, or null. Falls back to the default install
 * folder because a fresh install is not on this process's PATH yet.
 */
function tailscaleExe() {
  const override = process.env.AGENT_NOTIFY_TAILSCALE_EXE;
  if (override) return fs.existsSync(override) ? override : null;
  if (commandExists("tailscale")) return "tailscale";
  if (process.platform === "win32") {
    for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      if (!base) continue;
      const candidate = path.join(base, "Tailscale", "tailscale.exe");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** { state, ip, authUrl } where state is Tailscale's BackendState or "NoService". */
function tailscaleState(exe) {
  try {
    const raw = execFileSync(exe, ["status", "--json"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const status = JSON.parse(raw);
    const ip = (status.Self?.TailscaleIPs || status.TailscaleIPs || []).find((value) =>
      /^\d+\.\d+\.\d+\.\d+$/.test(value),
    ) || "";
    return {
      state: status.BackendState || "Unknown",
      ip: status.BackendState === "Running" ? ip : "",
      authUrl: status.AuthURL || "",
    };
  } catch (error) {
    // `status` exits non-zero when stopped or logged out but still prints JSON.
    const text = String(error.stdout || "");
    try {
      const status = JSON.parse(text);
      return { state: status.BackendState || "Unknown", ip: "", authUrl: status.AuthURL || "" };
    } catch {
      return { state: "NoService", ip: "", authUrl: "" };
    }
  }
}

async function askYesNo(question) {
  if (!process.stdin.isTTY) return false;
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function openInBrowser(target) {
  if (process.platform !== "win32") return;
  const child = spawn("explorer.exe", [target], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

function stopForTailscale(message) {
  console.error(`\n${message}`);
  console.error("Nothing was changed. Run Setup again once Tailscale is ready.");
  process.exit(2);
}

function installTailscaleWithWinget() {
  if (!commandExists("winget")) {
    stopForTailscale(
      `winget is not available, so Tailscale cannot be installed automatically.\nInstall it from ${TAILSCALE_DOWNLOAD}`,
    );
  }
  console.log("Installing Tailscale with winget (Windows may ask for permission)...");
  try {
    execFileSync(
      "winget",
      [
        "install",
        "--id",
        "Tailscale.Tailscale",
        "--exact",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
      ],
      { stdio: "inherit" },
    );
  } catch {
    // winget returns non-zero for "already installed"; check below instead.
  }
  const exe = tailscaleExe();
  if (!exe) {
    stopForTailscale(`Tailscale did not install. Install it from ${TAILSCALE_DOWNLOAD}`);
  }
  console.log("Tailscale installed.");
  return exe;
}

/**
 * Release setup needs a working tailnet address: without one the pairing QR
 * would point the phone at 127.0.0.1. Install (with consent) and sign in
 * before anything is changed on this machine.
 */
async function ensureTailscale() {
  console.log("Checking Tailscale...");
  let exe = tailscaleExe();
  if (!exe) {
    console.log("Tailscale is not installed. Agent Notify uses it to reach your phone privately.");
    const install =
      has("--install-tailscale") ||
      (await askYesNo("Install Tailscale now with winget?"));
    if (!install) {
      stopForTailscale(
        `Install Tailscale from ${TAILSCALE_DOWNLOAD}\n` +
          "or run Setup again with --install-tailscale to install it with winget.",
      );
    }
    exe = installTailscaleWithWinget();
  }

  let status = tailscaleState(exe);
  if (status.ip) {
    console.log(`Tailscale connected: ${status.ip}`);
    return;
  }

  if (status.state === "NoService" && process.platform === "win32") {
    // The background service or tray app may not be running yet.
    const folder = exe === "tailscale"
      ? path.join(process.env.ProgramFiles || "C:\\Program Files", "Tailscale")
      : path.dirname(exe);
    const gui = path.join(folder, "tailscale-ipn.exe");
    if (fs.existsSync(gui)) {
      const app = spawn(gui, [], { detached: true, stdio: "ignore" });
      app.on("error", () => {});
      app.unref();
    }
    for (let i = 0; i < 10 && status.state === "NoService"; i += 1) {
      await sleep(1000);
      status = tailscaleState(exe);
    }
    if (status.state === "NoService") {
      stopForTailscale(
        "The Tailscale service is not running. Open the Tailscale app (or restart the PC) and try again.",
      );
    }
  }

  console.log("Tailscale is not connected. Opening the Tailscale sign-in...");
  console.log("Sign in in your browser with the same account you will use on your phone.");
  // `tailscale up` connects, or prints a login URL and waits for sign-in.
  let opened = "";
  const openUrl = (candidate) => {
    if (!candidate || candidate === opened) return;
    opened = candidate;
    console.log(`  Sign-in link: ${candidate}`);
    openInBrowser(candidate);
  };
  openUrl(status.authUrl);
  const up = spawn(exe, ["up"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  up.on("error", () => {});
  const onOutput = (chunk) => openUrl(String(chunk).match(/https:\/\/\S+/)?.[0]);
  up.stdout?.on("data", onOutput);
  up.stderr?.on("data", onOutput);

  const waitSeconds = Number(process.env.AGENT_NOTIFY_TAILSCALE_WAIT || 300);
  const deadline = Date.now() + waitSeconds * 1000;
  let lastNotice = Date.now();
  while (Date.now() < deadline) {
    await sleep(2000);
    status = tailscaleState(exe);
    if (status.ip) break;
    openUrl(status.authUrl);
    if (Date.now() - lastNotice > 30_000) {
      lastNotice = Date.now();
      console.log("  Still waiting for Tailscale sign-in...");
    }
  }
  if (up.exitCode === null) up.kill();
  if (!status.ip) {
    stopForTailscale(
      "Tailscale did not connect. Open the Tailscale app, sign in, make sure it says Connected, then run Setup again.",
    );
  }
  console.log(`Tailscale connected: ${status.ip}`);
}

function tailnetInfo() {
  const info = { dns: "", ip: "", serve: false };
  const tailscale = tailscaleExe() || "tailscale";
  try {
    const raw = execFileSync(tailscale, ["status", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    info.dns = JSON.parse(raw).Self?.DNSName?.replace(/\.$/, "") || "";
  } catch {
    // Tailscale may not be installed or logged in.
  }
  try {
    info.ip = execFileSync(tailscale, ["ip", "-4"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split(/\r?\n/)[0];
  } catch {
    // fall through
  }
  try {
    const status = execFileSync(tailscale, ["serve", "status"], {
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

const RELEASES_URL = "https://github.com/hrid0yyy/agent-notify/releases";

/** Direct download link for the APK that matches this bundle's version. */
function apkDownloadUrl() {
  const pkg = readJson(path.join(SOURCE_ROOT, "package.json"), {});
  const version = /^\d+\.\d+\.\d+$/.test(pkg.version || "") ? pkg.version : "";
  return version
    ? `${RELEASES_URL}/download/v${version}/agent-notify-${version}.apk`
    : `${RELEASES_URL}/latest`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function setupPageHtml(installQr, pairQr, apkUrl) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Notify - phone setup</title>
<style>
  body { margin: 0; font: 16px/1.5 system-ui, "Segoe UI", sans-serif; background: #0b0f14; color: #e6edf3; }
  main { max-width: 980px; margin: 0 auto; padding: 32px 24px 48px; }
  h1 { font-size: 26px; margin: 0 0 6px; }
  .lead { color: #9aa7b4; margin: 0 0 28px; }
  .steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
  section { background: #141a21; border: 1px solid #222b35; border-radius: 14px; padding: 22px; }
  h2 { font-size: 19px; margin: 0 0 4px; }
  .step { color: #7ce38b; font-size: 13px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
  img { display: block; width: 100%; max-width: 340px; margin: 16px auto; background: #fff; border-radius: 10px; }
  ol { margin: 0; padding-left: 20px; color: #c5cfd9; }
  li { margin: 4px 0; }
  a { color: #8ab4f8; word-break: break-all; }
  .note { margin-top: 24px; color: #9aa7b4; font-size: 14px; }
</style>
</head>
<body>
<main>
  <h1>Set up your phone</h1>
  <p class="lead">Install Tailscale from the Play Store first and sign in with the same account as this PC.</p>
  <div class="steps">
    <section>
      <div class="step">Step 1</div>
      <h2>Install the app</h2>
      <img src="${installQr}" alt="QR code that downloads the Agent Notify app">
      <ol>
        <li>Scan with the phone camera and download the APK.</li>
        <li>Open it. If Android asks, allow installing apps from your browser.</li>
        <li>Already installed? Skip to step 2.</li>
      </ol>
      <p class="note">Link: <a href="${escapeHtml(apkUrl)}">${escapeHtml(apkUrl)}</a></p>
    </section>
    <section>
      <div class="step">Step 2</div>
      <h2>Pair with this PC</h2>
      <img src="${pairQr}" alt="QR code that pairs the app with this PC">
      <ol>
        <li>Scan with the phone camera.</li>
        <li>Agent Notify opens. Tap <b>Connect</b>.</li>
        <li>Allow notifications when asked.</li>
      </ol>
    </section>
  </div>
  <p class="note">Keep the step 2 code private: it contains your bridge token. Close this page when you are done.</p>
</main>
</body>
</html>
`;
}

function openFile(file) {
  if (process.platform !== "win32") return;
  const child = spawn("explorer.exe", [file], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

async function showSetupQr() {
  const uri = setupUri();
  const apkUrl = apkDownloadUrl();
  const qrPath = path.join(CONFIG_DIR, "setup-qr.png");
  const pagePath = path.join(CONFIG_DIR, "setup-qr.html");
  const qrOptions = {
    width: 760,
    margin: 2,
    color: { dark: "#000000", light: "#FFFFFF" },
  };
  try {
    const QRCode = (await import("qrcode")).default;
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    await QRCode.toFile(qrPath, uri, qrOptions);
    const installQr = await QRCode.toDataURL(apkUrl, qrOptions);
    const pairQr = await QRCode.toDataURL(uri, qrOptions);
    fs.writeFileSync(pagePath, setupPageHtml(installQr, pairQr, apkUrl), "utf8");
    console.log(`
Set up the phone (page opened in your browser):
  ${pagePath}
  1. Install the app : scan the first QR, or open ${apkUrl}
  2. Pair            : scan the second QR, then tap Connect on the phone
  Pairing QR image   : ${qrPath}`);
    openFile(pagePath);
  } catch {
    console.log("\nCould not generate the setup QR codes; enter the settings manually.");
    console.log(`  Install the app from: ${apkUrl}`);
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
    console.log("Pairing link opened on the phone. Tap Connect on the phone to finish.");
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

if (releaseMode && !valueOf("--url")) {
  await ensureTailscale();
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
    const output = execFileSync(tailscaleExe() || "tailscale", ["serve", "--bg", "8787"], {
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
phone  : ${phoneConfigured ? "installed; tap Connect on the phone to finish" : "follow the 2 steps on the setup page"}

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
