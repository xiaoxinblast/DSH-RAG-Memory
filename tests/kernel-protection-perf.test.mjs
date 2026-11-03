import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.mjs";
import { hash, normalize } from "../src/domain.mjs";
import { fixture, operation, model, draft, work } from "./helpers/kernel.mjs";
import { baselineStore, seedProtections, observeCollections, workspace } from "./helpers/protection-perf.mjs";

test("等价优化：一次新增只收集两次保护数据，包含提交时的新检查", async t => {
  const service = fixture(t), stats = observeCollections(service.store);
  model(service, p => draft([operation(p)])); await work(service);
  assert.equal(service.store.list().length, 1);
  assert.equal(stats.protectionCollections, 2);
});

test("等价优化：扫描不把整批墓碑与遗忘记录载入 JS 数组", t => {
  const store = new MemoryStore(":memory:"); t.after(() => store.close()); seedProtections(store, 200);
  const stats = observeCollections(store), source = store.getSource("origin-1");
  store.maskSource(source); store.protections("全新独立事实。", [], { project: workspace });
  store.protectedCandidates([{ id: "new", role: "user", text: "全新独立事实。" }], workspace);
  assert.equal(stats.allCalls, 0);
});

test("等价优化：保护分类、作用域、遮蔽、候选顺序和引用与冻结版逐项一致", async t => {
  const Before = await baselineStore(), before = new Before(":memory:"), after = new MemoryStore(":memory:");
  t.after(() => { before.close(); after.close(); });
  for (const store of [before, after]) { seedProtections(store, 120); store.protectControl([{ sourceId: "origin-1", start: 2, end: 7 }]); }
  let comparisons = 0;
  for (let i = 0; i < 120; i++) {
    const source = after.getSource(`origin-${i}`), row = after.get(`synthetic-${i}`);
    assert.deepEqual(after.maskSource(source), before.maskSource(source)); comparisons++;
    for (const text of [row.content, `继续保持遗忘 ${row.id}。`, `其他主题；${row.content.normalize("NFKC")}。`, "全新英文 zebra-otter" ]) {
      const ids = i % 3 ? [source.id] : [], options = { project: i % 7 ? workspace : `${workspace}/other`, scope: row.scope, attributes: { subject: `MODULE-${i}`, facet: "STORAGE" }, ranges: i % 2 ? [{ sourceId: source.id, start: 1, end: 3 }] : [] };
      assert.deepEqual(after.protections(text, ids, options), before.protections(text, ids, options));
      assert.equal(after.blocked(text, ids, options), before.blocked(text, ids, options)); comparisons += 2;
    }
    const sources = [{ id: "new-first", role: "user", text: `其他 ${row.content.slice(0, 12)}。` }, { id: "new-second", role: "user", text: `${row.id}。${row.content}。` }, { id: "context", role: "user", text: "中文。ＡＰＩ。", contextOnly: true }];
    for (const project of [workspace, `${workspace}/other`]) { assert.deepEqual(after.protectedCandidates(sources, project), before.protectedCandidates(sources, project)); comparisons++; }
  }
  assert.equal(comparisons, 1320);
});

test("等价优化：合法重记及过期、跨范围、控制来源许可与冻结版一致", async t => {
  const Before = await baselineStore(), before = new Before(":memory:"), after = new MemoryStore(":memory:"); t.after(() => { before.close(); after.close(); });
  for (const store of [before, after]) { seedProtections(store, 3); store.source({ id: "new-user", sessionId: "synthetic", eventId: "new", projectId: workspace, role: "user", text: "明确重新记住该事实。", createdAt: 10 }); }
  const row = after.get("synthetic-1"), grant = { memoryId: row.id, version: row.version, scope: row.scope, project: row.project_id, contentHash: hash(normalize(row.content)), operationHash: "synthetic-op", sourceIds: ["new-user"] };
  for (const patch of [{}, { version: 1 }, { sourceIds: ["origin-1"] }, { sourceIds: [] }, { operationHash: "different" }, { scope: "global" }, { project: `${workspace}/other` }, { contentHash: "wrong" }, { memoryId: "synthetic-2" }]) {
    const options = { scope: row.scope, project: workspace, operationHash: "synthetic-op", rerecordGrant: { ...grant, ...patch } };
    assert.equal(after.blocked(row.content, ["new-user"], options), before.blocked(row.content, ["new-user"], options));
  }
  assert.equal(after.blocked(row.content, ["new-user"], { scope: row.scope, project: workspace, operationHash: "synthetic-op", rerecordGrant: grant }), false);
  for (const store of [before, after]) store.protectControl([{ sourceId: "new-user", start: 0, end: 2 }]);
  assert.equal(after.blocked(row.content, ["new-user"], { scope: row.scope, project: workspace, operationHash: "synthetic-op", rerecordGrant: grant }), true);
});

test("等价优化：候选来源对象相互独立，复用特征不能引入可变引用共享", async t => {
  const Before = await baselineStore();
  for (const Store of [Before, MemoryStore]) {
    const store = new Store(":memory:"); t.after(() => store.close()); seedProtections(store, 3, { dense: true });
    const text = "合成模块仅在离线模式使用SQLite，在线模式使用PostgreSQL。", candidates = store.protectedCandidates([{ id: "shared", role: "user", text, boundaries: [0, text.length] }], workspace);
    assert.equal(candidates.length, 3);
    candidates[0].evidence[0].sourceId = "changed";
    assert.equal(candidates[1].evidence[0].sourceId, "shared");
  }
});

test("等价优化：裁决后新增墓碑仍在保存前拦截，不复用过期保护快照", async t => {
  const service = fixture(t), store = service.store, save = store.save.bind(store);
  model(service, p => draft([operation(p)]));
  store.save = (input, options) => {
    store.db.prepare("INSERT INTO tombstones VALUES(?,?,?)").run(hash(normalize(input.content)), "[]", store.now());
    return save(input, options);
  };
  await work(service);
  assert.equal(store.list({ status: "all" }).length, 0);
  assert.equal(store.getSource("s0").processed, 0);
  assert.equal(store.operations().length, 0);
});
