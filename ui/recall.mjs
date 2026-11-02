export const recallDefinition = {
  kind: "dsh-memory-recall",
  target: "chat",
  match: { "user/message": (event) => event.data?.source?.kind === "plugin:dsh-memory" && event.data.source.form === "snapshot" ? { id: String(event.data.id), role: "start", exclusive: true } : null },
  start: (_context, match) => ({ seq: match.event.seq, content: match.event.data.content, source: match.event.data.source }),
  update: (context) => context.state,
  buildViewNode: (context) => !context.state || !context.start?.location ? null : ({ key: context.key, kind: "dsh-memory-recall", id: context.id, target: "chat", anchorSeq: context.state.seq, location: context.start.location, visibility: "visible", groupTree: "input", data: context.state })
};
