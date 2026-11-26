#!/usr/bin/env node
/**
 * Antigravity CLI/IDE Stop hook adapter.
 *
 * Antigravity sends the event JSON on stdin. The Stop hook must answer with a
 * decision; "allow" lets the agent stop normally.
 */
import { postEvent, projectInfo, readStdin, truncate } from "./hook-lib.mjs";

function finish() {
  process.stdout.write(JSON.stringify({ decision: "allow" }));
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

  const info = projectInfo(input);
  const conversation = input.conversationId || "";
  const reason = String(input.terminationReason || "model_stop");
  const error = truncate(input.error || "", 900);
  const idle = input.fullyIdle !== false;

  let kind = "done";
  let title = "Antigravity finished";
  let body = `Finished in ${info.project}.`;
  if (reason === "error" || (error && !idle)) {
    kind = "error";
    title = "Antigravity stopped with an error";
    body = error || `The run ended with ${reason}.`;
  } else if (!idle) {
    kind = "info";
    title = "Antigravity is paused";
    body = "Background work is still running.";
  }

  await postEvent({
    agent: "antigravity",
    session: conversation,
    project: info.project,
    kind,
    title,
    body,
    dedupeKey: `antigravity|${conversation}|stop|${reason}`,
    dedupeMs: 5000,
    meta: { cwd: info.cwd, branch: info.branch, terminationReason: reason },
  });
  finish();
}

main().catch(() => finish());
