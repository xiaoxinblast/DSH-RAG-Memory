import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { MemoryService } from "../src/service.mjs";
import { redact } from "../src/qwen.mjs";
import { extractionCases } from "../tests/fixtures/extraction-cases-v6.mjs";
import { hash, CANDIDATES, auditHistory } from "./kernel-evaluation-budget.mjs";
export { hash, CANDIDATES };
export const OUTPUT = resolve(".cache/extraction-evaluation/kernel-v7");
export function seed(fixture, candidate) {
  const service = new MemoryService({ filename: ":memory:", client: { ready: async () => false } }), aliases = new Map();
  service.store.configure({ extractionRoute: { provider: candidate.provider, model: candidate.model } });
  for (const old of fixture.existing) {
    const workspace = old.foreign ? fixture.foreignWorkspace : fixture.workspace;
    service.store.source({ id: old.sourceId, sessionId: `${fixture.id}:seed`, eventId: old.key, projectId: workspace, role: "user", text: old.content });
    const row = service.store.save({ kind: old.kind, scope: old.scope, projectId: workspace, content: old.content, evidence: [{ sourceId: old.sourceId, quote: old.content }], ranges: [{ sourceId: old.sourceId, start: 0, end: old.content.length }], attributes: { legacy: false, ...old.attributes } });
    aliases.set(old.id, row.id);
    if (old.status === "forgotten") service.store.forget(row.id);
  }
  for (const s of fixture.sources) service.store.source({ id: s.id, sessionId: s.session_id, eventId: s.id, projectId: fixture.workspace, role: s.role, text: redact(s.text), turnId: "synthetic-turn" });
  const reverse = new Map([...aliases].map(([a, b]) => [b, a]));
  const canonical = (value) => JSON.parse(JSON.stringify(value, (_key, v) => typeof v === "string" ? reverse.get(v) ?? v : v));
  const snapshot = () => canonical(service.store.db.prepare("SELECT * FROM memories ORDER BY rowid").all().map((r) => ({ ...r, attributes: service.store.attributes(r.id), evidence: service.store.detail(r.id).evidence.map((e) => ({ sourceId: e.id, quote: e.quote })), ranges: service.store.detail(r.id).ranges })));
  const concurrent = () => {
    if (!fixture.concurrentUpdate) return;
    const old = service.store.get(aliases.get(fixture.existing[0].id)), sourceId = `${fixture.id}:concurrent`;
    service.store.source({ id: sourceId, sessionId: "synthetic-concurrent", eventId: sourceId, projectId: fixture.workspace, role: "user", text: fixture.concurrentUpdate });
    service.store.save({ ...old, projectId: fixture.workspace, content: fixture.concurrentUpdate, evidence: [{ sourceId, quote: fixture.concurrentUpdate }] }, { expectedVersion: old.version });
  };
  return { service, aliases, canonical, snapshot, concurrent };
}
export function prepare() {
  const releaseFile = "docs/kernel-release-manifest.json", release = JSON.parse(readFileSync(releaseFile)), audit = auditHistory();
  const cases = extractionCases.map(f => ({ ...structuredClone(f), split: "previously-used-regression" }));
  const tasks = []; for (let pass = 1; pass <= 2; pass++) for (const f of cases) for (const c of CANDIDATES) tasks.push({ id: `${f.id}:${c.id}:${pass}`, caseId: f.id, candidateId: c.id, pass });
  const files = [...Object.keys(release.files), releaseFile, ...Object.keys(audit.files), ".cache/extraction-evaluation/v6/live/completion.json", ".cache/extraction-evaluation/v6/reviews.json", ".cache/extraction-evaluation/v6/scored.json", "scripts/evaluate-kernel.mjs", "scripts/kernel-evaluation.mjs", "scripts/kernel-evaluation-budget.mjs", "scripts/kernel-evaluation-score.mjs", "tests/evaluation/kernel-evaluation.test.mjs", ...["", "-v2", "-v3", "-v4", "-v5", "-v6"].map(v=>`tests/fixtures/extraction-cases${v}.mjs`)];
  for (const [f,h] of Object.entries(release.files)) if (hash(readFileSync(f)) !== h) throw Error(`生产冻结不匹配：${f}`);
  const plan = { version: "kernel-v7-live-protocol-5", cases, candidates: CANDIDATES, tasks, priorAccountedCny: audit.budgetPriorCny, cumulativeCeilingCny: 10, historyAudit: { ...audit, at: undefined }, thresholds: { precision:.98, memoryPrecision:.98, recall:.9, firstStructure:.99, criticalErrors:0 }, settings: {temperature:0,maxTokens:2048,timeoutMs:90000,thinking:"off",attemptsPerPhase:1,liveCloudRetrieval:false}, reviewMethod:"Source-and-gold semantic review by Codex; blind grouped content; identical prior judgments revalidated; no paid judge; no unseen holdout claim", files:Object.fromEntries(files.map(f=>[f,hash(readFileSync(f))])) };
  plan.id=hash(plan); mkdirSync(OUTPUT,{recursive:true}); const file=join(OUTPUT,"plan.json");
  if(existsSync(file)&&JSON.parse(readFileSync(file)).id!==plan.id)throw Error("本轮已冻结，拒绝修改");
  if(!existsSync(file))writeFileSync(file,JSON.stringify(plan,null,2)); return plan;
}
export function verifyPlan() {
 const plan=JSON.parse(readFileSync(join(OUTPUT,"plan.json"))),{id,...body}=plan;
 if(id!==hash(body))throw Error("清单校验失败");
 const checkpointFile=join(OUTPUT,"continuation.json"),checkpoint=existsSync(checkpointFile)?JSON.parse(readFileSync(checkpointFile)):null;
 if(checkpoint){
   const {id:checkpointId,...data}=checkpoint;
   if(checkpointId!==hash(data)||checkpoint.planId!==id)throw Error("续跑核查清单无效");
   const journal=readFileSync(join(OUTPUT,"live/journal.jsonl"));
   if(hash(journal.subarray(0,checkpoint.journalBytes))!==checkpoint.journalHash)throw Error("停止前日志变化，拒绝续跑");
   for(const [f,h]of Object.entries(checkpoint.harness)){
     if(!["scripts/evaluate-kernel.mjs","scripts/kernel-evaluation.mjs"].includes(f)||hash(readFileSync(f))!==h||hash(readFileSync(join(OUTPUT,"frozen-harness",f.split("/").at(-1))))!==plan.files[f])throw Error("只允许已归档的评估续跑控制变更");
   }
 }
 for(const [f,h]of Object.entries(plan.files))if(hash(readFileSync(f))!==(checkpoint?.harness[f]??h))throw Error(`冻结文件变化：${f}`);
 if(checkpoint)plan.continuation=checkpoint;
 return plan;
}
