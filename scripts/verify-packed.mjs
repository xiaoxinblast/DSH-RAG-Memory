import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { readPluginMeta } from "@deepseek-ai/dsh-app-boot";
import { hash } from "../src/domain.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, ".cache/final-v7/pack.json"), "utf8"))[0];
assert.equal(manifest.filename, "dsh-rag-memory-0.1.4.tgz");
const archivePath = join(root, "artifacts/final-v7", manifest.filename), bytes = readFileSync(archivePath), tar = gunzipSync(bytes);
const destination = join(root, ".cache/final-v7/unpacked"), entries = [];
const field = (block, start, size) => block.subarray(start, start + size).toString("utf8").split("\0")[0];
// This release uses ordinary regular-file npm tar entries. Refuse links and extended
// entries rather than extracting unreviewed paths or falling back to another unpacker.
for (let offset = 0; offset + 512 <= tar.length;) {
  const header = tar.subarray(offset, offset + 512); if (header.every(b => b === 0)) break;
  const prefix = field(header, 345, 155), name = (prefix ? prefix + "/" : "") + field(header, 0, 100);
  const size = parseInt(field(header, 124, 12).trim(), 8), type = field(header, 156, 1);
  const checksum = [...header].reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0);
  assert.equal(checksum, parseInt(field(header, 148, 8).trim(), 8));
  assert.ok(["", "0"].includes(type), `拒绝非普通文件: ${name}`);
  assert.ok(name.startsWith("package/") && !name.includes("\\") && !name.split("/").includes(".."));
  assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length);
  const path = resolve(destination, name), child = relative(destination, path);
  assert.ok(!isAbsolute(child) && !child.startsWith(".."));
  entries.push({ name: name.slice(8), path, data: tar.subarray(offset + 512, offset + 512 + size) });
  offset += 512 + Math.ceil(size / 512) * 512;
}
assert.equal(new Set(entries.map(e => e.name)).size, entries.length);
assert.deepEqual(entries.map(e => e.name).sort(), manifest.files.map(f => f.path).sort());
const allowed = /^(?:src\/[^/]+\.mjs|dsh\/[^/]+\.mjs|dist\/client\.js|locale\/(?:en|zh)\.json|docs\/release-v7\.md|(?:README|CHANGELOG)\.md|LICENSE|icon\.svg|cordis\.patch\.yml|package\.json)$/;
for (const entry of entries) {
  assert.match(entry.name, allowed, `发布包包含非白名单文件: ${entry.name}`);
  assert.equal(hash(entry.data), hash(readFileSync(join(root, entry.name))), entry.name);
}
for (const entry of entries) { mkdirSync(dirname(entry.path), { recursive: true }); writeFileSync(entry.path, entry.data); }
const packageRoot = join(destination, "package"), pkg = JSON.parse(readFileSync(join(packageRoot, "package.json")));
assert.equal(pkg.version, "0.1.4"); assert.equal(pkg.name, "dsh-rag-memory");
const metadata = readPluginMeta(pkg.name, pathToFileURL(join(packageRoot, "package.json")).href);
assert.equal(metadata.error, undefined); assert.equal(metadata.title.zh, "DSH-RAG-Memory");
const entrypoint = await import(pathToFileURL(join(packageRoot, "dsh/index.mjs")));
assert.equal(typeof entrypoint.apply, "function");
let browserModule;
runInNewContext(readFileSync(join(packageRoot, "dist/client.js"), "utf8"), { window: { __ModuleLoader__: { load: m => { browserModule = m; } } } });
assert.equal(browserModule.id, pkg.name); assert.equal(typeof browserModule.factory, "function");
const { PROTOCOL_VERSION } = await import(pathToFileURL(join(packageRoot, "src/extraction.mjs")));
const { MemoryService } = await import(pathToFileURL(join(packageRoot, "src/service.mjs")));
assert.equal(PROTOCOL_VERSION, 7);
const service = new MemoryService({ filename: ":memory:", client: { ready: async () => false } }), phases = [];
try {
  assert.equal(service.store.settings().extractionRoute, null);
  const route = { provider: "deepseek-account", model: "deepseek-flash" }, workspace = "d:/synthetic/packed-v7", content = "项目导出格式使用 NDJSON。";
  service.store.configure({ extractionRoute: route });
  service.store.source({ id: "pack-source", sessionId: "pack-test", eventId: "one", projectId: workspace, role: "user", text: content, turnId: "turn" });
  service.extractor = { request: async (phase, raw, _signal, meta) => {
    phases.push(phase); assert.deepEqual(meta.route, route);
    const input = JSON.parse(raw), evidence = [{ sourceId: "pack-source", anchorId: "p1" }];
    const response = phase === "extraction"
      ? { version: 7, operations: [{ action: "add", intent: "statement", content, kind: "fact", scope: "project", targetId: null, targetVersion: null, certainty: "confirmed", authorization: "ordinary", eventState: "not_applicable", unit: "self_contained", restores: null, evidence, authorizationEvidence: [], attributes: {} }] }
      : { version: 7, units: input.items.map(o => ({ members: [o.id], decision: "approve", reason: "合成打包验收", evidence: o.evidence, authorizationEvidence: o.authorizationEvidence, restores: o.restores, unit: o.unit, certainty: o.certainty, authorization: o.authorization, eventState: o.eventState })) };
    return { text: JSON.stringify(response), finish: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
  } };
  service.schedule("pack-test"); await service.work("extract");
  assert.deepEqual(phases, ["extraction", "verification"]);
  const rows = service.store.eligible(workspace); assert.equal(rows.length, 1); assert.equal(rows[0].content, content);
  assert.equal(service.store.operations()[0].details.protocolVersion, 7);
  service.store.forget(rows[0].id, { expectedVersion: rows[0].version });
  assert.equal((await service.search("NDJSON", workspace, { cloud: false })).length, 0);
} finally { await service.close(); }
const report = { at: new Date().toISOString(), package: `${pkg.name}@${pkg.version}`, archive: relative(root, archivePath).replaceAll("\\", "/"), sha256: hash(bytes), bytes: bytes.length, entries: entries.length, files: Object.fromEntries(entries.map(e => [e.name, hash(e.data)])), packageBytesMatchWorkspace: true, metadataValid: true, serverAndBrowserEntryValid: true, protocol: PROTOCOL_VERSION, syntheticPhases: phases, syntheticWriteAndForgetPassed: true, realModelCalls: 0, dailyProfileReadOrChanged: false, note: "Package extracted inside workspace after path/type/allowlist verification. Provider ID is a synthetic test setting, not a change to a real profile." };
writeFileSync(join(root, "artifacts/final-v7/package-verification.json"), JSON.stringify(report, null, 2));
writeFileSync(join(root, "artifacts/final-v7/SHA256SUMS.txt"), `${report.sha256}  ${manifest.filename}\n`);
console.log(JSON.stringify({ package: report.package, bytes: report.bytes, entries: report.entries, sha256: report.sha256, syntheticWriteAndForgetPassed: true }));
