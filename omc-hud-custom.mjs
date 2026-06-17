#!/usr/bin/env node
/**
 * OMC HUD custom formatter (wrapper).
 *
 * Runs the canonical OMC HUD (omc-hud.mjs), then reformats its rendered line
 * into a compact pipe-delimited layout requested by the user:
 *
 *   Op4.8/high|5h:6%/3h56m|wk:..|sn:..|think|ctx:21%|se:4.7hr|🔧N|<cwd>|<account>|OMC#X.Y.Z
 *
 * Why a wrapper: OMC's render.js hardcodes " | " separators, the "[...]" label
 * brackets, the "Model: " prefix, the "percent(time)" rate layout and the
 * "session:Nm" label. None are configurable, so we transform the final text.
 * All data (usage %, reset times, tool counts, cwd) still comes from OMC.
 *
 * Defensive: on any parse failure it prints OMC's raw output unchanged, so the
 * statusline never breaks if OMC's format changes after an update.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HUD = join(__dirname, "omc-hud.mjs");

// Currently logged-in Claude account: the part of the email before "@".
// Read from ~/.claude.json (oauthAccount.emailAddress) via a light regex so we
// don't JSON.parse the whole config every render.
function loginAccount() {
  try {
    const raw = readFileSync(join(homedir(), ".claude.json"), "utf8");
    const m = raw.match(/"emailAddress"\s*:\s*"([^"@]+)@/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

// Read the statusline JSON Claude Code pipes on stdin (empty when run manually).
let input = "";
try {
  input = readFileSync(0, "utf8");
} catch {
  /* no stdin */
}

// Current reasoning effort level (low/medium/high/xhigh) from the statusline
// payload (effort.level) — shown next to the model. Empty if absent.
let effort = "";
try {
  effort = String(JSON.parse(input)?.effort?.level || "");
} catch {
  /* no/invalid stdin JSON */
}

const res = spawnSync(process.execPath, [HUD], { input, encoding: "utf8" });
const raw = (res.stdout || "").replace(/\r/g, "");
if (!raw.trim()) {
  // HUD produced nothing usable; surface stderr for debugging and exit.
  process.stdout.write((res.stderr || "").trim() + "\n");
  process.exit(0);
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// Color helpers — we strip OMC's ANSI to parse, then re-apply our own so the
// statusline is highlighted. Threshold scale (usage/context %): green<70,
// yellow<85, red>=85. Pipes and path are dimmed; model name cyan, effort yellow.
const A = (c, s) => `\x1b[${c}m${s}\x1b[0m`;
const SEP = "\x1b[2m|\x1b[0m";
const pc = (n) => (n >= 85 ? "31" : n >= 70 ? "33" : "32");
const colorRate = (seg) => {
  const m = seg.match(/^(\w+):(\d+)%\/(.+)$/);
  return m ? `${m[1]}:${A(pc(+m[2]), m[2] + "%")}\x1b[2m/\x1b[0m${A("36", m[3])}` : seg;
};
const colorCtx = (seg) => {
  const m = seg.match(/^ctx:(\d+)%/); // tolerate a trailing " CRITICAL"/suffix
  return m ? `ctx:${A(pc(+m[1]), m[1] + "%")}` : seg;
};
const colorModel = (seg) => {
  const m = seg.match(/^(.+?)\/(\w+)$/);
  return m ? `${A("36", m[1])}\x1b[2m/\x1b[0m${A("33", m[2])}` : A("36", seg);
};
const colorSe = (seg) => {
  const m = seg.match(/^se:(.+)$/);
  return m ? `se:${A("33", m[1])}` : seg;
};

try {
  const lines = raw.split("\n").map(stripAnsi).filter((l) => l.length);
  const mainIdx = lines.findIndex((l) => l.includes("OMC#"));
  if (mainIdx === -1) throw new Error("no OMC line");

  const main = lines[mainIdx];
  const pathLine = lines.slice(0, mainIdx).join(" ").trim(); // cwd (+git) group above
  let below = lines.slice(mainIdx + 1); // multiline detail group (agent tree, warnings)

  // Collapse " | " -> "|", then split into segments.
  const rawSegs = main
    .replace(/\s*\|\s*/g, "|")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);

  // The 5h/wk/sn rate windows live in one space-separated segment; expand them.
  const segs = [];
  for (const s of rawSegs) {
    if (/\b(5h|wk|sn):/.test(s) && /\s/.test(s)) {
      for (const p of s.split(/\s+/)) if (p) segs.push(p);
    } else {
      segs.push(s);
    }
  }

  const f = { label: "", model: "", r5: "", rwk: "", rsn: "", think: "", ctx: "", se: "", counts: "" };
  const extra = [];
  const slash = (s) => s.replace(/%\*?\s*\(~?([^)]+)\)/, "%/$1"); // 9%*(~4h3m)/6%(3h56m) -> 9%/4h3m

  for (const s of segs) {
    if (/^\[?OMC#/.test(s)) {
      const m = s.match(/OMC#([0-9][0-9.]*)/);
      f.label = m ? `OMC#${m[1]}` : s; // drop brackets + trailing "L"
    } else if (/^Model:/.test(s) || /^(Opus|Sonnet|Haiku)\b/.test(s)) {
      const m = s.match(/(?:Model:\s*)?([A-Za-z]+)\s*([0-9][0-9.]*)/);
      f.model = m ? `${m[1].slice(0, 2)}${m[2]}${effort ? "/" + effort : ""}` : s; // Opus 4.8 -> Op4.8/high
    } else if (/^5h:/.test(s)) {
      f.r5 = slash(s);
    } else if (/^wk:/.test(s)) {
      f.rwk = slash(s);
    } else if (/^sn:/.test(s)) {
      f.rsn = slash(s);
    } else if (/^think/i.test(s)) {
      f.think = "think";
    } else if (/^ctx:/.test(s)) {
      f.ctx = s;
    } else if (/^session:/.test(s)) {
      const m = s.match(/session:(\d+)m/);
      f.se = m ? `se:${(parseInt(m[1], 10) / 60).toFixed(1)}hr` : s.replace(/^session:/, "se:");
    } else if (/🔧|🤖|⚡/.test(s) || /^[TAS]:\d/.test(s)) {
      f.counts = s;
    } else {
      extra.push(s); // dynamic badges: todos, ralph, autopilot, bg, skill, etc.
    }
  }

  // pathLine = the cwd group OMC renders above the OMC# line. Depending on OMC
  // version/config it can also carry git decorations (repo:/branch:/!N) and even
  // the model token. Keep ONLY the real filesystem path; recover the model from
  // here if the main line didn't carry it (older layouts put it in this group).
  let cwd = "";
  if (pathLine) {
    const parts = pathLine.split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
    // Keep ONLY the real filesystem path. A "label:value" token (profile:, repo:,
    // branch:, [API ...]) is a badge, not a path — exclude it. A drive letter
    // (C:\) is a path: "label:" is a badge only when NOT followed by a slash.
    // No fallback to parts[0]: if no path token exists, show nothing (never a badge).
    const isBadge = (s) => /^[A-Za-z][\w.-]*:(?![\\/])/.test(s) || /^\[/.test(s);
    cwd = parts.find((s) => /[\/~\\]/.test(s) && !isBadge(s)) || "";
    if (!f.model) {
      const mp = parts.find((s) => /^(?:Model:\s*)?(Opus|Sonnet|Haiku)\b/.test(s));
      const m = mp && mp.match(/(Opus|Sonnet|Haiku)\s*([0-9][0-9.]*)/);
      if (m) f.model = `${m[1].slice(0, 2)}${m[2]}${effort ? "/" + effort : ""}`;
    }
  }

  // At critical context OMC drops ctx from the main line and emits it as a detail
  // line below (e.g. "  ctx:94% CRITICAL"). Fold it back inline and remove the
  // standalone line so the layout stays single-line. Red color conveys severity.
  const isCtxLine = (l) => /(?:^|\s)ctx:\d+%/.test(l);
  if (!f.ctx) {
    const cl = below.find(isCtxLine);
    const m = cl && cl.match(/ctx:(\d+)%/);
    if (m) f.ctx = `ctx:${m[1]}%`;
  }
  below = below.filter((l) => !isCtxLine(l));

  const colored = [];
  if (f.model) colored.push(colorModel(f.model));
  if (f.r5) colored.push(colorRate(f.r5));
  if (f.rwk) colored.push(colorRate(f.rwk));
  if (f.rsn) colored.push(colorRate(f.rsn));
  if (f.think) colored.push(A("36", f.think));
  if (f.ctx) colored.push(colorCtx(f.ctx));
  if (f.se) colored.push(colorSe(f.se));
  if (f.counts) colored.push(f.counts.trim().replace(/\s+/g, SEP));
  // 화이트리스트 고정: profile/스킬/브랜치 등 동적 배지(extra)는 출력하지 않는다.
  // (ralph/autopilot/todo/background 배지도 함께 표시되지 않음 — 의도된 동작)
  if (cwd) colored.push(A("36", cwd)); // sanitized path only (git/model stripped)
  const acct = loginAccount();
  if (acct) colored.push(A("92", acct));
  if (f.label) colored.push(A("1", f.label)); // OMC label moved to the very end

  let result = colored.join(SEP);
  if (below.length) result += "\n" + below.join("\n");
  process.stdout.write(result + "\n");
} catch {
  process.stdout.write(raw.endsWith("\n") ? raw : raw + "\n"); // safe passthrough
}
