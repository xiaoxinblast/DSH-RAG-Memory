import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { hash, normalize } from "../../src/domain.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const workspace = "d:/synthetic/protection-perf";
export async function baselineStore(name = "protection-perf") {
  const manifest = JSON.parse(readFileSync(resolve(root, `docs/${name}-baseline.json`)));
  const bytes = readFileSync(resolve(root, `tests/fixtures/${name}-baseline.json.gz`));
  assert.equal(hash(bytes), manifest.archiveHash);
  const archive = JSON.parse(gunzipSync(bytes));
  for (const [file, encoded] of Object.entries(archive.files).filter(([f]) => /^(src|dsh)\//.test(f))) {
    const data = Buffer.from(encoded, "base64"), path = resolve(root, `.cache/${name}/baseline`, file);
    assert.equal(hash(data), manifest.fingerprints[file]); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data);
  }
  return (await import(pathToFileURL(resolve(root, `.cache/${name}/baseline/src/store.mjs`)).href)).MemoryStore;
}

// Deterministic synthetic records only. Direct inserts keep fixture creation out of the measured write path.
export function seedProtections(store, count, { dense = false } = {}) {
  const memory = store.db.prepare("INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?,?)"), protection = store.db.prepare("INSERT INTO forgotten_facts VALUES(?,?,?,?,?,?,?,?,?)"), legacy = store.db.prepare("INSERT OR IGNORE INTO tombstones VALUES(?,?,?)");
  store.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `synthetic-${i}`, content = dense ? `合成模块${i}仅在离线模式使用SQLite，在线模式使用PostgreSQL。` : [hash(id), `ＡＰＩ ${i} Ｆｌａｇ：仅离线可用。`, `「引文${i}」与条件并存。`, `计划${i}尚未执行；已确认的日期为周五。`, `alpha/${i} beta-${i} gamma_${i}`, "汉", "中文", `日本語の検証${i}。`][i % 8];
      const scope = i % 11 === 0 ? "global" : "project", project = scope === "global" ? null : i % 13 === 0 ? `${workspace}/other` : workspace;
      const sourceId = `origin-${i}`, ranges = i % 9 === 0 ? [] : [{ sourceId, start: 0, end: content.length }];
      store.source({ id: sourceId, sessionId: "synthetic", projectId: project ?? workspace, eventId: id, role: "user", text: content, createdAt: 1 });
      memory.run(id, scope === "global" ? "preference" : "fact", scope, project, content, hash(normalize(content)), "forgotten", 1, 2, 2, null);
      protection.run(id, hash(normalize(content)), scope, project, i % 5 === 0 ? `module-${i}` : "", i % 5 === 0 ? "storage" : "", JSON.stringify(ranges), 2, count);
      if (!ranges.length) legacy.run(hash(normalize(content)), JSON.stringify([sourceId]), 2);
    }
  });
}

export function observeCollections(store) {
  const prepare = store.db.prepare.bind(store.db), stats = { allCalls: 0, materializedRows: 0, protectionCollections: 0 };
  const protections = store.protections.bind(store);
  store.protections = (...args) => { stats.protectionCollections++; return protections(...args); };
  store.db.prepare = sql => {
    const statement = prepare(sql);
    if (!/^SELECT\b/i.test(sql) || !/forgotten_facts|tombstones/.test(sql)) return statement;
    return new Proxy(statement, { get(target, key) {
      if (key === "all") return (...args) => { const rows = target.all(...args); stats.allCalls++; stats.materializedRows += rows.length; return rows; };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  };
  return stats;
}
