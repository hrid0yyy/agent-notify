#!/usr/bin/env node
/**
 * Gemini CLI hook adapter.
 *
 * Gemini runs this with the event name as argv[2] and sends the event JSON on
 * stdin. It is observational: stdout always receives a valid empty JSON object
 * so the agent is never blocked.
 */
import { postEvent, projectInfo, readStdin, truncate } from "./hook-lib.mjs";

function finish(value = {}) {
  process.stdout.write(JSON.stringify(value));
}

async function handleAfterAgent(input) {
  const info = projectInfo(input);
  const session = input.session_id || process.env.GEMINI_SESSION_ID || "";
  const body = truncate(
    input.prompt_response || "Gemini finished responding.",
    900,
  );
  await postEvent({
    agent: "gemini-cli",
    session,
    project: info.project,
    kind: "done",
    title: "Gemini finished",
    body,
    dedupeKey: `gemini|${session}|stop`,
    dedupeMs: 5000,
    meta: { cwd: info.cwd, branch: info.branch },
  });
}

async function handleNotification(input) {
  const info = projectInfo(input);
  const session = input.session_id || process.env.GEMINI_SESSION_ID || "";
  const type = String(input.notification_type || "notification");
  const needsYou = /permission|approval|input|question/i.test(type);
  const body = truncate(
    input.message || input.title || "Gemini CLI notification.",
    900,
  );
  await postEvent({
    agent: "gemini-cli",
    session,
    project: info.project,
    kind: needsYou ? "needs_input" : "info",
    title: needsYou ? "Gemini needs you" : "Gemini CLI",
    body,
    allowText: false,
    dedupeKey: `gemini|${session}|notification|${type}`,
    dedupeMs: 15_000,
    meta: { cwd: info.cwd, branch: info.branch, notificationType: type },
  });
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) {
    finish();
    return;
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    finish();
    return;
  }
  const event = process.argv[2] || input.hook_event_name || "";
  if (event === "AfterAgent") await handleAfterAgent(input);
  if (event === "Notification") await handleNotification(input);
  finish();
}

main().catch(() => finish());
