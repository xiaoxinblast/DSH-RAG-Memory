import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { MemoryService } from "../../src/service.mjs";
import { hash, tokens } from "../../src/domain.mjs";
import { SourceRoute } from "./source-route.mjs";
import { queries, assess } from "./queries.mjs";
import { seed } from "../../scripts/kernel-evaluation.mjs";

const out = ".cache/evidence-route-comparison", live = ".cache/extraction-evaluation/units-v7-live";
const read = f => readFileSync(f, "utf8"), json = f => JSON.parse(read(f));
const baseline = json(`${out}/baseline.json`), plan = json(`${live}/plan.json`);
const records = read(`${live}/live/responses.jsonl`).trim().split(/\r?\n/).map(JSON.parse);
function verifyFrozen() { for (const [file, digest] of Object.entries(baseline.files)) assert.equal(hash(readFileSync(file)), digest, file); }
const projection = rows => rows.map(m => ({ content: m.content, scope: m.scope, kind: m.kind, status: m.status, version: m.version, supersedes: m.supersedes })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

async function replay(record) {
  const fixture = plan.cases.find(f => f.id === record.caseId), candidate = plan.candidates.find(c => c.id === record.candidateId);
  // Capture a deterministic clock in MemoryStore's default argument; no global clock remains patched.
  const originalNow = Date.now; let seeded;
  try { Date.now = () => Date.parse(record.phases[0].timestamp); seeded = seed(fixture, candidate); } finally { Date.now = originalNow; }
  const { service, aliases } = seeded, mapping = new Map();
  const oldInput = record.stages.find(s => s.phase === "input").response;
  const request = record.calls.find(c => c.request.phase === "extraction").request;
  const wire = JSON.parse(request.messages.find(m => m.role === "user").content[0].text);
  for (const field of ["existing", "protected"]) for (let i = 0; i < wire[field].length; i++) {
    const id = aliases.get(oldInput[field][i].id); assert.ok(id); mapping.set(wire[field][i].id, id);
  }
  let calls = 0;
  service.extractor = { request: async phase => {
    const stored = record.phases[calls++]; assert.equal(phase, stored.phase);
    let text = stored.text; for (const [a, b] of mapping) text = text.replaceAll(a, b);
    if (phase === "extraction") seeded.concurrent();
    return { text, finish: stored.finish, usage: stored.usage };
  } };
  service.schedule(fixture.sources[0].session_id); await service.work("extract");
  assert.equal(calls, record.phases.length);
  assert.deepEqual(projection(seeded.snapshot()), projection(record.after), `v7 replay diverged: ${record.taskId}`);
  const targets = fixture.existing.filter(m => m.status === "active" && fixture.expectedOldStatus[m.id] === "forgotten");
  return { service, fixture, calls, explicitForget: targets.length ? { requested: targets.length, executed: targets.filter(m => service.store.get(aliases.get(m.id)).status === "forgotten").length } : null };
}

function routes(service, fixture, record) {
  const pair = [new SourceRoute(service.store), new SourceRoute(service.store, true)];
  // Reuse verbatim synthetic model output, not its later review or the gold answer.
  // SourceRoute validates every hint's anchor independently before using it for retrieval.
  const parsed = JSON.parse(record.phases.find(p => p.phase === "extraction").text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  const operations = parsed.operations ?? [];
  const sources = service.store.db.prepare("SELECT * FROM sources ORDER BY rowid").all();
  const groups = new Map();
  for (const source of sources) {
    const key = `${source.project_id}:${source.session_id}`;
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(source.id);
  }
  for (const [key, ids] of groups) {
    const hints = operations.filter(o => ["add", "update", "merge"].includes(o?.action) && typeof o.content === "string").map(o => ({ text: o.content, evidence: o.evidence }));
    for (const route of pair) route.add(key, ids, hints);
  }
  return pair;
}

const results = [], replayed = []; let registeredHints = 0; verifyFrozen();
for (const record of records) {
  const { service, fixture, calls, explicitForget } = await replay(record);
  try {
    replayed.push({ taskId: record.taskId, phases: calls, stateEqual: true });
    const [source, indexed] = routes(service, fixture, record);
    registeredHints += [...indexed.documents.values()].reduce((n, d) => n + d.hints.length, 0);
    for (const [index, probe] of queries.entries()) {
      if (probe.caseId !== fixture.id) continue;
      const workspace = probe.foreign ? fixture.foreignWorkspace ?? "d:/synthetic/foreign-probe" : fixture.workspace;
      const recalled = await service.recall(`probe:${record.taskId}`, String(index), workspace, probe.query);
      const baseItems = (recalled?.ids ?? []).map(id => { const m = service.store.get(id); return { id, body: m.content, scope: m.scope }; });
      const outputs = { v7: { items: baseItems, text: recalled?.text ?? "", trace: [], bytes: tokens(recalled?.text ?? "") }, source: source.search(probe.query, workspace), "source-index": indexed.search(probe.query, workspace) };
      for (const [route, value] of Object.entries(outputs)) {
        assert.ok(value.bytes <= 1500); assert.ok(value.items.length <= 5);
        results.push({ taskId: record.taskId, candidate: record.candidateId, pass: record.pass, caseId: fixture.id, probe: index, query: probe.query, category: probe.category, explicitForget, route, ...assess(value.items, probe), ...value });
      }
    }
  } finally { await service.close(); }
  if (replayed.length % 48 === 0) console.log(`Frozen host replay: ${replayed.length}/${records.length}; new model calls: 0`);
}

function summarize(rows) {
  const needs = rows.filter(r => r.completeUnit !== null);
  const executed = rows.filter(r => r.explicitForget && r.explicitForget.requested === r.explicitForget.executed);
  return { probes: rows.length, nonempty: rows.filter(r => r.hit).length, required: needs.length, completeUnit: needs.filter(r => r.completeUnit).length, completeAcrossItems: needs.filter(r => r.completeAcrossItems).length, forbiddenProbes: rows.filter(r => r.forbidden.length).length, executedForgetProbes: executed.length, executedForgetLeaks: executed.filter(r => r.forbidden.length).length, retainedOtherFactAfterForget: executed.filter(r => r.category === "forget-and-retain" && r.completeUnit).length, meanBytes: rows.reduce((n, r) => n + r.bytes, 0) / rows.length };
}
const byRoute = Object.fromEntries(["v7", "source", "source-index"].map(route => {
  const rows = results.filter(r => r.route === route);
  return [route, { ...summarize(rows), categories: Object.fromEntries([...new Set(rows.map(r => r.category))].map(c => [c, summarize(rows.filter(r => r.category === c))])) }];
}));

// Same AST node definition as verify-kernel-structure; include all experiment runtime code.
const module = { exports: {} }; new Function("exports", "module", process.binding("natives")["internal/deps/acorn/acorn/dist/acorn"])(module.exports, module);
const parse = s => module.exports.parse(s, { ecmaVersion: "latest", sourceType: "module" });
function branches(node) {
  if (!node || typeof node !== "object") return 0;
  const own = ["IfStatement", "ConditionalExpression", "LogicalExpression", "CatchClause", "ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"].includes(node.type) || node.type === "SwitchCase" && node.test ? 1 : 0;
  return own + Object.values(node).reduce((n, v) => n + (Array.isArray(v) ? v.reduce((s, x) => s + branches(x), 0) : branches(v)), 0);
}
const runtime = Object.keys(baseline.files).filter(f => /^(src|dsh)\/.*\.mjs$/.test(f));
const production = Object.fromEntries(runtime.map(f => [f, branches(parse(read(f)))]));
const serviceAst = parse(read("src/service.mjs")), serviceClass = serviceAst.body.find(n => n.type === "ExportNamedDeclaration" && n.declaration?.type === "ClassDeclaration").declaration;
const readMethods = Object.fromEntries(serviceClass.body.body.filter(n => ["search", "recall"].includes(n.key.name)).map(n => [n.key.name, branches(n)]));
const experimentFiles = readdirSync("experiments/evidence-routes").filter(f => f.endsWith(".mjs")).map(f => "experiments/evidence-routes/" + f);
const complexity = { definition: "If + ternary + logical (including ??) + nondefault case + catch + loop AST nodes", productionBefore: production, productionAfter: production, productionTotal: Object.values(production).reduce((a, b) => a + b, 0), v7ReadMethods: readMethods, experimentalRuntime: { "experiments/evidence-routes/source-route.mjs": branches(parse(read("experiments/evidence-routes/source-route.mjs"))) }, allExperimentFiles: Object.fromEntries(experimentFiles.map(f => [f, branches(parse(read(f)))])), sharedGuards: ["MemoryStore.maskSource", "MemoryStore.protections", "MemoryStore.visible", "sourceAnchors", "resolveEvidence"], note: "Prototype is not a full replacement: it has no write authorization, consolidation, global core, vector/rerank or long-window splitting. Branch totals cannot prove complete product simplification." };
assert.ok(registeredHints > 0, "必须实际加载历史输出作为轻量索引");
const report = { at: new Date().toISOString(), frozenFiles: Object.keys(baseline.files).length, protocol: 7, replayed: replayed.length, replayedPhases: replayed.reduce((n, r) => n + r.phases, 0), replayStateMatches: replayed.every(r => r.stateEqual), newModelCalls: 0, embeddings: 0, dailyProfileRead: false, queryDefinitions: queries.length, registeredHints, byRoute, complexity, limitations: baseline.limitations, interpretation: "Literal content/context probes, not new model accuracy. Paired routes reuse the same completed v7 mutation results; source-only variants do not demonstrate independent chat forget intent recognition." };
mkdirSync(out, { recursive: true }); writeFileSync(`${out}/retrieval.json`, JSON.stringify({ report, replayed, results }, null, 2));
writeFileSync(`${out}/summary.json`, JSON.stringify(report, null, 2)); verifyFrozen(); console.log(JSON.stringify({ replayed: report.replayed, phases: report.replayedPhases, byRoute }));
