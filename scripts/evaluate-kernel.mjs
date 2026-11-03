import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, existsSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { BlockAssembler } from "@deepseek-ai/dsh-llm";
import { createDshExtractor } from "../dsh/extractor.mjs";
import { OUTPUT, hash, prepare, verifyPlan, seed, CANDIDATES } from "./kernel-evaluation.mjs";
import { Budget, reserveCost, budgetCost, journalState } from "./kernel-evaluation-budget.mjs";
import { parseOperations, parseReview } from "../src/extraction.mjs";

function append(file, item) { const fd = openSync(file, "a"); try { writeSync(fd, JSON.stringify(item) + "\n"); fsyncSync(fd); } finally { closeSync(fd); } }
const safeFailure = (e) => ({ code: /^[A-Z0-9_-]+$/.test(e?.code) ? e.code : e?.name ?? "Error", status: e?.failure?.status ?? null });
export function checkWire(body, candidate, endpoint) {
  const wire = { model: body.model, temperature: body.temperature, maxTokens: body.max_tokens ?? body.max_completion_tokens, messageCount: body.messages?.length, hasTools: !!body.tools?.length, thinking: body.enable_thinking === false || body.thinking?.type === "disabled" ? "off" : "unknown", responseFormat: body.response_format ?? null, bodyHash: hash(body), endpoint };
  if (wire.model !== candidate.model || wire.maxTokens !== 2048 || wire.temperature !== 0 || wire.hasTools || wire.responseFormat || wire.thinking !== "off" || wire.messageCount !== (candidate.provider === "deepseek-account" ? 1 : 2)) throw new Error("实际请求与冻结参数不一致，拒绝发送");
  return wire;
}
async function loadSecrets() {
  const { parseCredentialsDocument } = await import("@deepseek-ai/dsh-credentials-local");
  const home = process.env.USERPROFILE + "/.dsh", credentialFile = `${home}/.credentials.yaml`, raw = readFileSync(credentialFile, "utf8");
  const credentials = parseCredentialsDocument(raw, credentialFile), db = new DatabaseSync(`${home}/storages/dsh-memory/memory.sqlite`, { readOnly: true });
  let settings;
  try { settings = JSON.parse(db.prepare("SELECT value FROM meta WHERE key='settings'").get().value); } finally { db.close(); }
  if (settings.extractionRoute?.provider !== "deepseek-account" || settings.extractionRoute?.model !== "deepseek-flash") throw new Error("日用模型基线变化，停止评估");
  const grant = credentials.records.get("deepseek-account-platform/default")?.payload, qwenKey = credentials.refs.get(settings.credentialRef);
  if (grant?.issuer !== "https://platform.deepseek.com" || !grant.token || typeof qwenKey !== "string" || !qwenKey || !/^ws-[a-z0-9]+$/.test(settings.workspaceId)) throw new Error("现有凭据不齐备");
  return { workspaceId: settings.workspaceId, qwenKey, accountToken: grant.token, fingerprints: { credentials: hash(raw), settings: hash(settings), profile: hash(readFileSync(`${home}/profiles/desktop/cordis.patch.yml`, "utf8")) } };
}
async function createRunner(secrets, runDir, journal, plan, budget, stopState) {
  const [{ Context }, { LlmRuntime }, { PiAiAdapter }, deepseek] = await Promise.all([import("@deepseek-ai/cordis"), import("@deepseek-ai/dsh-llm"), import("@deepseek-ai/dsh-llm-pi-ai"), import("@deepseek-ai/dsh-llm-deepseek")]);
  const originalFetch = globalThis.fetch, active = new AsyncLocalStorage(), ctx = new Context();
  const endpoint = `https://${secrets.workspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`;
  const allowed = new Set([`${endpoint}/chat/completions`, "https://api.deepseek.com/anthropic/v1/messages"]);
  const scrub = (value) => JSON.parse(JSON.stringify(value).replaceAll(secrets.qwenKey, "[redacted]").replaceAll(secrets.accountToken, "[redacted]"));
  globalThis.fetch = async (input, init) => {
    const state = active.getStore(), phase = state?.phase;
    if (!state || !phase) throw new Error("拒绝未归属任务的网络请求");
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (!allowed.has(url) || (state.candidate.provider === "deepseek-account") !== url.includes("api.deepseek.com")) throw new Error("网络目标不在冻结路由中");
    if (++phase.attempts !== 1) throw new Error("禁止重试和回退");
    const body = JSON.parse(init?.body ?? await input.clone().text());
    phase.wire = checkWire(body, state.candidate, url.includes("aliyuncs.com") ? "beijing-workspace" : "deepseek-account-official");
    const reserve = reserveCost(body, state.candidate);
    if (stopState.stop || !budget.reserve(reserve)) { stopState.stop = true; throw new Error("累计预算护栏停止发送"); }
    phase.reservedCny = reserve; phase.sent = true;
    append(journal, { event: "phase-start", planId: plan.id, key: `${state.task.id}:${phase.name}`, reservedCny: reserve, at: new Date().toISOString(), wire: phase.wire });
    const response = await originalFetch(input, { ...init, redirect: "error" });
    phase.httpStatus = response.status; phase.requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id");
    if ([401,403,404].includes(response.status)) stopState.stop = true;
    if (!response.ok) phase.providerError = scrub((await response.clone().text()).slice(0, 1000));
    return response;
  };
  try {
    new LlmRuntime(ctx);
    ctx.on("llm/stream", async function* (_options, next) { for await (const chunk of next()) { active.getStore().phase.assembler.push(chunk); yield chunk; } });
    const adapterFile = realpathSync(fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-llm-pi-ai")));
    const { openAICompletionsApi } = await import(pathToFileURL(join(dirname(adapterFile), "../../../@earendil-works/pi-ai/dist/api/openai-completions.lazy.js")).href), api = openAICompletionsApi();
    const provider = "evaluation-qwen-beijing", models = CANDIDATES.filter((c) => c.id.startsWith("qwen-")).map((c) => ({ id: c.model, name: c.model, api: "openai-completions", provider, baseUrl: endpoint, reasoning: true, input: ["text"], contextWindow: c.inputLimit, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { thinkingFormat: "qwen", supportsDeveloperRole: false } }));
    const piProvider = { id: provider, name: provider, auth: { apiKey: { name: "existing-memory-ref", resolve: async ({ credential }) => ({ auth: { apiKey: credential.key }, source: "existing-memory-ref" }) } }, getModels: () => models, stream: (...args) => api.stream(...args), streamSimple: (...args) => api.streamSimple(...args) };
    const profiles = new Map([[provider, { displayName: provider, piProvider, modelErrors: new Map(), configuredMaxTokens: new Map(), streamIdleTimeoutMs: 90000 }]]);
    ctx.llm.registerAdapter([provider], new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => secrets.qwenKey }));
    const connection = deepseek.resolveAdapterOptions({});
    ctx.llm.registerAdapter(["deepseek-account"], new deepseek.DeepSeekAdapter({ providerName: "DeepSeek Account", options: () => connection, resolveAuth: async () => ({ headers: { "x-dsh-auth-token": secrets.accountToken } }), resolveUserId: () => "dsh-rag-synthetic-evaluation", prepareExtensions: async () => ({ fields: {}, accept: async () => {} }), discoverModels: async () => [deepseek.catalogModelInfo("deepseek-account", connection.models.find((m) => m.id === "deepseek-flash"))], resolveFiles: () => new deepseek.DeepSeekFileStore({ index: new deepseek.DeepSeekUploadIndex(join(runDir, "unused-files.json")) }) }));
    return {
      async call(task) {
        const fixture = plan.cases.find((f) => f.id === task.caseId), candidate = CANDIDATES.find((c) => c.id === task.candidateId);
        const seeded = seed(fixture, candidate), { service, canonical, snapshot } = seeded;
        const state = { task, candidate, phase: null, phases: [] }, before = snapshot(), started = Date.now();
        const base = createDshExtractor(ctx, service.store);
        const phaseCall = async (name, fn) => {
          const phase = { name, attempts: 0, sent: false, assembler: new BlockAssembler(), at: new Date().toISOString() }, begin = Date.now(); state.phase = phase;
          let value, failure;
          try { value = await fn(); return value; } catch (e) { failure = safeFailure(e); throw e; }
          finally {
            const measured = budgetCost({ usage:phase.assembler.usage, httpStatus:phase.httpStatus, finish:phase.assembler.finish.kind }, candidate);
            const charged = phase.sent ? budget.settle(phase.reservedCny, measured) : 0;
            if (phase.sent && measured === null || budget.overrun) stopState.stop = true;
            const record = scrub({ taskId: task.id, candidateId: candidate.id, phase: name, timestamp: phase.at, latencyMs: Date.now() - begin, sent: phase.sent, httpStatus: phase.httpStatus ?? null, requestId: phase.requestId ?? null, text: phase.assembler.blocks().filter((b) => b.type === "text").map((b) => b.text).join(""), finish: phase.assembler.finish.kind, usage: phase.assembler.usage, failure: failure ?? null, providerError: phase.providerError ?? null, wire: phase.wire ?? null, reservedCny: phase.reservedCny ?? 0, chargedCny: charged, rawReceived: value !== undefined });
            state.phases.push(record);
            if (phase.sent) append(journal, { event: "phase-finish", planId: plan.id, key: `${task.id}:${name}`, record });
          }
        };
        const extractor = { assertReady:base.assertReady, request:(name,...args)=>phaseCall(name,async()=>{const result=await base.request(name,...args);if(name==="extraction")seeded.concurrent();return result;}) };
        service.extractor = extractor;
        try {
          await active.run(state, async () => { service.schedule(fixture.sources[0].session_id); await service.work("extract"); });
          const stages = service.store.db.prepare("SELECT * FROM job_stages ORDER BY rowid").all().map((s) => ({ ...s, response: s.response ? JSON.parse(s.response) : null }));
          const sources=stages.find(s=>s.phase==="input")?.response?.sources??[];
          let operations=[];
          for(const p of state.phases){
            try{if(p.finish!=="stop")throw Error("unfinished");const parsed=p.phase==="extraction"?parseOperations(p.text,sources):parseReview(p.text,sources,operations.filter(o=>o.action!=="skip"));if(p.phase==="extraction")operations=parsed.operations;p.validParsedResult=!parsed.errors.length;p.invalidOperationCount=parsed.errors.length;p.usableParsedResult=true;}
            catch{p.validParsedResult=false;p.usableParsedResult=false;}
          }
          return scrub(canonical({ planId: plan.id, taskId: task.id, caseId: fixture.id, candidateId: candidate.id, pass: task.pass, split: fixture.split, latencyMs: Date.now() - started, phases: state.phases, before, after: snapshot(), stages, calls: service.store.db.prepare("SELECT * FROM extraction_calls ORDER BY rowid").all().map((c) => ({ ...c, request: JSON.parse(c.request), usage: c.usage ? JSON.parse(c.usage) : null })), operations: service.store.operations(), jobs: service.store.db.prepare("SELECT kind,status,attempts,error FROM jobs WHERE kind='extract' ORDER BY rowid").all(), processed: fixture.sources.map((s) => ({ id: s.id, processed: service.store.getSource(s.id).processed })), warning: service.lastWarning, actualCostVerified: false }));
        } finally { await service.close(); }
      },
      async dispose() { globalThis.fetch = originalFetch; await ctx.fiber.dispose(); },
    };
  } catch (e) { globalThis.fetch = originalFetch; await ctx.fiber.dispose(); throw e; }
}
async function main() {
  const mode=process.argv[2];
  if(mode==="prepare"){const plan=prepare();console.log(JSON.stringify({planId:plan.id,cases:plan.cases.length,tasks:plan.tasks.length,priorCny:plan.priorAccountedCny,paidCalls:0}));return;}
  if(["pack","score"].includes(mode)){await (await import("./kernel-evaluation-score.mjs")).report(mode);return;}
  if(!["run","continue-unsent"].includes(mode))throw Error("指定 prepare / run / continue-unsent / pack / score；run 与 continue-unsent 发送模型请求");
  const plan = verifyPlan(), runDir = join(OUTPUT, "live"), journal = join(runDir, "journal.jsonl"); mkdirSync(runDir, { recursive: true });
  const previous = journalState(journal, plan.id);
  if (previous.unresolved.length || previous.orphanTasks.length) throw new Error("存在结果不明或任务未落盘的请求，禁止自动重发");
  const reviewedUnknown = new Set();
  if(mode==="continue-unsent"){
    if(!plan.continuation)throw Error("缺少中断后核查记录");
    for(const [key,digest]of Object.entries(plan.continuation.unknown)){
      const p=previous.phases.get(key),start=previous.started.get(key);
      if(!p||hash(p)!==digest||!previous.tasks.has(p.taskId)||p.chargedCny!==start.reservedCny)throw Error("未确认请求未完整保留费用和失败记录");
      reviewedUnknown.add(key);
    }
  }
  const secrets = await loadSecrets(), isolationFile = join(runDir, "isolation.json");
  if (existsSync(isolationFile) && JSON.stringify(JSON.parse(readFileSync(isolationFile)).before) !== JSON.stringify(secrets.fingerprints)) throw new Error("日用配置或凭据在测试期间变化");
  if (!existsSync(isolationFile)) writeFileSync(isolationFile, JSON.stringify({ before: secrets.fingerprints, syntheticOnly: true, dailyDatabaseMode: "readOnly-settings-row-only", noDailyDeployment: true }, null, 2));
  const budget = new Budget(plan.priorAccountedCny + [...previous.phases.values()].reduce((sum, p) => sum + p.chargedCny, 0));
  const stopState = { stop: [...previous.phases.entries()].some(([key,p]) => [401,403,404].includes(p.httpStatus) || budgetCost(p, CANDIDATES.find((c) => c.id === p.candidateId)) === null && !reviewedUnknown.has(key)) };
  const pending = plan.tasks, done=previous.tasks;
  let cursor = 0;
  const runner = await createRunner(secrets, runDir, journal, plan, budget, stopState);
  try {
    async function work() {
      while (!stopState.stop && cursor < pending.length) {
        const task = pending[cursor++]; if (done.has(task.id)) continue;
        const record = await runner.call(task);
        append(journal, { event: "task-finish", planId: plan.id, record }); done.set(task.id, record);
        if (done.size <= 3 || done.size % 12 === 0) console.log(JSON.stringify({ tasks: done.size, planned: plan.tasks.length, candidate: task.candidateId, phases: record.phases.map((p) => ({ phase: p.phase, status: p.httpStatus, finish: p.finish })), job: record.jobs[0]?.status, cumulativeAccountedCny: budget.used, stopped: stopState.stop }));
      }
    }
    await Promise.all(Array.from({ length: 3 }, work));
  } finally {
    await runner.dispose(); verifyPlan();
    const after = (await loadSecrets()).fingerprints, before = JSON.parse(readFileSync(isolationFile)).before;
    writeFileSync(join(runDir, "responses.jsonl"), [...done.values()].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const completion = { planId: plan.id, records: done.size, planned: plan.tasks.length, roundAccountedCny: budget.used - plan.priorAccountedCny, cumulativeAccountedCny: budget.used, cumulativeCeilingCny: 10, pendingReserveCny: budget.pending, stopped: stopState.stop, dailyConfigurationUnchanged: JSON.stringify(before) === JSON.stringify(after), productionAndPriorEvidenceUnchanged: true, syntheticOnly: true, actualInvoiceVerified: false, at: new Date().toISOString() };
    writeFileSync(join(runDir, "completion.json"), JSON.stringify(completion, null, 2)); console.log(JSON.stringify(completion));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(JSON.stringify({ error: safeFailure(e), message: "评估停止；检查本地安全日志，禁止自动重发结果不明请求" })); process.exitCode = 1; });
