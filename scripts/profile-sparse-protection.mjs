import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { seedProtections, workspace } from "../tests/helpers/protection-perf.mjs";
import { identity, overlaps } from "../src/evidence.mjs";
import { normalize, terms, scoreTerms, hash } from "../src/domain.mjs";

// Diagnostic only: sample the real path, then time isolated work on a materialized synthetic row set.
// The diagnostic materialization is not used by production and its RSS is not a performance result.
const label = process.argv[2] ?? "before", file = process.argv[3] ?? ".cache/sparse-protection/baseline/src/store.mjs";
const { MemoryStore } = await import(pathToFileURL(resolve(file)).href), store = new MemoryStore(":memory:");
seedProtections(store, 10000);
const content = `${store.get("synthetic-9999").content}。另一独立主题0。`, options = { project: workspace };
const statements = new Map(), prepare = store.db.prepare.bind(store.db);
store.db.prepare = sql => {
  const statement = prepare(sql);
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== "function") return value;
    return (...args) => { if (/forgotten_facts|tombstones/.test(sql)) statements.set(sql, args); return value.apply(target, args); };
  } });
};
const expected = store.protections(content, [], options); store.db.prepare = prepare;
const session = new Session(); session.connect(); await session.post("Profiler.enable"); await session.post("Profiler.setSamplingInterval", { interval: 500 });
for (let i = 0; i < 5; i++) store.protections(content, [], options);
await session.post("Profiler.start");
const started = performance.now(); for (let i = 0; i < 80; i++) store.protections(content, [], options); const actualTotalMs = performance.now() - started;
const { profile } = await session.post("Profiler.stop"); await session.post("Profiler.disable"); session.disconnect();
const nodes = new Map(profile.nodes.map(n => [n.id, n])), samples = new Map();
for (let i = 0; i < profile.samples.length; i++) { const n = nodes.get(profile.samples[i]), key = `${n.callFrame.functionName || "(anonymous)"} @ ${n.callFrame.url}:${n.callFrame.lineNumber + 1}`; samples.set(key, (samples.get(key) ?? 0) + profile.timeDeltas[i]); }
const timing = (name, fn) => { const values = []; for (let i = 0; i < 12; i++) { const start = performance.now(); fn(); if (i >= 3) values.push(performance.now() - start); } values.sort((a, b) => a - b); return { name, p50Ms: values[4], p95Ms: values[8] }; };
const stages = [], reads = [];
for (const [sql, args] of statements) {
  const statement = prepare(sql);
  stages.push(timing(sql.includes("forgotten_facts") ? "SQL full forgotten rows: iterate" : "SQL legacy matches: iterate", () => { for (const row of statement.iterate(...args)) assert.ok(row); }));
  stages.push(timing(sql.includes("forgotten_facts") ? "SQL full forgotten rows: all (diagnostic only)" : "SQL legacy matches: all (diagnostic only)", () => statement.all(...args)));
  statement.setReturnArrays(true);
  stages.push(timing(sql.includes("forgotten_facts") ? "SQL full forgotten rows: array iterate (diagnostic only)" : "SQL legacy matches: array iterate (diagnostic only)", () => { for (const row of statement.iterate(...args)) assert.ok(row); }));
  reads.push({ sql, plan: prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) });
}
const [sql, args] = [...statements].find(([sql]) => sql.includes("forgotten_facts")), rows = prepare(sql).all(...args);
const normalized = normalize(content), text = identity(content), digest = hash(normalized);
stages.push(timing("JSON parse empty-range overlap", () => { for (const row of rows) JSON.parse(row.ranges).some(a => [].some(b => overlaps(a, b))); }));
stages.push(timing("Identity body + id exact checks", () => { for (const row of rows) { const body = identity(row.content); void (row.content_hash === digest || text.includes(identity(row.memory_id)) || body.length >= 4 && text.includes(body)); } }));
stages.push(timing("Terms + score, all rows (upper bound, not additive)", () => { for (const row of rows) scoreTerms(terms(row.content), normalized); }));
assert.deepEqual(store.protections(content, [], options), expected);
const report = { label, measuredAt: new Date().toISOString(), sampledCalls: 80, actualAverageMs: actualTotalMs / 80, input: { count: 10000, profile: "sparse", sourceIds: [], ranges: [], scopedRows: rows.length }, resultFingerprint: hash(JSON.stringify(expected)), stages, cpuSelfSamples: [...samples].map(([frame, us]) => ({ frame, ms: us / 1000 })).sort((a, b) => b.ms - a.ms).slice(0, 20), reads, note: "CPU self samples include native work attributed to JS caller; isolated stage medians overlap and are not additive. All inputs synthetic; no provider/model." };
mkdirSync(".cache/sparse-protection/profiles", { recursive: true });
writeFileSync(`.cache/sparse-protection/profiles/${label}.cpuprofile`, JSON.stringify(profile)); writeFileSync(`.cache/sparse-protection/profiles/${label}.json`, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2)); store.close();
