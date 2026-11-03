import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { projectId } from "../src/domain.mjs";

export function registerIntegration(ctx, service) {
  const generations = new Map(), inflight = new Map();
  ctx.on("session/event", (session, event) => {
    const id = session?.id ?? session?.header?.id;
    if (event.type === "compaction/end" && !event.data?.error) generations.set(id, (generations.get(id) ?? 0) + 1);
    try { service.capture(session, event); } catch { ctx.logger.warn("dsh-memory: 会话片段暂未保存"); }
  });
  ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision?.kind !== "enter" || signal.aborted || agent.session.header.origin === "subagent") return decision;
    const workspace = agent.session.header.cwd, sid = agent.session.header.id;
    const user = [...decision.messages].reverse().find((m) => m.source?.kind === "user");
    if (!workspace || !user || !service.enabled(workspace)) return decision;
    const generation = generations.get(sid) ?? 0;
    const epoch = service.store.epoch();
    if (decision.messages.some((m) => m.source?.kind === "plugin:dsh-memory" && m.source.messageId === user.id && m.source.generation === generation && m.source.memoryEpoch === epoch)) return decision;
    const key = `${sid}:${user.id}:${generation}:${epoch}`, messages = decision.messages.filter((m) => m.source?.kind !== "plugin:dsh-memory");
    try {
      if (!inflight.has(key)) inflight.set(key, service.recall(sid, user.id, workspace, user.content.filter((b) => b.type === "text").map((b) => b.text).join("\n"), generation, signal).finally(() => inflight.delete(key)));
      const recall = await inflight.get(key);
      if (!recall || signal.aborted || epoch !== service.store.epoch()) return { ...decision, messages };
      const snapshot = createUserMessage({ content: [{ type: "text", text: recall.text }], source: { kind: "plugin:dsh-memory", form: "snapshot", messageId: user.id, generation, memoryEpoch: epoch, memoryIds: recall.ids, sections: [{ name: "DSH 记忆 · 来源编号可在记忆面板查看", text: recall.text }] } });
      messages.splice(messages.findIndex((m) => m.id === user.id), 0, snapshot);
      return { ...decision, messages };
    } catch { ctx.logger.warn("dsh-memory: 召回失败，继续当前对话"); return decision; }
  });
  const tools = [
    ["search", "查询记忆。默认当前项目和全局偏好；只有用户明确要求查询另一项目时才传 projectId。history=true 可查询已替代历史，但始终不返回已遗忘内容。", { query: { type: "string", required: true }, projectId: { type: "string", description: "用户明确指定的完整工作区路径，默认当前工作区" }, history: { type: "boolean", description: "明确查询历史方案时启用" }, at: { type: "string", description: "明确的 ISO 日期，按记忆的来源明示适用时间过滤" } }],
    ["read", "读取当前项目或全局记忆，包含原消息出处和修订记录。", { id: { type: "string", required: true } }],
    ["remember", "按用户要求提议记住信息，经统一提炼和独立复核后裁决；工具参数不代表用户授权。长期个人偏好/全局规则可用 global，其余使用 project。检查 outcome：applied/merged 才是生效，pending 是候选，review-required 需要检查，rejected/blocked 未生效，不得把候选说成已确认。", { content: { type: "string", required: true }, kind: { type: "string", required: true, enum: ["preference", "rule", "decision", "fact", "progress"] }, scope: { type: "string", required: true, enum: ["global", "project"] } }],
    ["update", "依据用户纠正提议更新当前范围内的记忆；先读取并传 version，保留修订。经统一提炼与独立复核，按 outcome 如实说明已生效、待确认、需要检查或未执行，不能把 pending 说成已替代。", { id: { type: "string", required: true }, content: { type: "string", required: true }, version: { type: "integer", required: true } }],
    ["forget", "按用户明确要求遗忘一条记忆；核对唯一目标和复核通过后停止召回，保留本地修订。outcome=clarification 或 needsClarification 时须向用户澄清目标，不得宣称已遗忘。", { id: { type: "string", required: true } }]
  ];
  for (const [action, description, parameters] of tools) {
    const dispose = ctx.tools.register(defineTool({ name: `dsh_memory_${action}`, description, parameters, output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] }, async execute(args, exec) {
      const header = exec.agent.session.header, context = { kind: "agent", workspace: header.cwd, sessionId: header.id };
      if (!service.enabled(context.workspace)) throw new Error("当前工作区已停用记忆");
      const row = args.id ? service.store.get(args.id) : null;
      if (args.id && (!row || (row.scope !== "global" && row.project_id !== projectId(context.workspace)))) throw new Error("记忆不存在或不属于当前项目");
      if (action === "read" && row.status === "forgotten") throw new Error("这条记忆已遗忘，不再向 Agent 返回；审计仅在用户管理界面查看");
      if (action === "remember") return service.manual(args, context);
      if (action === "update") return service.manual({ ...row, ...args, scope: row.scope, projectId: row.project_id }, context);
      return service.invoke({ ...args, action }, context);
    } }));
    if (typeof dispose === "function") ctx.effect(() => dispose);
  }
}
