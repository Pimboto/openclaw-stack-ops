# OpenClaw Stack Ops

**Live mission-control UI for multi-agent [OpenClaw](https://openclaw.ai) fleets.**
Watch your orchestrator fan out work to specialist agents and their architecture critics â€” spawns, completions, failures and SHARP quality scores â€” in real time, on a radial map of your whole stack.

> Built for setups where one **orchestrator** agent (e.g. `architect`) delegates to **specialist** agents via `sessions_spawn`, and each specialist is paired with an **architecture critic** that scores its work with a SHARP rubric (`SHARP: S=4 H=5 A=4 R=4 P=5 TOTAL=22/25 VERDICT=APPROVE`). Any other multi-agent topology works too â€” the roster is fully configurable.

## What you get

- **Radial stack map** â€” your orchestrator in the center, specialist layers in a ring, critics as satellites. Nodes light up while agents work; particles trace every handoff.
- **LIVE mode** â€” real events from your running OpenClaw gateway: sub-agent spawns, completions, failures, and parsed **SHARP scores** as badges per layer.
- **Dispatch from the UI** â€” type a task, hit â–¶, and it runs `openclaw agent --agent <orchestrator> -m "<task>"` for real.
- **Per-agent panel** â€” current task, last SHARP breakdown (S/H/A/R/P grid), collaborators, recent messages.
- **Real timeline** â€” bars per layer from actual task start/end timestamps (critic runs drawn dimmed on their layer's row).
- **DEMO mode** â€” a scripted simulator (no gateway needed) to demo the concept or develop the UI.

## Requirements

- Node.js â‰¥ 18
- [OpenClaw](https://openclaw.ai) CLI installed and a **running gateway** (`openclaw gateway status`)
- A multi-agent setup (`openclaw agents list`)

## Quickstart

```bash
git clone https://github.com/Pimboto/openclaw-stack-ops
cd openclaw-stack-ops
node server.js
# â†’ http://127.0.0.1:7788
```

The bridge auto-connects to your local OpenClaw CLI. If the gateway is up you'll land in **LIVE** mode with your task history already on screen.

## Configure your fleet

Edit [`public/agents.js`](public/agents.js):

```js
window.STACKOPS = {
  hub: { id: 'architect', code: 'ARCH', cap: 'ARCHITECT', desc: 'â€¦' },
  groups: { build: { label: 'BUILD', c: '#ff5c45' }, /* â€¦ */ },
  agents: [
    { id: 'database-storage', code: 'DB', cap: 'Database', g: 'build',
      critic: 'database-storage-critic', desc: 'â€¦' },
    // â€¦ your layers
  ],
};
```

- `id` must match your OpenClaw agent ids exactly (`openclaw agents list`).
- `critic` is optional â€” if present it's drawn as a satellite and its SHARP verdicts badge the parent layer.
- Agents that show up at runtime but aren't listed are added automatically to an "OTROS" group, so nothing breaks.

Bridge options (env vars): `PORT` (7788), `HOST` (127.0.0.1), `OPENCLAW_BIN` (openclaw), `POLL_MS` (2500), `STACKOPS_TOKEN` (unset â€” set it to require auth before exposing the bridge; see [Security notes](#security-notes)), `STACKOPS_PROJECTS_ROOT` (`C:\Work` â€” folder scanned by the projects API), `STACKOPS_NARRATOR_MODEL` (`haiku` â€” model used by the SITREP narrator).

## How it works

```
openclaw CLI (--json) â”€â”€pollâ”€â”€> server.js (zero-dep bridge) â”€â”€SSEâ”€â”€> browser UI
                                   â”‚
                                   â””â”€â”€ POST /api/run â†’ openclaw agent --agent <hub> -m "â€¦"
```

The bridge polls `openclaw tasks list --json`, diffs task state, parses agent ids out of session keys (`agent:<id>:subagent:<run>`), extracts SHARP lines with a regex, and streams normalized events:

```jsonc
{ "t": 1781032029769, "type": "spawn|work|done|fail|sys|snapshot",
  "a": "architect", "to": "database-storage",
  "text": "â€¦", "taskId": "â€¦", "critic": false,
  "session": "p-c-work-onlyreels",
  "sharp": { "S": 4, "H": 5, "A": 4, "R": 4, "P": 5, "total": 22, "verdict": "APPROVE" } }
```

- `session` *(optional)* â€” the project-thread id of the dispatching session, parsed
  from a `agent:<orchestrator>:p-<slug>` requester key (e.g. `p-c-work-onlyreels`).
  Lets the UI filter the feed per project. Absent on main/subagent/legacy sessions
  and on global `sys` events â€” the UI routes those to a shared "global" view.

Anything that speaks this shape can feed the UI â€” the simulator uses the exact same contract. The contract is additive-only: new fields may appear, existing ones never change shape.

Per-project **conversation history** comes from a different source: the agent's
own session transcript on disk (`GET /api/conversation`, below), not the event
ring. The ring is the live orchestration feed; the transcript is the actual
back-and-forth of a project thread.

## HTTP API

All routes below live under `/api/*` and are therefore covered by the
`STACKOPS_TOKEN` auth gate automatically â€” when a token is set, each call must
carry it (see [Security notes](#security-notes)).

### Projects (`STACKOPS_PROJECTS_ROOT`, default `C:\Work`)

`GET /api/projects` â€” list the direct subfolders of the projects root (files and
folders starting with `.` or `_` are ignored; per-folder read errors are skipped,
never fatal):

```jsonc
{ "ok": true, "root": "C:\\Work",
  "projects": [
    { "name": "OnlyReels", "dir": "C:\\Work\\OnlyReels", "slug": "p-c-work-onlyreels",
      "hasAgentsMd": true, "isGit": true, "hasThread": false }
  ] }
```

`slug` replicates the UI's project-thread key exactly (`public/app.js`): the
`slice(-40)` is applied to the normalized body **before** the `p-` prefix.
`hasThread` is true when any known task has `session === slug`.

`POST /api/projects` `{ "name": "My Project" }` â€” create a new project folder
under the root plus a minimal Spanish `AGENTS.md` starter:

```jsonc
{ "ok": true, "name": "My Project", "dir": "C:\\Work\\My Project", "slug": "p-c-work-my-project" }
```

- `name` must match `^[A-Za-z0-9][A-Za-z0-9 ._-]{0,49}$` and contain no `..` â†’ otherwise `400`.
- Folder already exists â†’ `409 { "ok": false, "error": "el proyecto ya existe" }`.

### Per-agent model

`GET /api/agents/models` â€” per-agent model overrides plus the fleet default
(`model` is `null` when the agent inherits the default):

```jsonc
{ "ok": true, "default": "anthropic/claude-opus-4-8", "running": 0,
  "agents": [ { "id": "architect", "model": "anthropic/claude-fable-5" },
              { "id": "main", "model": null } ] }
```

`PUT /api/agents/<id>/model` `{ "model": "anthropic/claude-sonnet-4-6" }` â€” set
or clear one agent's model override (`POST` to the same path is also accepted).
`model` is validated against `^[a-z0-9/._-]+$/i`; `""` or `null` removes the
override (the agent falls back to the fleet default). Same flow as `/api/fleet`:
writes config preserving everything else, runs `config validate` (reverts the file
and errors on failure), restarts the gateway (90s timeout), and pushes a Spanish
`sys` event. `anthropic/*` models are auto-registered with the `claude-cli` runtime.

```jsonc
{ "ok": true, "id": "architect", "model": "anthropic/claude-sonnet-4-6", "restarted": true }
```

Unknown `<id>` â†’ `404`. The endpoint restarts the gateway itself; surfacing the
`running` count from the GET so the UI can warn about active tasks is the UI's job.

### Conversation history

`GET /api/conversation?session=<p-slug>&agent=<id>` â€” the conversation of one
project thread, read from the agent's session transcript (`.jsonl`) on disk:

```jsonc
{ "ok": true, "session": "p-c-work-barcelona", "agent": "architect",
  "turns": [
    { "role": "user",      "text": "Â¿estado del proyecto?", "t": 1781230800000 },
    { "role": "assistant", "text": "Todo en marcha.",        "t": 1781230805000 }
  ],
  "truncated": false }
```

- `session` *(required)* â€” validated against `^p-[a-z0-9-]+$` â†’ otherwise `400`.
- `agent` *(optional, default `architect`)* â€” sanitized to `[a-zA-Z0-9_-]`.
- Resolution: reads `%USERPROFILE%\.openclaw\agents\<agent>\sessions\sessions.json`,
  looks up the key `agent:<agent>:<session>`, and uses its `sessionFile` (or
  `<sessionId>.jsonl` in the same folder). After `/new` the entry already points
  at the fresh transcript, so you get the **current** conversation.
- Unknown key or missing transcript â†’ `200 { "ok": true, "session", "turns": [], "truncated": false }` (**not** an error).
- `turns` are in chronological file order. `t` is the entry timestamp in epoch ms
  (`null` when absent/unparseable). `role` is only `user` or `assistant`.
- **Noise filtered out** (these never appear as turns): user turns that are
  runtime events â€” starting with `A background task completed`, or containing
  `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>` or `[Inter-session message]`; and
  assistant turns that are exactly `NO_REPLY` or empty.
- **Caps**: at most the last **100** turns (`truncated: true` when older turns were
  dropped); each turn's `text` is capped at **8000** chars (`â€¦` appended). The
  transcript file is read whole up to **10 MB** (~500 KB is normal); larger files
  are tail-read, keeping the most recent turns. A corrupt JSON line is skipped,
  not fatal.

### SITREP (AI narrator, `STACKOPS_NARRATOR_MODEL`, default `haiku`)

`GET /api/sitrep` â€” a 2â€“3 sentence Spanish status of what the fleet is doing
right now, generated by the local `claude` CLI:

```jsonc
{ "ok": true, "text": "El arquitecto estÃ¡ repartiendo trabajo a dos especialistasâ€¦", "t": 1781032029769, "model": "haiku" }
```

- If the `claude` CLI isn't found â†’ `{ "ok": false, "disabled": true }` (always; the UI hides the panel).
- Before the first generation â†’ `{ "ok": true, "text": null, "t": null, "model": "haiku" }`.
- Server-side throttle: regenerates at most once every 60s, and only when there
  are active tasks or new events since the last attempt; otherwise returns the
  cached text. An in-flight lock prevents stampedes; CLI errors keep the last good
  text and never return 500. Generation happens **only** on request â€” never in the poll loop.

## SHARP rubric (the quality gate)

If your critics end every review with a parseable verdict line, Stack Ops picks it up automatically:

```
SHARP: S=4 H=5 A=4 R=4 P=5 TOTAL=22/25 VERDICT=APPROVE
```

| Dim | Meaning |
|---|---|
| S | Structural soundness â€” boundaries, coupling/cohesion |
| H | Handles failure & scale |
| A | Appropriate patterns (not cargo-culted) |
| R | Resilience to change |
| P | Pragmatism â€” no over-engineering |

Gate: **total â‰¥ 20 and no dimension â‰¤ 2**.

## Security notes

- The bridge binds to `127.0.0.1` by default. It can **dispatch real agent runs** â€” do not expose it to the network without auth.
- It shells out to your local `openclaw` CLI and inherits its credentials; it stores none of its own.
- On Windows, double quotes in dispatched messages are converted to single quotes (cmd quoting limitation).

### Exposing on LAN / Tailscale

To reach Stack Ops from your phone or another machine, set a token **and** a non-local host:

```bash
STACKOPS_TOKEN=$(openssl rand -hex 24) \
HOST=0.0.0.0 \
node server.js
# or bind to your Tailscale IP: HOST=100.x.y.z
```

When `STACKOPS_TOKEN` is set, every `/api/*` and `/events` request must carry it:

- `Authorization: Bearer <token>` header (fetches), or
- `X-Stackops-Token: <token>` header, or
- `?token=<token>` query param (used by `EventSource`, which can't send headers).

What the **server guarantees**: a missing or wrong token â†’ `401 {"ok":false,"error":"token requerido"}`
on every `/api/*` and `/events` request; the token may arrive by any of the three forms
above; static files (`/`, `*.js`, `*.css`) are always served without a token so the UI
can load to ask for it â€” they expose no fleet data; and the comparison is timing-safe
(SHA-256 digests via `crypto.timingSafeEqual`).

On top of that contract, the **Stack Ops UI** handles the 401 for you: it prompts for the
token once, stores it in `localStorage` (`stackops-token`), then sends it as a `Bearer`
header on fetches and as a `?token=` query param on the `EventSource` for subsequent loads.

> âš ï¸ **Never bind off `127.0.0.1` without `STACKOPS_TOKEN`.** `/api/run` dispatches real
> agents with your CLI credentials â€” an open port is remote code execution on your fleet.

## License

MIT
