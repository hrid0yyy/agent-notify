#!/usr/bin/env node
/**
 * Send a test event through the bridge.
 *   node scripts/test-event.mjs
 *   node scripts/test-event.mjs --ask
 */
import { baseUrl, readConfig, authHeaders } from "../lib/config.mjs";

const config = readConfig();
const BASE = baseUrl(config);
const wantAsk = process.argv.includes("--ask");
const wantText = process.argv.includes("--text");
const wantAlarm = process.argv.includes("--alarm");

async function post(route, body, timeoutMs = 10_000) {
  const response = await fetch(`${BASE}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(config) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

const project = "agent-notify";

if (wantAlarm) {
  console.log("Sending an urgent ask; the phone should ring after 10 seconds…");
  const result = await post(
    "/ask",
    {
      agent: "test",
      project,
      title: "Urgent escalation test",
      body: "Do not answer this for 10 seconds. The phone should ring, wake the screen, and show Allow / Deny / Snooze / Stop.",
      options: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny", style: "destructive" },
      ],
      allowText: true,
      timeoutSeconds: 120,
      urgent: true,
      escalateAfterSeconds: 10,
    },
    140_000,
  );
  console.log(result);
  process.exit(0);
}

if (wantText) {
  console.log("Sending a free-text ask; type a reply on the phone…");
  const result = await post(
    "/ask",
    {
      agent: "test",
      project,
      title: "Free-text test",
      body: "Tap Reply, type anything, and send it. This tests the RemoteInput path with no buttons.",
      options: [],
      allowText: true,
      timeoutSeconds: 300,
    },
    320_000,
  );
  console.log(result);
  process.exit(0);
}

if (!wantAsk) {
  const result = await post("/event", {
    agent: "test",
    kind: "done",
    project,
    title: "Test notification",
    body: "If you can see this on your phone, the bridge and Tailscale are working.",
  });
  console.log(result);
  process.exit(0);
}

console.log("Sending an ask; waiting for a phone response…");
const result = await post(
  "/ask",
  {
    agent: "test",
    project,
    title: "Test decision",
    body: "Tap Allow or Deny on the phone. This tests the two-way path.",
    options: [
      { id: "allow", label: "Allow" },
      { id: "deny", label: "Deny", style: "destructive" },
    ],
    allowText: true,
    timeoutSeconds: 120,
  },
  140_000,
);
console.log(result);
