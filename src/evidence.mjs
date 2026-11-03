import { redact } from "./qwen.mjs";
import { normalize } from "./domain.mjs";

export const identity = text => normalize(text).replace(/[\p{P}\p{Z}\s]/gu, "");
export const sameRange = (a, b) => a.sourceId === b.sourceId && a.start === b.start && a.end === b.end;
export const overlaps = (a, b) => a.sourceId === b.sourceId && a.start < b.end && b.start < a.end;
export const unionRanges = (...groups) => [...new Map(groups.flat().map(r => [JSON.stringify(r), r])).values()];

export function unquotedText(text) { return text.replace(/“[^”]*”|「[^」]*」|"[^"]*"|`[^`]*`/gu, (s) => " ".repeat(s.length)); }
export function sourceBoundaries(text) {
  const plain = unquotedText(text), boundaries = [0];
  for (const m of plain.matchAll(/[，。！？；;\n]/gu)) boundaries.push(m.index + m[0].length);
  return [...new Set([...boundaries, text.length])];
}
export function sourceAnchors(source) {
  const points = source.boundaries ?? sourceBoundaries(source.text);
  const ranges = points.slice(1).map((end, i) => ({ id: `p${i + 1}`, start: points[i], end }));
  return ranges.filter((r) => Number.isInteger(r.start) && Number.isInteger(r.end) && r.start >= 0 && r.end > r.start && r.end <= source.text.length && !(source.maskedRanges ?? []).some((m) => m.start < r.end && r.start < m.end)).map((r) => ({ ...r, text: source.text.slice(r.start, r.end) })).filter((r) => r.text.trim() && redact(r.text) === r.text);
}
// One validator for model anchor references and the canonical ranges rechecked at commit time.
export function resolveEvidence(evidence, sources, { canonical = false } = {}) {
  if (!Array.isArray(evidence) || !evidence.length) throw new Error("缺少原文引用");
  const fields = canonical ? ["sourceId", "start", "end"] : ["sourceId", "anchorId"];
  return evidence.map((e) => {
    if (!e || Object.keys(e).some(k => !fields.includes(k)) || typeof e.sourceId !== "string") throw new Error("必须引用宿主生成的原文编号或规范范围");
    const source = sources.find(s => s.id === e.sourceId), anchor = source && sourceAnchors(source).find(a => canonical ? a.start === e.start && a.end === e.end : a.id === e.anchorId);
    if (!anchor) throw new Error("原文引用无效或已被遮蔽");
    return { source, anchorId: anchor.id, range: { sourceId: source.id, start: anchor.start, end: anchor.end }, text: anchor.text, direct: source.role === "user" && !source.contextOnly && !!unquotedText(anchor.text).trim() };
  });
}
