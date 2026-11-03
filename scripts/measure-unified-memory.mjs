import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

// Separate processes, in-memory SQLite, synthetic forgotten rows. No model or normal profile is loaded.
if (process.argv[2] === "worker") {
  const { MemoryStore } = await import(pathToFileURL(resolve(process.argv[3])).href), count = Number(process.argv[4]), workspace = "d:/synthetic/benchmark";
  const store = new MemoryStore(":memory:"), hash = text => createHash("sha256").update(text).digest("hex");
  const memory = store.db.prepare("INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?,?)"), protection = store.db.prepare("INSERT INTO forgotten_facts VALUES(?,?,?,?,?,?,?,?,?)");
  store.transaction(() => { for (let i = 0; i < count; i++) {
    const id = `synthetic-${i}`, content = hash(id);
    memory.run(id, "fact", "project", workspace, content, hash(content), "forgotten", 0, 0, 2, null);
    protection.run(id, hash(content), "project", workspace, "", "", "[]", 0, 0);
  } });
  const content = hash(`synthetic-${count - 1}`), samples = [];
  for (let i = 0; i < 12; i++) { const start = performance.now(); assert.equal(store.blocked(content, [], { scope: "project", project: workspace }), true); samples.push(performance.now() - start); }
  let candidateMs = null;
  if (store.protectedCandidates) { const start = performance.now(); const candidates = store.protectedCandidates([{ id: "new", role: "user", text: content }], workspace); candidateMs = performance.now() - start; assert.equal(candidates.filter(c => c.match === "exact").length, 1); }
  samples.sort((a, b) => a - b); const result = { count, exactProtectionP50Ms: samples[6], exactProtectionP95Ms: samples[11], protectedCandidateMs: candidateMs, processPeakRssMiB: process.resourceUsage().maxRSS / 1024 };
  store.close(); console.log(JSON.stringify(result));
} else {
  const report = { measuredAt: new Date().toISOString(), method: "fresh Node process per variant/size; in-memory SQLite; 12 exact protection checks; full local candidate scan once; process peak RSS includes Node and SQLite; no accuracy measurement", results: [] };
  for (const [variant, file] of [["before", ".cache/unified-v6/verified/baseline/src/store.mjs"], ["after", "src/store.mjs"]]) for (const count of [1000, 10000]) {
    const run = spawnSync(process.execPath, ["--import", "./tests/helpers/offline.mjs", "scripts/measure-unified-memory.mjs", "worker", file, String(count)], { encoding: "utf8", timeout: 60000 });
    assert.equal(run.status, 0, run.stderr); report.results.push({ variant, ...JSON.parse(run.stdout) });
  }
  const verification = JSON.parse(readFileSync("docs/unified-v6-verification.json")); assert.equal(verification.current.fail, 0);
  writeFileSync("docs/unified-v6-performance.json", JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report, null, 2));
}
