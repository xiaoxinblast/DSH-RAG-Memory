import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Development-only parser already bundled with Node. No production package/dependency is added.
const module = { exports: {} }; new Function("exports", "module", process.binding("natives")["internal/deps/acorn/acorn/dist/acorn"])(module.exports, module);
const parse = source => module.exports.parse(source, { ecmaVersion: "latest", sourceType: "module" });
function walk(node, visit) { if (!node || typeof node !== "object") return; if (Array.isArray(node)) { for (const item of node) walk(item, visit); return; } visit(node); for (const value of Object.values(node)) if (value && typeof value === "object") walk(value, visit); }
function count(source) {
  const counts = { IfStatement: 0, ConditionalExpression: 0, LogicalExpression: 0, SwitchCase: 0, CatchClause: 0, loops: 0 };
  walk(parse(source), n => { if (n.type === "SwitchCase") counts.SwitchCase += n.test ? 1 : 0; else if (n.type in counts) counts[n.type]++; else if (["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"].includes(n.type)) counts.loops++; });
  return { ...counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
}
function graph(files) {
  return Object.fromEntries(Object.entries(files).map(([file, source]) => [file, parse(source).body.filter(n => n.type === "ImportDeclaration").map(n => n.source.value)]));
}
export function measureKernel(root, archive) {
  const before = Object.fromEntries(Object.entries(archive.files).filter(([f]) => /^(src|dsh)\/.*\.mjs$/.test(f)).map(([f, bytes]) => [f, Buffer.from(bytes, "base64").toString()]));
  const after = {}; function collect(dir) { for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) { const file = `${dir}/${entry.name}`; if (entry.isDirectory()) collect(file); else if (file.endsWith(".mjs")) after[file] = readFileSync(join(root, file), "utf8"); } } collect("src"); collect("dsh");
  const measure = files => { const perFile = Object.fromEntries(Object.entries(files).map(([f, s]) => [f, count(s)])); return { files: Object.keys(files).length, total: Object.values(perFile).reduce((n, v) => n + v.total, 0), perFile, imports: graph(files) }; };
  assert.ok(!("src/content-policy.mjs" in after));
  for (const name of ["candidateOnly", "uncertainPlan", "contentPolicy", "inferIntent", "verifyOperations", "parseExtraction", "extractionInput"]) assert.ok(!Object.values(after).some(s => new RegExp(`\\b${name}\\b`).test(s)), `旧生产语义/协议入口仍存在: ${name}`);
  const policy = parse(after["src/policy.mjs"]); walk(policy, n => { assert.ok(!(n.type === "CallExpression" && n.callee?.type === "MemberExpression" && ["db", "fetch", "request"].includes(n.callee.object?.name)), "裁决器不得 I/O"); });
  const callers = Object.entries(after).flatMap(([file, source]) => { const found = []; walk(parse(source), n => { if (n.type === "CallExpression" && n.callee?.name === "decideOperation") found.push(file); }); return found; }); assert.deepEqual(callers, ["src/operations.mjs"]);
  const transports = files => Object.values(files).reduce((count, source) => { walk(parse(source), n => { if (n.type === "CallExpression" && n.callee?.property?.name === "prepareCall") count++; }); return count; }, 0);
  assert.equal(transports(after), 1);
  for (const file of ["src/extraction.mjs", "src/policy.mjs", "src/evidence.mjs", "src/operations.mjs"]) walk(parse(after[file]), n => { if (n.regex) assert.ok(!/记住|尚未|因果|导致|完成|计划|候选/.test(n.regex.pattern), "不得搬迁语义句式正则"); });
  walk(parse(after["src/operations.mjs"]), n => { assert.ok(!(n.type === "AssignmentExpression" && n.left?.property?.name === "outcome"), "执行层不得修改最终状态"); });
  const beforeStats = measure(before), afterStats = measure(after);
  return { boundary: "all recursive src/**/*.mjs and dsh/**/*.mjs, including new helpers", definition: "IfStatement + ConditionalExpression + LogicalExpression (including ??) + non-default SwitchCase + CatchClause + loop nodes; identical AST parser before/after", before: beforeStats, after: afterStats, decrease: beforeStats.total - afterStats.total, decisionCallers: callers, productionProtocols: 1, transportImplementations: { before: transports(before), after: transports(after) } };
}
