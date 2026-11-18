import test from "node:test";
import assert from "node:assert/strict";
import { selectRelease, releaseVersion, inRange, completedAttempt, semver } from "../scripts/ci/contracts.mjs";

const release = (version, extra = {}) => ({ tag_name: `dsh-v${version}`, draft: false, published_at: "2026-11-18", ...extra });
test("List releases 选择 RC/正式版的最高 SemVer，忽略草稿、其他产品和无效标签", () => {
  const rows = [release("0.2.2-rc.3"), release("0.2.2-rc.4"), release("0.2.1"), release("0.2.3", { draft: true }), release("0.2.9", { tag_name: "other-v0.2.9" })];
  assert.equal(selectRelease(rows).version, "0.2.2-rc.4");
  assert.equal(selectRelease([...rows, release("0.2.2")]).version, "0.2.2");
  assert.equal(selectRelease(rows, "dsh-v0.2.2-rc.3").version, "0.2.2-rc.3");
  assert.equal(releaseVersion(release("garbage")), null);
  assert.throws(() => selectRelease(rows, "latest"));
  assert.throws(() => selectRelease(rows, "0.2.8"));
});
test("范围含已测 RC 与同补丁正式版，下一补丁的最早预发布也被排除", () => {
  const range = ">=0.2.2-rc.2 <0.2.3-0";
  for (const version of ["0.2.2-rc.2", "0.2.2-rc.3", "0.2.2-rc.99", "0.2.2"]) {
    assert.ok(inRange(version, range));
    assert.ok(semver.satisfies(version, range), "普通 npm peer 语义也必须接受，无须 includePrerelease 绕过");
  }
  for (const version of ["0.2.2-rc.1", "0.2.3-0", "0.2.3-rc.1", "0.2.3", "0.3.0", "not-a-version"]) assert.equal(inRange(version, range), false);
});
test("上游版本＋插件 SHA 对应的完成记录包含失败，不把跳过或运行中的任务当作测试", () => {
  for (const conclusion of ["success", "failure", "cancelled"]) assert.ok(completedAttempt([{ name: "Windows smoke (0.2.2-rc.3)", status: "completed", conclusion }], "0.2.2-rc.3"));
  assert.equal(completedAttempt([{ name: "Windows smoke (0.2.2-rc.3)", status: "completed", conclusion: "skipped" }], "0.2.2-rc.3"), undefined);
  assert.equal(completedAttempt([{ name: "Windows smoke (0.2.2-rc.3)", status: "in_progress" }], "0.2.2-rc.3"), undefined);
  assert.equal(completedAttempt([{ name: "Windows smoke (0.2.2-rc.2)", status: "completed", conclusion: "success" }], "0.2.2-rc.3"), undefined);
});
