import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { measureKernel } from "./verify-kernel-structure.mjs";
import { CONTRACT, PROTOCOL_VERSION, stageContract, OPERATIONS_PROMPT, VERIFICATION_PROMPT } from "../src/extraction.mjs";
import { tokens } from "../src/domain.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), out = join(root, ".cache/units-v7/verified");
mkdirSync(out, { recursive: true });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const read = file => readFileSync(join(root, file));
const baseline = JSON.parse(read("docs/units-v7-baseline.json"));
const bytes = read("tests/fixtures/units-v7-baseline.json.gz"); assert.equal(hash(bytes), baseline.archiveHash);
const archive = JSON.parse(gunzipSync(bytes));
function extract(files, fingerprints, target) {
  for (const [file, encoded] of Object.entries(files)) {
    const path = resolve(target, file), data = Buffer.from(encoded, "base64");
    assert.ok(!relative(target, path).startsWith("..")); assert.equal(hash(data), fingerprints[file]);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data);
  }
}
const beforeRoot = join(out, "baseline"), historyRoot = join(out, "history");
extract(archive.files, baseline.fingerprints, beforeRoot);
const oldManifest = JSON.parse(read("tests/fixtures/kernel-v6-manifest.json"));
const oldBytes = read("tests/fixtures/kernel-v6-baseline.json.gz"), deps = read("tests/fixtures/kernel-v6-history-deps.json.gz");
assert.equal(hash(oldBytes), oldManifest.archiveHash); assert.equal(hash(deps), oldManifest.historyDependenciesHash);
extract({ ...JSON.parse(gunzipSync(oldBytes)).files, ...JSON.parse(gunzipSync(deps)).files }, { ...oldManifest.files, ...oldManifest.historyDependencies }, historyRoot);

const allowed = new Set(["src/extraction.mjs", "src/operations.mjs", "src/policy.mjs", "scripts/verify-kernel.mjs", "scripts/verify-kernel-sdk.mjs", "tests/helpers/kernel.mjs", "tests/kernel-contracts.test.mjs", "tests/kernel-invariants.test.mjs", "tests/kernel-protocol.test.mjs", "tests/kernel-runtime.test.mjs", "tests/kernel-sdk.test.mjs", "tests/kernel-unified.test.mjs"]);
function fingerprints() {
  for (const [file, digest] of Object.entries(baseline.fingerprints)) if (!allowed.has(file)) assert.equal(hash(read(file)), digest, `非本轮范围或冻结历史文件被改写: ${file}`);
  for (const [file, digest] of Object.entries(baseline.evidence)) assert.equal(hash(read(file)), digest, `历史评估证据被改写: ${file}`);
  return { preserved: Object.keys(baseline.fingerprints).length - allowed.size, historicalEvidence: Object.keys(baseline.evidence).length };
}
const preservedBefore = fingerprints(), networkLog = join(out, "network.jsonl"); writeFileSync(networkLog, "");
const guard = pathToFileURL(join(root, "tests/helpers/offline.mjs")).href;
function suite(label, directory, recursive = false) {
  const files = readdirSync(join(directory, "tests"), { recursive }).filter(f => f.endsWith(".test.mjs")).map(f => join(directory, "tests", f));
  // Absolute imports select frozen code; cwd keeps immutable historical journals at their original paths.
  const result = spawnSync(process.execPath, ["--import", guard, "--test", "--test-reporter=tap", ...files], { cwd: root, encoding: "utf8", env: { ...process.env, DSH_KERNEL_NETWORK_LOG: networkLog }, maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
  const output = (result.stdout ?? "") + (result.stderr ?? ""); writeFileSync(join(out, `${label}.tap`), output);
  const count = k => Number(output.match(new RegExp(`^# ${k} (\\d+)`, "m"))?.[1] ?? 0);
  const report = { exitCode: result.status, tests: count("tests"), pass: count("pass"), fail: count("fail"), skipped: count("skipped"), log: relative(root, join(out, `${label}.tap`)).replaceAll("\\", "/") };
  console.log(`${label}: ${JSON.stringify(report)}`); return report;
}
const before = suite("before", beforeRoot, true), current = suite("current", root, true), historical = suite("historical", historyRoot);
const tooling = ["check", "build"].map(name => {
  const result = spawnSync(process.execPath, ["--import", guard, `scripts/${name}.mjs`], { cwd: root, encoding: "utf8", env: { ...process.env, DSH_KERNEL_NETWORK_LOG: networkLog }, timeout: 60000 });
  writeFileSync(join(out, `${name}.log`), (result.stdout ?? "") + (result.stderr ?? "")); console.log(`${name}: exit ${result.status}`); return { name, exitCode: result.status };
});
const structure = measureKernel(root, archive), preservedAfter = fingerprints();
const blocked = readFileSync(networkLog, "utf8").trim().split("\n").filter(Boolean).length;
const previousProtocol = await import(pathToFileURL(join(beforeRoot, "src/extraction.mjs")).href);
const constraints = module => ({ version: module.PROTOCOL_VERSION, fields: Object.fromEntries(Object.entries(module.CONTRACT.fields).map(([k, v]) => [k, v.length])), enums: Object.fromEntries(Object.entries(module.CONTRACT.enums).map(([k, v]) => [k, v.length])), maxItems: module.CONTRACT.maxItems, maxContent: module.CONTRACT.maxContent, maxReason: module.CONTRACT.maxReason, promptConservativeTokens: { extraction: tokens(module.OPERATIONS_PROMPT), review: tokens(module.VERIFICATION_PROMPT) } });
const report = { verifiedAt: new Date().toISOString(), before, current, historical, tooling, structure, constraints: { before: constraints(previousProtocol), after: constraints({ PROTOCOL_VERSION, CONTRACT, OPERATIONS_PROMPT, VERIFICATION_PROMPT }), projections: { extraction: stageContract("extraction"), review: stageContract("verification") } }, preservedBefore, preservedAfter, externalNetworkAttempts: blocked, paidCalls: 0, realChatsRead: false, dailyProfileLoaded: false, uiChanged: false, note: "Frozen historical code remains independent; synthetic grouping/review responses validate host contracts, not model accuracy. Known model partition failure is recorded as a limitation test, not semantic success." };
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
writeFileSync(join(root, "docs/units-v7-verification.json"), JSON.stringify(report, null, 2) + "\n");
assert.equal(before.pass, baseline.tests.pass); assert.equal(before.exitCode, 0);
assert.equal(current.exitCode, 0, "当前测试失败，查看 current.tap"); assert.equal(current.skipped, 0);
assert.equal(historical.exitCode, 0); assert.equal(historical.pass, 180);
assert.equal(blocked, 0); assert.ok(tooling.every(t => t.exitCode === 0));
assert.ok(structure.after.total < structure.before.total, "包含新增辅助模块后的分支数必须下降");
console.log("Offline units v7 verification passed; no paid model request.");
