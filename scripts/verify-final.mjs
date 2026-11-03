import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hash, DEFAULTS } from "../src/domain.mjs";
import { PROTOCOL_VERSION } from "../src/extraction.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url))), out = join(root, ".cache/final-v7/verification");
const read = file => readFileSync(join(root, file));
const baseline = JSON.parse(read("docs/final-v7-baseline.json")), pkg = JSON.parse(read("package.json"));
function unchanged() {
  for (const [file, digest] of Object.entries(baseline.preserved)) assert.equal(hash(read(file)), digest, `冻结内核或历史证据变化: ${file}`);
}
unchanged(); assert.equal(PROTOCOL_VERSION, 7); assert.equal(pkg.version, baseline.packageVersion);
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
const report = { at: new Date().toISOString(), package: `${pkg.name}@${pkg.version}`, protocol: PROTOCOL_VERSION, selectedModel: baseline.selectedModel, runtimeFrozen: Object.keys(baseline.runtime).length, preservedFiles: Object.keys(baseline.preserved).length, build, check, current, externalAttempts, paidCalls: 0, realChatsRead: false, dailyConfigurationReadOrChanged: false, historicalReportsRewritten: false, note: "Final release regression; SDK replies are synthetic localhost data, not a new model-quality test. Experimental acceptance failures remain archived outside this suite." };
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
assert.equal(build.exitCode, 0); assert.equal(check.exitCode, 0); assert.equal(current.exitCode, 0, "完整回归失败，查看 current.log");
assert.equal(current.tests, 176); assert.equal(current.pass, current.tests); assert.equal(current.skipped, 0); assert.equal(externalAttempts, 0);
console.log("Final v7 offline regression passed; no paid model calls or daily deployment.");
