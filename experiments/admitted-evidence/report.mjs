import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { hash } from "../../src/domain.mjs";

const out = ".cache/admitted-evidence", read = f => readFileSync(f, "utf8"), json = f => JSON.parse(read(f));
const baseline = json(`${out}/baseline.json`);
for (const [file, digest] of Object.entries(baseline.files)) assert.equal(hash(readFileSync(file)), digest, file);
const module = { exports: {} }; new Function("exports", "module", process.binding("natives")["internal/deps/acorn/acorn/dist/acorn"])(module.exports, module);
function branches(node) {
  if (!node || typeof node !== "object") return 0;
  const own = ["IfStatement", "ConditionalExpression", "LogicalExpression", "CatchClause", "ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"].includes(node.type) || node.type === "SwitchCase" && node.test ? 1 : 0;
  return own + Object.values(node).reduce((n, v) => n + (Array.isArray(v) ? v.reduce((s, x) => s + branches(x), 0) : branches(v)), 0);
}
const count = f => branches(module.exports.parse(read(f), { ecmaVersion: "latest", sourceType: "module" }));
const oldAst = module.exports.parse(read("experiments/evidence-routes/source-route.mjs"), { ecmaVersion: "latest", sourceType: "module" });
let removedIndexBlock = 0;
function indexBranches(node) {
  if (!node || typeof node !== "object") return;
  if (node.type === "IfStatement" && node.test.type === "MemberExpression" && node.test.property.name === "indexed") removedIndexBlock += branches(node);
  for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(indexBranches); else indexBranches(value);
}
indexBranches(oldAst);
const production = Object.keys(baseline.files).filter(f => /^(src|dsh)\/.*\.mjs$/.test(f));
const experiments = readdirSync("experiments/admitted-evidence").filter(f => f.endsWith(".mjs")).map(f => `experiments/admitted-evidence/${f}`);
function suite(name) {
  const text = read(`${out}/${name}.tap`), value = key => Number(text.match(new RegExp(`^# ${key} (\\d+)`, "m"))?.[1] ?? 0);
  assert.ok(value("tests") > 0, name);
  return { tests: value("tests"), pass: value("pass"), fail: value("fail"), skipped: value("skipped"), failures: [...text.matchAll(/^not ok \d+ - (.+)$/gm)].map(m => m[1]) };
}
const tests = Object.fromEntries(["original-red", "contracts-red", "contracts", "acceptance", "production", "sdk-loopback"].map(name => [name, suite(name)]));
assert.equal(tests.contracts.fail, 0); assert.equal(tests["sdk-loopback"].fail, 0);
assert.ok(tests.production.fail === 0 || tests.production.fail === 5 && tests.production.failures.every(s => s.includes("SDK")));
assert.equal(tests.acceptance.fail, 4); // Product blockers remain real failed tests, not expected-failure assertions.
assert.equal(read(`${out}/check.log`), "");
const networkAttempts = ["network.jsonl", "network-sdk.jsonl"].reduce((n, name) => n + (existsSync(`${out}/${name}`) ? read(`${out}/${name}`).split(/\r?\n/).filter(Boolean).length : 0), 0);
assert.equal(networkAttempts, 0);
const replay = json(`${out}/replay.json`).report, previous = json("docs/evidence-route-comparison.json");
const report = {
  at: new Date().toISOString(), readyForDailyReplacement: false, frozenFiles: Object.keys(baseline.files).length,
  frozenUnchanged: true, productionProtocol: 7, paidModelCalls: 0, networkAttempts, dailyProfileRead: false,
  commitOrPush: false, uiOrBuildChanged: false, tests, productionTestsCombinedPassed: tests.production.pass + (tests.production.fail ? tests["sdk-loopback"].pass : 0),
  replay, previousCategories: { v7: previous.byRoute.v7.categories, source: previous.byRoute.source.categories },
  complexity: { definition: previous.complexity.definition, productionBefore: previous.complexity.productionTotal, productionAfter: production.reduce((n, f) => n + count(f), 0), oldRuntime: count("experiments/evidence-routes/source-route.mjs"), removedIndexBlock, oldWithoutIndexBlock: branches(oldAst) - removedIndexBlock, newRuntime: count("experiments/admitted-evidence/route.mjs"), allNewModules: Object.fromEntries(experiments.map(f => [f, count(f)])), runtimeDependencies: ["MemoryStore read/visibility/mask/protections/blockedBy", "resolveEvidence", "operationFingerprint", "hash/lexicalScore/tokens/projectId"], note: "Runtime comparison excludes unchanged shared guards on both sides. Old experiment retained as frozen evidence. Subtracting the hint-generation block gives 30 vs new 32, not a branch reduction. Other inert index-score expressions are not removed from that 30. Capabilities differ; no equivalent full-product simplification claim." },
  performance: json(`${out}/performance.json`), firstPerformance: json(`${out}/performance-first.json`),
  blockers: ["Unadmitted B is not auto-admitted", "Unknown cross-language identity remains vulnerable to incorrect v7 approval", "Incorrectly complete v7 references still omit conditions", "Incorrect v7 approval of do-not-save is not repaired by the reader", "Full corpus reads remain too costly; automatic provenance generation and durable integration are not implemented"],
  interpretation: "Mechanisms use synthetic semantic decisions or unchanged historical model responses. Literal probes and reference checks do not measure model accuracy. Historical seeds/manual receipts without complete v7 grants are withheld, not migrated or deleted. No physical erasure claim.",
};
assert.equal(report.complexity.productionBefore, report.complexity.productionAfter);
writeFileSync("docs/admitted-evidence-results.json", JSON.stringify(report, null, 2));
const evidence = [...experiments, ...readdirSync(out).map(f => `${out}/${f}`), "docs/admitted-evidence-results.json", "docs/admitted-evidence-results.md"];
writeFileSync("docs/admitted-evidence-evidence.json", JSON.stringify({ at: report.at, frozen: baseline.files, files: Object.fromEntries(evidence.map(f => [f, hash(readFileSync(f))])) }, null, 2));
console.log(JSON.stringify({ ready: false, contracts: tests.contracts, productAcceptance: tests.acceptance, productionPassed: report.productionTestsCombinedPassed, complexity: report.complexity, frozenFiles: report.frozenFiles }));
