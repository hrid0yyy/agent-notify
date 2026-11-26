#!/usr/bin/env node
/**
 * Bind the bridge to the Tailscale IPv4 address, not the LAN.
 *
 *   HOST=127.0.0.1 npm run bridge   # local-only debugging
 *   HOST=0.0.0.0 npm run bridge     # all interfaces (not recommended)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// A fresh Tailscale install is not on PATH until the next logon, so also try
// the default install folder.
function tailscaleCommand() {
  if (process.platform === "win32") {
    for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      if (!base) continue;
      const candidate = path.join(base, "Tailscale", "tailscale.exe");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return "tailscale";
}

function tailscaleIpv4() {
  try {
    const value = execFileSync(tailscaleCommand(), ["ip", "-4"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split(/\r?\n/)[0];
    return value || "";
  } catch {
    return "";
  }
}

const explicitHost = process.env.HOST || process.env.AGENT_NOTIFY_HOST;
const host = explicitHost || tailscaleIpv4();
if (!host) {
  console.error(
    "Agent Notify: Tailscale is not running or has no IPv4 address. " +
      "Refusing to bind to loopback; the supervisor will retry.",
  );
  process.exit(1);
}
process.env.HOST = host;
const port = process.env.PORT || process.env.AGENT_NOTIFY_PORT || "8787";
console.log(`Agent Notify bridge will bind to ${host}:${port}`);
if (host === "0.0.0.0") {
  console.warn("Warning: HOST=0.0.0.0 exposes the bridge on every network interface.");
}

await import("./server.mjs");
