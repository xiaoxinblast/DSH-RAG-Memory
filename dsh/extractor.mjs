import { randomUUID } from "node:crypto";
import { BlockAssembler, createSystemMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { OPERATIONS_PROMPT, VERIFICATION_PROMPT, PROTOCOL_VERSION } from "../src/extraction.mjs";
import { tokens } from "../src/domain.mjs";

export async function listDshModels(llm) {
  const providers = await Promise.all(llm.listProviders().map(async (p) => {
    try { return { id: p.id, name: p.name, models: (await llm.listModels(p.id)).map((m) => ({ id: m.id, name: m.name })) }; }
    catch { return { id: p.id, name: p.name, models: [], error: "暂时无法读取模型列表，请检查 DSH 配置后刷新" }; }
  }));
  return providers;
}
export async function requireDshModel(llm, route) {
  let message;
  if (!route?.provider || !route?.model) message = "请在记忆的连接设置中单独选择 DSH 提炼模型";
  else if (!llm.listProviders().some((p) => p.id === route.provider)) message = "已选择的 DSH 提炼提供商不可用，请重新选择提炼模型";
  else {
    let models;
    try { models = await llm.listModels(route.provider); }
    catch { message = "无法读取已选择的 DSH 提炼模型，请检查 DSH 配置后重试"; }
    if (models && !models.some((m) => m.id === route.model)) message = "已选择的 DSH 提炼模型不可用，请重新选择；不会自动切换模型";
  }
  if (message) { const error = new Error(message); error.code = "WAIT_DSH_MODEL"; throw error; }
}

export function createDshExtractor(ctx, store) {
  async function request(phase, payload, signal, meta = {}) {
    const prompt = phase === "verification" ? VERIFICATION_PROMPT : OPERATIONS_PROMPT;
    if (store.settings().cloudPaused) { const error = new Error("云端记忆处理已暂停，保留任务等待恢复"); error.code = "WAIT_DSH_MODEL"; throw error; }
    const route = meta.route ?? store.settings().extractionRoute;
    await requireDshModel(ctx.llm, route);
    if (JSON.stringify(route) !== JSON.stringify(store.settings().extractionRoute)) { const error = new Error("提炼路由已变化，保留批次等待核对"); error.code = "WAIT_DSH_MODEL"; throw error; }
    if (tokens(prompt) + tokens(payload) > (phase === "verification" ? 16000 : 8000)) throw new Error("记忆阶段输入超过保守预算");
    const combined = AbortSignal.any([signal, AbortSignal.timeout(90000)]), assembler = new BlockAssembler();
    const messages = [createSystemMessage(prompt), createUserMessage({ source: { kind: "plugin:dsh-memory" }, content: [{ type: "text", text: payload }] })];
    const prepared = await ctx.llm.prepareCall({ provider: route.provider, model: route.model, temperature: 0, maxTokens: 2048 }, combined, (controls, info) => { const least = info.reasoning?.efforts?.[0]?.id; return least === undefined ? controls : { ...controls, reasoningEffort: least }; });
    const id = randomUUID();
    store.db.prepare("INSERT INTO extraction_calls(id,session_id,provider,model,request,status,created_at) VALUES(?,?,?,?,?,'running',?)").run(id, meta.sessionId ?? "dsh-memory", route.provider, route.model, JSON.stringify({ version: PROTOCOL_VERSION, phase, jobId: meta.jobId ?? null, config: prepared.config, messages }), store.now());
    try {
      for await (const chunk of prepared.stream({ ...prepared.config, messages, sessionId: meta.sessionId, purpose: phase === "verification" ? "memory-verification" : "memory-extraction", signal: combined })) assembler.push(chunk);
      const text = assembler.blocks().filter((b) => b.type === "text").map((b) => b.text).join("");
      store.db.prepare("UPDATE extraction_calls SET response=?,usage=?,status='done' WHERE id=?").run(text, assembler.usage ? JSON.stringify(assembler.usage) : null, id);
      return { text, usage: assembler.usage ?? null, finish: assembler.finish.kind };
    } catch (error) { store.db.prepare("UPDATE extraction_calls SET status='failed',usage=?,error=? WHERE id=?").run(assembler.usage ? JSON.stringify(assembler.usage) : null, "记忆阶段未完成，需要核对审计记录", id); throw error; }
  }
  return { request, assertReady: route => requireDshModel(ctx.llm, route ?? store.settings().extractionRoute) };
}
