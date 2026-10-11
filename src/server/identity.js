import crypto from 'node:crypto';

const VOLATILE_QUERY = /^(?:r|_t|t|timestamp|cacheBust|cache_bust|utm_.+|fbclid|gclid)$/i;
const normalizeText = (value) => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 240);

export function routeIdentity(raw) {
  try {
    const url = new URL(raw);
    const query = [...url.searchParams.entries()].filter(([key]) => !VOLATILE_QUERY.test(key)).sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
    return `${url.origin}${url.pathname}${query.length ? `?${new URLSearchParams(query)}` : ''}`;
  } catch { return String(raw ?? '').slice(0, 2000); }
}

export function anchorFor(element = {}) {
  const anchor = {
    selector: String(element.selector ?? '').slice(0, 2000),
    role: String(element.role ?? '').slice(0, 80),
    accessibleName: normalizeText(element.accessibleName),
    text: normalizeText(element.text),
    nearbyText: normalizeText(element.nearbyText),
    tag: String(element.tag ?? '').toLowerCase().slice(0, 32),
    ancestors: Array.isArray(element.ancestors) ? element.ancestors.slice(-5).map((item) => String(item).slice(0, 120)) : [],
    attributes: Object.fromEntries(Object.entries(element.attributes ?? {}).filter(([key]) => ['data-testid', 'data-test', 'name', 'type', 'aria-label', 'href', 'alt', 'role'].includes(key)).slice(0, 12)),
    component: element.component && typeof element.component === 'object' ? { framework: String(element.component.framework ?? '').slice(0, 40), name: String(element.component.name ?? '').slice(0, 100) } : null,
  };
  const digest = crypto.createHash('sha256').update(JSON.stringify({ role: anchor.role, name: anchor.accessibleName, text: anchor.text, tag: anchor.tag, ancestors: anchor.ancestors })).digest('hex').slice(0, 24);
  return { ...anchor, fingerprint: digest, route: routeIdentity(element.page) };
}

export function scoreAnchor(left = {}, right = {}) {
  const a = left.anchor ?? anchorFor(left);
  const b = right.anchor ?? anchorFor(right);
  if (a.route && b.route && a.route !== b.route) return 0;
  const points = [
    [a.fingerprint && a.fingerprint === b.fingerprint, 0.38],
    [a.role && a.role === b.role, 0.14],
    [a.tag && a.tag === b.tag, 0.08],
    [a.accessibleName && a.accessibleName === b.accessibleName, 0.22],
    [a.text && a.text === b.text, 0.14],
    [a.component?.name && a.component.name === b.component?.name, 0.12],
    [a.nearbyText && a.nearbyText === b.nearbyText, 0.08],
  ];
  const score = Math.min(1, points.reduce((sum, [match, weight]) => sum + (match ? weight : 0), 0));
  return Math.round(score * 1000) / 1000;
}

export function recoverAnchor(anchor, candidates, { threshold = 0.72, ambiguityGap = 0.12 } = {}) {
  const ranked = (Array.isArray(candidates) ? candidates : []).map((candidate) => ({ candidate, score: scoreAnchor({ anchor }, candidate) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
  if (!ranked.length || ranked[0].score < threshold) return { status: 'missing', candidate: null, score: ranked[0]?.score ?? 0, candidates: ranked.slice(0, 3) };
  if (ranked[1] && ranked[0].score - ranked[1].score < ambiguityGap) return { status: 'ambiguous', candidate: null, score: ranked[0].score, candidates: ranked.slice(0, 3) };
  return { status: ranked[0].candidate.selector === anchor.selector ? 'located' : 'recovered', candidate: ranked[0].candidate, score: ranked[0].score, candidates: ranked.slice(0, 3) };
}
