# AGENTS.md — OpenClaw Stack Ops

Reglas del proyecto para agentes de IA.

## Qué es

Mission-control para fleets multi-agente de OpenClaw: un bridge Node que traduce el
gateway (CLI --json → SSE) y una UI radial que muestra orquestación en vivo
(spawns, críticos, líneas SHARP) y despacha tareas reales al orquestador.

## Identidad técnica (NO negociable)

1. **Bridge con CERO dependencias npm** (`server.js`, Node ≥18 puro). Nada de
   express/ws/axios. Es el selling point del addon.
2. **UI vanilla** (`public/`): HTML + CSS + JS sin frameworks, sin build step,
   sin bundler. Se sirve estática tal cual.
3. **El contrato de eventos es API pública** (README §How it works): eventos
   `{t, type, a, to, text, taskId, critic, sharp}` por SSE. Se puede EXTENDER
   (campos nuevos), nunca romper.
4. Config por env vars (PORT, HOST, OPENCLAW_BIN, POLL_MS) — sin archivos de
   config nuevos salvo necesidad real.
5. Roster de agentes en `public/agents.js` — es la superficie de configuración
   del usuario; mantener su forma documentada.

## Convenciones

- Código y comentarios técnicos en inglés; textos de UI en español.
- El bridge corre MIENTRAS se edita (sin hot-reload): no matar/reiniciar
  procesos; la usuaria reinicia.
- Seguridad: HOST=127.0.0.1 por default. Cualquier feature de exposición
  (LAN/móvil) REQUIERE autenticación en el bridge (token), porque /api/run
  despacha agentes reales.
- `inbox/` y `dispatch.log` son runtime (gitignored); `tools/` para utilidades CLI.

## Cómo probar

`node server.js` → http://127.0.0.1:7788 (requiere gateway de OpenClaw corriendo).
`node --check` cada JS modificado. No hay test runner (aún) — si agregas tests,
runner-less (node assert + script) para no violar la regla #1.
