import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.mjs";
import { hash, normalize } from "../src/domain.mjs";
import { baselineStore, seedProtections, workspace } from "./helpers/protection-perf.mjs";

test("稀疏保护：未命中扫描不构造带字段名的数据库结果对象", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close()); seedProtections(store, 300);
  const prepare = store.db.prepare.bind(store.db), counts = { arrayRows: 0, namedRows: 0 };
  store.db.prepare = sql => {
    const statement = prepare(sql);
    if (!sql.startsWith("SELECT") || !sql.includes("forgotten_facts")) return statement;
    return new Proxy(statement, { get(target, key) {
      if (key === "iterate") return function* (...args) { for (const row of target.iterate(...args)) { counts[Array.isArray(row) ? "arrayRows" : "namedRows"]++; yield row; } };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  };
  const result = store.protections("zebraonly987 otteronly654", [], { project: workspace });
  assert.equal(result.precise.length + result.related.length, 0);
  assert.equal(counts.namedRows, 0); assert.ok(counts.arrayRows > 250);
});

test("稀疏保护：完整行字段、null 原型、顺序和重记授权与紧邻冻结版一致", async t => {
  const Before = await baselineStore("sparse-protection"), before = new Before(":memory:"), after = new MemoryStore(":memory:");
  t.after(() => { before.close(); after.close(); });
  for (const store of [before, after]) {
    seedProtections(store, 160);
    store.source({ id: "new-user", sessionId: "synthetic", projectId: workspace, eventId: "new", role: "user", text: "合成新用户授权。", createdAt: 10 });
    store.protectControl([{ sourceId: "origin-7", start: 0, end: 2 }]);
  }
  let comparisons = 0;
  for (let i = 0; i < 160; i++) {
    const row = after.get(`synthetic-${i}`), content = row.content;
    for (const options of [
      { project: workspace },
      { project: `${workspace}/other`, ranges: [{ sourceId: `origin-${i}`, start: 1, end: 3 }] },
      { project: workspace, attributes: { subject: `MODULE-${i}`, facet: "STORAGE" } },
      { project: workspace, scope: row.scope, operationHash: "synthetic-op", rerecordGrant: { memoryId: row.id, version: row.version, scope: row.scope, project: row.project_id, contentHash: hash(normalize(content)), operationHash: "synthetic-op", sourceIds: ["new-user"] } },
    ]) {
      const ids = i % 3 ? ["new-user"] : [`origin-${i}`], result = after.protections(content, ids, options), expected = before.protections(content, ids, options);
      assert.deepEqual(result, expected); assert.equal(JSON.stringify(result), JSON.stringify(expected));
      for (const item of [...result.precise, ...result.related]) { assert.equal(Object.getPrototypeOf(item), null); assert.deepEqual(Object.keys(item), ["memory_id", "content_hash", "scope", "project_id", "subject", "facet", "ranges", "created_at", "source_watermark", "version", "content"]); }
      assert.equal(after.blocked(content, ids, options), before.blocked(content, ids, options)); comparisons += 2;
    }
  }
  assert.equal(comparisons, 1280);
});

test("稀疏保护：跨调用读取最新正文、目标版本和墓碑，不缓存结果", async t => {
  const Before = await baselineStore("sparse-protection");
  for (const Store of [Before, MemoryStore]) {
    const store = new Store(":memory:"); t.after(() => store.close()); seedProtections(store, 3);
    const old = store.get("synthetic-1"), options = { project: workspace };
    const first = store.protections(old.content, [], options); assert.equal(first.precise[0].version, 2);
    store.db.prepare("UPDATE memories SET version=3 WHERE id=?").run(old.id);
    assert.equal(store.protections(old.content, [], options).precise[0].version, 3);
    const text = "Zebraonly987 uses otteronly654.";
    assert.equal(store.blocked(text, [], options), false);
    store.db.prepare("INSERT INTO tombstones VALUES(?,?,?)").run(hash(normalize(text)), "[]", 10);
    assert.equal(store.blocked(text, [], options), true);
    first.precise[0].version = 100;
    assert.equal(store.protections(old.content, [], options).precise[0].version, 3);
  }
});
