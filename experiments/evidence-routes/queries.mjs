// Fixed offline probes. Regexes are test oracles, never production language rules.
export const queries = [
  { caseId: "holdout-reference-1", query: "8123", required: ["8123", "回环|127\\.0\\.0\\.1|本机|本地", "不.*外|禁止.*外"], category: "qualification" },
  { caseId: "holdout-reference-1", query: "8124", required: ["8124", "回环|127\\.0\\.0\\.1|本机|本地", "不.*外|禁止.*外"], category: "qualification" },
  { caseId: "units7-new-1", query: "7351", required: ["7351", "127\\.0\\.0\\.1", "禁止.*局域网", "公网"], category: "qualification" },
  { caseId: "fresh-v5-5", query: "9460", required: ["9460", "本地", "禁止.*外|外.*禁止"], category: "qualification" },
  { caseId: "negation-1-2", query: "SQLite", required: ["SQLite", "离线"], category: "qualification" },
  { caseId: "units7-new-14", query: "迁移元数据", required: ["下周三", "未启动|没有启动|尚未开始", "备份.*验收.*通过"], category: "qualification" },
  { caseId: "fresh-v6-3", query: "DNS", required: ["DNS", "中断", "因果.*未确认|因果.*未.*确认"], category: "qualification" },
  { caseId: "units7-new-15", query: "证书", required: ["队列", "证书", "不能认定|因果.*未确认"], category: "qualification" },
  { caseId: "roles-1-4", query: "部署", required: ["没有允许部署|未.*部署授权", "权限不足", "未执行"], category: "role-context" },
  { caseId: "completion-1-1", query: "PostgreSQL", required: ["下周", "尚未开始|未开始"], category: "qualification" },
  { caseId: "v3-actions-4", query: "NDJSON", required: ["NDJSON"], absent: ["SQLite"], category: "forget-and-retain" },
  { caseId: "units7-new-9", query: "UTC", required: ["UTC"], absent: ["CedarDB"], category: "forget-and-retain" },
  { caseId: "v3-actions-1", query: "SQLite", required: [], absent: ["SQLite"], category: "forget" },
  { caseId: "units7-new-5", query: "CedarDB", required: [], absent: ["CedarDB"], category: "forget" },
  { caseId: "units7-new-10", query: "CedarDB", required: [], absent: ["CedarDB"], category: "forgotten-replay" },
  { caseId: "units7-new-11", query: "音频索引", required: ["音频索引", "CedarDB"], absent: ["目录索引"], category: "different-subject" },
  { caseId: "units7-new-12", query: "CedarDB", required: ["目录索引", "CedarDB"], category: "authorized-rerecord" },
  { caseId: "units7-new-16", query: "Parquet", required: ["Parquet"], absent: ["SYNTHETIC_SECRET_NEVER_USE_123456"], category: "redaction" },
  { caseId: "noise-1-1", query: "今天几点", required: [], absent: ["今天几点"], category: "noise" },
  { caseId: "fresh-v5-2", query: "语气", required: [], absent: ["语气"], category: "do-not-save" },
  { caseId: "holdout-reference-1", query: "管理界面", foreign: true, required: [], absent: ["8123", "8124"], category: "project-isolation" },
  { caseId: "units7-new-3", query: "简体中文", foreign: true, required: ["简体中文", "标识符"], category: "global-preference" },
  { caseId: "units7-new-4", query: "缓存", required: ["候选|未批准|未确定"], category: "unresolved-context" },
  { caseId: "holdout-reference-1", query: "loopback", required: ["8123", "回环|127\\.0\\.0\\.1|本机|本地"], category: "index-expansion" },
];

export function assess(items, probe) {
  const bodies = items.map(i => i.body), all = bodies.join("\n");
  return {
    hit: items.length > 0,
    completeUnit: probe.required.length ? bodies.some(body => probe.required.every(p => new RegExp(p, "isu").test(body))) : null,
    completeAcrossItems: probe.required.length ? probe.required.every(p => new RegExp(p, "isu").test(all)) : null,
    forbidden: (probe.absent ?? []).filter(p => new RegExp(p, "isu").test(all)),
  };
}
