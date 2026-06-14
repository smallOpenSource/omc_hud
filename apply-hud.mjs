#!/usr/bin/env node
/**
 * apply-hud.mjs — cross-platform installer for the custom OMC HUD statusline.
 *
 * Installs into ${CLAUDE_CONFIG_DIR:-~/.claude}:
 *   - hud/omc-hud.mjs        (OMC loader, copied from the installed plugin)
 *   - hud/lib/config-dir.mjs (loader dependency)
 *   - hud/omc-hud-custom.mjs (the custom compact/colored formatter)
 *   - .omc/hud-config.json   (HUD preset/elements)
 *   - settings.json          (statusLine -> the custom formatter; existing file backed up)
 *
 * Runs identically on Linux, macOS, and Windows (only needs node + an OMC install).
 * The platform launchers (apply-hud-*.sh / .ps1) just invoke this file.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = (process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")).replace(/[\\/]+$/, "");
const HUD_DIR = join(CONFIG_DIR, "hud");
const OMC_DIR = join(CONFIG_DIR, ".omc");
const log = (m) => process.stdout.write(m + "\n");

// 1. Ensure target directories exist.
for (const d of [join(HUD_DIR, "lib"), OMC_DIR]) mkdirSync(d, { recursive: true });

// 2. Resolve the installed OMC plugin root (for the canonical HUD loader template).
function resolvePluginRoot() {
  const hasTemplate = (r) => !!r && existsSync(join(r, "scripts", "lib", "hud-wrapper-template.txt"));
  if (hasTemplate(process.env.OMC_PLUGIN_ROOT)) return process.env.OMC_PLUGIN_ROOT;
  const base = join(CONFIG_DIR, "plugins", "cache", "omc", "oh-my-claudecode");
  if (!existsSync(base)) return null;
  const SEMVER = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
  const versions = readdirSync(base)
    .filter((n) => SEMVER.test(n))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); // newest first
  for (const v of versions) {
    const r = join(base, v);
    if (hasTemplate(r)) return r;
  }
  return null;
}

const pluginRoot = resolvePluginRoot();
const loaderDst = join(HUD_DIR, "omc-hud.mjs");
if (pluginRoot) {
  copyFileSync(join(pluginRoot, "scripts", "lib", "hud-wrapper-template.txt"), loaderDst);
  copyFileSync(join(pluginRoot, "scripts", "lib", "config-dir.mjs"), join(HUD_DIR, "lib", "config-dir.mjs"));
  log("[ok] OMC HUD loader installed from " + pluginRoot);
} else if (existsSync(loaderDst)) {
  log("[..] OMC plugin root not found; keeping existing hud/omc-hud.mjs");
} else {
  log("[x] OMC plugin not installed and no existing hud/omc-hud.mjs found.");
  log("    Install OMC first, then re-run:");
  log("      /plugin install oh-my-claudecode   (or)   npm i -g oh-my-claude-sisyphus");
  process.exit(1);
}

// 3. Install the custom formatter and HUD config from the bundled templates.
copyFileSync(join(SELF, "omc-hud-custom.mjs"), join(HUD_DIR, "omc-hud-custom.mjs"));
copyFileSync(join(SELF, "hud-config.json"), join(OMC_DIR, "hud-config.json"));
log("[ok] Custom formatter -> " + join(HUD_DIR, "omc-hud-custom.mjs"));
log("[ok] HUD config       -> " + join(OMC_DIR, "hud-config.json"));

// 4. Point settings.json statusLine at the custom formatter.
//    Use an absolute forward-slash path: Claude Code runs statusLine via a shell
//    that treats backslashes as escapes, so forward slashes are required on Windows too.
const settingsPath = join(CONFIG_DIR, "settings.json");
const cmdPath = join(HUD_DIR, "omc-hud-custom.mjs").split(sep).join("/");
let settings = {};
if (existsSync(settingsPath)) {
  const rawTxt = readFileSync(settingsPath, "utf8");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = settingsPath + ".backup." + stamp;
  writeFileSync(backup, rawTxt);
  log("[ok] Backed up settings.json -> " + backup);
  try {
    settings = JSON.parse(rawTxt);
  } catch {
    log("[!] Existing settings.json is not valid JSON; writing a fresh one (backup kept).");
    settings = {};
  }
}
settings.statusLine = { type: "command", command: "node " + cmdPath };
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
log("[ok] statusLine -> node " + cmdPath);

log("");
log("Done. Restart Claude Code to load the new statusline.");
