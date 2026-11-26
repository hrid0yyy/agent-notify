import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function commandExists(command) {
  try {
    if (process.platform === "win32") {
      execFileSync("where", [command], { stdio: "ignore" });
    } else {
      execFileSync("which", [command], { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function backup(file) {
  if (!fs.existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(file, `${file}.bak-agent-notify-${stamp}`);
}

function quote(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

export function hookCommand(node, script, event = "") {
  return `${quote(node)} ${quote(script)}${event ? ` ${event}` : ""}`;
}

export function installGeminiIntegration({
  home = os.homedir(),
  node,
  mcpScript,
  hookScript,
  force = false,
} = {}) {
  const settingsPath = path.join(home, ".gemini", "settings.json");
  if (!force && !fs.existsSync(settingsPath) && !commandExists("gemini")) {
    return { installed: false, reason: "Gemini CLI not detected" };
  }

  const settings = readJson(settingsPath, {});
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return { installed: false, reason: `${settingsPath} is not a JSON object` };
  }
  backup(settingsPath);

  settings.mcpServers =
    settings.mcpServers && typeof settings.mcpServers === "object"
      ? settings.mcpServers
      : {};
  settings.mcpServers["agent-notify"] = {
    command: node,
    args: [mcpScript],
  };

  settings.hooks =
    settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  const addHook = (event, name) => {
    const current = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    settings.hooks[event] = current
      .filter((group) => !JSON.stringify(group).includes("gemini-hook.mjs"))
      .concat([
        {
          matcher: "",
          hooks: [
            {
              name,
              type: "command",
              command: hookCommand(node, hookScript, event),
              timeout: 5000,
            },
          ],
        },
      ]);
  };
  addHook("AfterAgent", "agent-notify-gemini-done");
  addHook("Notification", "agent-notify-gemini-notification");

  writeJson(settingsPath, settings);
  return { installed: true, path: settingsPath };
}

export function installAntigravityIntegration({
  home = os.homedir(),
  node,
  mcpScript,
  hookScript,
  force = false,
} = {}) {
  const configDir = path.join(home, ".gemini", "config");
  const cliDir = path.join(home, ".gemini", "antigravity-cli");
  if (
    !force &&
    !fs.existsSync(configDir) &&
    !fs.existsSync(cliDir) &&
    !commandExists("agy")
  ) {
    return { installed: false, reason: "Antigravity not detected" };
  }

  const mcpPath = path.join(configDir, "mcp_config.json");
  const mcp = readJson(mcpPath, {});
  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) {
    return { installed: false, reason: `${mcpPath} is not a JSON object` };
  }
  backup(mcpPath);
  mcp.mcpServers =
    mcp.mcpServers && typeof mcp.mcpServers === "object" ? mcp.mcpServers : {};
  mcp.mcpServers["agent-notify"] = {
    command: node,
    args: [mcpScript],
  };
  writeJson(mcpPath, mcp);

  const stopHook = [
    {
      type: "command",
      command: hookCommand(node, hookScript, "Stop"),
      timeout: 15,
    },
  ];
  const hookPaths = [path.join(configDir, "hooks.json")];
  if (fs.existsSync(cliDir) || commandExists("agy")) {
    hookPaths.push(path.join(cliDir, "hooks.json"));
  }
  for (const hookPath of hookPaths) {
    const hooks = readJson(hookPath, {});
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) continue;
    backup(hookPath);
    const existing =
      hooks["agent-notify"] &&
      typeof hooks["agent-notify"] === "object" &&
      !Array.isArray(hooks["agent-notify"])
        ? hooks["agent-notify"]
        : {};
    hooks["agent-notify"] = { ...existing, Stop: stopHook };
    writeJson(hookPath, hooks);
  }

  return {
    installed: true,
    path: mcpPath,
    hooks: hookPaths,
  };
}
