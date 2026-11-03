import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hash, DEFAULTS } from "../src/domain.mjs";
import { PROTOCOL_VERSION } from "../src/extraction.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url))), out = join(root, ".cache/conversation-maintenance/verification");
const read = file => readFileSync(join(root, file));
const baseline = JSON.parse(read("docs/final-v7-baseline.json")), pkg = JSON.parse(read("package.json"));
// Explicit feature changes; all other frozen sources and historical evidence remain checked.
const maintenanceChanges = new Set(["src/extraction.mjs", "src/operations.mjs", "src/policy.mjs", "src/service.mjs", "src/store.mjs", "dsh/index.mjs", "dsh/integration.mjs", "tests/integration.test.mjs"]);
function unchanged() {
  for (const [file, digest] of Object.entries(baseline.preserved)) if (!maintenanceChanges.has(file)) assert.equal(hash(read(file)), digest, `未涉及本次功能的冻结源码或历史证据变化: ${file}`);
}
unchanged(); assert.equal(PROTOCOL_VERSION, 7);
const lock = JSON.parse(read("package-lock.json"));
assert.equal(lock.version, pkg.version); assert.equal(lock.packages[""].version, pkg.version);
assert.ok(read("ui/plugin.jsx").toString().includes(`<b>${pkg.version}</b>`), "侧栏版本须与安装包一致");
assert.ok(read("dsh/index.mjs").toString().includes(`DSH-RAG-Memory ${pkg.version} 已启用`), "启动日志版本须与安装包一致");
assert.equal(DEFAULTS.extractionRoute, null, "发布不能自动改写路由");
mkdirSync(out, { recursive: true });
const networkLog = join(out, "network.jsonl"); writeFileSync(networkLog, "");
const guard = pathToFileURL(join(root, "tests/helpers/offline.mjs")).href;
function run(name, args) {
  const result = spawnSync(process.execPath, ["--import", guard, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, DSH_KERNEL_NETWORK_LOG: networkLog }, maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  writeFileSync(join(out, `${name}.log`), output);
  const value = key => Number(output.match(new RegExp(`^# ${key} (\\d+)`, "m"))?.[1] ?? 0);
  const report = { exitCode: result.status, error: result.error?.message ?? null, tests: value("tests"), pass: value("pass"), fail: value("fail"), skipped: value("skipped"), log: relative(root, join(out, `${name}.log`)).replaceAll("\\", "/") };
  console.log(`${name}: ${JSON.stringify(report)}`); return report;
}
const build = run("build", ["scripts/build.mjs"]), check = run("check", ["scripts/check.mjs"]);
const files = readdirSync(join(root, "tests"), { recursive: true }).filter(f => f.endsWith(".test.mjs")).map(f => join(root, "tests", f));
const current = run("current", ["--test", "--test-reporter=tap", ...files]);
unchanged();
const externalAttempts = readFileSync(networkLog, "utf8").split(/\r?\n/).filter(Boolean).length;
const report = { at: new Date().toISOString(), package: `${pkg.name}@${pkg.version}`, protocol: PROTOCOL_VERSION, selectedModel: baseline.selectedModel, feature: "conversation-maintenance", changedFromFrozenBaseline: [...maintenanceChanges], preservedFiles: Object.keys(baseline.preserved).filter(f => !maintenanceChanges.has(f)).length, build, check, current, externalAttempts, paidCalls: 0, realChatsRead: false, dailyConfigurationReadOrChanged: false, historicalReportsRewritten: false, note: "Conversation maintenance regression; SDK replies are synthetic localhost data, not a new model-quality test. Historical evidence remains unchanged." };
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
assert.equal(build.exitCode, 0); assert.equal(check.exitCode, 0); assert.equal(current.exitCode, 0, "完整回归失败，查看 current.log");
assert.ok(current.tests >= 176); assert.equal(current.pass, current.tests); assert.equal(current.skipped, 0); assert.equal(externalAttempts, 0);
console.log("Conversation maintenance offline regression passed; no paid model calls or daily deployment.");
