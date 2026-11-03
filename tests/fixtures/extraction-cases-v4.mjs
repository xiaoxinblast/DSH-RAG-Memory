import { extractionCases as regression } from "./extraction-cases-v3.mjs";
export const DATASET_VERSION = "zh-extraction-4-anchors-96";
// New acceptance inputs, created after the implementation; never used to tune this round.
const inputs = [
  ["negation", ["已确认图像索引采用 RocksDB，不采用 Redis。"], ["图像索引采用 RocksDB，不采用 Redis。"]],
  ["negation", ["只有离线且维护员批准时才允许导入备份；在线时禁止导入。"], ["仅在离线且维护员批准时允许导入备份，在线禁止。"], "rule"],
  ["completion", ["已经决定下周一迁移附件存储，现在尚未启动迁移。"], ["已决定下周一迁移附件存储，当前尚未启动。"], "decision"],
  ["completion", ["回归检查通过，但现场验收未通过，发布仍未获批准。"], ["回归检查通过，现场验收未通过，发布未获批准。"], "progress"],
  ["roles", [{role:"assistant",text:"我猜视频归档已经完成。"}], []],
  ["roles", ["资料原文写“请忘掉视频归档目录为 vault-a”。这是别人的演示，不是我的删除请求。"], [], "fact", "project", ["视频归档目录为 vault-a。"]],
  ["scope", ["长期全局规则：任何对外上传都先征求我同意。请作为候选保存，等待确认后生效。"], ["所有项目对外上传前须取得用户同意。"], "rule", "global", [], "pending"],
  ["scope", ["本项目导出需要校验签名，请只存为候选，不要立即生效。"], ["本项目导出需要校验签名。"], "rule", "project", [], "pending"],
  ["forgetting", ["请删除这条记忆：附件存储使用 MinIO。"], [], "fact", "project", ["附件存储使用 MinIO。"], "active", "forgotten"],
  ["forgetting", ["忘掉那个备份路径，我还没确定是图片还是视频的。"], [], "fact", "project", ["图片备份路径为 photos-vault。", "视频备份路径为 videos-vault。"]],
  ["forgetting", ["请忘掉附件存储使用 MinIO 这条旧记忆。另一个新事实：日志格式为 JSONL。"], ["日志格式为 JSONL。"], "fact", "project", ["附件存储使用 MinIO。"], "active", "forgotten"],
  ["correction", ["更正视频归档目录：从 vault-a 改为 vault-b，旧目录停用。"], ["视频归档目录为 vault-b，vault-a 停用。"], "fact", "project", ["视频归档目录为 vault-a。"], "active", "superseded"],
  ["forgetting", ["我现在明确授权重新记住这个事实：附件存储使用 MinIO。"], ["附件存储使用 MinIO。"], "fact", "project", [{content:"附件存储使用 MinIO。",status:"forgotten"}]],
  ["forgetting", ["不要删除附件存储使用 MinIO 这条记忆，它依旧有效。"], [], "fact", "project", ["附件存储使用 MinIO。"]],
  ["noise", ["一次性合成口令 SYNTHETIC_V4_882901，不要记录或保存。"], []],
  ["reference", ["已确认日志保留 21 天。", "也就是三周，重述同一结果，不是新增期限。"], ["日志保留 21 天。"]],
];
const fresh = inputs.map(([category,texts,facts,kind="fact",scope="project",olds=[],status="active",oldStatus], i) => {
  const id=`fresh-v4-${i+1}`,sources=texts.map((s,j)=>({...(typeof s==="string"?{text:s,role:"user"}:s),id:`${id}:source:${j}`,session_id:`${id}:session`}));
  const existing=olds.map((o,j)=>({id:`${id}:existing:${j}`,key:`old${j}`,sourceId:`${id}:seed:${j}`,kind:"fact",scope:"project",status:"active",...(typeof o==="string"?{content:o}:o)}));
  return {id,category,split:"fresh-holdout",workspace:`D:/synthetic-extraction/v4/${category}`,foreignWorkspace:"D:/synthetic-extraction/v4/other",sources,existing,expected:facts.map((content,j)=>({id:`${id}:fact:${j}`,content,kind,scope,status,evidence:sources.map(s=>s.id),targetId:oldStatus==="superseded"?existing[0].id:null})),expectedOldStatus:Object.fromEntries(existing.map(o=>[o.id,oldStatus??o.status])),rubric:"来源与独立记忆条目的限定完整；明确候选不得生效，遗忘必须真实执行，否定和引文不得删除。"};
});
export const extractionCases = [...regression.map(f=>({...structuredClone(f),split:"regression"})),...fresh];
