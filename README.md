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

Bridge options (env vars): `PORT` (7788), `HOST` (127.0.0.1), `OPENCLAW_BIN` (openclaw), `POLL_MS` (2500).

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
  "sharp": { "S": 4, "H": 5, "A": 4, "R": 4, "P": 5, "total": 22, "verdict": "APPROVE" } }
```

Anything that speaks this shape can feed the UI — the simulator uses the exact same contract.

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

- The bridge binds to `127.0.0.1` by default. It can **dispatch real agent runs** — do not expose it to the network without adding auth in front.
- It shells out to your local `openclaw` CLI and inherits its credentials; it stores none of its own.
- On Windows, double quotes in dispatched messages are converted to single quotes (cmd quoting limitation).

## License

MIT
