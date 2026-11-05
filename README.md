# herdr-claude-resume

A mod for the [Herdr](https://herdr.dev) desktop app: **one key restarts the focused agent in place, on the same conversation.**

After a Claude Code update every pane says "restart to apply". Instead of quitting each one and retyping `claude --resume <id>`, press the key twice: the program is ended, its terminal keeps its shell, and the same command line comes back with `--resume <its session id>` added when it was missing. Same pane, same tab, same address.

## Install

Tell the agent in your Herdr window:

> Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/iosif2/herdr-claude-resume

It copies `mods/claude-resume/` into `~/.config/herdr-app/mods/`, merges `keys.json` (Cmd+Shift+R), and adds the floating block to your layout. By hand:

```sh
git clone https://github.com/iosif2/herdr-claude-resume
cp -R herdr-claude-resume/mods/claude-resume ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/claude-resume
```

Then, because a mod command only reaches a mod that is shown, give it a place. Herdr's shipped layouts are read-only, so clone `main` and add a floating block to the clone's `main` node (`layouts/<clone>.json`):

```sh
herdr-app do layout.clone '{"name":"main","as":"mine"}'
```

```json
"floating": [ { "id": "claude-resume-float", "content": { "mod": "claude-resume" }, "edge": "bottom", "align": "center" } ]
```

It draws nothing until it has something to say. Bind the key in `keys.json`:

```json
{ "global": { "cmd-shift-r": "claude-resume.go" } }
```

## Use

| do this | what happens |
|---|---|
| Cmd+Shift+R | a pill asks `Restart <agent> on the same session? Press the key again.` |
| Cmd+Shift+R again within 4 s | `Stopping…`, `Starting again…`, `Restarted <agent>` |
| `herdr-app do claude-resume.dry` | shows the line it would type, changes nothing |
| `herdr-app do claude-resume.go:t7` | the same two-step restart for a terminal that isn't focused |

Claude Code sessions get `--resume <id>` from Claude's own `~/.claude/sessions/<pid>.json`; a bare `codex` comes back as `codex resume --last`; anything else is run again exactly as it was.

## What it runs

`hc get` and `hc send` on the terminal, `kill` on the program's pid (SIGTERM, SIGKILL after 8 s), and `cat` on the session file. Nothing is written and nothing reaches the network. See [RECIPE.md](RECIPE.md) for the whole brief.

## License

MIT.
