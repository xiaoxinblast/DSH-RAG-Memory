import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULTS, hash, normalize, projectId, validateMemory, validateSettings, lexicalScore, terms } from "./domain.mjs";

export class MemoryStore {
  constructor(filename, { now = Date.now } = {}) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.now = now;
    this.db = new DatabaseSync(filename);
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
    return id;
  }
  getSource(id) { return this.db.prepare("SELECT * FROM sources WHERE id=?").get(id); }
  finishTurn(sessionId, turnId) { this.db.prepare("UPDATE sources SET turn_id=? WHERE session_id=? AND turn_id IS NULL").run(turnId, sessionId); }
  pendingSources(sessionId) { return this.db.prepare("SELECT * FROM sources WHERE processed=0 AND turn_id IS NOT NULL AND session_id=? ORDER BY created_at,rowid").all(sessionId); }
  sessionsReady(idleMs = 120000) { return this.db.prepare("SELECT session_id, count(DISTINCT turn_id) AS turns, max(created_at) AS last_at FROM sources WHERE processed=0 AND turn_id IS NOT NULL GROUP BY session_id HAVING turns>=4 OR last_at<=?").all(this.now() - idleMs); }
  blocked(content, sourceIds = []) {
    const all = this.db.prepare("SELECT content_hash,source_ids FROM tombstones").all();
    return all.some((r) => r.content_hash === hash(normalize(content)) || JSON.parse(r.source_ids).some((s) => sourceIds.includes(s)));
  }
  save(input, { reason = "manual", supersedes = null, expectedVersion } = {}) {
    const value = validateMemory(input), evidence = input.evidence ?? [];
    if (!evidence.length) throw new Error("记忆必须包含可核查的消息来源");
    for (const e of evidence) {
      const source = this.getSource(e.sourceId);
      if (!source || !e.quote?.trim() || !source.text.includes(e.quote)) throw new Error("来源或原文引句无效");
      if (value.scope === "project" && source.project_id !== value.projectId) throw new Error("记忆来源与项目不一致");
    }
    if (this.blocked(value.content, evidence.map((e) => e.sourceId))) return { blocked: true };
    const digest = hash(normalize(value.content)), old = input.id ? this.get(input.id) : null;
    if (input.id && !old) throw new Error("记忆不存在");
    if (old?.status === "forgotten") throw new Error("已遗忘的记忆不能恢复");
    if (old && expectedVersion !== undefined && old.version !== expectedVersion) throw new Error("记忆已被其他操作修改，请重新读取");
    if (old && old.content_hash === digest && old.status === (input.status ?? "active") && old.kind === value.kind && old.scope === value.scope && old.project_id === value.projectId) return { ...old, duplicate: true };
    const duplicate = this.db.prepare("SELECT * FROM memories WHERE content_hash=? AND scope=? AND project_id IS ? AND status='active' AND id<>?").get(digest, value.scope, value.projectId, old?.id ?? "");
    if (duplicate) return { ...duplicate, duplicate: true };
    const target = supersedes ? this.get(supersedes) : null;
    if (supersedes && (!target || target.status !== "active" || target.scope !== value.scope || target.project_id !== value.projectId)) throw new Error("被替代记忆不在当前范围或已失效");
    const id = old?.id ?? randomUUID(), now = this.now(), status = input.status ?? "active";
    if (!["active", "pending"].includes(status)) throw new Error("无效的写入状态");
    return this.transaction(() => {
      if (old) this.revision(old, reason);
      if (target && status === "active") { this.revision(target, "superseded"); this.db.prepare("UPDATE memories SET status='superseded',version=version+1,updated_at=? WHERE id=?").run(now, target.id); this.unindex(target.id); }
      this.db.prepare(`INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,scope=excluded.scope,project_id=excluded.project_id,content=excluded.content,content_hash=excluded.content_hash,status=excluded.status,updated_at=excluded.updated_at,version=excluded.version,supersedes=excluded.supersedes`).run(id, value.kind, value.scope, value.projectId, value.content, digest, status, old?.created_at ?? now, now, (old?.version ?? 0) + 1, supersedes ?? old?.supersedes ?? null);
      for (const e of evidence) this.db.prepare("INSERT INTO evidence VALUES(?,?,?) ON CONFLICT(memory_id,source_id) DO UPDATE SET quote=excluded.quote").run(id, e.sourceId, e.quote);
      this.unindex(id);
      if (status === "active") this.db.prepare("INSERT INTO memories_fts VALUES(?,?)").run(id, value.content);
      const result = this.get(id);
      this.db.prepare("DELETE FROM recalls").run();
      this.revision(result, old ? "updated" : reason);
      this.enqueue("embed", `${id}:${digest}:${result.version}:${this.settings().embeddingModel}`, { id, contentHash: digest, version: result.version });
      return result;
    });
  }
  revision(row, reason) { this.db.prepare("INSERT INTO revisions(memory_id,snapshot,reason,created_at) VALUES(?,?,?,?)").run(row.id, JSON.stringify(row), reason, this.now()); }
  unindex(id) { this.db.prepare("DELETE FROM memories_fts WHERE id=?").run(id); this.db.prepare("DELETE FROM embeddings WHERE memory_id=?").run(id); }
  get(id) { return this.db.prepare("SELECT * FROM memories WHERE id=?").get(id) ?? null; }
  detail(id) { const memory = this.get(id); if (!memory) throw new Error("记忆不存在"); return { ...memory, evidence: this.db.prepare("SELECT s.*,e.quote FROM evidence e JOIN sources s ON s.id=e.source_id WHERE memory_id=?").all(id), revisions: this.db.prepare("SELECT * FROM revisions WHERE memory_id=? ORDER BY id DESC").all(id).map((r) => ({ ...r, snapshot: JSON.parse(r.snapshot) })) }; }
  forget(id) {
    const row = this.get(id); if (!row) throw new Error("记忆不存在");
    if (row.status === "forgotten") return row;
    return this.transaction(() => {
      const refs = this.db.prepare("SELECT source_id FROM evidence WHERE memory_id=?").all(id).map((r) => r.source_id);
      this.revision(row, "forgotten");
      this.db.prepare("INSERT INTO tombstones VALUES(?,?,?) ON CONFLICT DO NOTHING").run(row.content_hash, JSON.stringify(refs), this.now());
      this.db.prepare("UPDATE memories SET status='forgotten',version=version+1,updated_at=? WHERE id=?").run(this.now(), id);
      this.unindex(id);
      this.db.prepare("DELETE FROM recalls").run();
      return this.get(id);
    });
  }
  list({ project, scope, status = "active", query = "", limit = 100 } = {}) {
    const rows = this.db.prepare("SELECT * FROM memories WHERE (?='all' OR status=?) AND (? IS NULL OR scope=?) AND (? IS NULL OR project_id=? OR scope='global') ORDER BY updated_at DESC LIMIT 1000").all(status, status, scope ?? null, scope ?? null, project ?? null, project ?? null);
    return rows.filter((r) => !query || normalize(r.content).includes(normalize(query))).slice(0, Math.min(200, Math.max(1, limit)));
  }
  eligible(project) { return this.db.prepare("SELECT * FROM memories WHERE status='active' AND (scope='global' OR project_id=?) ORDER BY updated_at DESC").all(projectId(project)); }
  lexical(query, project, k = 20) {
    const eligible = this.eligible(project), allowed = new Map(eligible.map((r) => [r.id, r]));
    const phrase = terms(query).filter((t) => [...t].length >= 3).map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ");
    const fts = phrase ? this.db.prepare("SELECT id,bm25(memories_fts) AS score FROM memories_fts WHERE memories_fts MATCH ? ORDER BY score LIMIT 100").all(phrase).filter((r) => allowed.has(r.id)) : [];
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
  enqueue(kind, key, payload) { const id = randomUUID(); this.db.prepare("INSERT INTO jobs(id,job_key,kind,payload,next_at,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING").run(id, `${kind}:${key}`, kind, JSON.stringify(payload), this.now(), this.now()); return id; }
  claim(kind = null) { return this.transaction(() => { this.db.prepare("UPDATE jobs SET status='pending' WHERE status='running' AND next_at<=?").run(this.now()); const job = this.db.prepare("SELECT * FROM jobs WHERE status='pending' AND next_at<=? AND (? IS NULL OR kind=?) ORDER BY created_at LIMIT 1").get(this.now(), kind, kind); if (!job) return null; this.db.prepare("UPDATE jobs SET status='running',attempts=attempts+1,next_at=? WHERE id=?").run(this.now() + 120000, job.id); return { ...job, attempts: job.attempts + 1, payload: JSON.parse(job.payload) }; }); }
  complete(job) { this.db.prepare("UPDATE jobs SET status='done',error=NULL WHERE id=?").run(job.id); }
  retry(job, error) { this.db.prepare("UPDATE jobs SET status=?,next_at=?,error=? WHERE id=?").run(job.attempts >= 5 ? "failed" : "pending", this.now() + Math.min(3600000, 30000 * 2 ** job.attempts), error, job.id); }
  cached(key) { const r = this.db.prepare("SELECT value FROM cache WHERE key=? AND expires_at>?").get(key, this.now()); return r ? JSON.parse(r.value) : null; }
  cache(key, value) { this.db.prepare("INSERT INTO cache VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at").run(key, JSON.stringify(value), this.now() + 86400000); }
  usage(data) { this.db.prepare("INSERT INTO usage(purpose,model,input_tokens,output_tokens,cost,estimated,request_id,created_at) VALUES(?,?,?,?,?,?,?,?)").run(data.purpose, data.model, data.inputTokens, data.outputTokens ?? 0, data.cost, data.estimated ? 1 : 0, data.requestId ?? null, this.now()); }
  dashboard() {
    const start = new Date(this.now()); const hk = new Intl.DateTimeFormat("en", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit" }).formatToParts(start); const y = +hk.find((p) => p.type === "year").value, m = +hk.find((p) => p.type === "month").value;
    const month = `${y}-${String(m).padStart(2, "0")}`;
    const since = Date.UTC(y, m - 1, 1) - 8 * 3600000;
    const totals = this.db.prepare("SELECT coalesce(sum(cost),0) AS cost,coalesce(sum(input_tokens),0) AS input_tokens,coalesce(sum(output_tokens),0) AS output_tokens, count(*) AS requests FROM usage WHERE created_at>=?").get(since);
    const dshUsage = this.db.prepare("SELECT provider,model,usage,status FROM extraction_calls WHERE created_at>=?").all(since).reduce((all, row) => {
      const key = `${row.provider}/${row.model}`, u = row.usage ? JSON.parse(row.usage) : {};
      const item = all[key] ??= { provider: row.provider, model: row.model, requests: 0, inputTokens: 0, outputTokens: 0, missingUsage: 0 };
      item.requests++; item.inputTokens += u.inputTokens ?? u.promptTokens ?? 0; item.outputTokens += u.outputTokens ?? u.completionTokens ?? 0; if (!row.usage) item.missingUsage++;
      return all;
    }, {});
    return { month, ...totals, dshUsage: Object.values(dshUsage), counts: this.db.prepare("SELECT status,count(*) AS count FROM memories GROUP BY status").all(), projects: this.db.prepare("SELECT * FROM projects ORDER BY workspace").all(), jobs: this.db.prepare("SELECT id,kind,status,attempts,error,created_at FROM jobs WHERE status<>'done' ORDER BY created_at DESC LIMIT 100").all(), usage: this.db.prepare("SELECT purpose,model,sum(cost) AS cost,sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens,count(*) AS requests,max(estimated) AS estimated FROM usage WHERE created_at>=? GROUP BY purpose,model").all(since), injectionTokens: this.db.prepare("SELECT coalesce(sum(token_bound),0) AS count FROM injections WHERE created_at>=?").get(since).count };
  }
  close() { this.db.close(); }
}
