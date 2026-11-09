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
// `all` does the same for every agent at once (keys.json: "cmd-alt-shift-r": "claude-resume.all"),
// also armed by one press and run by the next.
//
// Commands (keys, or `herdr-app do claude-resume.<name>`):
//   go[:<terminal>], dry[:<terminal>], all, go:all, dry:all, cancel.
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
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

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
    this.armed = null; // { addr, label, n } or { all: [addr…], label, n }
    this.note = null; // { text, kind, n }
    this.busy = false;
    this.n = 0;
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const [name, value] = c.split(/:(.*)/s);
        const all = name === "all" || value === "all";
        const addr = all ? null : value || focused()?.terminal || null;
        if (name === "cancel") this.armed = null;
        else if (all && name === "dry") this.dryAll(cx);
        else if (all) this.goAll(cx);
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

  arm(armed, cx) {
    const n = ++this.n;
    this.armed = { ...armed, n };
    cx.timer.after(ARM_MS, (cx) => { if (this.armed?.n === n) this.armed = null; cx.notify(); });
    cx.notify();
  }

  // First press arms; the same terminal again within ARM_MS runs it.
  go(addr, cx) {
    if (this.busy) return;
    if (this.armed?.addr === addr) { this.armed = null; this.restart(addr, cx); return; }
    this.arm({ addr, label: labelOf(addr) }, cx);
  }

  // Every live agent; first press arms, the next one restarts them all at once.
  goAll(cx) {
    if (this.busy) return;
    if (this.armed?.all) { const addrs = this.armed.all; this.armed = null; this.restartAll(addrs, cx); return; }
    const list = agents();
    if (!list.length) { this.say("No agents are running", "error", cx); return; }
    const working = list.filter((a) => a.status === "working").length;
    const label = `all ${plural(list.length, "agent")}${working ? ` (${working} working too)` : ""}`;
    this.arm({ all: list.map((a) => a.address), label }, cx);
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

  dryAll(cx) {
    const addrs = agents().map((a) => a.address);
    if (!addrs.length) { this.say("No agents are running", "error", cx); return; }
    cx.spawn(async (cx) => {
      const rows = await Promise.all(addrs.map(async (addr) => {
        try { return `${labelOf(addr)}: ${(await this.plan(addr)).line}`; }
        catch (e) { return `${labelOf(addr)}: skip (${String(e?.message ?? e)})`; }
      }));
      this.say(`Would restart ${plural(addrs.length, "agent")}; see the notification`, "info", cx);
      notify({ title: `Would restart ${plural(addrs.length, "agent")}`, body: rows.join("\n"), level: "info", timeout: 12000 });
      cx.notify();
    });
  }

  // End the program in <addr> and type its line back. Resolves to the line; throws with the reason.
  async cycle(addr, label, say) {
    const p = await this.plan(addr);
    say(`Stopping ${label}…`);
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
    say(`Starting ${label} again…`);
    const s = await hc(["send", addr, p.line]);
    if (s.code !== 0) throw new Error(s.stderr.trim() || "hc send failed");
    return p.line;
  }

  restart(addr, cx) {
    const label = labelOf(addr);
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const line = await this.cycle(addr, label, (t) => this.say(t, "busy", cx));
        this.say(`Restarted ${label}`, "ok", cx);
        notify({ title: `Restarted ${label}`, body: line, level: "success", timeout: 5000 });
      } catch (e) {
        const msg = String(e?.message ?? e);
        this.say(msg, "error", cx);
        notify({ title: `Couldn't restart ${label}`, body: msg, level: "error" });
      }
      this.busy = false;
      cx.notify();
    });
  }

  // All at once; the pill counts them in, a toast sums up and names what didn't come back.
  restartAll(addrs, cx) {
    this.busy = true;
    cx.spawn(async (cx) => {
      const total = addrs.length;
      let done = 0;
      const progress = () => this.say(`Restarting ${plural(total, "agent")}… ${done}/${total}`, "busy", cx);
      progress();
      const results = await Promise.all(addrs.map(async (addr) => {
        const label = labelOf(addr);
        try { const line = await this.cycle(addr, label, () => {}); return { label, line }; }
        catch (e) { return { label, error: String(e?.message ?? e) }; }
        finally { done++; progress(); }
      }));
      const ok = results.filter((r) => r.line);
      const skipped = results.filter((r) => r.error?.startsWith("Nothing to restart"));
      const failed = results.filter((r) => r.error && !skipped.includes(r));
      const head = `Restarted ${ok.length} of ${plural(total, "agent")}`;
      const tail = failed.length ? `; ${plural(failed.length, "failure")}` : skipped.length ? `; ${skipped.length} at a shell prompt` : "";
      this.say(head + tail, failed.length ? "error" : "ok", cx);
      const body = [...ok.map((r) => `✓ ${r.label}`), ...failed.map((r) => `✗ ${r.label}: ${r.error}`), ...skipped.map((r) => `– ${r.label}: at a shell prompt`)].join("\n");
      notify({ title: head, body, level: failed.length ? "error" : "success", timeout: failed.length ? 0 : 8000 });
      this.busy = false;
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const a = this.armed, n = this.note;
    if (!a && !n) return div();
    const color = a ? t.blocked : n.kind === "error" ? t.blocked : n.kind === "ok" ? t.done : n.kind === "busy" ? t.working : t.foreground;
    const text = a ? `Restart ${a.label} on the same session${a.all ? "s" : ""}? Press the key again.` : n.text;
    return h_flex().px(12).h(26).gap(8).items_center().text_size(12.5).text_color(t.foreground)
      .child(div().size(7).rounded(4).flex_none().bg(color).when(Boolean(a) || n?.kind === "busy", (el) => el.loop("opacity", { from: 0.3, to: 1, period: 700 })))
      .child(div().max_w(640).truncate().child(text));
  }
}
