#!/usr/bin/env node
/**
 * Pair an Android phone over wireless ADB using a QR code.
 *
 *   npm run pair:qr
 *   npm run pair:qr -- --connect 100.74.63.46:43793 --install
 *
 * The phone must be on the same network (Wi-Fi or Tailscale) and have
 * Wireless debugging enabled.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (flag) => args.includes(flag);
const timeoutSeconds = Number(valueOf("--timeout") || 90);
const connectOverride = valueOf("--connect");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const name = `agent-notify-${randomBytes(3).toString("hex")}`;
const code = String(randomInt(100000, 1_000_000));
const payload = `WIFI:T:ADB;S:${name};P:${code};;`;

let QRCode;
try {
  QRCode = (await import("qrcode")).default;
} catch {
  console.error("The `qrcode` package is missing. Run: npm install");
  process.exit(1);
}

const qrPath = path.join(ROOT, "dist", "pair-qr.png");
fs.mkdirSync(path.dirname(qrPath), { recursive: true });
await QRCode.toFile(qrPath, payload, {
  width: 720,
  margin: 2,
  color: { dark: "#000000", light: "#FFFFFF" },
});

console.log(`
QR pairing
----------
1. On the phone: Developer options > Wireless debugging
2. Tap "Pair device with QR code"
3. Scan the QR window that just opened on this PC.

Service: ${name}
Code:    ${code}
`);

if (!has("--no-open")) {
  const command = process.platform === "win32" ? "mspaint.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const opener = spawn(command, [qrPath], { detached: true, stdio: "ignore" });
  opener.unref();
}

function adb(args, options = {}) {
  return execFileSync("adb", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function mdnsServices() {
  try {
    return adb(["mdns", "services"]);
  } catch {
    return "";
  }
}

function findService(text, type) {
  const line = text
    .split(/\r?\n/)
    .find((candidate) => candidate.includes(type));
  if (!line) return undefined;
  const match = line.match(/(\d{1,3}(?:\.\d{1,3}){3}:\d+)/);
  return match?.[1];
}

let pairingAddress;
for (let elapsed = 0; elapsed < timeoutSeconds; elapsed += 1) {
  const text = mdnsServices();
  pairingAddress = findService(text, "_adb-tls-pairing._tcp");
  if (pairingAddress) break;
  if (elapsed > 0 && elapsed % 15 === 0) {
    console.log(`Still waiting for the phone… ${timeoutSeconds - elapsed}s left`);
  }
  await sleep(1000);
}

if (!pairingAddress) {
  console.error(`
No pairing service appeared. Common causes:
  - The QR was not scanned, or the scanner is still open.
  - The PC and phone are on different networks (Wi-Fi, guest Wi-Fi, or one is offline).
  - mDNS is blocked on this Wi-Fi. In that case use Android Studio's
    Device Manager > Pair using QR code, or connect USB and run:
      adb tcpip 5555
      adb connect <phone-ip>:5555
`);
  process.exit(1);
}

console.log(`Found pairing service at ${pairingAddress}. Pairing…`);
try {
  const output = adb(["pair", pairingAddress, code]);
  console.log(output.trim());
} catch (error) {
  console.error(`Pairing failed: ${error.stderr || error.message}`);
  process.exit(1);
}

let connectAddress = connectOverride;
if (!connectAddress) {
  for (let i = 0; i < 10; i += 1) {
    connectAddress = findService(mdnsServices(), "_adb-tls-connect._tcp");
    if (connectAddress) break;
    await sleep(500);
  }
}

if (!connectAddress) {
  console.log(`
Paired, but I could not discover the normal ADB port automatically.
On the phone, look at the main Wireless debugging screen for "IP address and port"
and run:
  adb connect <that-ip>:<that-port>
`);
  process.exit(0);
}

console.log(`Connecting to ${connectAddress}…`);
try {
  console.log(adb(["connect", connectAddress]).trim());
} catch (error) {
  console.error(`adb connect failed: ${error.stderr || error.message}`);
}

const devices = adb(["devices", "-l"]).trim();
console.log(devices);

if (has("--install")) {
  const serial = devices
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[0])
    .find((value) => value && value.includes(":"));
  const apk = path.join(ROOT, "dist", "agent-notify-debug.apk");
  if (!serial) {
    console.error("No network ADB device found; skipping install.");
    process.exit(1);
  }
  if (!fs.existsSync(apk)) {
    console.error(`APK not found at ${apk}`);
    process.exit(1);
  }
  console.log(`Installing ${apk} on ${serial}…`);
  console.log(adb(["-s", serial, "install", "-r", apk], { stdio: "inherit" }));
}
