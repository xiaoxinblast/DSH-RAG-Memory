export const SCHEMA_VERSION = 3;

export function migrate(db) {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version > SCHEMA_VERSION) throw new Error("记忆数据库来自更新版本，请使用匹配插件或恢复升级前备份");
  if (version === SCHEMA_VERSION) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const add = (table, name, type) => { if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`); };
    for (const [name, type] of Object.entries({ event_root: "TEXT", part_index: "INTEGER", part_count: "INTEGER", original_chars: "INTEGER", retained_chars: "INTEGER", truncated: "INTEGER NOT NULL DEFAULT 0", span_start: "INTEGER", span_end: "INTEGER" })) add("sources", name, type);
    add("jobs", "lease_token", "TEXT");
    db.exec(`
      CREATE TABLE memory_attributes(memory_id TEXT PRIMARY KEY REFERENCES memories(id), subject TEXT NOT NULL DEFAULT '', facet TEXT NOT NULL DEFAULT '', valid_from INTEGER, valid_until INTEGER, core INTEGER NOT NULL DEFAULT 0, legacy INTEGER NOT NULL DEFAULT 0, confirmed_at INTEGER);
      INSERT INTO memory_attributes(memory_id,legacy) SELECT id,1 FROM memories;
      CREATE INDEX attributes_subject ON memory_attributes(subject,facet);
      CREATE TABLE evidence_ranges(memory_id TEXT NOT NULL REFERENCES memories(id), source_id TEXT NOT NULL REFERENCES sources(id), start INTEGER NOT NULL, end INTEGER NOT NULL, PRIMARY KEY(memory_id,source_id,start,end));
      CREATE TABLE forgotten_facts(memory_id TEXT PRIMARY KEY REFERENCES memories(id), content_hash TEXT NOT NULL, scope TEXT NOT NULL, project_id TEXT, subject TEXT NOT NULL, facet TEXT NOT NULL, ranges TEXT NOT NULL, created_at INTEGER NOT NULL, source_watermark INTEGER NOT NULL);
      CREATE INDEX forgotten_subject ON forgotten_facts(scope,project_id,subject,facet);
      CREATE TABLE memory_operations(id TEXT PRIMARY KEY, operation_key TEXT UNIQUE NOT NULL, job_id TEXT, memory_id TEXT REFERENCES memories(id), action TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT NOT NULL, evidence TEXT NOT NULL, before_state TEXT, after_state TEXT, details TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX operation_memory ON memory_operations(memory_id,created_at);
      CREATE TABLE job_stages(job_id TEXT NOT NULL REFERENCES jobs(id), phase TEXT NOT NULL, input_hash TEXT NOT NULL, state TEXT NOT NULL, response TEXT, error TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(job_id,phase));
      DELETE FROM recalls;
      INSERT INTO meta(key,value) VALUES('memoryEpoch','1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(meta.value AS INTEGER)+1 AS TEXT);
      PRAGMA user_version=3;
    `);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
