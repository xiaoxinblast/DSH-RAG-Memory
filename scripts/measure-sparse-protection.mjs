import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { cpus, platform, release } from "node:os";
import { baselineStore, seedProtections, workspace } from "../tests/helpers/protection-perf.mjs";
import { hash } from "../src/domain.mjs";

const files = { original: ".cache/protection-perf/baseline/src/store.mjs", before: ".cache/sparse-protection/baseline/src/store.mjs", after: "src/store.mjs" };
const summarize = values => { const sorted = [...values].sort((a, b) => a - b); return { p50Ms: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1] }; };
if (process.argv[2] === "worker") {
  const [, , , variant, size, profile, round] = process.argv, count = Number(size);
  const { MemoryStore } = await import(pathToFileURL(resolve(files[variant])).href), store = new MemoryStore(":memory:");
  seedProtections(store, count, { dense: profile === "dense" });
  const sourceId = `origin-${count - 1}`, content = `${store.get(`synthetic-${count - 1}`).content}。另一独立主题0。`, cases = [];
  for (const [shape, sourceIds, extra] of [
    ["empty", [], {}],
    ["source", [sourceId], {}],
    ["range", [sourceId], { ranges: [{ sourceId, start: 0, end: 3 }], attributes: { subject: `module-${count - 1}`, facet: "storage" } }],
  ]) {
    const samplesMs = [], options = { project: workspace, ...extra };
    let signature, matchingRows;
    for (let i = 0; i < 18; i++) {
      const started = performance.now(), result = store.protections(content, sourceIds, options), ms = performance.now() - started;
      if (i >= 3) samplesMs.push(ms);
      const current = hash(JSON.stringify(result)); if (signature) assert.equal(current, signature); signature = current;
      matchingRows = { precise: result.precise.length, related: result.related.length, legacy: result.legacy.length, controls: result.controls.length };
    }
    cases.push({ shape, ...summarize(samplesMs), samplesMs, signature, matchingRows });
  }
  const result = { variant, count, profile, round: Number(round), cases, processPeakRssMiB: process.resourceUsage().maxRSS / 1024 };
  store.close(); console.log(JSON.stringify(result));
} else {
  await baselineStore(); await baselineStore("sparse-protection"); mkdirSync(".cache/sparse-protection/benchmark", { recursive: true });
  const report = { measuredAt: new Date().toISOString(), environment: { node: process.version, platform: platform(), release: release(), cpu: cpus()[0].model }, method: "In-memory SQLite, fixed synthetic seed, no CPU profiler. Three fresh-process rounds per variant/size/profile; rotated original/before/after order. Each process measures empty sources/ranges, source-only, and source+range+attributes. Each shape has 3 warm-up and 15 measured calls; pooled P50/P95 use 45 samples. Output hashing is outside timing. RSS includes setup, Node/SQLite and all shapes, not function-only allocation. Original is pre-previous-optimization, before is the immediately preceding frozen release. No model, normal profile or network.", sourceHashes: Object.fromEntries(Object.entries(files).map(([name, path]) => [name, hash(readFileSync(path))])), results: [], summary: [] };
  for (const count of [1000, 10000]) for (const profile of ["sparse", "dense"]) for (let round = 0; round < 3; round++) {
    const names = ["original", "before", "after"], order = [...names.slice(round), ...names.slice(0, round)];
    for (const variant of order) {
      const run = spawnSync(process.execPath, ["--import", "./tests/helpers/offline.mjs", "scripts/measure-sparse-protection.mjs", "worker", variant, String(count), profile, String(round)], { encoding: "utf8", timeout: 180000 });
      assert.equal(run.status, 0, run.stderr + run.stdout); const result = JSON.parse(run.stdout); report.results.push(result);
      writeFileSync(`.cache/sparse-protection/benchmark/${count}-${profile}-${round}-${variant}.json`, JSON.stringify(result, null, 2) + "\n");
      console.log(`${count} ${profile} round ${round + 1} ${variant}: ${result.cases.map(c => `${c.shape}=${c.p50Ms.toFixed(2)}ms`).join(", ")}`);
    }
  }
  for (const count of [1000, 10000]) for (const profile of ["sparse", "dense"]) for (const shape of ["empty", "source", "range"]) {
    let expected;
    const variants = {};
    for (const variant of ["original", "before", "after"]) {
      const rows = report.results.filter(r => r.count === count && r.profile === profile && r.variant === variant), cases = rows.map(r => r.cases.find(c => c.shape === shape));
      for (const c of cases) { if (expected) assert.equal(c.signature, expected, "Every variant/round must produce identical ordered results"); expected = c.signature; }
      variants[variant] = { ...summarize(cases.flatMap(c => c.samplesMs)), roundP50Ms: cases.map(c => c.p50Ms), peakRssMiB: rows.map(r => r.processPeakRssMiB) };
    }
    report.summary.push({ count, profile, shape, signature: expected, variants });
  }
  writeFileSync("docs/sparse-protection-performance.json", JSON.stringify(report, null, 2) + "\n");
}
