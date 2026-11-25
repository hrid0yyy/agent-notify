// Agent Notify — OpenCode 2 server plugin.
//
// Drop this file in ~/.config/opencode/plugins/agent-notify.js (the setup
// script does it for you). It reports finished/failed runs and turns permission
// prompts into phone notifications with Allow / Deny buttons.
//
// This file intentionally imports nothing from an OpenCode package so it can
// live as a plain file in the global plugins directory.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_PATH = path.join(os.homedir(), ".agent-notify", "config.json");

function loadConfig() {
  try {
    const file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return {
      url: process.env.AGENT_NOTIFY_URL || file.url || "",
      token: process.env.AGENT_NOTIFY_TOKEN || file.token || "",
      permissionWaitSeconds: Number(
        process.env.AGENT_NOTIFY_PERMISSION_WAIT || file.permissionWaitSeconds || 120,
      ),
    };
  } catch {
    return { url: "", token: "", permissionWaitSeconds: 120 };
  }
}

function baseUrl(config) {
  let url = (config.url || "http://127.0.0.1:8787").trim().replace(/\/+$/, "");
  url = url.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
  if (url.endsWith("/ws")) url = url.slice(0, -3);
  return url;
}

function truncate(value, max = 900) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function projectName(ctx) {
  return (
    path.basename(
      ctx.location?.project?.canonical ||
        ctx.location?.directory ||
        process.cwd(),
    ) || "project"
  );
}

async function bridge(config, route, body, timeoutMs = 5000, onAskId) {
  const response = await fetch(`${baseUrl(config)}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const askId = response.headers.get("x-ask-id") || undefined;
  if (askId) onAskId?.(askId);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return { ...data, askId };
}

export default {
  id: "agent-notify",

  async setup(ctx) {
    const config = loadConfig();
    if (!config.token) {
      console.error("[agent-notify] no ~/.agent-notify/config.json; notifications disabled");
      return;
    }

    const abort = new AbortController();
    const pendingByRequest = new Map(); // OpenCode permission request ID -> bridge ask ID

    const askPermission = async (data) => {
      const toolDetail = Array.isArray(data.resources) && data.resources.length
        ? data.resources.join(", ")
        : data.action;
      try {
        const result = await bridge(
          config,
          "/ask",
          {
            agent: "opencode",
            project: projectName(ctx),
            session: data.sessionID,
            title: "Permission needed",
            body: `OpenCode wants to ${data.action || "use a tool"}:\n${truncate(toolDetail, 500)}`,
            options: [
              { id: "allow", label: "Allow" },
              { id: "deny", label: "Deny", style: "destructive" },
            ],
            allowText: true,
            timeoutSeconds: Math.max(5, Math.min(config.permissionWaitSeconds, 600)),
            urgent: true,
            dedupeKey: `opencode|${data.sessionID}|permission|${data.id}`,
            meta: { permissionID: data.id, action: data.action },
          },
          (Math.max(5, Math.min(config.permissionWaitSeconds, 600)) + 8) * 1000,
          (askId) => pendingByRequest.set(data.id, askId),
        );
        if (result.status !== "answered") return;
        const action = String(result.action || "").toLowerCase();
        const allow = action === "allow" || action === "approve" || action === "always";
        await ctx.permission.reply({
          sessionID: data.sessionID,
          requestID: data.id,
          decision: allow ? "once" : "reject",
        });
      } catch (error) {
        console.error(`[agent-notify] permission bridge failed: ${error.message}`);
      } finally {
        pendingByRequest.delete(data.id);
      }
    };

    const report = async (event) => {
      const sessionID = event.data?.sessionID;
      if (!sessionID) return;
      let title = sessionID;
      try {
        const session = await ctx.session.get({ sessionID });
        title = session?.title || sessionID;
      } catch {
        // session lookup is best-effort
      }
      const project = projectName(ctx);
      let branch = "";
      try {
        branch = (await ctx.vcs.get())?.branch?.current || "";
      } catch {
        // VCS metadata is best-effort.
      }
      if (event.type === "session.execution.succeeded") {
        await bridge(config, "/event", {
          agent: "opencode",
          kind: "done",
          project,
          session: sessionID,
          title: "OpenCode finished",
          body: truncate(title, 600),
          dedupeKey: `opencode|${sessionID}|done`,
          dedupeMs: 5000,
          meta: { sessionTitle: title, branch },
        });
        return;
      }
      const error = event.data?.error;
      const message =
        (typeof error === "string" && error) ||
        error?.message ||
        (error ? JSON.stringify(error).slice(0, 600) : "The run failed.");
      await bridge(config, "/event", {
        agent: "opencode",
        kind: "error",
        project,
        session: sessionID,
        title: "OpenCode failed",
        body: truncate(`${title}\n\n${message}`, 900),
        dedupeKey: `opencode|${sessionID}|error`,
        dedupeMs: 10_000,
        meta: { sessionTitle: title, branch },
      });
    };

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: [
            "session.execution.succeeded",
            "session.execution.failed",
            "permission.asked",
            "permission.replied",
          ],
          signal: abort.signal,
        })) {
          if (event.type === "permission.asked") {
            void askPermission(event.data);
            continue;
          }
          if (event.type === "permission.replied") {
            const askId = pendingByRequest.get(event.data?.requestID);
            if (askId) {
              pendingByRequest.delete(event.data.requestID);
              void bridge(config, `/cancel/${askId}`, {}, 3000).catch(() => {});
            }
            continue;
          }
          void report(event).catch((error) => {
            console.error(`[agent-notify] report failed: ${error.message}`);
          });
        }
      } catch (error) {
        if (error?.name !== "AbortError") {
          console.error(`[agent-notify] event stream stopped: ${error.message}`);
        }
      }
    })();

    return () => abort.abort();
  },
};
