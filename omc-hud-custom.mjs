#!/usr/bin/env node
/**
 * OMC HUD custom formatter (wrapper) — v3
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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Changes vs v1 (formatting logic below is byte-identical to v1 on purpose):
 *
 *   1. The canonical HUD runs IN THIS PROCESS instead of via spawnSync, so a
 *      statusline refresh costs one node process instead of two. Windows charges
 *      kernel paged pool per process creation (fltmgr FMfn name-cache node), and
 *      on this machine that accumulation is not reclaimable short of a reboot.
 *
 *   2. Every unbounded wait now has a time budget. v1 could block forever in two
 *      places with no timeout: readFileSync(0) waiting for stdin EOF, and
 *      spawnSync waiting on the child. Both are SYNCHRONOUS, so a setTimeout
 *      watchdog cannot fire while they block — the event loop is not running.
 *      A stalled instance never dies, and the next refresh spawns another, so
 *      they accumulate linearly. Both are now async and bounded.
 *
 * Timer discipline comes from a 3-OS reproduction documented in
 * .omc/wiki/bounding-a-hanging-dynamic-import-in-node.md:
 *   - the budget timer stays REF'd: an unref'd timer never fires when Node bails
 *     out of an unsettled top-level await with exit 13,
 *   - the self-exit timer is UNREF'd: it must not hold a healthy process open,
 *     and when something really is hung the loop is alive so it still fires,
 *   - the budget is 10s, not 3s: a tight budget silently discards work that was
 *     merely slow, without saving any time (the hung import holds the loop anyway).
 *
 * 🔴 omc-hud.mjs ends with a bare `main();` — no await. Module evaluation
 *    therefore completes BEFORE any output is produced. Awaiting the import
 *    alone captures nothing (that is why v2 printed "[OMC HUD] no output").
 *    We wait for the first complete line instead.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HUD = join(__dirname, "omc-hud.mjs");

const STDIN_TIMEOUT_MS = 2000; // Claude Code pipes the payload immediately
const RENDER_TIMEOUT_MS = 10000; // see timer discipline note above
const SPAWN_TIMEOUT_MS = 8000; // fallback path only
const EXIT_GRACE_MS = 2000;
const HARD_EXIT_MS = 20000;

// Last-resort guard: if any path leaves us alive past this, end voluntarily.
// unref'd so a healthy render is never held open by it.
{
  const g = setTimeout(() => {
    try {
      process.stdout.write("\n");
    } catch {
      /* stdout already gone */
    }
    process.exit(0);
  }, HARD_EXIT_MS);
  if (g && g.unref) g.unref();
}

// Print and terminate. The canonical HUD ran in-process, so its own async work
// may still be pending on the event loop; once our line is out there is nothing
// left to wait for. The write callback is the flush-safe exit point, and the
// unref'd timer covers the case where the callback never arrives.
function emit(s) {
  try {
    process.stdout.write(s, () => process.exit(0));
  } catch {
    process.exit(0);
  }
  const k = setTimeout(() => process.exit(0), EXIT_GRACE_MS);
  if (k && k.unref) k.unref();
}

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

// Read the statusline JSON Claude Code pipes on stdin, bounded.
// A TTY means a human ran this by hand — there is no EOF coming, so skip it
// entirely rather than hang waiting for one.
function readStdinBounded(ms) {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const onData = (c) => {
      data += c;
    };
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", finish);
      process.stdin.removeListener("error", finish);
      try {
        process.stdin.pause();
      } catch {
        /* already closed */
      }
      resolve(data);
    };
    const t = setTimeout(finish, ms); // ref'd on purpose
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", onData);
      process.stdin.once("end", finish);
      process.stdin.once("error", finish);
    } catch {
      finish();
    }
  });
}

const input = await readStdinBounded(STDIN_TIMEOUT_MS);

// Current reasoning effort level (low/medium/high/xhigh) from the statusline
// payload (effort.level) — shown next to the model. Empty if absent.
let effort = "";
try {
  effort = String(JSON.parse(input)?.effort?.level || "");
} catch {
  /* no/invalid stdin JSON */
}

// Run the canonical HUD in-process, capturing what it writes to stdout.
// Resolves on the first complete line (see the `main();` note in the header),
// or when the budget expires — whichever comes first.
//
// 🔴 The HUD DOES read stdin — dist/hud/stdin.js readStdin() async-iterates
//    process.stdin (it is not readFileSync(0)). We already drained the real fd,
//    so without replaying the payload the HUD sees empty input and prints its
//    "HUD installed / statusLine configured" info screen instead of a
//    statusline. Swapping process.stdin for a stream carrying the same bytes
//    restores identical behaviour to the spawnSync path, which fed the child
//    through its stdin.
async function renderInProcess(ms) {
  const origWrite = process.stdout.write.bind(process.stdout);
  const origStdin = Object.getOwnPropertyDescriptor(process, "stdin");
  let captured = "";
  let settleFirstLine;
  const firstLine = new Promise((r) => {
    settleFirstLine = r;
  });

  const replay = Readable.from(input ? [input] : []);
  replay.isTTY = false; // must stay falsy or readStdin() bails out early
  try {
    Object.defineProperty(process, "stdin", { value: replay, configurable: true });
  } catch {
    /* leave the real stdin in place; the fallback path still works */
  }

  process.stdout.write = (chunk, enc, cb) => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const done = typeof enc === "function" ? enc : cb;
    if (typeof done === "function") done();
    if (captured.includes("\n")) settleFirstLine();
    return true;
  };

  let budgetTimer;
  const budget = new Promise((r) => {
    budgetTimer = setTimeout(r, ms); // ref'd on purpose
  });

  try {
    await Promise.race([
      (async () => {
        await import(pathToFileURL(HUD).href);
        await firstLine;
      })(),
      budget,
    ]);
  } finally {
    clearTimeout(budgetTimer);
    process.stdout.write = origWrite;
    // Restore the real stdin so the spawnSync fallback below behaves normally.
    if (origStdin) {
      try {
        Object.defineProperty(process, "stdin", origStdin);
      } catch {
        /* not restorable; we exit right after anyway */
      }
    }
  }
  return captured;
}

let raw = "";
try {
  raw = (await renderInProcess(RENDER_TIMEOUT_MS)).replace(/\r/g, "");
} catch {
  raw = ""; // fall through to the child-process path
}

if (!raw.trim()) {
  // In-process rendering produced nothing usable. Fall back to the original
  // out-of-process path: it costs an extra node, but a statusline that renders
  // beats one that does not — e.g. if a future OMC version stops being
  // import-safe. Bounded, unlike v1.
  const res = spawnSync(process.execPath, [HUD], {
    input,
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
  });
  raw = (res.stdout || "").replace(/\r/g, "");
  if (!raw.trim()) {
    emit(((res.stderr || "").trim() || "[OMC HUD] no output") + "\n");
  }
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
  const m = seg.match(/^ctx:(\d+)%$/);
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
// Per-model usage badge ("fable:0%") rides along in the rate group and has no
// dedicated field. Shorten the model name to two letters so it matches the
// model token's own convention (Opus 4.8 -> Op4.8): fable:0% -> Fa:0%.
// OMC appends a stale marker and/or a reset time to scoped weekly buckets
// (renderRateLimits in dist/hud/elements/limits.js), so the pattern must not
// anchor at "%": keep that tail intact -> fable:0%(3d3h) -> Fa:0%(3d3h).
const shortModelPct = (seg) => {
  const m = seg.match(/^([A-Za-z][A-Za-z0-9.-]*):(\d+%\*?(?:\([^)]*\))?)$/);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1, 2).toLowerCase()}:${m[2]}` : seg;
};

try {
  const lines = raw.split("\n").map(stripAnsi).filter((l) => l.length);
  const mainIdx = lines.findIndex((l) => l.includes("OMC#"));
  if (mainIdx === -1) throw new Error("no OMC line");

  const main = lines[mainIdx];
  const pathLine = lines.slice(0, mainIdx).join(" ").trim(); // cwd (+git) group above
  const below = lines.slice(mainIdx + 1); // multiline agent tree, kept as-is

  // Collapse " | " -> "|", then split into segments.
  const rawSegs = main
    .replace(/\s*\|\s*/g, "|")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);

  // The 5h/wk/sn rate windows live in one space-separated segment; expand them.
  // The per-model usage badge ("fable:0%") arrives inside that same segment, so
  // remember which pieces came from there. Only those get abbreviated later —
  // unrelated badges that also land in `extra` must be left alone.
  const segs = [];
  const rateGroup = new Set();
  for (const s of rawSegs) {
    if (/\b(5h|wk|sn):/.test(s) && /\s/.test(s)) {
      for (const p of s.split(/\s+/)) {
        if (!p) continue;
        segs.push(p);
        if (!/^(5h|wk|sn):/.test(p)) rateGroup.add(p);
      }
    } else {
      segs.push(s);
    }
  }

  const f = { label: "", model: "", r5: "", rwk: "", rsn: "", think: "", ctx: "", se: "", counts: "" };
  const extra = [];
  const slash = (s) => s.replace(/%\(([^)]+)\)/, "%/$1"); // 6%(3h56m) -> 6%/3h56m

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

  const colored = [];
  if (f.model) colored.push(colorModel(f.model));
  if (f.r5) colored.push(colorRate(f.r5));
  if (f.rwk) colored.push(colorRate(f.rwk));
  if (f.rsn) colored.push(colorRate(f.rsn));
  if (f.think) colored.push(A("36", f.think));
  if (f.ctx) colored.push(colorCtx(f.ctx));
  if (f.se) colored.push(colorSe(f.se));
  if (f.counts) colored.push(f.counts.trim().replace(/\s+/g, SEP));
  for (const e of extra) colored.push(A("2", rateGroup.has(e) ? shortModelPct(e) : e));
  if (pathLine) colored.push(A("36", pathLine));
  const acct = loginAccount();
  if (acct) colored.push(A("92", acct));
  if (f.label) colored.push(A("1", f.label)); // OMC label moved to the very end

  let result = colored.join(SEP);
  if (below.length) result += "\n" + below.join("\n");
  emit(result + "\n");
} catch {
  emit(raw.endsWith("\n") ? raw : raw + "\n"); // safe passthrough
}
