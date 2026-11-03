import { hash, projectId, validityTime } from "./domain.mjs";
import { redact } from "./qwen.mjs";
import { resolveEvidence, unquotedText, identity, sameRange, unionRanges, overlaps } from "./evidence.mjs";

function datesSupported(attributes, fragments) {
  return ["validFrom", "validUntil"].every(field => {
    const value = attributes[field]; if (value == null) return true;
    const date = value.slice(0, 10), numbers = date.split("-").map(Number);
    return Number.isFinite(validityTime(value)) && fragments.some(f => f.text.includes(value) || !value.includes("T") && f.text.includes(`${numbers[0]}年${numbers[1]}月${numbers[2]}日`));
  }) && !(attributes.validFrom && attributes.validUntil && validityTime(attributes.validFrom) > validityTime(attributes.validUntil, true));
}

// Pure decision table. All database facts are supplied by the caller; no I/O or language-pattern inference.
export function decideOperation(operation, review, facts) {
  const o = operation, target = facts.target;
  let evidence = o.evidence;
  const result = (outcome, reason, extra = {}) => ({ outcome, reason, evidence, rerecordGrant: null, ...extra });
  const defer = reason => result(o.action === "forget" ? "clarification" : "pending", reason);
  let fragments, parts;
  try { parts = (o.members ?? [o]).map(p => resolveEvidence(p.evidence, facts.sources, { canonical: true })); fragments = parts.flat(); } catch { return result("rejected", "来源引用无效或已被遮蔽"); }
  if (!parts.every(p => p.some(f => !f.source.contextOnly)) || fragments.some(f => f.source.project_id !== projectId(facts.workspace))) return result("rejected", "上下文不能单独写入，来源不得跨项目");
  if (o.action === "skip") return result("skipped", "来源无需新增记忆");
  if (redact(o.content) !== o.content || ["query", "temporary", "quoted"].includes(o.intent)) return result("rejected", "凭据、查询、临时要求或引文不能形成持久记忆");
  const credible = parts.every(p => p.some(f => ["user", "tool", "tool-error"].includes(f.source.role) && !!unquotedText(f.text).trim()));
  if (!credible || (!parts.every(p => p.some(f => f.direct)) && (["preference", "rule", "decision"].includes(o.kind) || o.scope === "global"))) return result("rejected", "缺少可确认此类记忆的直接来源");
  if (o.action !== "forget" && o.scope === "global" && !["preference", "rule"].includes(o.kind)) return result("rejected", "全局只允许个人偏好或通用规则");
  if (facts.toolRequest && (["action", "scope", "targetId", "targetVersion"].some(k => o[k] !== facts.toolRequest[k]) || o.action !== "forget" && o.content !== facts.toolRequest.content)) return result("rejected", "提议超出工具请求的操作、正文、目标或范围");
  if (o.action === "add" && (o.targetId !== null || o.targetVersion !== null)) return result("rejected", "新增不能携带覆盖目标");
  if (!review || !["approve", "reject", "uncertain"].includes(review.decision)) return result("review-required", "该项复核缺失或无效，需要检查；未写入记忆");
  if (review.decision === "reject" || [o.authorization, review.authorization].includes("none")) return result("rejected", review.reason);
  let reviewed, authorization;
  try {
    reviewed = resolveEvidence(review.evidence, facts.sources, { canonical: true });
    const agreed = o.authorizationEvidence.filter(a => review.authorizationEvidence.some(b => sameRange(a, b)));
    authorization = agreed.length ? resolveEvidence(agreed, facts.sources, { canonical: true }) : [];
  } catch { return result("review-required", "复核或授权来源无效，未扩大授权"); }
  if ([...reviewed, ...authorization].some(f => f.source.project_id !== projectId(facts.workspace))) return result("rejected", "复核补证与授权不得跨项目");
  evidence = unionRanges(o.evidence, review.evidence, ...(o.action === "forget" ? [authorization.map(f => f.range)] : []));
  if (!datesSupported(o.attributes ?? {}, [...fragments, ...reviewed])) return result("rejected", "适用时间缺少明确来源或起止无效");
  if (evidence.some(a => (facts.ambiguousRanges ?? []).some(b => overlaps(a, b)))) return result("review-required", "控制操作与记忆共用不可区分的原文范围，相关项均需检查");
  if ([o.unit, review.unit].includes("incomplete") || o.unit !== review.unit || (o.unit === "control") !== (o.action === "forget")) return result("review-required", "完整记忆单位或控制用途不一致，不能作为独立记忆写入");
  if (o.action !== "forget" && o.intent === "forget") return result("rejected", "遗忘意图不能保存为记忆正文");
  if (o.intent !== "rerecord" && (o.restores !== null || review.restores !== null)) return result("rejected", "普通写入不能携带重记许可");
  const explicit = o.authorization === "explicit" && review.authorization === "explicit" && authorization.length > 0 && authorization.every(f => f.direct);
  if (["update", "merge", "forget"].includes(o.action)) {
    const available = [...facts.existing, ...(facts.protected ?? [])];
    if (!available.some(r => r.id === o.targetId)) return result(o.action === "forget" ? "clarification" : "rejected", "目标不在提供的范围，不能猜测");
    if (!target || !(o.action === "forget" ? ["active", "forgotten"] : ["active"]).includes(target.status)) return result(o.action === "forget" ? "clarification" : "rejected", "目标已失效或被遗忘");
    if (target.scope !== o.scope || target.project_id !== (o.scope === "global" ? null : projectId(facts.workspace))) return result("rejected", "目标与操作范围不一致");
    if (o.action === "forget") {
      const text = identity([...fragments, ...authorization].filter(f => f.direct).map(f => unquotedText(f.text)).join("\n"));
      const named = available.filter(r => text.includes(identity(r.id)) || identity(r.content ?? "").length >= 4 && text.includes(identity(r.content)) || r.attributes?.subject && text.includes(identity(r.attributes.subject)) || r.match === "exact" && r.evidence.some(e => authorization.some(f => e.sourceId === f.source.id && e.anchorId === f.anchorId)));
      if (named.length !== 1 || named[0].id !== target.id) return result("clarification", "原文不能唯一指向遗忘目标，请明确名称或编号");
    }
  }
  const rerecord = o.intent === "rerecord" && o.action === "add" && explicit && o.restores !== null && o.restores === review.restores && facts.rerecordGrant && !facts.restoreBlocked && review.decision === "approve" && o.certainty === "confirmed" && review.certainty === "confirmed" && o.eventState === review.eventState;
  if (o.action !== "forget" && facts.blocked && !rerecord || o.intent === "rerecord" && !rerecord) return result("rejected", "遗忘保护生效，缺少限定到该事实的新来源及双阶段明确授权");
  if (o.action !== "forget" && facts.relatedProtection?.length) return result("review-required", "命中近义遗忘候选但事实身份未确定；相似度不作为同一事实或恢复授权，需核对");
  if (target && (target.version !== o.targetVersion || target.status !== "forgotten" && target.attributes?.legacy)) return defer("目标版本变化或历史元数据不足，保留原结论");
  if (o.action === "merge" && (target.kind !== o.kind || ["validFrom", "validUntil"].some(k => o.attributes?.[k] != null && validityTime(o.attributes[k], k === "validUntil") !== target.attributes?.[k]))) return defer("合并分类或时间不一致，保留候选");
  if (review.decision === "uncertain" || [o.certainty, review.certainty].includes("unresolved") || [o.authorization, review.authorization].includes("candidate_only") || o.authorization !== review.authorization || o.eventState !== review.eventState) return defer("两阶段存在未决、候选限制或不一致，不能提升为有效状态");
  if ((o.scope === "global" || ["update", "merge", "forget"].includes(o.action) || o.intent === "rerecord") && !explicit) return defer("对应高影响操作缺少双阶段明确用户授权");
  if (o.action === "add" && facts.conflicts?.length) return defer("相同主体属性存在不同有效结论，保留原条目");
  if (facts.duplicate && (facts.duplicate.kind !== o.kind || o.action === "update" && facts.duplicate.id !== o.targetId)) return defer("相同正文已存在但分类或替代目标不同，需要核对");
  return result(o.action === "merge" || facts.duplicate && o.action !== "forget" ? "merged" : "applied", review.reason, { rerecordGrant: rerecord ? facts.rerecordGrant : null });
}
export const operationFingerprint = value => hash(JSON.stringify(value));
