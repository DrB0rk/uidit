import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { readSession } from './store.js';

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); }
  catch { return null; }
}

export function gitContext(cwd) {
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) return { available: false, reason: 'This project is not inside a readable Git worktree.' };
  const status = git(cwd, ['status', '--porcelain']);
  const changed = [...new Set([...(git(cwd, ['diff', '--name-only', 'HEAD']) ?? '').split('\n'), ...(git(cwd, ['ls-files', '--others', '--exclude-standard']) ?? '').split('\n')].filter(Boolean))].slice(0, 200);
  return {
    available: true,
    root: path.relative(cwd, root) || '.',
    branch: git(cwd, ['branch', '--show-current']) || '(detached HEAD)',
    head: git(cwd, ['rev-parse', 'HEAD']),
    dirty: Boolean(status),
    changedFiles: changed,
    provenance: 'read-only Git metadata',
  };
}

export function impactGraph(cwd) {
  const session = readSession(cwd);
  const components = new Map();
  for (const element of session.elements) {
    const commentRefs = session.comments.filter((comment) => comment.elementId === element.id).flatMap((comment) => comment.codeRefs ?? []).map((reference) => reference.file);
    const source = element.source?.file ?? element.sourceFile ?? element.codeRef?.file ?? commentRefs[0] ?? null;
    const component = element.component?.name ?? source ?? element.selector ?? 'unmapped element';
    const route = element.routeKey ?? element.anchor?.route ?? element.page ?? 'unknown route';
    const key = `${component}::${source ?? ''}`;
    const node = components.get(key) ?? { id: key, component, source, provenance: source ? 'recorded source reference' : element.component?.name ? 'element metadata' : 'DOM selector', confidence: source ? 'linked' : 'observed-only', routes: [], elements: [], commentIds: [] };
    if (!node.routes.includes(route)) node.routes.push(route);
    node.elements.push(element.id);
    for (const comment of session.comments.filter((item) => item.elementId === element.id)) node.commentIds.push(comment.id);
    components.set(key, node);
  }
  const nodes = [...components.values()].map((node) => ({ ...node, commentIds: [...new Set(node.commentIds)] }));
  const byFile = new Map();
  for (const node of nodes) if (node.source) byFile.set(node.source, [...(byFile.get(node.source) ?? []), node.id]);
  const edges = [...byFile].flatMap(([file, ids]) => ids.length > 1 ? ids.slice(1).map((id) => ({ from: ids[0], to: id, reason: `shared source: ${file}`, confidence: 'recorded' })) : []);
  return { nodes, edges, coverage: { observedElements: session.elements.length, mappedElements: nodes.filter((node) => node.source).reduce((n, node) => n + node.elements.length, 0), observedRoutes: new Set(nodes.flatMap((node) => node.routes)).size, completeness: 'observed-only; routes and component usage not visited by UIDIT are unknown' } };
}

export function designRuleContext(cwd) {
  const rulesPath = path.join(cwd, '.uidit', 'design-rules.md');
  let designRules = { available: false, source: '.uidit/design-rules.md', category: 'project preference', content: '' };
  let fd;
  try { fd = fs.openSync(rulesPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); const stat = fs.fstatSync(fd); if (stat.isFile() && stat.size <= 12000) designRules = { ...designRules, available: true, content: fs.readFileSync(fd, 'utf8').slice(0, 12000) }; }
  catch {}
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return designRules;
}

export function projectContext(cwd) {
  return { git: gitContext(cwd), impact: impactGraph(cwd), designRules: designRuleContext(cwd) };
}
