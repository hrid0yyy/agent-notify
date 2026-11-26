#!/usr/bin/env node
/**
 * Agent Notify bridge.
 *
 * A deliberately small HTTP + WebSocket service that sits between coding-agent
 * hooks/MCP tools and the Android app. It binds to localhost by default and is
 * meant to be published on the tailnet with `tailscale serve`.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import { readConfig } from "../lib/config.mjs";

const config = readConfig();
const TOKEN = config.token;
if (!TOKEN) {
  console.error(
    "No bridge token. Run `npm run setup` first, or set AGENT_NOTIFY_TOKEN.",
  );
  process.exit(1);
}

const PORT = Number(process.env.PORT || config.port || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY = 64 * 1024;
const MAX_EVENTS = 100;
const DEFAULT_ASK_TIMEOUT = 300;

const ESCALATION = {
  enabled: config.escalation?.enabled !== false,
  afterSeconds: clamp(config.escalation?.afterSeconds ?? 120, 5, 3600),
  repeatSeconds: clamp(config.escalation?.repeatSeconds ?? 60, 10, 3600),
  maxRings: clamp(config.escalation?.maxRings ?? 3, 1, 10),
  ringDurationSeconds: clamp(config.escalation?.ringDurationSeconds ?? 45, 5, 120),
  leaseSeconds: clamp(config.escalation?.leaseSeconds ?? 300, 5, 3600),
  cooldownSeconds: clamp(config.escalation?.cooldownSeconds ?? 600, 0, 86_400),
  maxPerHour: clamp(config.escalation?.maxPerHour ?? 3, 1, 100),
  maxPerDay: clamp(config.escalation?.maxPerDay ?? 10, 1, 1000),
  minGapSeconds: clamp(config.escalation?.minGapSeconds ?? 30, 0, 3600),
  unansweredPenaltySeconds: clamp(
    config.escalation?.unansweredPenaltySeconds ?? 1800,
    0,
    86_400,
  ),
  quietHours: {
    enabled: config.escalation?.quietHours?.enabled === true,
    start: config.escalation?.quietHours?.start || "22:00",
    end: config.escalation?.quietHours?.end || "08:00",
    allowUrgent: config.escalation?.quietHours?.allowUrgent !== false,
  },
};

const STATE_PATH =
  process.env.AGENT_NOTIFY_STATE ||
  path.join(os.homedir(), ".agent-notify", "state.json");
const DEFAULT_STATE = {
  presence: "away",
  alarmMode: "off",
  alarmsUntil: 0,
};
const state = loadState();

const events = [];
const pending = new Map(); // askId -> pending ask with escalation state
const recent = new Map(); // dedupe key -> timestamp
let activeAlarm = null; // the single global alarm lease
let lastLeaseEndedAt = 0;
const budgets = new Map(); // "agent|project" -> { grants, lastGrantAt, penaltyUntil }

function loadState() {
  try {
    const value = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    const presence = value.presence === "desk" ? "desk" : "away";
    let alarmMode = ["off", "on", "timed"].includes(value.alarmMode)
      ? value.alarmMode
      : "off";
    let alarmsUntil = Number(value.alarmsUntil || 0);
    if (!value.alarmMode && Number(value.alarmsConsentUntil) > now()) {
      alarmMode = "timed";
      alarmsUntil = Number(value.alarmsConsentUntil);
    }
    if (alarmMode === "timed" && alarmsUntil <= now()) {
      alarmMode = "off";
      alarmsUntil = 0;
    }
    if (presence === "desk") {
      alarmMode = "off";
      alarmsUntil = 0;
    }
    return { presence, alarmMode, alarmsUntil };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveState() {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function alarmActive() {
  return (
    state.alarmMode === "on" ||
    (state.alarmMode === "timed" && state.alarmsUntil > now())
  );
}

function statePayload() {
  const active = alarmActive();
  return {
    presence: state.presence,
    alarmMode: active ? state.alarmMode : "off",
    alarmsUntil: active ? state.alarmsUntil : 0,
    alarmsActive: active,
  };
}

function broadcastState() {
  broadcast({ type: "state", state: statePayload() });
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function minutesOfDay(value, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return fallback;
  return Math.min(1439, Number(match[1]) * 60 + Math.min(59, Number(match[2])));
}

function isQuietNow() {
  const quiet = ESCALATION.quietHours;
  if (!quiet.enabled) return false;
  const date = new Date();
  const current = date.getHours() * 60 + date.getMinutes();
  const start = minutesOfDay(quiet.start, 22 * 60);
  const end = minutesOfDay(quiet.end, 8 * 60);
  return start <= end
    ? current >= start && current < end
    : current >= start || current < end;
}

function now() {
  return Date.now();
}

function truncate(value, max) {
  if (typeof value !== "string") return "";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function isAuthorized(req) {
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const alt = req.headers["x-agent-notify-token"];
  return safeEqual(bearer, TOKEN) || safeEqual(alt, TOKEN);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function kindPriority(kind) {
  if (kind === "needs_input") return "high";
  if (kind === "error") return "high";
  if (kind === "done") return "default";
  return "default";
}

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .filter((option) => option && typeof option.id === "string")
    .slice(0, 4)
    .map((option) => ({
      id: truncate(option.id, 40),
      label: truncate(option.label || option.id, 40),
      style: option.style === "destructive" ? "destructive" : "default",
    }));
}

function makeEvent(input, id = `evt_${randomUUID().replaceAll("-", "").slice(0, 16)}`) {
  const kind = ["done", "needs_input", "error", "info"].includes(input.kind)
    ? input.kind
    : "info";
  const agent = truncate(input.agent || "agent", 40);
  const project = truncate(input.project || "project", 80);
  const defaultTitle =
    kind === "done"
      ? "Agent finished"
      : kind === "error"
        ? "Agent hit an error"
        : kind === "needs_input"
          ? "Agent needs you"
          : "Agent update";
  return {
    id,
    kind,
    priority: input.priority || kindPriority(kind),
    agent,
    project,
    session: truncate(input.session || "", 120),
    title: truncate(input.title || defaultTitle, 120),
    body: truncate(input.body || "", 1200),
    askId: input.askId || undefined,
    options: normalizeOptions(input.options),
    allowText: input.allowText === true,
    urgent: input.urgent === true,
    createdAt: now(),
    meta: input.meta && typeof input.meta === "object" ? input.meta : undefined,
  };
}

function deduped(input, event) {
  const key =
    input.dedupeKey ||
    `${event.agent}|${event.session}|${event.kind}|${event.title}`;
  const ttl = Number(input.dedupeMs || 8000);
  const at = now();
  const previous = recent.get(key);
  recent.set(key, at);
  if (recent.size > 500) {
    for (const [k, ts] of recent) {
      if (at - ts > 60_000) recent.delete(k);
    }
  }
  return typeof previous === "number" && at - previous < ttl;
}

function remember(event) {
  events.push(event);
  if (events.length > MAX_EVENTS) events.shift();
}

function budgetKey(agent, project) {
  return `${agent || "agent"}|${project || "project"}`;
}

function getBudget(agent, project) {
  const key = budgetKey(agent, project);
  let budget = budgets.get(key);
  if (!budget) {
    budget = { grants: [], lastGrantAt: 0, penaltyUntil: 0 };
    budgets.set(key, budget);
  }
  const cutoff = now() - 24 * 60 * 60 * 1000;
  budget.grants = budget.grants.filter((timestamp) => timestamp >= cutoff);
  return budget;
}

function countSince(grants, windowMs) {
  const cutoff = now() - windowMs;
  return grants.filter((timestamp) => timestamp >= cutoff).length;
}

function holderInfo() {
  if (!activeAlarm) return null;
  return {
    agent: activeAlarm.agent,
    project: activeAlarm.project,
    askId: activeAlarm.askId,
    remainingSeconds: Math.max(0, Math.ceil((activeAlarm.leaseUntil - now()) / 1000)),
  };
}

function rateLimited(reason, retryAfterSeconds) {
  return {
    status: "rate_limited",
    reason,
    retryAfterSeconds: Math.max(0, Math.ceil(retryAfterSeconds)),
    holder: holderInfo(),
  };
}

/**
 * The single alarm slot. Normal notifications never call this; only asks that
 * explicitly request urgency do.
 */
function requestLease(entry, { returning = false } = {}) {
  if (!ESCALATION.enabled) return { status: "disabled" };
  if (!entry?.urgent) return { status: "normal" };
  if (isQuietNow() && !ESCALATION.quietHours.allowUrgent) {
    return { status: "quiet_hours", reason: "quiet-hours", retryAfterSeconds: 0 };
  }

  const current = now();
  if (activeAlarm) {
    if (activeAlarm.leaseUntil > current) {
      return {
        status: "busy",
        reason: "held",
        holder: holderInfo(),
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((activeAlarm.leaseUntil - current) / 1000),
        ),
      };
    }
    releaseLease(activeAlarm, "expired");
  }

  const gapRemaining = ESCALATION.minGapSeconds * 1000 - (current - lastLeaseEndedAt);
  if (lastLeaseEndedAt > 0 && gapRemaining > 0) {
    return rateLimited("global-gap", gapRemaining / 1000);
  }

  const budget = getBudget(entry.event.agent, entry.event.project);
  if (budget.penaltyUntil > current) {
    return rateLimited(
      "unanswered-penalty",
      (budget.penaltyUntil - current) / 1000,
    );
  }
  if (!returning) {
    if (
      budget.lastGrantAt > 0 &&
      current - budget.lastGrantAt < ESCALATION.cooldownSeconds * 1000
    ) {
      return rateLimited(
        "cooldown",
        (ESCALATION.cooldownSeconds * 1000 - (current - budget.lastGrantAt)) / 1000,
      );
    }
    if (countSince(budget.grants, 60 * 60 * 1000) >= ESCALATION.maxPerHour) {
      return rateLimited("hourly-budget", 3600);
    }
    if (countSince(budget.grants, 24 * 60 * 60 * 1000) >= ESCALATION.maxPerDay) {
      return rateLimited("daily-budget", 86_400);
    }
  }

  const lease = {
    askId: entry.event.id,
    agent: entry.event.agent,
    project: entry.event.project,
    grantedAt: current,
    leaseUntil: current + ESCALATION.leaseSeconds * 1000,
    rings: 0,
    timer: null,
    penalized: false,
  };
  activeAlarm = lease;
  entry.lease = lease;
  if (!returning) {
    budget.lastGrantAt = current;
    budget.grants.push(current);
  }
  lease.timer = setTimeout(
    () => releaseLease(lease, "expired"),
    ESCALATION.leaseSeconds * 1000,
  );
  lease.timer.unref?.();
  return {
    status: "granted",
    reason: "granted",
    leaseUntil: lease.leaseUntil,
    retryAfterSeconds: 0,
    holder: null,
  };
}

function releaseLease(lease, reason) {
  if (!lease) return;
  if (lease.timer) clearTimeout(lease.timer);
  lease.timer = null;

  const wasActive = activeAlarm?.askId === lease.askId;
  if (wasActive) {
    activeAlarm = null;
    lastLeaseEndedAt = now();
  }

  const entry = pending.get(lease.askId);
  if (entry?.lease?.askId === lease.askId) entry.lease = null;

  if (
    !lease.penalized &&
    lease.rings > 0 &&
    ["max-rings", "expired", "timeout"].includes(reason)
  ) {
    lease.penalized = true;
    const budget = getBudget(lease.agent, lease.project);
    budget.penaltyUntil = now() + ESCALATION.unansweredPenaltySeconds * 1000;
  }

  if (wasActive && ["max-rings", "expired"].includes(reason)) {
    broadcast({ type: "leaseEnded", askId: lease.askId, reason });
  }
}

function clearEscalation(entry) {
  if (entry?.escalationTimer) {
    clearTimeout(entry.escalationTimer);
    entry.escalationTimer = null;
  }
}

function mayEscalate(entry) {
  return Boolean(
    ESCALATION.enabled &&
      entry &&
      !entry.answered &&
      !entry.stopped &&
      entry.lease &&
      entry.lease === activeAlarm &&
      entry.lease.leaseUntil > now() &&
      (!isQuietNow() || (entry.urgent && ESCALATION.quietHours.allowUrgent)),
  );
}

function scheduleEscalation(askId, delaySeconds) {
  const entry = pending.get(askId);
  clearEscalation(entry);
  if (!mayEscalate(entry)) return;
  const timer = setTimeout(
    () => fireEscalation(askId),
    Math.max(1, clamp(delaySeconds, 1, 3600)) * 1000,
  );
  timer.unref?.();
  entry.escalationTimer = timer;
}

function fireEscalation(askId) {
  const entry = pending.get(askId);
  if (!mayEscalate(entry)) return;
  entry.rings += 1;
  entry.lease.rings += 1;
  broadcast({
    type: "alarm",
    askId,
    event: entry.event,
    ring: entry.rings,
    maxRings: ESCALATION.maxRings,
    ringDurationSeconds: ESCALATION.ringDurationSeconds,
    repeatSeconds: ESCALATION.repeatSeconds,
  });
  if (entry.rings < ESCALATION.maxRings && entry.lease.leaseUntil > now()) {
    scheduleEscalation(askId, ESCALATION.repeatSeconds);
  } else {
    releaseLease(entry.lease, "max-rings");
  }
}

async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const route = url.pathname;

  if (req.method === "GET" && route === "/health") {
    return json(res, 200, {
      ok: true,
      name: "agent-notify-bridge",
      uptimeSeconds: Math.round(process.uptime()),
      pending: pending.size,
      clients: wss.clients.size,
      events: events.length,
      ...statePayload(),
      activeAlarm: activeAlarm
        ? {
            agent: activeAlarm.agent,
            project: activeAlarm.project,
            askId: activeAlarm.askId,
            rings: activeAlarm.rings,
            remainingSeconds: Math.max(
              0,
              Math.ceil((activeAlarm.leaseUntil - now()) / 1000),
            ),
          }
        : null,
      escalation: {
        enabled: ESCALATION.enabled,
        afterSeconds: ESCALATION.afterSeconds,
        repeatSeconds: ESCALATION.repeatSeconds,
        maxRings: ESCALATION.maxRings,
        leaseSeconds: ESCALATION.leaseSeconds,
        cooldownSeconds: ESCALATION.cooldownSeconds,
        maxPerHour: ESCALATION.maxPerHour,
        maxPerDay: ESCALATION.maxPerDay,
        minGapSeconds: ESCALATION.minGapSeconds,
      },
    });
  }

  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, error: "unauthorized" });
  }

  if (req.method === "GET" && route === "/status") {
    return json(res, 200, {
      ok: true,
      ...statePayload(),
      clients: wss.clients.size,
      pending: pending.size,
      activeAlarm: activeAlarm
        ? {
            agent: activeAlarm.agent,
            project: activeAlarm.project,
            askId: activeAlarm.askId,
            rings: activeAlarm.rings,
          }
        : null,
    });
  }

  if (req.method === "POST" && route === "/presence") {
    const input = await readBody(req);
    if (!["desk", "away"].includes(input.mode)) {
      return json(res, 400, { ok: false, error: "mode must be desk or away" });
    }
    state.presence = input.mode;
    if (input.mode === "desk") {
      state.alarmMode = "off";
      state.alarmsUntil = 0;
      const ids = [];
      for (const entry of pending.values()) {
        clearEscalation(entry);
        entry.stopped = true;
        if (entry.lease) {
          ids.push(entry.lease.askId);
          releaseLease(entry.lease, "desk");
        }
      }
      for (const askId of ids) {
        broadcast({ type: "leaseEnded", askId, reason: "desk" });
      }
    }
    saveState();
    broadcast({ type: "presence", mode: state.presence });
    broadcastState();
    return json(res, 200, { ok: true, ...statePayload() });
  }

  if (req.method === "POST" && route === "/alarm") {
    if (state.presence === "desk") {
      return json(res, 409, {
        ok: false,
        error: "at_desk",
        message: "Alarms cannot be enabled while at the desk.",
      });
    }
    const input = await readBody(req);
    const mode = input.mode;
    if (!["off", "on", "timed"].includes(mode)) {
      return json(res, 400, {
        ok: false,
        error: "mode must be off, on, or timed",
      });
    }
    if (mode === "off") {
      state.alarmMode = "off";
      state.alarmsUntil = 0;
      if (activeAlarm) {
        const askId = activeAlarm.askId;
        releaseLease(activeAlarm, "alarm-off");
        broadcast({ type: "leaseEnded", askId, reason: "alarm-off" });
      }
    } else if (mode === "on") {
      state.alarmMode = "on";
      state.alarmsUntil = 0;
    } else {
      const minutes = clamp(input.minutes ?? 30, 1, 1440);
      state.alarmMode = "timed";
      state.alarmsUntil = now() + minutes * 60_000;
    }
    saveState();
    broadcastState();
    return json(res, 200, { ok: true, ...statePayload() });
  }

  if (req.method === "GET" && route === "/events") {
    const limit = Math.min(Number(url.searchParams.get("limit") || 30), MAX_EVENTS);
    return json(res, 200, { events: events.slice(-limit) });
  }

  if (req.method === "DELETE" && route === "/events") {
    events.length = 0;
    broadcast({ type: "eventsCleared" });
    return json(res, 200, { ok: true, cleared: true });
  }

  if (req.method === "POST" && route === "/event") {
    const input = await readBody(req);
    if (state.presence === "desk") {
      return json(res, 200, { ok: true, suppressed: "at-desk" });
    }
    const event = makeEvent(input);
    if (deduped(input, event)) {
      return json(res, 200, { ok: true, deduped: true });
    }
    remember(event);
    broadcast({ type: "event", event });
    return json(res, 200, { ok: true, id: event.id });
  }

  if (req.method === "POST" && route === "/ask") {
    const input = await readBody(req);
    if (state.presence === "desk") {
      return json(res, 200, {
        status: "desk",
        message:
          "The user is at their machine. Ask the question in the conversation instead.",
      });
    }
    if (wss.clients.size === 0) {
      return json(res, 200, {
        status: "unavailable",
        message:
          "No phone is connected. Ask the question in the conversation instead.",
      });
    }
    const id = `evt_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const timeoutSeconds = Math.max(
      5,
      Math.min(Number(input.timeoutSeconds || DEFAULT_ASK_TIMEOUT), 900),
    );
    const event = makeEvent(
      {
        ...input,
        kind: "needs_input",
        askId: id,
        options:
          input.options === undefined
            ? [
                { id: "allow", label: "Allow" },
                { id: "deny", label: "Deny", style: "destructive" },
              ]
            : input.options,
        allowText: input.allowText !== false,
      },
      id,
    );

    const alarmRequested = input.urgent === true;
    let alarmAllowed;
    if (alarmRequested) {
      alarmAllowed = alarmActive();
      if (!alarmAllowed) event.urgent = false;
    }

    const escalateAfterSeconds = clamp(
      input.escalateAfterSeconds ?? ESCALATION.afterSeconds,
      5,
      3600,
    );
    const entry = {
      event,
      resolve: null,
      rings: 0,
      urgent: event.urgent === true,
      stopped: false,
      answered: false,
      acked: false,
      lease: null,
      alarm: null,
      escalationTimer: null,
    };
    const answer = new Promise((resolve) => {
      let done = false;
      let answerTimer;
      const finish = (value) => {
        if (done) return;
        done = true;
        entry.answered = true;
        clearTimeout(answerTimer);
        clearEscalation(entry);
        if (entry.lease) {
          const reason =
            value.status === "timeout"
              ? "timeout"
              : value.status === "cancelled"
                ? "cancelled"
                : "answered";
          releaseLease(entry.lease, reason);
        }
        pending.delete(id);
        resolve(value);
      };
      entry.resolve = finish;
      answerTimer = setTimeout(() => {
        finish({ status: "timeout", askId: id });
        broadcast({ type: "cancelled", askId: id, reason: "timeout" });
      }, timeoutSeconds * 1000);
      answerTimer.unref?.();
      pending.set(id, entry);
    });

    const alarm = requestLease(entry);
    entry.alarm = alarm;
    if (alarm.status === "granted") {
      scheduleEscalation(id, escalateAfterSeconds);
    }

    remember(event);
    broadcast({ type: "event", event });
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-ask-id": id,
      "x-alarm-status": alarm.status,
      "x-alarm-holder": alarm.holder
        ? `${alarm.holder.agent}/${alarm.holder.project}`
        : "",
      "x-alarm-retry-after": String(alarm.retryAfterSeconds || 0),
      "x-alarm-mode": statePayload().alarmMode,
      "x-alarm-allowed": alarmAllowed === undefined ? "" : String(alarmAllowed),
    });
    res.flushHeaders();
    const result = await answer;
    res.end(
      JSON.stringify({
        ...result,
        askId: id,
        alarm,
        alarmMode: statePayload().alarmMode,
        ...(alarmRequested ? { alarmAllowed } : {}),
      }),
    );
    return;
  }

  const ackMatch = route.match(/^\/ack\/([A-Za-z0-9_-]+)$/);
  if (req.method === "POST" && ackMatch) {
    const askId = ackMatch[1];
    const entry = pending.get(askId);
    if (!entry) return json(res, 200, { ok: true, alreadyGone: true });
    entry.acked = true;
    clearEscalation(entry);
    if (entry.lease) releaseLease(entry.lease, "acknowledged");
    return json(res, 200, { ok: true });
  }

  const snoozeMatch = route.match(/^\/snooze\/([A-Za-z0-9_-]+)$/);
  if (req.method === "POST" && snoozeMatch) {
    const askId = snoozeMatch[1];
    const entry = pending.get(askId);
    if (!entry) return json(res, 410, { ok: false, error: "ask is no longer pending" });
    const input = await readBody(req);
    const minutes = clamp(input.minutes ?? 5, 1, 60);
    clearEscalation(entry);
    if (entry.lease) releaseLease(entry.lease, "snoozed");
    entry.rings = 0;
    entry.stopped = false;
    entry.acked = false;
    const nextAt = now() + minutes * 60_000;
    const timer = setTimeout(() => {
      const current = pending.get(askId);
      if (!current || current.answered || current.stopped) return;
      const alarm = requestLease(current, { returning: true });
      current.alarm = alarm;
      if (alarm.status === "granted") {
        current.rings = 0;
        fireEscalation(askId);
      }
    }, minutes * 60_000);
    timer.unref?.();
    broadcast({ type: "snoozed", askId, minutes });
    return json(res, 200, {
      ok: true,
      nextAt,
    });
  }

  const stopMatch = route.match(/^\/stop\/([A-Za-z0-9_-]+)$/);
  if (req.method === "POST" && stopMatch) {
    const askId = stopMatch[1];
    const entry = pending.get(askId);
    if (!entry) return json(res, 200, { ok: true, alreadyGone: true });
    entry.stopped = true;
    clearEscalation(entry);
    if (entry.lease) releaseLease(entry.lease, "stopped");
    broadcast({ type: "stopped", askId });
    return json(res, 200, { ok: true });
  }

  const cancelMatch = route.match(/^\/cancel\/([A-Za-z0-9_-]+)$/);
  if (req.method === "POST" && cancelMatch) {
    const askId = cancelMatch[1];
    const pendingAsk = pending.get(askId);
    if (!pendingAsk) return json(res, 200, { ok: true, alreadyGone: true });
    pendingAsk.answered = true;
    clearEscalation(pendingAsk);
    pendingAsk.resolve({ status: "cancelled", askId });
    broadcast({ type: "cancelled", askId, reason: "answered-elsewhere" });
    return json(res, 200, { ok: true });
  }

  const respondMatch = route.match(/^\/respond\/([A-Za-z0-9_-]+)$/);
  if (req.method === "POST" && respondMatch) {
    const askId = respondMatch[1];
    const pendingAsk = pending.get(askId);
    if (!pendingAsk) {
      return json(res, 410, { ok: false, error: "ask is no longer pending" });
    }
    const input = await readBody(req);
    const action = truncate(input.action || "reply", 40);
    const text = truncate(input.text || "", 1000);
    pendingAsk.answered = true;
    clearEscalation(pendingAsk);
    pendingAsk.resolve({ status: "answered", action, text });
    broadcast({ type: "resolved", askId, action, text });
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { ok: false, error: "not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    const status = error.message === "invalid json" ? 400 : 500;
    if (!res.headersSent) json(res, status, { ok: false, error: error.message });
    else res.destroy();
  });
});
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 65_000;

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const queryToken = url.searchParams.get("token") || "";
  if (!safeEqual(bearer, TOKEN) && !safeEqual(queryToken, TOKEN)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  ws.on("error", () => {});
  ws.send(
    JSON.stringify({
      type: "hello",
      now: now(),
      pending: [...pending.values()].map((entry) => entry.event),
    }),
  );
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
heartbeat.unref();

server.listen(PORT, HOST, () => {
  console.log(`agent-notify bridge listening on http://${HOST}:${PORT}`);
  console.log(`websocket: ws://${HOST}:${PORT}/ws`);
  console.log(`pending asks are kept in memory; max ${MAX_EVENTS} recent events`);
});

function shutdown() {
  console.log("shutting down");
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, "server shutdown");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
