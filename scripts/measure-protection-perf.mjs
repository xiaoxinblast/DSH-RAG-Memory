import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { cpus, platform, release } from "node:os";
import { baselineStore, seedProtections, observeCollections, workspace } from "../tests/helpers/protection-perf.mjs";
import { model, operation, draft } from "../tests/helpers/kernel.mjs";
import { hash } from "../src/domain.mjs";

// Both variants use identical synthetic data in fresh processes. No normal profile or provider is loaded.
if (process.argv[2] === "worker") {
  const [, , , variant, size, profile] = process.argv, count = Number(size);
  const path = variant === "before" ? ".cache/protection-perf/baseline/src/service.mjs" : "src/service.mjs";
  const { MemoryService } = await import(pathToFileURL(resolve(path)).href);
  const service = new MemoryService({ filename: ":memory:", now: () => 10000, client: { ready: async () => false } }), store = service.store;
  seedProtections(store, count, { dense: profile === "dense" });
  const stats = observeCollections(store), sources = Array.from({ length: 4 }, (_, i) => ({ id: `probe-${i}`, role: "user", text: `${store.get(`synthetic-${count - 1 - i}`).content}。另一独立主题${i}。`, contextOnly: i === 3 }));
  const measures = { protection: [], masking: [], candidates: [] }, signatures = {};
  for (let i = 0; i < 11; i++) {
    for (const [name, run] of [
      ["protection", () => store.protections(sources[0].text, [], { project: workspace })],
      ["masking", () => sources.map((_, n) => store.maskSource(store.getSource(`origin-${count - 1 - n}`)))],
      ["candidates", () => store.protectedCandidates(sources, workspace)],
    ]) {
      const start = performance.now(), value = run(), elapsed = performance.now() - start;
      if (i >= 2) measures[name].push(elapsed);
      const signature = hash(JSON.stringify(value)); if (signatures[name]) assert.equal(signature, signatures[name]); signatures[name] = signature;
    }
  }
  const scans = { ...stats }, callsBefore = stats.protectionCollections;
  for (let i = 0; i < 4; i++) store.source({ id: `write-${i}`, sessionId: "new-batch", projectId: workspace, eventId: `write-${i}`, role: "user", text: `Zebraonly${i} uses otteronly${i}.`, turnId: "turn", createdAt: 10000 });
  const calls = model(service, p => draft(p.sources.filter(s => !s.contextOnly).map(s => operation(p, { content: s.anchors.map(a => a.text).join(""), evidence: [{ sourceId: s.sourceId, anchorId: s.anchors[0].id }] }))));
  const start = performance.now(); service.schedule("new-batch"); await service.work("extract"); const writeBatchMs = performance.now() - start;
  assert.equal(calls.length, 2); assert.equal(store.eligible(workspace).length, 4);
  signatures.writes = hash(JSON.stringify(store.operations().map(r => ({ outcome: r.outcome, reason: r.reason, content: r.after.content })).sort((a, b) => a.content.localeCompare(b.content))));
  const summary = values => { const sorted = [...values].sort((a, b) => a - b); return { p50Ms: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], samplesMs: values }; };
  const result = { variant, count, profile, stages: Object.fromEntries(Object.entries(measures).map(([k, v]) => [k, summary(v)])), writeBatchMs, writeProtectionCollections: stats.protectionCollections - callsBefore, scanCollections: scans, signatures, processPeakRssMiB: process.resourceUsage().maxRSS / 1024 };
  await service.close(); console.log(JSON.stringify(result));
} else {
  await baselineStore(); mkdirSync(".cache/protection-perf/benchmark", { recursive: true });
  const report = { measuredAt: new Date().toISOString(), environment: { node: process.version, platform: platform(), release: release(), cpu: cpus()[0].model }, method: "Fresh process per variant/size/profile; in-memory SQLite; 2 warm-up + 9 timed samples per stage; four sources; P95 is the largest of nine samples, not a production tail-latency estimate. One additional four-item write batch uses two mocked phases. Peak RSS covers setup and all stages, including Node/SQLite. No paid calls or normal profile. Sparse fixtures mix hashes, CJK, Latin, short strings and full-width text; dense fixtures share Chinese text. No claim of indexed/sublinear search.", results: [] };
  for (const count of [1000, 10000]) for (const profile of ["sparse", "dense"]) for (const variant of ["before", "after"]) {
    const run = spawnSync(process.execPath, ["--import", "./tests/helpers/offline.mjs", "scripts/measure-protection-perf.mjs", "worker", variant, String(count), profile], { encoding: "utf8", timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(run.status, 0, run.stderr + run.stdout); const result = JSON.parse(run.stdout);
    report.results.push(result); writeFileSync(`.cache/protection-perf/benchmark/${count}-${profile}-${variant}.json`, JSON.stringify(result, null, 2) + "\n");
    console.log(`${count} ${profile} ${variant}: protection ${result.stages.protection.p50Ms.toFixed(1)}ms, candidates ${result.stages.candidates.p50Ms.toFixed(1)}ms, RSS ${result.processPeakRssMiB.toFixed(1)}MiB`);
    if (variant === "after") assert.deepEqual(result.signatures, report.results.at(-2).signatures, "Performance measurements require identical results, order and evidence");
  }
  writeFileSync("docs/protection-perf-performance.json", JSON.stringify(report, null, 2) + "\n");
}
