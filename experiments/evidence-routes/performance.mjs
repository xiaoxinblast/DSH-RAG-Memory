import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { MemoryService } from "../../src/service.mjs";
import { hash } from "../../src/domain.mjs";
import { SourceRoute } from "./source-route.mjs";

const baseline = JSON.parse(readFileSync(".cache/evidence-route-comparison/baseline.json"));
for (const [f, digest] of Object.entries(baseline.files)) assert.equal(hash(readFileSync(f)), digest);
const output = [];
for (const count of [1000, 10000]) {
  console.log(`Preparing synthetic corpus: ${count}`);
  const workspace = "d:/synthetic/evidence-performance";
  const service = new MemoryService({ filename: ":memory:", client: { ready: async () => false } });
  const source = new SourceRoute(service.store), indexed = new SourceRoute(service.store, true);
  const begin = performance.now();
  let forgotten;
  service.store.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `node-${String(i).padStart(5, "0")}`, body = `${id} 监听端口 ${7000 + i}，只允许本机访问，禁止公网开放。`;
      service.store.source({ id, sessionId: "synthetic-perf", eventId: id, projectId: workspace, role: "user", text: body });
      const memory = service.store.save({ content: body, kind: "fact", scope: "project", projectId: workspace, evidence: [{ sourceId: id, quote: body }], ranges: [{ sourceId: id, start: 0, end: body.length }], attributes: { legacy: false } });
      if (!i) forgotten = memory;
      source.add(id, [id]); indexed.add(id, [id], [{ text: `${id} 回环网络服务`, evidence: [{ sourceId: id, anchorId: "p1" }] }]);
    }
  });
  service.store.forget(forgotten.id);
  console.log(`Corpus ready: ${count}`);
  const buildMs = performance.now() - begin, times = { v7: [], source: [], "source-index": [] }, matches = {};
  for (let turn = 0; turn < 6; turn++) {
    const query = `node-${String(count - 10 - turn).padStart(5, "0")}`;
    const order = turn % 2 ? ["source-index", "source", "v7"] : ["v7", "source", "source-index"];
    for (const route of order) {
      const start = performance.now();
      const result = route === "v7" ? await service.recall("perf", `${count}:${turn}`, workspace, query) : (route === "source" ? source : indexed).search(query, workspace);
      const ms = performance.now() - start; if (turn) times[route].push(ms);
      matches[route] = (result?.text ?? "").includes(query);
    }
  }
  const stats = Object.fromEntries(Object.entries(times).map(([route, values]) => { const sorted = [...values].sort((a, b) => a - b); return [route, { samples: values.length, medianMs: sorted[2], maxMs: sorted.at(-1), valuesMs: values, lastQueryFound: matches[route] }]; }));
  output.push({ records: count, tombstones: 1, combinedBuildMs: buildMs, combinedProcessMemory: process.memoryUsage(), routes: stats });
  await service.close(); console.log(JSON.stringify({ records: count, routes: stats }));
}
writeFileSync(".cache/evidence-route-comparison/performance.json", JSON.stringify({ at: new Date().toISOString(), method: "in-memory SQLite; same synthetic corpus; one tombstone; one warmup then five samples; alternate order; unique message IDs bypass v7 recall snapshot; cloud disabled; max is not P95", memoryNote: "Process memory includes all three routes together, not per-route attribution. No production performance claim.", modelCalls: 0, output }, null, 2));
