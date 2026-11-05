// Restart the focused agent in place, on the same conversation.
//
// A key (keys.json: "cmd-shift-r": "claude-resume.go") arms it for the focused terminal;
// the same key again within a few seconds does it: the foreground program is
// ended (SIGTERM), the terminal's own shell gets its prompt back, and the same
// command line is typed into it again. A Claude Code session started without
// --resume gets "--resume <its session id>" (from ~/.claude/sessions/<pid>.json),
// so it comes back on the same conversation; a plain `codex` comes back as
// `codex resume --last`. Anything else is simply run again as it was.
//
// Commands (keys, or `herdr-app do claude-resume.<name>`): go[:<terminal>], dry[:<terminal>], cancel.
// This copy floats over the main block and draws only while it has something to say.

import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { focused, panes, agents, hc, exec, notify, nextCommand, theme } from "herdr";

const ARM_MS = 4000; // the second press must come within this
const SHOW_MS = 4000; // how long a result stays on screen
const WAIT_MS = 15000; // at most this long for the program to end
const SOFT_MS = 8000; // SIGKILL after this if SIGTERM didn't do it
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "nu", "dash", "ksh", "pwsh", "powershell", "cmd"]);

const machineOf = (addr) => (addr.includes("/") ? addr.split("/")[0] : null);
const base = (p) => String(p ?? "").split("/").pop();
const quote = (s) => (/^[A-Za-z0-9_\-.\/=:@%+,]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const sleep = (s) => exec("sleep", [String(s)]).catch(() => {});

// Whose terminal: the agent's space and tab name, else the pane's title, else the address.
function labelOf(addr) {
  const a = agents().find((x) => x.address === addr);
  if (a) return a.space_name ? `${a.space_name} / ${a.tab_name}` : a.tab_name;
  return panes().find((p) => p.terminal === addr)?.title || addr;
}

// The command line to come back with. Claude Code without a session flag gets
// its running session's id; a bare codex resumes its last session.
function withResume(argv, sessionId) {
  const prog = base(argv[0]);
  if (prog === "claude") {
    const has = argv.slice(1).some((a) => /^(-r|--resume|-c|--continue|--session-id)(=|$)/.test(a));
    return !has && sessionId ? [...argv, "--resume", sessionId] : argv;
  }
  if (prog === "codex" && argv.length === 1) return [argv[0], "resume", "--last"];
  return argv;
}

export default class ClaudeResume extends View {
  init(_props, cx) {
    this.armed = null; // { addr, label, n }
    this.note = null; // { text, kind, n }
    this.busy = false;
    this.n = 0;
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const [name, value] = c.split(/:(.*)/s);
        const addr = value || focused()?.terminal || null;
        if (name === "cancel") this.armed = null;
        else if (!addr) this.say("No terminal is focused", "error", cx);
        else if (name === "dry") this.dry(addr, cx);
        else if (name === "go") this.go(addr, cx);
        cx.notify();
      }
    });
  }

  say(text, kind, cx) {
    const n = ++this.n;
    this.note = { text, kind, n };
    cx.timer.after(SHOW_MS, (cx) => { if (this.note?.n === n) this.note = null; cx.notify(); });
    cx.notify();
  }

  // First press arms; the same terminal again within ARM_MS runs it.
  go(addr, cx) {
    if (this.busy) return;
    if (this.armed?.addr === addr) { this.armed = null; this.restart(addr, cx); return; }
    const n = ++this.n;
    this.armed = { addr, label: labelOf(addr), n };
    cx.timer.after(ARM_MS, (cx) => { if (this.armed?.n === n) this.armed = null; cx.notify(); });
    cx.notify();
  }

  // What the terminal runs now, and the line it would come back with.
  async plan(addr) {
    const g = await hc(["get", addr, "--json"]);
    if (g.code !== 0) throw new Error(g.stderr.trim() || `hc get ${addr} failed`);
    const info = JSON.parse(g.stdout);
    const fg = info.foreground;
    if (!fg?.pid || !Array.isArray(fg.argv) || !fg.argv.length || SHELLS.has(base(fg.argv[0]))) {
      throw new Error("Nothing to restart: the terminal is at its shell prompt");
    }
    const on = machineOf(addr);
    let sessionId = null;
    if (base(fg.argv[0]) === "claude") {
      const r = await exec("sh", ["-c", 'cat "$HOME/.claude/sessions/$1.json" 2>/dev/null', "sh", String(fg.pid)], { on }).catch(() => null);
      try { sessionId = JSON.parse(r?.stdout || "{}").sessionId ?? null; } catch { sessionId = null; }
    }
    const argv = withResume(fg.argv, sessionId);
    return { on, pid: fg.pid, argv, line: argv.map(quote).join(" "), was: fg.argv.map(quote).join(" ") };
  }

  dry(addr, cx) {
    cx.spawn(async (cx) => {
      try {
        const p = await this.plan(addr);
        this.say(`${labelOf(addr)} would come back as: ${p.line}`, "info", cx);
        notify({ title: `Would restart ${labelOf(addr)}`, body: `pid ${p.pid}: ${p.was}\n→ ${p.line}`, level: "info", timeout: 8000 });
      } catch (e) {
        this.say(String(e?.message ?? e), "error", cx);
      }
      cx.notify();
    });
  }

  restart(addr, cx) {
    const label = labelOf(addr);
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const p = await this.plan(addr);
        this.say(`Stopping ${label}…`, "busy", cx);
        await exec("kill", ["-TERM", String(p.pid)], { on: p.on });
        // Wait for it to go; a program that ignores SIGTERM gets SIGKILL.
        const t0 = Date.now();
        let killed = false;
        for (;;) {
          await sleep(0.3);
          const alive = (await exec("kill", ["-0", String(p.pid)], { on: p.on }).catch(() => ({ code: 1 }))).code === 0;
          if (!alive) break;
          if (Date.now() - t0 > WAIT_MS) throw new Error(`${label} didn't stop (pid ${p.pid})`);
          if (!killed && Date.now() - t0 > SOFT_MS) { killed = true; await exec("kill", ["-KILL", String(p.pid)], { on: p.on }); }
        }
        // The terminal's shell has its prompt back; the terminal itself must still be there.
        await sleep(0.6);
        const g = await hc(["get", addr, "--json"]);
        if (g.code !== 0) throw new Error(`${label}'s terminal is gone; start it again by hand`);
        const fg = JSON.parse(g.stdout).foreground;
        if (fg?.argv?.length && !SHELLS.has(base(fg.argv[0]))) throw new Error(`${label} still runs ${base(fg.argv[0])}`);
        this.say(`Starting ${label} again…`, "busy", cx);
        const s = await hc(["send", addr, p.line]);
        if (s.code !== 0) throw new Error(s.stderr.trim() || "hc send failed");
        this.say(`Restarted ${label}`, "ok", cx);
        notify({ title: `Restarted ${label}`, body: p.line, level: "success", timeout: 5000 });
      } catch (e) {
        const msg = String(e?.message ?? e);
        this.say(msg, "error", cx);
        notify({ title: `Couldn't restart ${label}`, body: msg, level: "error" });
      }
      this.busy = false;
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const a = this.armed, n = this.note;
    if (!a && !n) return div();
    const color = a ? t.blocked : n.kind === "error" ? t.blocked : n.kind === "ok" ? t.done : n.kind === "busy" ? t.working : t.foreground;
    const text = a ? `Restart ${a.label} on the same session? Press the key again.` : n.text;
    return h_flex().px(12).h(26).gap(8).items_center().text_size(12.5).text_color(t.foreground)
      .child(div().size(7).rounded(4).flex_none().bg(color).when(Boolean(a) || n?.kind === "busy", (el) => el.loop("opacity", { from: 0.3, to: 1, period: 700 })))
      .child(div().max_w(640).truncate().child(text));
  }
}
