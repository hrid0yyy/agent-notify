#!/usr/bin/env node
/**
 * End-to-end bridge self-test (no phone required).
 *   node scripts/selftest.mjs
 */
import WebSocket from "ws";
import { baseUrl, readConfig, authHeaders } from "../lib/config.mjs";

const config = readConfig();
const BASE = baseUrl(config);
const headers = { "content-type": "application/json", ...authHeaders(config) };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function post(route, body, timeoutMs = 10_000) {
  const response = await fetch(`${BASE}${route}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return { data, response };
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`ok - ${message}`);
}

const health = await fetch(`${BASE}/health`).then((response) => response.json());
assert(health.ok === true, "bridge health endpoint");

const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws`, {
  headers: authHeaders(config),
});
const frames = [];
ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});
await sleep(200);
assert(frames.some((frame) => frame.type === "hello"), "websocket hello frame");

await post("/event", {
  agent: "selftest",
  kind: "done",
  title: "Self-test event",
  body: "A notification frame should arrive over the websocket.",
  dedupeKey: `selftest|${Date.now()}`,
});
await sleep(300);
assert(
  frames.some((frame) => frame.type === "event" && frame.event.title === "Self-test event"),
  "websocket receives event",
);

const askPromise = post(
  "/ask",
  {
    agent: "selftest",
    title: "Self-test ask",
    body: "This should be answered by the self-test.",
    options: [
      { id: "allow", label: "Allow" },
      { id: "deny", label: "Deny" },
    ],
    timeoutSeconds: 20,
  },
  25_000,
).then(({ data }) => data);
await sleep(350);
const askFrame = frames.find(
  (frame) => frame.type === "event" && frame.event.title === "Self-test ask",
);
assert(Boolean(askFrame?.event?.askId), "ask event contains askId");
await post(`/respond/${askFrame.event.askId}`, { action: "allow", text: "from selftest" });
const answer = await askPromise;
assert(answer.status === "answered" && answer.action === "allow", "ask round-trip answer");

await sleep(200);
assert(
  frames.some(
    (frame) => frame.type === "resolved" && frame.askId === askFrame.event.askId,
  ),
  "websocket receives resolution",
);

ws.close();
console.log("\nbridge self-test passed");
