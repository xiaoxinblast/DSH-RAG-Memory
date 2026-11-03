import { bounded, projectId, tokens, validityTime, hash, normalize } from "./domain.mjs";
import { decideOperation, operationFingerprint } from "./policy.mjs";
import { OPERATIONS_PROMPT, operationsInput, parseOperations, parseReview, PROTOCOL_VERSION } from "./extraction.mjs";
import { unionRanges, sameRange, overlaps } from "./evidence.mjs";
import { resolutionFacts } from "./maintenance.mjs";

export async function prepareOperations(service, sources, workspace, { cloud = true } = {}) {
  const store = service.store, first = sources[0];
  const context = store.db.prepare("SELECT * FROM sources WHERE session_id=? AND project_id=? AND (created_at<? OR (created_at=? AND rowid<(SELECT rowid FROM sources WHERE id=?))) ORDER BY created_at DESC,rowid DESC LIMIT 2").all(first.session_id, projectId(workspace), first.created_at, first.created_at, first.id).reverse().filter((s) => !sources.some((n) => n.id === s.id)).map((s) => ({ ...s, text: bounded(s.text, 600), contextOnly: true }));
  const allSources = [...context, ...sources.map((s) => ({ ...s, contextOnly: false }))].map((s) => store.maskSource({ ...store.getSource(s.id), ...s }));
  const protectedItems = store.protectedCandidates(allSources, workspace);
  const query = bounded(allSources.filter((s) => !s.contextOnly).map((s) => s.text).join("\n"), 1200);
  const related = await service.search(query, workspace, { cloud });
  const subject = store.subjectMatches(query, workspace);
  const rows = [...new Map([...subject, ...related, ...store.lexical(query, workspace, 10)].map((r) => [r.id, r])).values()];
  let selected = [], contextSources = allSources;
  for (const row of rows.slice(0, 16)) {
    const next = [...selected, { ...row, attributes: store.attributes(row.id) }];
    if (tokens(operationsInput(contextSources, next, undefined, undefined, protectedItems)) + tokens(OPERATIONS_PROMPT) > 8000) continue;
    selected = next;
    if (selected.length === 10) break;
  }
  if (tokens(operationsInput(contextSources, selected, undefined, undefined, protectedItems)) + tokens(OPERATIONS_PROMPT) > 8000) contextSources = allSources.filter((s) => !s.contextOnly);
  if (tokens(operationsInput(contextSources, selected, undefined, undefined, protectedItems)) + tokens(OPERATIONS_PROMPT) > 8000) throw new Error("来源批次超过输入预算");
  return { sources: contextSources, existing: selected, protected: protectedItems, workspace, route: store.settings().extractionRoute, protocolVersion: PROTOCOL_VERSION, forgetEpoch: store.getMeta("forgetEpoch", 0) };
}
function snapshot(store, row) { return row ? { ...row, attributes: store.attributes(row.id) } : null; }
function checkError(message, code = "CHECK_MODEL_RESULT") { const error = new Error(message); error.code = code; return error; }
async function phase(service, job, name, prepared, payload) {
  const store = service.store, fingerprint = operationFingerprint({ version: PROTOCOL_VERSION, route: prepared.route, payload });
  const saved = store.stage(job.id, name);
  if (saved) {
    if (saved.input_hash !== fingerprint || saved.response?.version !== PROTOCOL_VERSION || saved.state !== "done") throw checkError("阶段版本、输入不匹配或调用结果不明，需要检查；未自动重发");
    return saved.response.raw;
  }
  await service.extractor.assertReady?.(prepared.route);
  store.startStage(job, name, fingerprint);
  try {
    const raw = await service.extractor.request(name, payload, service.abort.signal, { jobId: job.id, route: prepared.route, sessionId: prepared.sources.find(s => !s.contextOnly)?.session_id });
    store.finishStage(job, name, { version: PROTOCOL_VERSION, raw });
    return raw;
  } catch (error) {
    if (error.code === "WAIT_DSH_MODEL") store.db.prepare("DELETE FROM job_stages WHERE job_id=? AND phase=? AND state='started'").run(job.id, name);
    else if (store.owns(job)) store.db.prepare("UPDATE job_stages SET state='interrupted',error=? WHERE job_id=? AND phase=?").run("请求未获可复用结果，需要检查", job.id, name);
    error.code = error.code === "WAIT_DSH_MODEL" ? error.code : "CHECK_MODEL_RESULT"; throw error;
  }
}
function parsed(raw, parse) {
  try { if (raw?.finish !== "stop") throw new Error("未完整结束"); return parse(raw.text); }
  catch { throw checkError("已收到并保存原始回答，但批次格式、版本或结束状态无效；需要检查，未重发", "BATCH_CONTRACT"); }
}
function factsFor(store, prepared, operation, review, ambiguousRanges) {
  const o = operation, attributes = o.attributes ?? {}, scope = o.scope, project = scope === "global" ? null : projectId(prepared.workspace);
  const evidence = unionRanges(o.evidence, review?.evidence ?? []), sourceIds = evidence.map(e => e.sourceId), options = { ranges: evidence, attributes, scope, project: prepared.workspace, operationHash: operationFingerprint(o) };
  const restore = prepared.protected.find(r => r.id === o.restores && r.match === "exact");
  const rerecordGrant = restore ? { memoryId: restore.id, version: restore.version, scope, project, contentHash: hash(normalize(o.content)), operationHash: operationFingerprint(o), sourceIds: o.authorizationEvidence.filter(a => review?.authorizationEvidence.some(b => sameRange(a, b))).map(e => e.sourceId) } : null;
  const conflicts = attributes.subject && attributes.facet ? store.db.prepare("SELECT m.* FROM memories m JOIN memory_attributes a ON a.memory_id=m.id WHERE m.status='active' AND m.scope=? AND m.project_id IS ? AND a.subject=? AND a.facet=? AND m.content_hash<>?").all(scope, project, normalize(attributes.subject), normalize(attributes.facet), hash(normalize(o.content))).filter(r => { const a = store.attributes(r.id); return !(a.validUntil != null && attributes.validFrom && a.validUntil < validityTime(attributes.validFrom)); }) : [];
  const duplicate = store.db.prepare("SELECT * FROM memories WHERE content_hash=? AND scope=? AND project_id IS ? AND status='active'").get(hash(normalize(o.content ?? "")), scope ?? "project", project);
  const protections = [{ ...o, evidence }, ...(o.members ?? [])].map(part => {
    const ids = part.evidence.map(e => e.sourceId), opts = { ...options, ranges: part.evidence }, content = part.content ?? "", protection = store.protections(content, ids, opts);
    return { related: protection.related, blocked: store.blockedBy(protection, content, ids, opts), restoreBlocked: store.blockedBy(protection, content, ids, { ...opts, rerecordGrant }) };
  });
  return { ...prepared, ...resolutionFacts(store, prepared), sources: prepared.sources.map(s => store.maskSource(s)), target: snapshot(store, store.get(o.targetId ?? "")), duplicate, conflicts, ambiguousRanges, relatedProtection: protections.flatMap(p => p.related), rerecordGrant, restoreBlocked: protections.some(p => p.restoreBlocked), blocked: protections.some(p => p.blocked) };
}
function commitOperation(store, job, operation, review, decision, facts) {
  const o = operation, target = facts.target, before = snapshot(store, target), active = ["applied", "merged"].includes(decision.outcome), status = active ? "active" : "pending";
  const ranges = decision.evidence, evidence = ranges.map(e => ({ sourceId: e.sourceId, quote: facts.sources.find(s => s.id === e.sourceId).text.slice(e.start, e.end) }));
  let result = null;
  if (decision.outcome === "applied" && o.action === "forget" && facts.toolRequest?.resolution) result = store.dismissCandidate(facts.candidate.id, facts.candidate.version);
  else if (decision.outcome === "applied" && o.action === "forget") { result = store.forget(target.id, { expectedVersion: o.targetVersion }); store.protectControl(ranges); }
  else if (active && o.action === "merge") { store.mergeEvidence(target.id, evidence, ranges); result = target; }
  else if (decision.outcome === "pending" && facts.toolRequest?.resolution) result = facts.candidate;
  else if (active || decision.outcome === "pending") result = store.save({ ...(facts.toolRequest?.resolution ? { id: facts.candidate.id } : {}), kind: o.kind, scope: o.scope, projectId: facts.workspace, content: o.content, status, evidence, ranges, attributes: { ...o.attributes, legacy: false, core: o.scope === "global" && status === "active", confirmedAt: status === "active" ? store.now() : null } }, { reason: `automatic-v${PROTOCOL_VERSION}`, supersedes: target?.id ?? null, expectedTargetVersion: o.targetVersion, rerecordGrant: decision.rerecordGrant, operationHash: operationFingerprint(o), ...(facts.toolRequest?.resolution ? { resolveCandidate: facts.candidate.version } : {}) });
  if (result?.blocked) throw new Error("事务内遗忘状态发生变化，拒绝提交");
  store.receipt({ key: `${job.id}:${o.id}`, jobId: job.id, memoryId: result?.id ?? target?.id ?? null, action: facts.toolRequest?.resolution && o.action === "forget" ? "dismiss" : o.action, outcome: decision.outcome, reason: decision.reason, evidence: ranges, before, after: result?.id ? snapshot(store, store.get(result.id)) : null, details: { protocolVersion: PROTOCOL_VERSION, targetId: o.targetId, operation: o, verification: review, decision } });
}
export async function processOperations(service, job, sources) {
  const store = service.store;
  if (job.payload.protocolVersion !== PROTOCOL_VERSION) throw checkError("旧版本未完成任务需要检查，未重新解释或发送模型");
  if (!service.enabled(job.payload.projectId) || !sources.length) { store.complete(job); return; }
  let prepared = store.stage(job.id, "input")?.response;
  if (prepared && prepared.protocolVersion !== PROTOCOL_VERSION) throw checkError("旧输入阶段版本不匹配，需要检查");
  if (!prepared) {
    prepared = await prepareOperations(service, sources, job.payload.projectId, { cloud: !job.payload.toolRequest });
    prepared.toolRequest = job.payload.toolRequest ?? null;
    if (prepared.toolRequest?.resolution) {
      const resolution = prepared.toolRequest.resolution;
      if (resolution.targetId) { const target = store.get(resolution.targetId); if (target && (target.scope === "global" || target.project_id === projectId(prepared.workspace))) prepared.existing.push(snapshot(store, target)); }
    }
    if (prepared.toolRequest?.targetId && !prepared.existing.some(r => r.id === prepared.toolRequest.targetId)) {
      const target = store.get(prepared.toolRequest.targetId);
      if (target && (target.scope === "global" || target.project_id === projectId(prepared.workspace))) prepared.existing.push(snapshot(store, target));
    }
    store.transaction(() => { store.startStage(job, "input", operationFingerprint(prepared)); store.finishStage(job, "input", prepared); });
  }
  const cancelled = () => {
    if (prepared.forgetEpoch === store.getMeta("forgetEpoch", 0)) return false;
    store.transaction(() => { store.assertLease(job); store.receipt({ key: `${job.id}:forgotten-input`, jobId: job.id, action: "skip", outcome: "blocked", reason: "遗忘后旧批次失效，未继续复核或写回" }); store.complete(job); });
    if (!prepared.toolRequest) service.schedule(sources[0].session_id);
    return true;
  };
  if (cancelled()) return;
  if (!prepared.sources.some(s => !s.contextOnly && /[\p{L}\p{N}]/u.test(s.text))) {
    store.transaction(() => { store.assertLease(job); store.receipt({ key: `${job.id}:masked`, jobId: job.id, action: "skip", outcome: "blocked", reason: "本批来源已遮蔽，未发送模型" }); if (!prepared.toolRequest) for (const s of sources) store.db.prepare("UPDATE sources SET processed=1 WHERE id=?").run(s.id); store.complete(job); }); return;
  }
  const raw = await phase(service, job, "extraction", prepared, operationsInput(prepared.sources, prepared.existing, undefined, prepared.toolRequest, prepared.protected));
  const draft = parsed(raw, text => parseOperations(text, prepared.sources, [...prepared.existing, ...prepared.protected]));
  if (cancelled()) return;
  if (prepared.toolRequest && draft.operations.filter(o => o.action !== "skip").length > 1) throw checkError("工具返回多个提议，已保留回答，需要检查", "BATCH_CONTRACT");
  const items = draft.operations.filter(o => o.action !== "skip");
  let reviewed = { units: [], errors: [] };
  if (items.length) {
    const response = await phase(service, job, "verification", prepared, operationsInput(prepared.sources, prepared.existing, items, prepared.toolRequest, prepared.protected));
    reviewed = parsed(response, text => parseReview(text, prepared.sources, items));
  }
  if (cancelled()) return;
  const controlRanges = unionRanges(...[...items, ...reviewed.units].filter(o => o.unit === "control").flatMap(o => [o.evidence, o.authorizationEvidence]));
  const memoryRanges = [...items, ...reviewed.units].filter(o => o.unit !== "control").flatMap(o => o.evidence);
  const ambiguousRanges = controlRanges.filter(a => memoryRanges.some(b => overlaps(a, b)));
  store.transaction(() => {
    store.assertLease(job);
    for (const [phaseName, errors] of [["extraction", draft.errors], ["verification", reviewed.errors]]) errors.forEach((error, index) => store.receipt({ key: `${job.id}:${phaseName}:error:${index}`, jobId: job.id, action: "skip", outcome: "review-required", reason: error.reason, details: { protocolVersion: PROTOCOL_VERSION, phase: phaseName, ...error } }));
    if (prepared.toolRequest?.resolution && !draft.operations.length && !draft.errors.length) store.receipt({ key: `${job.id}:deferred`, jobId: job.id, memoryId: prepared.toolRequest.resolution.candidateId, action: "skip", outcome: "skipped", reason: "本次回答没有确定可执行的候选变化，保留现状，不重复追问" });
    const handled = new Set(reviewed.units.flatMap(u => u.members));
    const units = [...reviewed.units, ...draft.operations.filter(o => !handled.has(o.id)).map(operation => ({ operation, decision: null }))];
    for (const review of units) {
      const operation = review.operation, facts = factsFor(store, prepared, operation, review, ambiguousRanges);
      commitOperation(store, job, operation, review, decideOperation(operation, review, facts), facts);
    }
    if (!prepared.toolRequest) for (const s of sources) store.db.prepare("UPDATE sources SET processed=1 WHERE id=?").run(s.id);
    store.complete(job);
  });
  if (!prepared.toolRequest) service.schedule(sources[0].session_id);
}
