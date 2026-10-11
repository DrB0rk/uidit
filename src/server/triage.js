const STOP = new Set(['about', 'after', 'again', 'also', 'because', 'before', 'could', 'does', 'from', 'have', 'here', 'into', 'just', 'more', 'need', 'page', 'please', 'should', 'that', 'their', 'there', 'these', 'this', 'want', 'with', 'would', 'your']);
const URGENT = /\b(broken|block(?:ing|ed)?|crash(?:es|ing)?|error|fails?|inaccessible|unusable|cannot|can't|doesn't work)\b/i;
const tokens = (comment) => new Set(String(comment.text ?? '').toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((word) => !STOP.has(word)) ?? []);
const groupKey = (comment) => {
  if (comment.elementId) return `element:${comment.elementId}`;
  const topic = [...tokens(comment)].sort().slice(0, 2).join('-');
  return topic ? `topic:${comment.page ?? ''}:${topic}` : `general:${comment.id}`;
};

export function triageFeedback(comments, elements = [], { includeResolved = false } = {}) {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const open = comments.filter((comment) => includeResolved || !comment.resolved);
  const related = new Map();
  for (const comment of open) {
    const key = groupKey(comment);
    if (!related.has(key)) related.set(key, []);
    related.get(key).push(comment);
  }
  const ranked = open.map((comment) => {
    const key = groupKey(comment);
    const group = related.get(key) ?? [];
    const score = (URGENT.test(comment.text) ? 4 : 0) + (group.length > 1 ? 2 : 0) + (comment.status === 'needs_info' ? -2 : 0);
    return { comment, score, priority: score >= 4 ? 'high' : score >= 2 ? 'normal' : 'low', groupKey: key, element: byId.get(comment.elementId) ?? null };
  }).sort((a, b) => b.score - a.score || String(a.comment.createdAt ?? '').localeCompare(String(b.comment.createdAt ?? '')));
  const groups = [...related.entries()].map(([key, group]) => ({
    id: key,
    label: key.startsWith('element:') ? byId.get(group[0].elementId)?.selector ?? 'Related element feedback' : key.startsWith('topic:') ? key.split(':').at(-1).replaceAll('-', ' ') : 'Related feedback',
    commentIds: group.map((comment) => comment.id),
  })).filter((group) => group.commentIds.length > 1);
  const duplicatePairs = [];
  for (let i = 0; i < open.length; i += 1) for (let j = i + 1; j < open.length; j += 1) {
    const left = tokens(open[i]); const right = tokens(open[j]);
    if (!left.size || !right.size) continue;
    const overlap = [...left].filter((word) => right.has(word)).length;
    if (overlap / Math.min(left.size, right.size) >= 0.65) duplicatePairs.push([open[i].id, open[j].id]);
  }
  return {
    openCount: open.length,
    suggestedOrder: ranked.map(({ comment, priority, element }) => ({ id: comment.id, text: comment.text, priority, status: comment.status ?? 'open', element: element ? { id: element.id, selector: element.selector, accessibleName: element.accessibleName ?? null, component: element.component ?? null } : null, page: comment.page ?? null })),
    relatedGroups: groups,
    possibleDuplicates: duplicatePairs,
    method: 'Heuristic suggestions use urgency wording, shared page or element targets, and text overlap. Review the original feedback before acting.',
  };
}
