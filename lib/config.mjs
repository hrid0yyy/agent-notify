import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_DIR = path.join(os.homedir(), ".agent-notify");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

export function readConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    // no config yet; env-only operation is allowed
  }
  return {
    url: process.env.AGENT_NOTIFY_URL || file.url || "",
    token: process.env.AGENT_NOTIFY_TOKEN || file.token || "",
    port: Number(process.env.AGENT_NOTIFY_PORT || file.port || 8787),
    notifyOnDone: file.notifyOnDone !== false,
    permissionWaitSeconds: Number(
      process.env.AGENT_NOTIFY_PERMISSION_WAIT || file.permissionWaitSeconds || 600,
    ),
    escalation: {
      enabled: file.escalation?.enabled !== false,
      afterSeconds: Number(
        process.env.AGENT_NOTIFY_ESCALATE_AFTER ?? file.escalation?.afterSeconds ?? 120,
      ),
      repeatSeconds: Number(
        process.env.AGENT_NOTIFY_ESCALATE_REPEAT ?? file.escalation?.repeatSeconds ?? 60,
      ),
      maxRings: Number(file.escalation?.maxRings ?? 3),
      ringDurationSeconds: Number(file.escalation?.ringDurationSeconds ?? 45),
      leaseSeconds: Number(
        process.env.AGENT_NOTIFY_LEASE_SECONDS ?? file.escalation?.leaseSeconds ?? 300,
      ),
      cooldownSeconds: Number(
        process.env.AGENT_NOTIFY_COOLDOWN_SECONDS ??
          file.escalation?.cooldownSeconds ??
          600,
      ),
      maxPerHour: Number(
        process.env.AGENT_NOTIFY_MAX_PER_HOUR ?? file.escalation?.maxPerHour ?? 3,
      ),
      maxPerDay: Number(
        process.env.AGENT_NOTIFY_MAX_PER_DAY ?? file.escalation?.maxPerDay ?? 10,
      ),
      minGapSeconds: Number(
        process.env.AGENT_NOTIFY_MIN_GAP_SECONDS ??
          file.escalation?.minGapSeconds ??
          30,
      ),
      unansweredPenaltySeconds: Number(
        process.env.AGENT_NOTIFY_PENALTY_SECONDS ??
          file.escalation?.unansweredPenaltySeconds ??
          1800,
      ),
      quietHours: file.escalation?.quietHours || {
        enabled: false,
        start: "22:00",
        end: "08:00",
        allowUrgent: true,
      },
    },
  };
}

export function baseUrl(config = readConfig()) {
  let url = (config.url || `http://127.0.0.1:${config.port || 8787}`).trim();
  url = url.replace(/\/+$/, "");
  url = url.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
  if (url.endsWith("/ws")) url = url.slice(0, -3);
  return url;
}

export function authHeaders(config = readConfig()) {
  return config.token ? { Authorization: `Bearer ${config.token}` } : {};
}
