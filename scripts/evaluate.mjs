import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../src/store.mjs";
import { cosine, hash } from "../src/domain.mjs";
import { MemoryService } from "../src/service.mjs";
import { scenarios, negatives } from "../tests/scenarios.mjs";
const live = process.argv.includes("--live");
let key = process.env.DSH_MEMORY_API_KEY, workspaceId = process.env.DSH_MEMORY_WORKSPACE_ID;
const homeArg = process.argv.indexOf("--home");
if (live && homeArg >= 0) {
  const home = process.argv[homeArg + 1]; if (!home) throw new Error("--home 缺少 DSH_HOME 路径");
  const settingsStore = new MemoryStore(join(home, "storages/dsh-memory/memory.sqlite"));
  const settings = settingsStore.settings(); settingsStore.close();
  const { parseCredentialsDocument } = await import("@deepseek-ai/dsh-credentials-local");
  const path = join(home, ".credentials.yaml"), document = parseCredentialsDocument(readFileSync(path, "utf8"), path);
  key = document.refs.get(settings.credentialRef); workspaceId = settings.workspaceId;
}
if (live && (!key || !workspaceId)) throw new Error("真实评估需要 DSH_MEMORY_API_KEY 和 DSH_MEMORY_WORKSPACE_ID；不得把 Key 写入报告");
const service = new MemoryService({ filename: ":memory:", credential: async () => key }), store = service.store;
if (live) store.configure({ workspaceId });
const project = "D:/dsh-memory-evaluation/project", other = "D:/dsh-memory-evaluation/foreign", ids = [];
for (let i = 0; i < scenarios.length; i++) {
  const content = scenarios[i][0];
  for (const p of [project, other]) { const sourceId = store.source({ sessionId: "synthetic", eventId: `${i}:${p}`, role: "user", projectId: p, text: content }); const row = store.save({ kind: "fact", scope: "project", projectId: p, content, evidence: [{ sourceId, quote: content }] }); if (p === project) ids.push(row.id); }
}
if (live) for (let i = 0; i < ids.length; i += 10) { const rows = ids.slice(i, i + 10).map((id) => store.get(id)), vectors = await service.client.embed(rows.map((r) => r.content), "document"); rows.forEach((row, j) => store.setEmbedding(row.id, row.content_hash, store.settings().embeddingModel, vectors[j])); }
let exact = 0, paraphrase = 0, negativeHits = 0, leaks = 0; const latencies = [], results = [];
for (let i = 0; i < scenarios.length; i++) for (const [type, query] of [["exact", scenarios[i][1]], ["paraphrase", scenarios[i][2]]]) {
  const start = performance.now(), rows = await service.search(query, project, { cloud: live }); latencies.push(performance.now() - start);
  const hit = rows.some((r) => r.id === ids[i]); if (type === "exact" && hit) exact++; if (type === "paraphrase" && hit) paraphrase++;
  leaks += rows.filter((r) => r.project_id !== project.toLowerCase()).length;
  const queryVector = live ? store.cached(hash(`query:${store.settings().embeddingModel}:${query}`)) : null;
  const expectedVector = queryVector ? store.vectors(project, store.settings().embeddingModel).find((r) => r.id === ids[i])?.vector : null;
  results.push({ type, query, hit, count: rows.length, expectedSemantic: expectedVector ? cosine(queryVector, expectedVector) : null, hits: rows.map((r) => ({ content: r.content, semantic: r.semantic, lexical: r.lexical, relevance: r.relevance })) });
}
for (const query of negatives) { const rows = await service.search(query, project, { cloud: live }); if (rows.length) negativeHits++; const q = live ? store.cached(hash(`query:${store.settings().embeddingModel}:${query}`)) : null; results.push({ type: "negative", query, count: rows.length, bestSemantic: q ? Math.max(...store.vectors(project, store.settings().embeddingModel).map((r) => cosine(q, r.vector))) : null }); }
const report = { mode: live ? "live-qwen" : "local-keyword-baseline", models: { extraction: "not-exercised-by-retrieval-evaluation", embedding: store.settings().embeddingModel, rerank: store.settings().rerankModel }, scenarios: results.length, exactRecallAt5: exact / 20, paraphraseRecallAt5: paraphrase / 20, negativeInjectionRate: negativeHits / 20, crossProjectLeaks: leaks, latencyP95Ms: latencies.sort((a, b) => a - b)[Math.floor(latencies.length * .95)], costCny: store.dashboard().cost, semanticAcceptance: live ? paraphrase / 20 >= .9 && negativeHits / 20 <= .05 && !leaks : "PENDING_REAL_QWEN_CREDENTIALS", results };
await mkdir(".cache", { recursive: true }); await writeFile(`.cache/evaluation-${live ? "live" : "local"}.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, results: undefined }, null, 2)); await service.close();
if (leaks || exact < 20 || (live && !report.semanticAcceptance)) process.exitCode = 1;

