import path from "node:path";
import { execFileSync } from "node:child_process";
import { baseUrl, readConfig, authHeaders } from "../lib/config.mjs";

export function truncate(value, max = 600) {
  if (typeof value !== "string") return "";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function projectInfo(input) {
  const candidates = [
    input?.cwd,
    input?.GEMINI_CWD,
    process.env.GEMINI_CWD,
    process.env.GEMINI_PROJECT_DIR,
    Array.isArray(input?.workspacePaths) ? input.workspacePaths[0] : "",
    process.env.ANTIGRAVITY_PROJECT_DIR,
    process.env.CLAUDE_PROJECT_DIR,
    process.cwd(),
  ];
  const cwd = candidates.find((value) => typeof value === "string" && value.trim()) || process.cwd();
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

export async function postEvent(event, timeoutMs = 2500) {
  const config = readConfig();
  const base = baseUrl(config);
  if (!base || !config.token) return false;
  try {
    const response = await fetch(`${base}/event`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(config) },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", () => resolve(""));
  });
}
