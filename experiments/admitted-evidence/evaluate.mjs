import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { hash } from "../../src/domain.mjs";
import { seed } from "../../scripts/kernel-evaluation.mjs";
import { queries, assess } from "../evidence-routes/queries.mjs";
import { AdmittedRoute } from "./route.mjs";

const out = ".cache/admitted-evidence", live = ".cache/extraction-evaluation/units-v7-live";
const json = file => JSON.parse(readFileSync(file, "utf8"));
const baseline = json(`${out}/baseline.json`), plan = json(`${live}/plan.json`);
const old = json(".cache/evidence-route-comparison/retrieval.json");
const records = readFileSync(`${live}/live/responses.jsonl`, "utf8").trim().split(/\r?\n/).map(JSON.parse);
const projection = rows => rows.map(m => ({ content: m.content, scope: m.scope, kind: m.kind, status: m.status, version: m.version, supersedes: m.supersedes })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
function verify() { for (const [file, digest] of Object.entries(baseline.files)) assert.equal(hash(readFileSync(file)), digest, file); }
verify();
const results = [], states = [];
for (const record of records) {
  const fixture = plan.cases.find(f => f.id === record.caseId), candidate = plan.candidates.find(c => c.id === record.candidateId);
  const originalNow = Date.now; let seeded;
  try { Date.now = () => Date.parse(record.phases[0].timestamp); seeded = seed(fixture, candidate); } finally { Date.now = originalNow; }
  const { service, aliases } = seeded, mapping = new Map();
  try {
    const oldInput = record.stages.find(s => s.phase === "input").response;
    const request = record.calls.find(c => c.request.phase === "extraction").request;
    const wire = JSON.parse(request.messages.find(m => m.role === "user").content[0].text);
    for (const field of ["existing", "protected"]) for (let i = 0; i < wire[field].length; i++) {
      const id = aliases.get(oldInput[field][i].id); assert.ok(id); mapping.set(wire[field][i].id, id);
    }
    let calls = 0;
    service.extractor = { request: async phase => {
      const saved = record.phases[calls++]; assert.equal(phase, saved.phase);
      let text = saved.text; for (const [a, b] of mapping) text = text.replaceAll(a, b);
      if (phase === "extraction") seeded.concurrent();
      return { text, finish: saved.finish, usage: saved.usage };
    } };
    service.schedule(fixture.sources[0].session_id); await service.work("extract");
    assert.equal(calls, record.phases.length);
    assert.deepEqual(projection(seeded.snapshot()), projection(record.after), record.taskId);
    const route = new AdmittedRoute(service.store), receipts = service.store.operations({ limit: 1000 });
    // No gold-derived boundaries, invented provenance, rewritten model answers or legacy grants.
    const admission = receipts.map(r => ({ id: r.id, outcome: r.outcome, registered: route.add(r.id) }));
    const writesBefore = service.store.db.prepare("SELECT total_changes() AS n").get().n;
    for (const [probe, q] of queries.entries()) {
      if (q.caseId !== fixture.id) continue;
      const workspace = q.foreign ? fixture.foreignWorkspace ?? "d:/synthetic/foreign-probe" : fixture.workspace;
      const value = route.search(q.query, workspace), previous = old.results.filter(r => r.taskId === record.taskId && r.probe === probe && r.route !== "source-index");
      assert.equal(previous.length, 2); assert.ok(value.bytes <= 1500); assert.ok(value.items.length <= 5);
      results.push({ taskId: record.taskId, candidate: record.candidateId, pass: record.pass, caseId: fixture.id, probe, query: q.query, category: q.category, explicitForget: previous[0].explicitForget, ...assess(value.items, q), ...value, previous: previous.map(r => ({ route: r.route, completeUnit: r.completeUnit, forbidden: r.forbidden, hit: r.hit })) });
    }
    assert.equal(service.store.db.prepare("SELECT total_changes() AS n").get().n, writesBefore);
    states.push({ taskId: record.taskId, phases: calls, stateEqual: true, admission, seedMemoriesWithoutNewAdmission: fixture.existing.length });
  } finally { await service.close(); }
  if (states.length % 48 === 0) console.log(`Frozen replay ${states.length}/${records.length}; new model calls 0`);
}
function summarize(rows) {
  const executed = rows.filter(r => r.explicitForget && r.explicitForget.requested === r.explicitForget.executed);
  return { probes: rows.length, nonempty: rows.filter(r => r.hit).length, required: rows.filter(r => r.completeUnit !== null).length, completeUnit: rows.filter(r => r.completeUnit === true).length, forbiddenProbes: rows.filter(r => r.forbidden.length).length, executedForgetProbes: executed.length, executedForgetLeaks: executed.filter(r => r.forbidden.length).length, retainedB: executed.filter(r => r.category === "forget-and-retain" && r.completeUnit).length };
}
const report = { at: new Date().toISOString(), frozenFiles: Object.keys(baseline.files).length, protocol: 7, replayed: states.length, replayedPhases: states.reduce((n, s) => n + s.phases, 0), newModelCalls: 0, categories: Object.fromEntries([...new Set(results.map(r => r.category))].map(c => [c, summarize(results.filter(r => r.category === c))])), total: summarize(results), registered: states.flatMap(s => s.admission).filter(a => a.registered).length, interpretation: "Unchanged v7 host replay. Raw evidence is gated by existing v7 receipts; absent boundaries/provenance are not supplied. Scores are literal retrieval contracts, not model accuracy." };
writeFileSync(`${out}/replay.json`, JSON.stringify({ report, states, results }, null, 2)); verify(); console.log(JSON.stringify(report));
