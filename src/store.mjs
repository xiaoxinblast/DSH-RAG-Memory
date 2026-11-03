import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULTS, hash, normalize, projectId, validateMemory, validateSettings, lexicalScore, terms, scoreTerms, validityTime } from "./domain.mjs";
import { migrate, SCHEMA_VERSION } from "./migrations.mjs";
import { identity, overlaps, unionRanges, sourceAnchors, sourceBoundaries } from "./evidence.mjs";

export class MemoryStore {
  constructor(filename, { now = Date.now } = {}) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.now = now;
    this.db = new DatabaseSync(filename);
    if (this.db.prepare("PRAGMA user_version").get().user_version > SCHEMA_VERSION) { this.db.close(); throw new Error("数据库版本过新，请恢复升级前备份或使用匹配插件"); }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, workspace TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL, event_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, turn_id TEXT, processed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, kind TEXT NOT NULL, scope TEXT NOT NULL, project_id TEXT, content TEXT NOT NULL, content_hash TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1, supersedes TEXT);
      CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope,project_id,status);
      CREATE TABLE IF NOT EXISTS evidence(memory_id TEXT NOT NULL REFERENCES memories(id), source_id TEXT NOT NULL REFERENCES sources(id), quote TEXT NOT NULL, PRIMARY KEY(memory_id,source_id));
      CREATE TABLE IF NOT EXISTS revisions(id INTEGER PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memories(id), snapshot TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS embeddings(memory_id TEXT PRIMARY KEY REFERENCES memories(id), content_hash TEXT NOT NULL, model TEXT NOT NULL, dimension INTEGER NOT NULL, vector BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS tombstones(content_hash TEXT PRIMARY KEY, source_ids TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, job_key TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, error TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS usage(id INTEGER PRIMARY KEY, purpose TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cost REAL NOT NULL, estimated INTEGER NOT NULL, request_id TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS extraction_calls(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, request TEXT NOT NULL, response TEXT, usage TEXT, status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS injections(session_id TEXT NOT NULL, message_id TEXT NOT NULL, generation INTEGER NOT NULL, token_bound INTEGER NOT NULL, ids TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(session_id,message_id,generation));
      CREATE TABLE IF NOT EXISTS recalls(session_id TEXT NOT NULL, message_id TEXT NOT NULL, generation INTEGER NOT NULL, text TEXT NOT NULL, ids TEXT NOT NULL, PRIMARY KEY(session_id,message_id,generation));
      CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, content, tokenize='trigram');`);
    try { migrate(this.db); } catch (error) { this.db.close(); throw error; }
    if (!this.getMeta("activatedAt")) this.setMeta("activatedAt", this.now());
  }
  getMeta(key, fallback = null) { const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key); return row ? JSON.parse(row.value) : fallback; }
  setMeta(key, value) { this.db.prepare("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value)); }
  settings() { const saved = this.getMeta("settings", {}); return Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, saved[k] ?? v])); }
  configure(patch) { const value = validateSettings({ ...this.settings(), ...patch }); this.setMeta("settings", value); return value; }
  transaction(fn) { if (this.inTransaction) return fn(); this.db.exec("BEGIN IMMEDIATE"); this.inTransaction = true; try { const v = fn(); this.db.exec("COMMIT"); return v; } catch (e) { this.db.exec("ROLLBACK"); throw e; } finally { this.inTransaction = false; } }
  ensureProject(workspace) { const id = projectId(workspace); this.db.prepare("INSERT INTO projects VALUES(?,?) ON CONFLICT DO NOTHING").run(id, workspace); return id; }
  source(input) {
    const p = this.ensureProject(input.projectId);
    const id = input.id ?? `${input.sessionId}:${input.eventId}`;
    this.db.prepare("INSERT INTO sources(id,session_id,project_id,event_id,role,text,created_at,turn_id) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING").run(id, input.sessionId, p, input.eventId, input.role, input.text, input.createdAt ?? this.now(), input.turnId ?? null);
    if (input.eventRoot) this.db.prepare("UPDATE sources SET event_root=?,part_index=?,part_count=?,original_chars=?,retained_chars=?,truncated=?,span_start=?,span_end=? WHERE id=? AND event_root IS NULL").run(input.eventRoot, input.partIndex, input.partCount, input.originalChars, input.retainedChars, input.truncated ? 1 : 0, input.spanStart, input.spanEnd, id);
    return id;
  }
  getSource(id) { return this.db.prepare("SELECT rowid AS source_order,* FROM sources WHERE id=?").get(id); }
  maskSource(source) {
    const ranges = [...(source.maskedRanges ?? []), ...this.getMeta(`control:${source.id}`, [])];
    if (this.db.prepare("SELECT 1 FROM tombstones t JOIN json_each(t.source_ids) j WHERE j.value=? LIMIT 1").get(source.id)) ranges.push({ start: 0, end: source.text.length });
    for (const r of this.db.prepare("SELECT j.value FROM forgotten_facts f JOIN json_each(f.ranges) j WHERE json_extract(j.value,'$.sourceId')=? ORDER BY f.rowid,CAST(j.key AS INTEGER)").iterate(source.id)) { const e = JSON.parse(r.value); ranges.push({ start: Math.max(0, e.start), end: Math.min(source.text.length, e.end) }); }
    let text = source.text; for (const r of ranges) if (r.end > r.start) text = text.slice(0, r.start) + " ".repeat(r.end - r.start) + text.slice(r.end);
    return { ...source, text, boundaries: source.boundaries ?? sourceBoundaries(source.text), maskedRanges: ranges.filter((r) => r.end > r.start) };
  }
  finishTurn(sessionId, turnId) { this.db.prepare("UPDATE sources SET turn_id=? WHERE session_id=? AND turn_id IS NULL").run(turnId, sessionId); }
  pendingSources(sessionId) { return this.db.prepare("SELECT * FROM sources WHERE processed=0 AND turn_id IS NOT NULL AND session_id=? ORDER BY created_at,rowid").all(sessionId); }
  sessionsReady(idleMs = 120000) { return this.db.prepare("SELECT session_id, count(DISTINCT turn_id) AS turns, max(created_at) AS last_at FROM sources WHERE processed=0 AND turn_id IS NOT NULL GROUP BY session_id HAVING turns>=4 OR last_at<=?").all(this.now() - idleMs); }
  protections(content, sourceIds = [], { ranges = [], attributes = {}, project } = {}) {
    const text = identity(content), normalized = normalize(content), digest = hash(normalized), subject = normalize(attributes.subject ?? ""), facet = normalize(attributes.facet ?? "");
    const legacy = [...this.db.prepare("SELECT t.content_hash,t.source_ids FROM tombstones t WHERE t.content_hash=? OR EXISTS(SELECT 1 FROM json_each(t.source_ids) old JOIN json_each(?) wanted ON old.value=wanted.value) ORDER BY t.rowid").iterate(digest, JSON.stringify(sourceIds))];
    const precise = [], related = [];
    const query = this.db.prepare("SELECT f.memory_id,f.content_hash,f.scope,f.project_id,f.subject,f.facet,f.ranges,f.created_at,f.source_watermark,m.version,m.content FROM forgotten_facts f JOIN memories m ON m.id=f.memory_id WHERE f.scope='global' OR f.project_id IS ? OR f.project_id IN (SELECT s.project_id FROM sources s JOIN json_each(?) j ON s.id=j.value)");
    // Stream positional rows; only matches need the original named, null-prototype result object.
    query.setReturnArrays(true);
    for (const [memory_id, content_hash, scope, project_id, oldSubject, oldFacet, encodedRanges, created_at, source_watermark, version, oldContent] of query.iterate(project ? projectId(project) : null, JSON.stringify(sourceIds))) {
      const overlap = JSON.parse(encodedRanges).some(a => ranges.some(b => overlaps(a, b)));
      const body = identity(oldContent);
      let matches;
      if (content_hash === digest || overlap || text.includes(identity(memory_id)) || body.length >= 4 && text.includes(body) || (!!oldSubject && !!oldFacet && oldSubject === subject && oldFacet === facet)) matches = precise;
      else if (scoreTerms(terms(oldContent), normalized) >= 0.5) matches = related;
      else continue;
      matches.push({ __proto__: null, memory_id, content_hash, scope, project_id, subject: oldSubject, facet: oldFacet, ranges: encodedRanges, created_at, source_watermark, version, content: oldContent });
    }
    const controls = sourceIds.flatMap(id => this.getMeta(`control:${id}`, [])).filter(a => !ranges.length || ranges.some(b => overlaps(a, b)));
    return { precise, related, legacy, controls };
  }
  protectedCandidates(sources, workspace) {
    const candidates = [], anchors = sources.flatMap(source => sourceAnchors(source).map(anchor => ({ text: identity(anchor.text), normalized: normalize(anchor.text), ref: { sourceId: source.id, anchorId: anchor.id } })));
    for (const r of this.db.prepare("SELECT f.memory_id,f.scope,m.version,m.content FROM forgotten_facts f JOIN memories m ON m.id=f.memory_id WHERE f.scope='global' OR f.project_id=?").iterate(projectId(workspace))) {
      const id = identity(r.memory_id), body = identity(r.content), query = terms(r.content);
      let match = "related", evidence = [], first = anchors.length;
      for (const [index, anchor] of anchors.entries()) {
        const exact = anchor.text.includes(id) || body.length >= 4 && anchor.text.includes(body);
        if (!exact && (match === "exact" || scoreTerms(query, anchor.normalized) < 0.5)) continue;
        if (exact && match !== "exact") { match = "exact"; evidence = []; }
        first = Math.min(first, index); evidence.push({ ...anchor.ref });
      }
      if (evidence.length) candidates.push({ id: r.memory_id, version: r.version, scope: r.scope, match, evidence, first });
    }
    // Preserve source-major discovery order, including candidates later promoted from related to exact.
    return candidates.sort((a, b) => a.first - b.first).map(({ first, ...candidate }) => candidate);
  }
  blocked(content, sourceIds = [], options = {}) {
    return this.blockedBy(this.protections(content, sourceIds, options), content, sourceIds, options);
  }
  blockedBy({ precise, legacy, controls }, content, sourceIds, options) {
    const grant = options.rerecordGrant;
    const target = precise.find(r => r.memory_id === grant?.memoryId);
    const allowed = target && grant.operationHash === options.operationHash && typeof grant.operationHash === "string" && grant.version === target.version && grant.contentHash === hash(normalize(content)) && grant.scope === target.scope && grant.project === target.project_id && grant.scope === options.scope && grant.project === (options.scope === "global" ? null : projectId(options.project)) && grant.sourceIds.length > 0 && grant.sourceIds.every(id => {
      const s = this.getSource(id); return sourceIds.includes(id) && s?.role === "user" && s.created_at >= target.created_at && s.source_order > target.source_watermark && !JSON.parse(target.ranges).some(r => r.sourceId === id);
    });
    return controls.length > 0 || precise.some(r => !allowed || r.memory_id !== target.memory_id) || legacy.some(r => !allowed || r.content_hash !== target.content_hash || JSON.parse(r.source_ids).some(id => sourceIds.includes(id)));
  }
  protectControl(ranges) {
    for (const id of new Set(ranges.map(r => r.sourceId))) this.setMeta(`control:${id}`, unionRanges(this.getMeta(`control:${id}`, []), ranges.filter(r => r.sourceId === id)));
    this.setMeta("forgetEpoch", this.getMeta("forgetEpoch", 0) + 1);
  }
  save(input, { reason = "manual", supersedes = null, expectedVersion, expectedTargetVersion, rerecordGrant = null, operationHash, resolveCandidate } = {}) {
    const value = validateMemory(input), evidence = input.evidence ?? [];
    if (!evidence.length) throw new Error("记忆必须包含可核查的消息来源");
    for (const e of evidence) {
      const source = this.getSource(e.sourceId);
      if (!source || !e.quote?.trim() || !source.text.includes(e.quote)) throw new Error("来源或原文引句无效");
      if (value.scope === "project" && source.project_id !== value.projectId) throw new Error("记忆来源与项目不一致");
    }
    if (this.blocked(value.content, evidence.map((e) => e.sourceId), { ranges: input.ranges, attributes: input.attributes, scope: value.scope, project: value.projectId, rerecordGrant, operationHash })) return { blocked: true };
    const digest = hash(normalize(value.content)), old = input.id ? this.get(input.id) : null;
    if (input.id && !old) throw new Error("记忆不存在");
    if (resolveCandidate !== undefined && (old?.status !== "pending" || old.version !== resolveCandidate)) throw new Error("候选已变化，未应用过期回答");
    if (old?.status === "forgotten") throw new Error("已遗忘的记忆不能恢复");
    if (old && expectedVersion !== undefined && old.version !== expectedVersion) throw new Error("记忆已被其他操作修改，请重新读取");
    const status = input.status ?? "active", confirming = old?.status === "pending" && status === "active" && old.supersedes && resolveCandidate === undefined;
    if (!["active", "pending"].includes(status)) throw new Error("无效的写入状态");
    if (confirming) supersedes = old.supersedes;
    const target = supersedes ? this.get(supersedes) : null;
    if (supersedes && (!target || target.id === old?.id || target.status !== "active" || target.scope !== value.scope || target.project_id !== value.projectId)) throw new Error("被替代记忆不在当前范围或已失效，请重新核对旧记忆");
    const proposal = old ? this.getMeta(`replacement:${old.id}`) : null;
    if (confirming && (!proposal || proposal.targetId !== target.id || proposal.version !== target.version)) throw new Error("旧记忆已变化，请重新生成替代候选后确认");
    if (old && old.content_hash === digest && old.status === (input.status ?? "active") && old.kind === value.kind && old.scope === value.scope && old.project_id === value.projectId) { this.mergeEvidence(old.id, evidence, input.ranges); return { ...old, duplicate: true }; }
    const duplicate = this.db.prepare("SELECT * FROM memories WHERE content_hash=? AND scope=? AND project_id IS ? AND status='active' AND id<>?").get(digest, value.scope, value.projectId, old?.id ?? "");
    if (duplicate && status === "active") { if (confirming) throw new Error("相同内容已存在，请重新核对替代候选"); this.mergeEvidence(duplicate.id, evidence, input.ranges); if (resolveCandidate !== undefined) this.dismissCandidate(old.id, old.version); return { ...duplicate, duplicate: true }; }
    if (status === "pending") {
      const pending = this.db.prepare("SELECT * FROM memories WHERE content_hash=? AND scope=? AND project_id IS ? AND status='pending' AND supersedes IS ? AND id<>?").all(digest, value.scope, value.projectId, supersedes ?? old?.supersedes ?? null, old?.id ?? "").find((row) => !target || this.getMeta(`replacement:${row.id}`)?.version === (proposal?.version ?? expectedTargetVersion ?? target.version));
      if (pending) { this.mergeEvidence(pending.id, evidence, input.ranges); return { ...pending, duplicate: true }; }
    }
    const id = old?.id ?? randomUUID(), now = this.now();
    return this.transaction(() => {
      if (old) this.revision(old, reason);
      if (target && status === "active") { this.revision(target, "superseded"); this.db.prepare("UPDATE memories SET status='superseded',version=version+1,updated_at=? WHERE id=?").run(now, target.id); this.unindex(target.id); }
      this.db.prepare(`INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,scope=excluded.scope,project_id=excluded.project_id,content=excluded.content,content_hash=excluded.content_hash,status=excluded.status,updated_at=excluded.updated_at,version=excluded.version,supersedes=excluded.supersedes`).run(id, value.kind, value.scope, value.projectId, value.content, digest, status, old?.created_at ?? now, now, (old?.version ?? 0) + 1, resolveCandidate !== undefined ? supersedes : supersedes ?? old?.supersedes ?? null);
      if (target && status === "pending" && !proposal) this.setMeta(`replacement:${id}`, { targetId: target.id, version: expectedTargetVersion ?? target.version });
      if (confirming || resolveCandidate !== undefined) this.db.prepare("DELETE FROM meta WHERE key=?").run(`replacement:${id}`);
      for (const e of evidence) this.db.prepare("INSERT INTO evidence VALUES(?,?,?) ON CONFLICT(memory_id,source_id) DO UPDATE SET quote=excluded.quote").run(id, e.sourceId, e.quote);
      this.mergeEvidence(id, [], input.ranges);
      this.setAttributes(id, input.attributes ?? (old ? this.attributes(id) : {}), { invalidate: false });
      this.unindex(id);
      if (status === "active") this.db.prepare("INSERT INTO memories_fts VALUES(?,?)").run(id, value.content);
      const result = this.get(id);
      this.invalidate();
      this.revision(result, old ? "updated" : reason);
      if (status === "active") this.enqueue("embed", `${id}:${digest}:${result.version}:${this.settings().embeddingModel}`, { id, contentHash: digest, version: result.version });
      return result;
    });
  }
  mergeEvidence(id, evidence = [], ranges = []) {
    return this.transaction(() => {
      for (const e of evidence) this.db.prepare("INSERT INTO evidence VALUES(?,?,?) ON CONFLICT(memory_id,source_id) DO UPDATE SET quote=excluded.quote").run(id, e.sourceId, e.quote);
      for (const r of ranges) this.db.prepare("INSERT INTO evidence_ranges VALUES(?,?,?,?) ON CONFLICT DO NOTHING").run(id, r.sourceId, r.start, r.end);
    });
  }
  attributes(id) { const r = (this.attributeQuery ??= this.db.prepare("SELECT * FROM memory_attributes WHERE memory_id=?")).get(id); return r ? { subject: r.subject, facet: r.facet, validFrom: r.valid_from, validUntil: r.valid_until, core: !!r.core, legacy: !!r.legacy, confirmedAt: r.confirmed_at } : { subject: "", facet: "", validFrom: null, validUntil: null, core: false, legacy: true, confirmedAt: null }; }
  setAttributes(id, input, { invalidate = true } = {}) {
    const old = this.attributes(id), v = { ...old, ...input };
    const from = validityTime(v.validFrom), until = validityTime(v.validUntil, true);
    if ([from, until].some((t) => t !== null && !Number.isFinite(t)) || (from !== null && until !== null && from > until)) throw new Error("记忆适用时间无效");
    this.db.prepare("INSERT INTO memory_attributes VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(memory_id) DO UPDATE SET subject=excluded.subject,facet=excluded.facet,valid_from=excluded.valid_from,valid_until=excluded.valid_until,core=excluded.core,legacy=excluded.legacy,confirmed_at=excluded.confirmed_at").run(id, normalize(v.subject ?? ""), normalize(v.facet ?? ""), from, until, v.core ? 1 : 0, input.legacy ?? false ? 1 : 0, v.confirmedAt ?? null);
    if (invalidate) this.invalidate();
  }
  invalidate() { this.db.prepare("DELETE FROM recalls").run(); this.setMeta("memoryEpoch", this.getMeta("memoryEpoch", 0) + 1); }
  epoch() { return this.getMeta("memoryEpoch", 0); }
  visible(id, project, { history = false, at } = {}) { const r = this.get(id); if (!r || (r.scope !== "global" && r.project_id !== projectId(project)) || !["active", ...(history ? ["superseded"] : [])].includes(r.status)) return false; const a = this.attributes(id), time = at ?? this.now(); return history && at === undefined || ((a.validFrom === null || a.validFrom <= time) && (a.validUntil === null || a.validUntil >= time)); }
  receipt({ key, jobId = null, memoryId = null, action, outcome, reason, evidence = [], before = null, after = null, details = {} }) {
    const id = hash(key); this.db.prepare("INSERT INTO memory_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_key) DO NOTHING").run(id, key, jobId, memoryId, action, outcome, reason, JSON.stringify(evidence), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, JSON.stringify(details), this.now()); return id;
  }
  operations({ memoryId, jobId, limit = 100 } = {}) { return this.db.prepare("SELECT * FROM memory_operations WHERE (? IS NULL OR memory_id=? OR json_extract(details,'$.targetId')=?) AND (? IS NULL OR job_id=?) ORDER BY created_at DESC,rowid DESC LIMIT ?").all(memoryId ?? null, memoryId ?? null, memoryId ?? null, jobId ?? null, jobId ?? null, limit).map((r) => ({ ...r, evidence: JSON.parse(r.evidence), before: r.before_state ? JSON.parse(r.before_state) : null, after: r.after_state ? JSON.parse(r.after_state) : null, details: JSON.parse(r.details), before_state: undefined, after_state: undefined })); }
  revert(operationId) {
    return this.transaction(() => {
      const receipt = this.operations({ limit: 10000 }).find((r) => r.id === operationId);
      if (!receipt || receipt.action !== "update" || receipt.outcome !== "applied" || !receipt.before || !receipt.after) throw new Error("这条操作不支持自动纠正回退");
      const old = this.get(receipt.before.id), current = this.get(receipt.after.id);
      if (!old || !current || old.status !== "superseded" || old.version !== receipt.before.version + 1 || current.status !== "active" || current.version !== receipt.after.version) throw new Error("后续已有修改或遗忘，拒绝过期回退");
      this.revision(old, "reverted"); this.revision(current, "reverted");
      this.db.prepare("UPDATE memories SET status='superseded',version=version+1,updated_at=? WHERE id=?").run(this.now(), current.id); this.unindex(current.id);
      this.db.prepare("UPDATE memories SET status='active',version=version+1,updated_at=? WHERE id=?").run(this.now(), old.id); this.unindex(old.id);
      this.setAttributes(old.id, receipt.before.attributes ?? {}); this.db.prepare("INSERT INTO memories_fts VALUES(?,?)").run(old.id, old.content);
      this.enqueue("embed", `reverted:${old.id}:${old.version + 1}:${this.settings().embeddingModel}`, { id: old.id, contentHash: old.content_hash }); this.invalidate();
      this.receipt({ key: `revert:${receipt.id}`, memoryId: old.id, action: "revert", outcome: "reverted", reason: "用户人工回退自动纠正", before: current, after: this.get(old.id), details: { operationId, targetId: current.id } });
      return this.get(old.id);
    });
  }
  revision(row, reason) { this.db.prepare("INSERT INTO revisions(memory_id,snapshot,reason,created_at) VALUES(?,?,?,?)").run(row.id, JSON.stringify(row), reason, this.now()); }
  dismissCandidate(id, version) {
    const row = this.get(id);
    if (row?.status !== "pending" || row.version !== version) throw new Error("候选已变化，未取消其他版本");
    this.revision(row, "dismissed");
    this.db.prepare("UPDATE memories SET status='dismissed',version=version+1,updated_at=? WHERE id=?").run(this.now(), id);
    this.unindex(id); this.invalidate();
    return this.get(id);
  }
  unindex(id) { this.db.prepare("DELETE FROM memories_fts WHERE id=?").run(id); this.db.prepare("DELETE FROM embeddings WHERE memory_id=?").run(id); }
  get(id) { return this.db.prepare("SELECT * FROM memories WHERE id=?").get(id) ?? null; }
  detail(id) { const memory = this.get(id); if (!memory) throw new Error("记忆不存在"); return { ...memory, attributes: this.attributes(id), operations: this.operations({ memoryId: id }), ranges: this.db.prepare("SELECT * FROM evidence_ranges WHERE memory_id=?").all(id), evidence: this.db.prepare("SELECT s.*,e.quote FROM evidence e JOIN sources s ON s.id=e.source_id WHERE memory_id=?").all(id), revisions: this.db.prepare("SELECT * FROM revisions WHERE memory_id=? ORDER BY id DESC").all(id).map((r) => ({ ...r, snapshot: JSON.parse(r.snapshot) })) }; }
  forget(id, { expectedVersion } = {}) {
    const row = this.get(id); if (!row) throw new Error("记忆不存在");
    if (expectedVersion !== undefined && row.version !== expectedVersion) throw new Error("遗忘目标已变化，请重新核对");
    if (row.status === "forgotten") return row;
    return this.transaction(() => {
      const refs = this.db.prepare("SELECT source_id FROM evidence WHERE memory_id=?").all(id).map((r) => r.source_id);
      this.revision(row, "forgotten");
      const a = this.attributes(id), ranges = this.db.prepare("SELECT source_id AS sourceId,start,end FROM evidence_ranges WHERE memory_id=?").all(id);
      if (!ranges.length) this.db.prepare("INSERT INTO tombstones VALUES(?,?,?) ON CONFLICT DO NOTHING").run(row.content_hash, JSON.stringify(refs), this.now());
      this.db.prepare("INSERT INTO forgotten_facts VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING").run(id, row.content_hash, row.scope, row.project_id, a.subject, a.facet, JSON.stringify(ranges), this.now(), this.db.prepare("SELECT coalesce(max(rowid),0) AS n FROM sources").get().n);
      this.db.prepare("UPDATE memories SET status='forgotten',version=version+1,updated_at=? WHERE id=?").run(this.now(), id);
      this.unindex(id);
      this.db.prepare("DELETE FROM cache").run();
      const candidates = this.db.prepare("SELECT id FROM memories WHERE supersedes=? AND status='pending'").all(id);
      for (const c of candidates) this.setMeta(`invalidCandidate:${c.id}`, { targetId: id, reason: "目标已遗忘，候选不能再确认" });
      this.invalidate();
      this.setMeta("forgetEpoch", this.getMeta("forgetEpoch", 0) + 1);
      return this.get(id);
    });
  }
  list({ project, scope, status = "active", query = "", limit = 100 } = {}) {
    const rows = this.db.prepare("SELECT * FROM memories WHERE (?='all' OR status=?) AND (? IS NULL OR scope=?) AND (? IS NULL OR project_id=? OR scope='global') ORDER BY updated_at DESC LIMIT 1000").all(status, status, scope ?? null, scope ?? null, project ?? null, project ?? null);
    return rows.filter((r) => !query || normalize(r.content).includes(normalize(query))).slice(0, Math.min(200, Math.max(1, limit)));
  }
  eligible(project, { history = false, at } = {}) { const time = at ?? this.now(); return this.db.prepare("SELECT m.* FROM memories m LEFT JOIN memory_attributes a ON a.memory_id=m.id WHERE (m.status='active' OR (? AND m.status='superseded')) AND (m.scope='global' OR m.project_id=?) AND (? OR ((a.valid_from IS NULL OR a.valid_from<=?) AND (a.valid_until IS NULL OR a.valid_until>=?))) ORDER BY m.updated_at DESC,m.id").all(history ? 1 : 0, projectId(project), history && at === undefined ? 1 : 0, time, time); }
  subjectMatches(query, project, { history = false, at } = {}, limit = 20) { const time = at ?? this.now(); return this.db.prepare("SELECT m.* FROM memories m JOIN memory_attributes a ON a.memory_id=m.id WHERE a.subject<>'' AND instr(?,a.subject)>0 AND (m.status='active' OR (? AND m.status='superseded')) AND (m.scope='global' OR m.project_id=?) AND (? OR ((a.valid_from IS NULL OR a.valid_from<=?) AND (a.valid_until IS NULL OR a.valid_until>=?))) ORDER BY m.updated_at DESC,m.id LIMIT ?").all(normalize(query), history ? 1 : 0, projectId(project), history && at === undefined ? 1 : 0, time, time, limit); }
  coreMemories() { return this.db.prepare("SELECT m.* FROM memories m JOIN memory_attributes a ON a.memory_id=m.id WHERE m.status='active' AND m.scope='global' AND a.core=1 AND (a.valid_from IS NULL OR a.valid_from<=?) AND (a.valid_until IS NULL OR a.valid_until>=?) ORDER BY m.id").all(this.now(), this.now()); }
  lexical(query, project, k = 20, options = {}) {
    const eligible = this.eligible(project, options), allowed = new Map(eligible.map((r) => [r.id, r]));
    const phrase = terms(query).filter((t) => [...t].length >= 3).map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ");
    const fts = phrase ? this.db.prepare("SELECT memories_fts.id,bm25(memories_fts) AS score FROM memories_fts JOIN memories m ON m.id=memories_fts.id WHERE memories_fts MATCH ? AND m.status='active' AND (m.scope='global' OR m.project_id=?) ORDER BY score LIMIT 100").all(phrase, projectId(project)).filter((r) => allowed.has(r.id)) : [];
    const ranks = new Map(fts.map((r, i) => [r.id, i]));
    return eligible.map((r) => ({ ...r, lexical: lexicalScore(query, r.content) })).filter((r) => r.lexical > 0 || ranks.has(r.id)).sort((a, b) => b.lexical - a.lexical || (ranks.get(a.id) ?? 999) - (ranks.get(b.id) ?? 999)).slice(0, k);
  }
  setEmbedding(id, digest, model, vector) {
    const row = this.get(id);
    if (!row || row.status !== "active" || row.content_hash !== digest) return false;
    if (!vector.length || vector.some((v) => !Number.isFinite(v))) throw new Error("向量格式无效");
    const data = new Float32Array(vector);
    this.db.prepare("INSERT INTO embeddings VALUES(?,?,?,?,?) ON CONFLICT(memory_id) DO UPDATE SET content_hash=excluded.content_hash,model=excluded.model,dimension=excluded.dimension,vector=excluded.vector").run(id, digest, model, vector.length, Buffer.from(data.buffer));
    return true;
  }
  vectors(project, model) {
    return this.db.prepare("SELECT m.*,e.vector,e.dimension FROM memories m JOIN embeddings e ON e.memory_id=m.id AND e.content_hash=m.content_hash WHERE m.status='active' AND (m.scope='global' OR m.project_id=?) AND e.model=?").all(projectId(project), model).map((r) => { const vector = Array.from(new Float32Array(Uint8Array.from(r.vector).buffer)); const { dimension, vector: _blob, ...memory } = r; return { ...memory, vector }; });
  }
  enqueue(kind, key, payload) { const id = randomUUID(), jobKey = `${kind}:${key}`; this.db.prepare("INSERT INTO jobs(id,job_key,kind,payload,next_at,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING").run(id, jobKey, kind, JSON.stringify(payload), this.now(), this.now()); return this.db.prepare("SELECT id FROM jobs WHERE job_key=?").get(jobKey).id; }
  claim(kind = null, id = null) { return this.transaction(() => {
    for (const expired of this.db.prepare("SELECT id FROM jobs WHERE status='running' AND next_at<=?").all(this.now())) {
      const unknown = this.db.prepare("SELECT 1 FROM job_stages WHERE job_id=? AND state='started'").get(expired.id);
      this.db.prepare("UPDATE jobs SET status=?,error=? WHERE id=?").run(unknown ? "failed" : "pending", unknown ? "模型调用结果不明，需要检查；未自动重发" : null, expired.id);
      if (unknown) this.db.prepare("UPDATE job_stages SET state='interrupted' WHERE job_id=? AND state='started'").run(expired.id);
    }
    const job = this.db.prepare("SELECT * FROM jobs WHERE status='pending' AND next_at<=? AND ((? IS NULL AND kind IN ('extract','embed','tool-memory')) OR (?='memory' AND kind IN ('extract','tool-memory')) OR kind=?) AND (? IS NULL OR id=?) ORDER BY created_at,rowid LIMIT 1").get(this.now(), kind, kind, kind, id, id);
    if (!job) return null;
    const lease = randomUUID(); this.db.prepare("UPDATE jobs SET status='running',attempts=attempts+1,next_at=?,lease_token=? WHERE id=?").run(this.now() + 120000, lease, job.id);
    return { ...job, lease_token: lease, attempts: job.attempts + 1, payload: JSON.parse(job.payload) };
  }); }
  owns(job) { return !!this.db.prepare("SELECT 1 FROM jobs WHERE id=? AND lease_token=? AND status='running' AND next_at>?").get(job.id, job.lease_token, this.now()); }
  assertLease(job) { if (!this.owns(job)) { const e = new Error("后台任务租约已失效，拒绝过期提交"); e.code = "LEASE_LOST"; throw e; } }
  renew(job) { return this.db.prepare("UPDATE jobs SET next_at=? WHERE id=? AND lease_token=? AND status='running' AND next_at>?").run(this.now() + 120000, job.id, job.lease_token, this.now()).changes === 1; }
  stage(jobId, phase) { const r = this.db.prepare("SELECT * FROM job_stages WHERE job_id=? AND phase=?").get(jobId, phase); return r ? { ...r, response: r.response ? JSON.parse(r.response) : null } : null; }
  startStage(job, phase, inputHash) { this.assertLease(job); this.db.prepare("INSERT INTO job_stages VALUES(?,?,?,'started',NULL,NULL,?)").run(job.id, phase, inputHash, this.now()); }
  finishStage(job, phase, response) { this.assertLease(job); this.db.prepare("UPDATE job_stages SET state='done',response=?,error=NULL WHERE job_id=? AND phase=? AND state='started'").run(JSON.stringify(response), job.id, phase); }
  complete(job) { this.assertLease(job); this.db.prepare("UPDATE jobs SET status='done',error=NULL WHERE id=? AND lease_token=?").run(job.id, job.lease_token); }
  retry(job, error) { if (!this.owns(job)) return; this.db.prepare("UPDATE jobs SET status=?,next_at=?,error=? WHERE id=? AND lease_token=?").run(job.attempts >= 5 ? "failed" : "pending", this.now() + Math.min(3600000, 30000 * 2 ** job.attempts), error, job.id, job.lease_token); }
  stopJob(job, message) { if (this.owns(job)) this.db.prepare("UPDATE jobs SET status='failed',error=? WHERE id=? AND lease_token=?").run(message, job.id, job.lease_token); }
  cached(key) { const r = this.db.prepare("SELECT value FROM cache WHERE key=? AND expires_at>?").get(key, this.now()); return r ? JSON.parse(r.value) : null; }
  cache(key, value) { this.db.prepare("INSERT INTO cache VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at").run(key, JSON.stringify(value), this.now() + 86400000); }
  usage(data) { this.db.prepare("INSERT INTO usage(purpose,model,input_tokens,output_tokens,cost,estimated,request_id,created_at) VALUES(?,?,?,?,?,?,?,?)").run(data.purpose, data.model, data.inputTokens, data.outputTokens ?? 0, data.cost, data.estimated ? 1 : 0, data.requestId ?? null, this.now()); }
  dashboard() {
    const start = new Date(this.now()); const hk = new Intl.DateTimeFormat("en", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit" }).formatToParts(start); const y = +hk.find((p) => p.type === "year").value, m = +hk.find((p) => p.type === "month").value;
    const month = `${y}-${String(m).padStart(2, "0")}`;
    const since = Date.UTC(y, m - 1, 1) - 8 * 3600000;
    const totals = this.db.prepare("SELECT coalesce(sum(cost),0) AS cost,coalesce(sum(input_tokens),0) AS input_tokens,coalesce(sum(output_tokens),0) AS output_tokens, count(*) AS requests FROM usage WHERE created_at>=?").get(since);
    const dshUsage = this.db.prepare("SELECT provider,model,usage,status,request FROM extraction_calls WHERE created_at>=?").all(since).reduce((all, row) => {
      const phase = JSON.parse(row.request).phase ?? "extraction", key = `${row.provider}/${row.model}/${phase}`, u = row.usage ? JSON.parse(row.usage) : {};
      const item = all[key] ??= { provider: row.provider, model: row.model, phase, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, missingUsage: 0 };
      item.requests++; item.inputTokens += (u.inputTokens ?? u.promptTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0); item.outputTokens += u.outputTokens ?? u.completionTokens ?? 0; item.cacheReadTokens += u.cacheReadTokens ?? 0; if (!row.usage || row.status === "failed" && !(u.inputTokens + (u.cacheReadTokens ?? 0) > 0)) item.missingUsage++;
      return all;
    }, {});
    return { month, ...totals, dshUsage: Object.values(dshUsage), counts: this.db.prepare("SELECT status,count(*) AS count FROM memories GROUP BY status").all(), projects: this.db.prepare("SELECT * FROM projects ORDER BY workspace").all(), jobs: this.db.prepare("SELECT id,kind,status,attempts,error,created_at FROM jobs WHERE status<>'done' ORDER BY created_at DESC LIMIT 100").all(), usage: this.db.prepare("SELECT purpose,model,sum(cost) AS cost,sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens,count(*) AS requests,max(estimated) AS estimated FROM usage WHERE created_at>=? GROUP BY purpose,model").all(since), injectionTokens: this.db.prepare("SELECT coalesce(sum(token_bound),0) AS count FROM injections WHERE created_at>=?").get(since).count };
  }
  close() { this.db.close(); }
}
