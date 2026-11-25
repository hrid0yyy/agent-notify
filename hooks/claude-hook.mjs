#!/usr/bin/env node
/**
 * Claude Code hook adapter.
 *
 * Claude Code runs this with the event name as argv[2] and sends the event
 * JSON on stdin. Observational events return immediately. PermissionRequest
 * blocks for a phone decision and prints Claude Code's decision JSON.
 */
import path from "node:path";
import { execFileSync } from "node:child_process";
import { baseUrl, readConfig, authHeaders } from "../lib/config.mjs";

const config = readConfig();
const BASE = baseUrl(config);
const WAIT_SECONDS = Math.max(5, Math.min(config.permissionWaitSeconds || 120, 600));

function truncate(value, max = 600) {
  if (typeof value !== "string") return "";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

async function post(route, body, timeoutMs) {
  const response = await fetch(`${BASE}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(config) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function projectInfo(input) {
  const cwd = input.cwd || process.cwd();
  const fallback = path.basename(cwd) || "project";
  let root = "";
  let branch = "";
  const git = (args) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 800,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
  try {
    root = git(["rev-parse", "--show-toplevel"]);
  } catch {
    // Not a git checkout; use the directory name.
  }
  try {
    branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    // Detached HEAD or no git; leave branch empty.
  }
  return {
    project: (root && path.basename(root)) || fallback,
    cwd,
    branch,
  };
}

function summarizeToolInput(input) {
  if (!input || typeof input !== "object") return "a tool";
  for (const key of ["command", "file_path", "path", "url", "pattern", "description", "prompt"]) {
    if (typeof input[key] === "string" && input[key].trim()) {
      return truncate(input[key], 240);
    }
  }
  try {
    return truncate(JSON.stringify(input), 240);
  } catch {
    return "a tool";
  }
}

function baseEvent(input, extra) {
  const info = projectInfo(input);
  const { meta, ...rest } = extra;
  return {
    agent: "claude-code",
    session: input.session_id,
    project: info.project,
    ...rest,
    meta: { cwd: info.cwd, branch: info.branch, ...meta },
  };
}

async function handleStop(input) {
  const background = Array.isArray(input.background_tasks) && input.background_tasks.length > 0;
  const crons = Array.isArray(input.session_crons) && input.session_crons.length > 0;
  const body = truncate(input.last_assistant_message || "Claude finished responding.");
  await post(
    "/event",
    baseEvent(input, {
      kind: "done",
      title: background || crons ? "Claude is paused" : "Claude finished",
      body: background || crons ? `${body}\n\n(Background work or a scheduled wakeup is still pending.)` : body,
      dedupeKey: `claude|${input.session_id}|stop`,
      dedupeMs: 5000,
    }),
    2500,
  );
}

async function handleStopFailure(input) {
  const detail =
    input.error?.message ||
    input.error ||
    input.reason ||
    `The turn ended with ${input.error_type || "an API error"}.`;
  await post(
    "/event",
    baseEvent(input, {
      kind: "error",
      title: "Claude stopped with an error",
      body: truncate(String(detail), 900),
      dedupeKey: `claude|${input.session_id}|stop-failure`,
      dedupeMs: 15000,
    }),
    2500,
  );
}

async function handleNotification(input) {
  const type = input.notification_type || "unknown";
  const message = truncate(input.message || input.title || "Claude Code notification.", 900);
  let kind = "info";
  let title = "Claude Code";
  if (type === "idle_prompt") {
    kind = "done";
    title = "Claude is idle";
  } else if (type === "permission_prompt") {
    kind = "needs_input";
    title = "Permission needed";
  } else if (type === "agent_needs_input") {
    kind = "needs_input";
    title = "Claude needs input";
  } else if (type === "agent_completed") {
    kind = "done";
    title = "Background agent finished";
  } else if (type === "elicitation_dialog" || type === "elicitation_url_dialog") {
    kind = "needs_input";
    title = "Claude needs input";
  }

  await post(
    "/event",
    baseEvent(input, {
      kind,
      title,
      body: message,
      allowText: false,
      dedupeKey:
        type === "permission_prompt"
          ? `claude|${input.session_id}|permission`
          : `claude|${input.session_id}|notification|${type}`,
      dedupeMs: type === "permission_prompt" ? 30_000 : 5_000,
      meta: { notificationType: type },
    }),
    2500,
  );
}

async function handlePermissionRequest(input) {
  const tool = input.tool_name || "a tool";
  const detail = summarizeToolInput(input.tool_input);
  let result;
  try {
    result = await post(
      "/ask",
      baseEvent(input, {
        title: "Permission needed",
        body: `Claude wants to use ${tool}:\n${detail}`,
        options: [
          { id: "allow", label: "Allow" },
          { id: "deny", label: "Deny", style: "destructive" },
        ],
        allowText: true,
        timeoutSeconds: WAIT_SECONDS,
        urgent: true,
        dedupeKey: `claude|${input.session_id}|permission`,
        meta: {
          tool,
          permissionMode: input.permission_mode,
          suggestions: input.permission_suggestions,
        },
      }),
      (WAIT_SECONDS + 8) * 1000,
    );
  } catch {
    // Bridge down or timed out at the HTTP layer: let Claude's normal prompt run.
    return;
  }

  if (result.status !== "answered") return;
  const action = String(result.action || "").toLowerCase();
  const text = truncate(result.text || "", 500);
  if (action === "allow" || action === "approve" || action === "always") {
    process.stdout.write(JSON.stringify({ decision: { behavior: "allow" } }));
    return;
  }
  if (action === "deny" || action === "reject") {
    process.stdout.write(
      JSON.stringify({
        decision: {
          behavior: "deny",
          message: text ? `Denied from phone: ${text}` : "Denied from phone.",
        },
      }),
    );
    return;
  }
  if (action === "reply" && text) {
    process.stdout.write(
      JSON.stringify({
        decision: {
          behavior: "deny",
          message: `The user replied from the phone: ${text}`,
        },
      }),
    );
  }
}

async function main() {
  if (!config.token || !BASE) return;
  const eventName = process.argv[2] || "";
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) return;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  const hook = eventName || input.hook_event_name || "";
  if (hook === "Stop") return handleStop(input);
  if (hook === "StopFailure") return handleStopFailure(input);
  if (hook === "Notification") return handleNotification(input);
  if (hook === "PermissionRequest") return handlePermissionRequest(input);
}

main().catch(() => {
  // Hooks must never break the agent.
  process.exitCode = 0;
});
