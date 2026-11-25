#!/usr/bin/env node
/**
 * MCP server exposing two portable tools:
 *   notify_user - fire-and-forget update on the phone
 *   ask_user    - blocking question with buttons / free-text reply
 *
 * Works with Claude Code, OpenCode, and any other MCP client.
 */
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { baseUrl, readConfig, authHeaders } from "../lib/config.mjs";

const config = readConfig();
const BASE = baseUrl(config);
const TIMEOUT_MS = 15_000;

function detectAgent() {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  if (process.env.OPENCODE || process.env.OPENCODE_SERVER) return "opencode";
  return "mcp";
}

function projectName(explicit) {
  if (explicit) return explicit;
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return path.basename(cwd) || "project";
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "option";
}

async function post(path, body, timeoutMs = TIMEOUT_MS) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders(config),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      data.error || `bridge returned HTTP ${response.status}`,
    );
    error.code = data.error;
    error.status = response.status;
    error.kind = data.kind;
    throw error;
  }
  const headerAlarm = response.headers.get("x-alarm-status");
  return {
    ...data,
    _alarm:
      data.alarm ||
      (headerAlarm
        ? {
            status: headerAlarm,
            holder: response.headers.get("x-alarm-holder") || "",
            retryAfterSeconds: Number(
              response.headers.get("x-alarm-retry-after") || 0,
            ),
          }
        : undefined),
  };
}

function alarmNote(result) {
  if (result.alarmAllowed === false) {
    return " The alarm was not armed because alarms are off.";
  }
  const alarm = result.alarm || result._alarm;
  if (!alarm || alarm.status === "granted" || alarm.status === "normal") return "";
  const holder = alarm.holder
    ? typeof alarm.holder === "string"
      ? ` (held by ${alarm.holder})`
      : ` (held by ${alarm.holder.agent}/${alarm.holder.project})`
    : "";
  const retry = Number(alarm.retryAfterSeconds || 0);
  return ` Alarm not armed: ${alarm.status}${holder}. The question was still delivered as a normal notification${retry > 0 ? `; retry after about ${retry}s` : ""}.`;
}

const server = new McpServer({
  name: "agent-notify",
  version: "0.1.0",
});

server.registerTool(
  "notify_user",
  {
    title: "Notify the user's phone",
    description:
      "Send a short push notification to the user's phone. Only use this when the user explicitly asks you to notify them. Never call it autonomously, and never use it for every small step.",
    inputSchema: {
      message: z.string().min(1).max(1000).describe("What the user should see."),
      title: z.string().max(120).optional().describe("Notification title."),
      kind: z
        .enum(["done", "needs_input", "error", "info"])
        .optional()
        .describe("done = finished; needs_input = blocked; error = failed."),
      project: z
        .string()
        .max(80)
        .optional()
        .describe("Repo or project name; pass it explicitly when you know it."),
    },
  },
  async ({ message, title, kind, project }) => {
    let result;
    try {
      result = await post("/event", {
        agent: detectAgent(),
        source: "agent",
        kind: kind || "info",
        title: title || (kind === "done" ? "Task complete" : "Agent update"),
        body: message,
        project: projectName(project),
      });
    } catch (error) {
      throw error;
    }
    return {
      content: [
        {
          type: "text",
          text: result.suppressed
            ? "Notification suppressed because the user is at their desk."
            : result.deduped
              ? "Notification suppressed as a duplicate."
              : "Notification sent to the user's phone.",
        },
      ],
    };
  },
);

server.registerTool(
  "ask_user",
  {
    title: "Ask the user and wait for an answer",
    description:
      "Send a question to the user's phone and block until they tap a button or reply. Only use this when the user explicitly asks to be contacted, or after asking them in the conversation and they agree. Never use it autonomously. If the answer times out, do not assume approval.",
    inputSchema: {
      question: z.string().min(1).max(1000).describe("The question to ask."),
      title: z.string().max(120).optional().describe("Notification title."),
      options: z
        .array(z.string().min(1).max(40))
        .min(1)
        .max(4)
        .optional()
        .describe("Button labels. Defaults to Allow / Deny."),
      timeout_seconds: z
        .number()
        .int()
        .min(5)
        .max(900)
        .optional()
        .describe("How long to wait. Default 120 seconds."),
      allow_text: z
        .boolean()
        .optional()
        .describe("Also offer a free-text reply field. Default true."),
      urgent: z
        .boolean()
        .optional()
        .describe(
          "Escalate to a ringing alarm if the user does not answer. Only enable when the user explicitly asks to be called or alarmed.",
        ),
      escalate_after_seconds: z
        .number()
        .int()
        .min(5)
        .max(3600)
        .optional()
        .describe("Override the escalation delay for this question."),
      project: z.string().max(80).optional().describe("Project name."),
    },
  },
  async ({
    question,
    title,
    options,
    timeout_seconds,
    allow_text,
    urgent,
    escalate_after_seconds,
    project,
  }) => {
    const labels = options?.length ? options : ["Allow", "Deny"];
    const buttons = labels.map((label) => ({
      id: slug(label),
      label,
      style: /deny|reject|stop|cancel/i.test(label) ? "destructive" : "default",
    }));
    const askTimeout = timeout_seconds || (urgent === true ? 600 : 120);

    let result;
    try {
      result = await post(
        "/ask",
        {
          agent: detectAgent(),
          source: "agent",
          title: title || "Agent needs a decision",
          body: question,
          options: buttons,
          allowText: allow_text !== false,
          timeoutSeconds: askTimeout,
          urgent: urgent === true,
          ...(escalate_after_seconds
            ? { escalateAfterSeconds: escalate_after_seconds }
            : {}),
          project: projectName(project),
        },
        askTimeout * 1000 + 10_000,
      );
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Could not reach the phone bridge at ${BASE}: ${error.message}`,
          },
        ],
      };
    }

    if (result.status === "desk") {
      return {
        content: [
          {
            type: "text",
            text: "The user is at their machine. Ask the question in the conversation instead; do not assume approval.",
          },
        ],
      };
    }
    if (result.status === "unavailable") {
      return {
        content: [
          {
            type: "text",
            text: "No phone is connected. Ask the question in the conversation instead; do not assume approval.",
          },
        ],
      };
    }

    const note = alarmNote(result);
    if (result.status === "answered") {
      if (result.action === "reply" && result.text) {
        return {
          content: [
            { type: "text", text: `The user replied: "${result.text}".${note}` },
          ],
        };
      }
      const chosen = buttons.find((button) => button.id === result.action);
      const label = chosen?.label || result.action;
      const text = result.text ? ` They added: "${result.text}"` : "";
      return {
        content: [
          {
            type: "text",
            text: `The user chose "${label}".${text}${note}`,
          },
        ],
      };
    }
    if (result.status === "cancelled") {
      return {
        content: [
          {
            type: "text",
            text: `The question was answered or cancelled elsewhere. Do not assume approval.${note}`,
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `The user did not answer within ${askTimeout} seconds. Do not assume approval; continue only with work that does not need this decision, or ask again later.${note}`,
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`agent-notify MCP connected; bridge ${BASE}`);
