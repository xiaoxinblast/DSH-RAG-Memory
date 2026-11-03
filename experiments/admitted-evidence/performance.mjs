import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { MemoryService } from "../../src/service.mjs";
import { sourceAnchors } from "../../src/evidence.mjs";
import { SourceRoute } from "../evidence-routes/source-route.mjs";
import { AdmittedRoute } from "./route.mjs";

const output = [];
for (const count of [1000, 10000]) {
  const workspace = "d:/synthetic/admitted-perf", service = new MemoryService({ filename: ":memory:", client: { ready: async () => false } });
  const store = service.store, raw = new SourceRoute(store), admitted = new AdmittedRoute(store);
  const begin = performance.now(); let forgotten;
  store.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `node-${String(i).padStart(5, "0")}`, body = `${id} 监听端口 ${7000 + i}，只允许本机访问，禁止公网开放。`;
      store.source({ id, sessionId: "synthetic-perf", eventId: id, projectId: workspace, role: "user", text: body });
      const ranges = sourceAnchors(store.getSource(id)).map(a => ({ sourceId: id, start: a.start, end: a.end }));
      const memory = store.save({ content: body, kind: "fact", scope: "project", projectId: workspace, evidence: [{ sourceId: id, quote: body }], ranges, attributes: { legacy: false } });
      // Explicit synthetic, already-admitted state: performance does not measure admission quality.
      const receipt = store.receipt({ key: `synthetic:${id}`, memoryId: memory.id, action: "add", outcome: "applied", reason: "synthetic performance fixture", evidence: ranges, after: memory, details: { protocolVersion: 7, operation: { unit: "self_contained" }, verification: { unit: "self_contained" }, decision: { rerecordGrant: null } } });
      raw.add(id, [id]); admitted.add(receipt); if (!i) forgotten = memory;
    }
  });
  store.forget(forgotten.id); const buildMs = performance.now() - begin;
  const times = { v7: [], source: [], admitted: [] }, queryCounts = { v7: [], source: [], admitted: [] };
  const prepare = store.db.prepare.bind(store.db); let calls = 0;
  store.db.prepare = (...args) => { const statement = prepare(...args); return new Proxy(statement, { get(target, key) { const value = target[key]; if (typeof value !== "function") return value; return (...params) => { if (["all", "get", "iterate"].includes(key)) calls++; return value.apply(target, params); }; } }); };
  // Recreate the cached receipt query through the counter; all database reads are counted.
  admitted.receipt = store.db.prepare("SELECT * FROM memory_operations WHERE id=?");
  store.attributeQuery = undefined;
  console.log(`Synthetic corpus ready: ${count}`);
  for (let turn = 0; turn < 6; turn++) {
    const query = `node-${String(count - 10 - turn).padStart(5, "0")}`;
    for (const name of turn % 2 ? ["admitted", "source", "v7"] : ["v7", "source", "admitted"]) {
      calls = 0; const start = performance.now();
      const result = name === "v7" ? await service.recall("perf", `${count}:${turn}`, workspace, query) : (name === "source" ? raw : admitted).search(query, workspace);
      const ms = performance.now() - start; assert.ok(result.text.includes(query), `${name}: ${query}`);
      if (turn) { times[name].push(ms); queryCounts[name].push(calls); }
    }
  }
  const routes = Object.fromEntries(Object.entries(times).map(([name, samples]) => [name, { samplesMs: samples, medianMs: [...samples].sort((a, b) => a - b)[2], maxMs: Math.max(...samples), databaseReads: queryCounts[name] }]));
  output.push({ records: count, tombstones: 1, combinedBuildMs: buildMs, combinedProcessMemory: process.memoryUsage(), routes });
  store.db.prepare = prepare; await service.close(); console.log(JSON.stringify({ records: count, routes }));
}
writeFileSync(".cache/admitted-evidence/performance.json", JSON.stringify({ at: new Date().toISOString(), modelCalls: 0, method: "Same in-memory SQLite; full qualifying source ranges and synthetic successful receipts; one tombstone; alternating order; one warmup plus five samples; uncached v7 message IDs; counters enabled for all routes; no lightweight index. Max is not P95. Memory is combined, not per route.", output }, null, 2));
