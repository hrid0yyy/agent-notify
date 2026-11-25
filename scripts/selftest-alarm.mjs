#!/usr/bin/env node
/**
 * Headless test for the singleton alarm lease and budgets.
 * Starts a second bridge on port 8788 with short test timings, so no phone
 * alarms are produced.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { readConfig } from "../lib/config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE_PATH = path.join(os.tmpdir(), `agent-notify-selftest-${process.pid}.json`);
const config = readConfig();
const headers = {
  "content-type": "application/json",
  authorization: `Bearer ${config.token}`,
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`ok - ${message}`);
}

const child = spawn(process.execPath, [path.join(ROOT, "bridge", "server.mjs")], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    AGENT_NOTIFY_STATE: STATE_PATH,
    AGENT_NOTIFY_LEASE_SECONDS: "5",
    AGENT_NOTIFY_COOLDOWN_SECONDS: "0",
    AGENT_NOTIFY_MAX_PER_HOUR: "2",
    AGENT_NOTIFY_MAX_PER_DAY: "10",
    AGENT_NOTIFY_MIN_GAP_SECONDS: "0",
    AGENT_NOTIFY_PENALTY_SECONDS: "60",
    AGENT_NOTIFY_ESCALATE_AFTER: "5",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (data) => (output += data));
child.stderr.on("data", (data) => (output += data));

async function waitForBridge() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const health = await fetch(`${BASE}/health`).then((r) => r.json());
      if (health.ok) return health;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`bridge did not start\n${output}`);
}

async function startAsk(body) {
  const response = await fetch(`${BASE}/ask`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(40_000),
  });
  return {
    response,
    askId: response.headers.get("x-ask-id"),
    status: response.headers.get("x-alarm-status"),
    holder: response.headers.get("x-alarm-holder"),
    retryAfter: Number(response.headers.get("x-alarm-retry-after") || 0),
    body: response.json(),
  };
}

async function cancel(askId) {
  await fetch(`${BASE}/cancel/${askId}`, {
    method: "POST",
    headers,
    body: "{}",
  });
}

let ws = null;
try {
  await waitForBridge();
  assert(true, "test bridge started");

  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, {
    headers: { Authorization: `Bearer ${config.token}` },
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  await fetch(`${BASE}/alarm`, {
    method: "POST",
    headers,
    body: JSON.stringify({ mode: "on" }),
  });

  const normal = await startAsk({
    agent: "claude-code",
    project: "normal-project",
    title: "Normal ask",
    body: "This should not take the alarm slot.",
    urgent: false,
    timeoutSeconds: 20,
  });
  assert(normal.status === "normal", "non-urgent ask does not claim the alarm slot");
  await cancel(normal.askId);
  await normal.body;

  const first = await startAsk({
    agent: "claude-code",
    project: "alpha",
    title: "Alpha urgent",
    body: "Hold the alarm slot.",
    urgent: true,
    escalateAfterSeconds: 5,
    timeoutSeconds: 30,
  });
  assert(first.status === "granted", "first urgent ask gets the alarm slot");

  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  assert(health.activeAlarm?.project === "alpha", "health reports the active alarm holder");

  const second = await startAsk({
    agent: "opencode",
    project: "beta",
    title: "Beta urgent",
    body: "This should be busy.",
    urgent: true,
    escalateAfterSeconds: 5,
    timeoutSeconds: 30,
  });
  assert(second.status === "busy", "second urgent ask is refused while the slot is held");
  assert(
    second.holder.includes("claude-code/alpha"),
    "busy response names the holder",
  );
  assert(second.retryAfter > 0, "busy response includes a retry window");
  await cancel(second.askId);
  await second.body;
  await cancel(first.askId);
  await first.body;

  const budgetOne = await startAsk({
    agent: "claude-code",
    project: "budget",
    title: "Budget one",
    body: "First budgeted alarm.",
    urgent: true,
    timeoutSeconds: 20,
  });
  assert(budgetOne.status === "granted", "budget grant 1");
  await cancel(budgetOne.askId);
  await budgetOne.body;

  const budgetTwo = await startAsk({
    agent: "claude-code",
    project: "budget",
    title: "Budget two",
    body: "Second budgeted alarm.",
    urgent: true,
    timeoutSeconds: 20,
  });
  assert(budgetTwo.status === "granted", "budget grant 2");
  await cancel(budgetTwo.askId);
  await budgetTwo.body;

  const budgetThree = await startAsk({
    agent: "claude-code",
    project: "budget",
    title: "Budget three",
    body: "This should exceed the hourly budget.",
    urgent: true,
    timeoutSeconds: 20,
  });
  assert(
    budgetThree.status === "rate_limited",
    "third grant for the same project is rate limited",
  );
  assert(
    budgetThree.retryAfter > 0,
    "rate-limited response includes a retry window",
  );
  await cancel(budgetThree.askId);
  await budgetThree.body;

  const expiring = await startAsk({
    agent: "opencode",
    project: "expiry",
    title: "Lease expiry",
    body: "The lease should expire in two seconds.",
    urgent: true,
    timeoutSeconds: 20,
  });
  assert(expiring.status === "granted", "expiry test takes the slot");
  await sleep(6000);
  const afterExpiry = await fetch(`${BASE}/health`).then((r) => r.json());
  assert(afterExpiry.activeAlarm === null, "lease expires on its own");
  await cancel(expiring.askId);
  await expiring.body;

  console.log("\nsingleton alarm self-test passed");
} finally {
  ws?.close();
  child.kill();
  try {
    fs.rmSync(STATE_PATH, { force: true });
  } catch {
    // ignore cleanup
  }
}
