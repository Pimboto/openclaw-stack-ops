/**
 * OpenClaw Stack Ops — agent roster config
 * ----------------------------------------
 * Edit this file to match YOUR OpenClaw multi-agent setup.
 *
 *  hub        → your orchestrator agent id (the one you talk to)
 *  agents[]   → your specialist layers:
 *      id    : exact OpenClaw agent id (openclaw agents list)
 *      code  : short label drawn inside the node
 *      cap   : caption under the node
 *      g     : group key (colors/legend) — define any groups you want
 *      critic: paired critic agent id (optional; drawn as a satellite)
 *      desc  : one-liner shown in the agent panel
 *
 * Agents discovered at runtime that are not listed here are added
 * automatically to the "other" group, so nothing breaks.
 */
window.STACKOPS = {
  hub: { id: 'architect', code: 'ARCH', cap: 'ARCHITECT', desc: 'Orquestador: descompone, reparte en olas, integra y decide.' },

  groups: {
    build: { label: 'BUILD',       c: '#ff5c45' },
    ship:  { label: 'SHIP',        c: '#38d9ff' },
    guard: { label: 'DEFENSA',     c: '#b07aff' },
    perf:  { label: 'PERFORMANCE', c: '#ffc145' },
    keep:  { label: 'FIABILIDAD',  c: '#4ade80' },
    other: { label: 'OTROS',       c: '#8a94a6' },
  },

  agents: [
    { id: 'frontend-foundations',   code: 'FRONT',  cap: 'Frontend',   g: 'build', critic: 'frontend-foundations-critic',   desc: 'UI, componentes, estado, accesibilidad y UX.' },
    { id: 'apis-backend-logic',     code: 'API',    cap: 'APIs',       g: 'build', critic: 'apis-backend-logic-critic',     desc: 'Endpoints, lógica de negocio, validación y contratos.' },
    { id: 'database-storage',       code: 'DB',     cap: 'Database',   g: 'build', critic: 'database-storage-critic',       desc: 'Schema, migraciones, índices y modelado de datos.' },
    { id: 'auth-permissions',       code: 'AUTH',   cap: 'Auth',       g: 'build', critic: 'auth-permissions-critic',       desc: 'Identidad, sesiones, JWT, roles y ownership.' },
    { id: 'hosting-deployment',     code: 'DEPLOY', cap: 'Hosting',    g: 'ship',  critic: 'hosting-deployment-critic',     desc: 'Entornos, variables, previews y despliegues.' },
    { id: 'cloud-computing',        code: 'CLOUD',  cap: 'Cloud',      g: 'ship',  critic: 'cloud-computing-critic',        desc: 'Infra como código, serverless, colas y cómputo.' },
    { id: 'cicd-version-control',   code: 'CI/CD',  cap: 'CI/CD',      g: 'ship',  critic: 'cicd-version-control-critic',   desc: 'Branches, PRs, pipelines, tests y releases.' },
    { id: 'security-rls',           code: 'SEC',    cap: 'Security',   g: 'guard', critic: 'security-rls-critic',           desc: 'RLS, secretos, OWASP y superficie de ataque.' },
    { id: 'rate-limiting',          code: 'RATE',   cap: 'Rate Limit', g: 'guard', critic: 'rate-limiting-critic',          desc: 'Límites por usuario/IP, anti-abuso y fair use.' },
    { id: 'caching-cdn',            code: 'CACHE',  cap: 'Cache·CDN',  g: 'perf',  critic: 'caching-cdn-critic',            desc: 'CDN, TTLs, invalidaciones y hit ratio.' },
    { id: 'load-balancing-scaling', code: 'SCALE',  cap: 'Scaling',    g: 'perf',  critic: 'load-balancing-scaling-critic', desc: 'Autoscaling, balanceo y capacidad.' },
    { id: 'error-tracking-logs',    code: 'LOGS',   cap: 'Logs',       g: 'keep',  critic: 'error-tracking-logs-critic',    desc: 'Observabilidad, alertas, trazas y postmortems.' },
    { id: 'availability-recovery',  code: 'RECOV',  cap: 'Recovery',   g: 'keep',  critic: 'availability-recovery-critic',  desc: 'Backups, failover, RPO/RTO y rollback.' },
  ],
};
