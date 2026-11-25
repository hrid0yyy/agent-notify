#!/usr/bin/env node
/**
 * Bind the bridge to the Tailscale IPv4 address, not the LAN.
 *
 *   HOST=127.0.0.1 npm run bridge   # local-only debugging
 *   HOST=0.0.0.0 npm run bridge     # all interfaces (not recommended)
 */
import { execFileSync } from "node:child_process";

function tailscaleIpv4() {
  try {
    const value = execFileSync("tailscale", ["ip", "-4"], {
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

const host = process.env.HOST || process.env.AGENT_NOTIFY_HOST || tailscaleIpv4() || "127.0.0.1";
process.env.HOST = host;
const port = process.env.PORT || process.env.AGENT_NOTIFY_PORT || "8787";
console.log(`Agent Notify bridge will bind to ${host}:${port}`);
if (host === "0.0.0.0") {
  console.warn("Warning: HOST=0.0.0.0 exposes the bridge on every network interface.");
}

await import("./server.mjs");
