# OpenClaw Stack Ops

**Live mission-control UI for multi-agent [OpenClaw](https://openclaw.ai) fleets.**
Watch your orchestrator fan out work to specialist agents and their architecture critics — spawns, completions, failures and SHARP quality scores — in real time, on a radial map of your whole stack.

> Built for setups where one **orchestrator** agent (e.g. `architect`) delegates to **specialist** agents via `sessions_spawn`, and each specialist is paired with an **architecture critic** that scores its work with a SHARP rubric (`SHARP: S=4 H=5 A=4 R=4 P=5 TOTAL=22/25 VERDICT=APPROVE`). Any other multi-agent topology works too — the roster is fully configurable.

## What you get

- **Radial stack map** — your orchestrator in the center, specialist layers in a ring, critics as satellites. Nodes light up while agents work; particles trace every handoff.
- **LIVE mode** — real events from your running OpenClaw gateway: sub-agent spawns, completions, failures, and parsed **SHARP scores** as badges per layer.
- **Dispatch from the UI** — type a task, hit ▶, and it runs `openclaw agent --agent <orchestrator> -m "<task>"` for real.
- **Per-agent panel** — current task, last SHARP breakdown (S/H/A/R/P grid), collaborators, recent messages.
- **Real timeline** — bars per layer from actual task start/end timestamps (critic runs drawn dimmed on their layer's row).
- **DEMO mode** — a scripted simulator (no gateway needed) to demo the concept or develop the UI.

## Requirements

- Node.js ≥ 18
- [OpenClaw](https://openclaw.ai) CLI installed and a **running gateway** (`openclaw gateway status`)
- A multi-agent setup (`openclaw agents list`)

## Quickstart

```bash
git clone https://github.com/<you>/openclaw-stack-ops
cd openclaw-stack-ops
node server.js
# → http://127.0.0.1:7788
```

The bridge auto-connects to your local OpenClaw CLI. If the gateway is up you'll land in **LIVE** mode with your task history already on screen.

## Configure your fleet

Edit [`public/agents.js`](public/agents.js):

```js
window.STACKOPS = {
  hub: { id: 'architect', code: 'ARCH', cap: 'ARCHITECT', desc: '…' },
  groups: { build: { label: 'BUILD', c: '#ff5c45' }, /* … */ },
  agents: [
    { id: 'database-storage', code: 'DB', cap: 'Database', g: 'build',
      critic: 'database-storage-critic', desc: '…' },
    // … your layers
  ],
};
```

- `id` must match your OpenClaw agent ids exactly (`openclaw agents list`).
- `critic` is optional — if present it's drawn as a satellite and its SHARP verdicts badge the parent layer.
- Agents that show up at runtime but aren't listed are added automatically to an "OTROS" group, so nothing breaks.

Bridge options (env vars): `PORT` (7788), `HOST` (127.0.0.1), `OPENCLAW_BIN` (openclaw), `POLL_MS` (2500), `STACKOPS_TOKEN` (unset — set it to require auth before exposing the bridge; see [Security notes](#security-notes)), `STACKOPS_PROJECTS_ROOT` (`C:\Work` — folder scanned by the projects API), `STACKOPS_NARRATOR_MODEL` (`haiku` — model used by the SITREP narrator).

## How it works

```
openclaw CLI (--json) ──poll──> server.js (zero-dep bridge) ──SSE──> browser UI
                                   │
                                   └── POST /api/run → openclaw agent --agent <hub> -m "…"
```

The bridge polls `openclaw tasks list --json`, diffs task state, parses agent ids out of session keys (`agent:<id>:subagent:<run>`), extracts SHARP lines with a regex, and streams normalized events:

```jsonc
{ "t": 1781032029769, "type": "spawn|work|done|fail|sys|snapshot",
  "a": "architect", "to": "database-storage",
  "text": "…", "taskId": "…", "critic": false,
  "session": "p-c-work-onlyreels",
  "sharp": { "S": 4, "H": 5, "A": 4, "R": 4, "P": 5, "total": 22, "verdict": "APPROVE" } }
```

- `session` *(optional)* — the project-thread id of the dispatching session, parsed
  from a `agent:<orchestrator>:p-<slug>` requester key (e.g. `p-c-work-onlyreels`).
  Lets the UI filter the feed per project. Absent on main/subagent/legacy sessions
  and on global `sys` events — the UI routes those to a shared "global" view.

Anything that speaks this shape can feed the UI — the simulator uses the exact same contract. The contract is additive-only: new fields may appear, existing ones never change shape.

## HTTP API

All routes below live under `/api/*` and are therefore covered by the
`STACKOPS_TOKEN` auth gate automatically — when a token is set, each call must
carry it (see [Security notes](#security-notes)).

### Projects (`STACKOPS_PROJECTS_ROOT`, default `C:\Work`)

`GET /api/projects` — list the direct subfolders of the projects root (files and
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

`POST /api/projects` `{ "name": "My Project" }` — create a new project folder
under the root plus a minimal Spanish `AGENTS.md` starter:

```jsonc
{ "ok": true, "name": "My Project", "dir": "C:\\Work\\My Project", "slug": "p-c-work-my-project" }
```

- `name` must match `^[A-Za-z0-9][A-Za-z0-9 ._-]{0,49}$` and contain no `..` → otherwise `400`.
- Folder already exists → `409 { "ok": false, "error": "el proyecto ya existe" }`.

### Per-agent model

`GET /api/agents/models` — per-agent model overrides plus the fleet default
(`model` is `null` when the agent inherits the default):

```jsonc
{ "ok": true, "default": "anthropic/claude-opus-4-8", "running": 0,
  "agents": [ { "id": "architect", "model": "anthropic/claude-fable-5" },
              { "id": "main", "model": null } ] }
```

`PUT /api/agents/<id>/model` `{ "model": "anthropic/claude-sonnet-4-6" }` — set
or clear one agent's model override (`POST` to the same path is also accepted).
`model` is validated against `^[a-z0-9/._-]+$/i`; `""` or `null` removes the
override (the agent falls back to the fleet default). Same flow as `/api/fleet`:
writes config preserving everything else, runs `config validate` (reverts the file
and errors on failure), restarts the gateway (90s timeout), and pushes a Spanish
`sys` event. `anthropic/*` models are auto-registered with the `claude-cli` runtime.

```jsonc
{ "ok": true, "id": "architect", "model": "anthropic/claude-sonnet-4-6", "restarted": true }
```

Unknown `<id>` → `404`. The endpoint restarts the gateway itself; surfacing the
`running` count from the GET so the UI can warn about active tasks is the UI's job.

### SITREP (AI narrator, `STACKOPS_NARRATOR_MODEL`, default `haiku`)

`GET /api/sitrep` — a 2–3 sentence Spanish status of what the fleet is doing
right now, generated by the local `claude` CLI:

```jsonc
{ "ok": true, "text": "El arquitecto está repartiendo trabajo a dos especialistas…", "t": 1781032029769, "model": "haiku" }
```

- If the `claude` CLI isn't found → `{ "ok": false, "disabled": true }` (always; the UI hides the panel).
- Before the first generation → `{ "ok": true, "text": null, "t": null, "model": "haiku" }`.
- Server-side throttle: regenerates at most once every 60s, and only when there
  are active tasks or new events since the last attempt; otherwise returns the
  cached text. An in-flight lock prevents stampedes; CLI errors keep the last good
  text and never return 500. Generation happens **only** on request — never in the poll loop.

## SHARP rubric (the quality gate)

If your critics end every review with a parseable verdict line, Stack Ops picks it up automatically:

```
SHARP: S=4 H=5 A=4 R=4 P=5 TOTAL=22/25 VERDICT=APPROVE
```

| Dim | Meaning |
|---|---|
| S | Structural soundness — boundaries, coupling/cohesion |
| H | Handles failure & scale |
| A | Appropriate patterns (not cargo-culted) |
| R | Resilience to change |
| P | Pragmatism — no over-engineering |

Gate: **total ≥ 20 and no dimension ≤ 2**.

## Security notes

- The bridge binds to `127.0.0.1` by default. It can **dispatch real agent runs** — do not expose it to the network without auth.
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

What the **server guarantees**: a missing or wrong token → `401 {"ok":false,"error":"token requerido"}`
on every `/api/*` and `/events` request; the token may arrive by any of the three forms
above; static files (`/`, `*.js`, `*.css`) are always served without a token so the UI
can load to ask for it — they expose no fleet data; and the comparison is timing-safe
(SHA-256 digests via `crypto.timingSafeEqual`).

On top of that contract, the **Stack Ops UI** handles the 401 for you: it prompts for the
token once, stores it in `localStorage` (`stackops-token`), then sends it as a `Bearer`
header on fetches and as a `?token=` query param on the `EventSource` for subsequent loads.

> ⚠️ **Never bind off `127.0.0.1` without `STACKOPS_TOKEN`.** `/api/run` dispatches real
> agents with your CLI credentials — an open port is remote code execution on your fleet.

## License

MIT
