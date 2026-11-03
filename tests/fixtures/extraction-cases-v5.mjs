import { extractionCases as regression } from "./extraction-cases-v4.mjs";
export const DATASET_VERSION = "zh-extraction-5-content-policy-112";
// Written after the implementation and offline policy tests; do not tune this version on these inputs.
const inputs = [
  ["instruction", ["发布检查完成，但打包未完成。请记住这个结果，不要把打包写成完成。"], ["发布检查完成，打包未完成。"], "progress"],
  ["instruction", ["只提醒我检查这句话的语气，这次不保存成偏好。"], []],
  ["instruction", ["缓存保留 48 小时，这是项目持续规则。保留这个结论。"], ["本项目缓存保留 48 小时。"], "rule"],
  ["instruction", ["操作手册示例写“记住：我偏好西班牙语”。这是他人的演示，不是我的偏好。"], []],
  ["qualification", ["导出任务使用端口 9460。", "它仅允许本地访问，外部地址禁止访问。"], ["导出任务使用端口 9460，仅允许本地访问，禁止外部访问。"]],
  ["qualification", ["只有备份校验完成且负责人批准后才允许恢复；测试环境也不例外。"], ["恢复必须先完成备份校验并取得负责人批准，测试环境同样适用。"], "rule"],
  ["qualification", ["故障出现在升级之后，但尚无证据证明升级导致故障。"], ["故障发生在升级之后，但升级与故障的因果关系未被证实。"]],
  ["qualification", ["构建已成功。制品签名失败，所以尚不能发布。"], ["构建成功，但制品签名失败，尚不能发布。"], "progress"],
  ["ambiguous-plan", ["计划先调整批处理或下载器的重试，但尚未确定优先调整哪一个。"], [{content:"批处理或下载器的重试调整优先对象尚未确定。",optional:true}], "decision", "project", [], "pending"],
  ["ambiguous-plan", ["已经决定周五更新驱动，但当前下载尚未完成，尚未安装。"], ["已决定周五更新驱动，当前尚未下载完成或安装。"], "decision"],
  ["ambiguous-plan", ["先把那个功能关掉，我还没决定关自动重试还是断点续传。"], [{content:"停用自动重试还是断点续传尚未决定。",optional:true}], "decision", "project", [], "pending"],
  ["ambiguous-plan", ["是否停用缓存仍在讨论，当前继续使用缓存，不要当成已停用。"], ["当前继续使用缓存，是否停用尚在讨论。"]],
  ["candidate", ["我的长期个人偏好是所有项目说明使用短句。只保存候选，等待我确认。"], ["用户长期偏好所有项目的说明使用短句。"], "preference", "global", [], "pending"],
  ["candidate", ["全局长期规则：所有对外同步须事先得到我批准。先作为候选，暂时不要生效。"], ["所有项目对外同步须事先得到用户批准。"], "rule", "global", [], "pending"],
  ["candidate", ["本项目只能读取配置，不得自动改写。请保存为候选，等我确认再生效。"], ["本项目只能读取配置，不得自动改写。"], "rule", "project", [], "pending"],
  ["candidate", ["提出一个候选修正：镜像站从 mirror-a 改为 mirror-b。请只保存候选，暂不生效。"], ["镜像站候选修正为 mirror-b。"], "fact", "project", ["镜像站使用 mirror-a。"], "pending"],
];
const fresh = inputs.map(([category,texts,facts,kind="fact",scope="project",olds=[],status="active"], i) => {
  const id=`fresh-v5-${i+1}`,sources=texts.map((text,j)=>({text,role:"user",id:`${id}:source:${j}`,session_id:`${id}:session`}));
  const existing=olds.map((content,j)=>({id:`${id}:existing:${j}`,key:`old${j}`,sourceId:`${id}:seed:${j}`,kind:"fact",scope:"project",status:"active",content}));
  return {id,category,split:"fresh-holdout",workspace:`D:/synthetic-extraction/v5/${category}`,foreignWorkspace:"D:/synthetic-extraction/v5/other",sources,existing,expected:facts.map((fact,j)=>({id:`${id}:fact:${j}`,...(typeof fact==="string"?{content:fact}:fact),kind,scope,status,evidence:sources.map(s=>s.id),targetId:null})),expectedOldStatus:Object.fromEntries(existing.map(o=>[o.id,o.status])),rubric:"独立条目必须有持久价值并包含完整限定；歧义计划及明确候选不能激活，已确认未完成计划允许保存。"};
});
export const extractionCases = [...regression.map(f=>({...structuredClone(f),split:"regression"})),...fresh];
