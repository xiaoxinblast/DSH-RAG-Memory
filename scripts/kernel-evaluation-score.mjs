import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { OUTPUT, verifyPlan, hash } from "./kernel-evaluation.mjs";
import { resolveEvidence } from "../src/evidence.mjs";

export const contentKey = (caseId, content) => hash({ caseId, content }).slice(0, 16);
const parse = (text) => { try { return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { return null; } };
function load() {
  const plan = verifyPlan(), records = readFileSync(join(OUTPUT, "live/responses.jsonl"), "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  return { plan, records };
}
export function groups(plan, records) {
  const items = new Map();
  for (const r of records) {
    const raw = parse(r.phases.find((p) => p.phase === "extraction")?.text ?? "");
    const oldIds = new Set(r.before.map((m) => m.id));
    const contents = [...(raw?.operations ?? []).filter((o) => ["add", "merge", "update"].includes(o?.action) && typeof o.content === "string").map((o) => o.content), ...r.after.filter((m) => !oldIds.has(m.id)).map((m) => m.content)];
    for (const content of contents) { const key = contentKey(r.caseId, content); items.set(key, { key, caseId: r.caseId, content }); }
  }
  return [...items.values()].sort((a, b) => a.caseId.localeCompare(b.caseId) || a.key.localeCompare(b.key));
}
export function makeReviewPack(plan, records) {
  const all = groups(plan, records);
  return plan.cases.map((f) => ({ caseId: f.id, split: f.split, sources: f.sources.map((s) => ({ role: s.role, text: s.text })), existing: f.existing.map((o) => ({ content: o.content, status: o.status, foreign: !!o.foreign })), gold: f.expected.map((e, i) => ({ atom: i, content: e.content, status: e.status, optional: !!e.optional, scope: e.scope })), items: all.filter((g) => g.caseId === f.id).map(({ key, content }) => ({ key, content })) }));
}
const ratio = (a, b) => b ? a / b : null;
const percentile = (a, q) => a.length ? [...a].sort((x, y) => x - y)[Math.ceil(q * a.length) - 1] : null;
export function score(plan, records, reviews) {
  const reviewByKey = new Map(reviews.map((r) => [r.key, r]));
  for (const g of groups(plan, records)) {
    const v = reviewByKey.get(g.key), f = plan.cases.find((f) => f.id === g.caseId);
    if (!v || typeof v.supported !== "boolean" || typeof v.durable !== "boolean" || typeof v.activeAllowed !== "boolean" || !["project", "global"].includes(v.scope) || !Array.isArray(v.atoms) || v.atoms.some((i) => !Number.isInteger(i) || !f.expected[i]) || !v.reason) throw new Error(`内容未经有效人工复核：${g.key}`);
  }
  const results = records.map((r) => {
    const f = plan.cases.find((f) => f.id === r.caseId), raw = parse(r.phases.find((p) => p.phase === "extraction")?.text ?? "");
    const strict = r.phases.length>0 && r.phases.every(p=>p.validParsedResult===true);
    const proposed = (raw?.operations ?? []).filter((o) => ["add", "merge", "update"].includes(o?.action) && typeof o.content === "string");
    const beforeIds = new Set(r.before.map((m) => m.id)), written = r.after.filter((m) => !beforeIds.has(m.id)), active = written.filter((m) => m.status === "active");
    const judge = (m) => reviewByKey.get(contentKey(f.id, m.content));
    const supported = proposed.filter((o) => judge(o).supported && judge(o).durable).length;
    const correctActive = active.filter((m) => { const j = judge(m); return j.supported && j.durable && j.activeAllowed && j.scope === m.scope; }).length;
    const covered = new Set();
    for (const m of written) { const j = judge(m); if (j.supported && j.durable) for (const i of j.atoms) if (f.expected[i].status === m.status && f.expected[i].scope === m.scope) covered.add(i); }
    // An explicit merge can attach new evidence to an existing, still-active correct fact.
    for (const op of r.operations.filter((o) => o.outcome === "merged" && o.after)) { const j = reviewByKey.get(contentKey(f.id, op.details?.operation?.content ?? op.after.content)); if (j?.supported && j.durable) for (const i of j.atoms) if (f.expected[i].status === op.after.status && f.expected[i].scope === op.after.scope) covered.add(i); }
    const required = f.expected.map((e, i) => ({ ...e, i })).filter((e) => !e.optional);
    const oldErrors = [], critical = [];
    for (const old of f.existing) {
      const after = r.after.find((m) => m.id === old.id), before = r.before.find((m) => m.id === old.id), expected = f.expectedOldStatus[old.id];
      if (!after || after.status !== expected) oldErrors.push({ id: old.id, expected, actual: after?.status ?? "missing" });
      if (old.foreign && (!after || after.status !== before.status || after.content !== before.content)) critical.push("cross-project-change");
      if (old.status === "forgotten" && after?.status !== "forgotten") critical.push("forgotten-original-revived");
      if (expected === "active" && after?.status !== "active") critical.push("unauthorized-old-overwrite");
      if (f.concurrentUpdate && old === f.existing[0] && after?.content !== f.concurrentUpdate) critical.push("concurrent-edit-overwritten");
    }
    for (const m of active) {
      const j = judge(m);
      if (j.supported && j.durable && !j.activeAllowed) critical.push("candidate-activated");
      if (m.scope === "global" && j.scope !== "global") critical.push("unauthorized-global");
      if (f.existing.some((o) => o.status === "forgotten") && f.id !== "v3-actions-5" && !j.durable) critical.push("forgotten-or-revoked-content-written");
    }
    const sources = r.stages.find((s) => s.phase === "input")?.response?.sources ?? [];
    const validRanges = proposed.filter((o) => { try { return o.evidence?.length && resolveEvidence(o.evidence, sources).length === o.evidence.length; } catch { return false; } }).length;
    return { taskId: r.taskId, caseId: f.id, candidateId: r.candidateId, pass: r.pass, split: f.split, category: f.category, rawJson: raw !== null, strict, proposed: proposed.length, supported, validRanges, active: active.length, correctActive, written: written.length, required: required.length, covered: required.filter((e) => covered.has(e.i)).length, coveredAtoms: [...covered], oldErrors, critical, jobDone: r.jobs[0]?.status === "done", verification: r.phases.some((p) => p.phase === "verification"), verificationValid: r.phases.some(p=>p.phase==="verification" && p.validParsedResult), latencyMs: r.latencyMs, warning: r.warning };
  });
  const aggregate = (rows, candidateId) => {
    const sums = Object.fromEntries(["proposed", "supported", "validRanges", "active", "correctActive", "written", "required", "covered"].map((k) => [k, rows.reduce((s, r) => s + r[k], 0)]));
    const planned = plan.tasks.filter((t) => t.candidateId === candidateId).length, phases = records.filter((r) => r.candidateId === candidateId).flatMap((r) => r.phases);
    return { tasks: rows.length, planned, json: rows.filter((r) => r.rawJson).length, strict: rows.filter((r) => r.strict).length, done: rows.filter((r) => r.jobDone).length, ...sums, precision: ratio(sums.supported, sums.proposed), memoryPrecision: ratio(sums.correctActive, sums.active), recall: ratio(sums.covered, sums.required), firstStructure: ratio(rows.filter((r) => r.strict).length, planned), validRangeRate: ratio(sums.validRanges, sums.proposed), exactCases: rows.filter((r) => r.jobDone && r.covered === r.required && !r.oldErrors.length && !r.critical.length && r.active === r.correctActive).length, criticalCases: rows.filter((r) => r.critical.length).length, critical: rows.flatMap((r) => r.critical), oldStateErrorCases: rows.filter((r) => r.oldErrors.length).length, verificationCalls: phases.filter((p) => p.phase === "verification" && p.sent).length, verificationValid: rows.filter((r) => r.verificationValid).length, httpFailures: phases.filter((p) => p.httpStatus !== 200).length, p50Ms: percentile(rows.map((r) => r.latencyMs), 0.5), p95Ms: percentile(rows.map((r) => r.latencyMs), 0.95), inputTokens: phases.reduce((s, p) => s + (p.usage?.inputTokens ?? 0), 0), cachedInputTokens: phases.reduce((s, p) => s + (p.usage?.cacheReadTokens ?? 0), 0), cacheWriteTokens: phases.reduce((s, p) => s + (p.usage?.cacheWriteTokens ?? 0), 0), outputTokens: phases.reduce((s, p) => s + (p.usage?.outputTokens ?? 0), 0), budgetAccountedCny: phases.reduce((s, p) => s + p.chargedCny, 0) };
  };
  return { manifestId: plan.id, reviewMethod: "Codex source-and-gold manual semantic adjudication, model labels omitted; no candidate self-grading", reviewHash: hash(reviews), complete: records.length === plan.tasks.length, byCandidate: Object.fromEntries(plan.candidates.map((c) => [c.id, aggregate(results.filter((r) => r.candidateId === c.id), c.id)])), tasks: results };
}
export async function report(mode) {
  const { plan, records } = load();
  if (mode === "pack") { const pack = makeReviewPack(plan, records); writeFileSync(join(OUTPUT, "review-pack.json"), JSON.stringify(pack, null, 2)); console.log(JSON.stringify({ records: records.length, groups: pack.reduce((s, c) => s + c.items.length, 0) })); }
  else if (mode === "score") { const reviews = JSON.parse(readFileSync(join(OUTPUT, "reviews.json"), "utf8")); const result = score(plan, records, reviews); writeFileSync(join(OUTPUT, "scored.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result.byCandidate)); }
}
