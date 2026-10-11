import fs from 'node:fs';
import path from 'node:path';
import { routeIdentity } from './identity.js';
import * as store from './store.js';
import * as taskStore from './tasks.js';

const CHECKED_EXTENSIONS = new Set(['.astro','.css','.html','.js','.jsx','.mjs','.svelte','.ts','.tsx','.vue']);
const IGNORED = new Set(['.git','.uidit','node_modules','dist','build','.astro','.next','.svelte-kit','coverage']);

function sourceFile(element) {
  return element.source?.file ?? element.sourceFile ?? element.codeRef?.file ?? element.component?.source ?? null;
}

function relatedSourceFiles(session, task) {
  const files = new Set((task.changedFiles ?? []).map((file) => path.normalize(file)));
  const comments = session.comments.filter((comment) => task.commentIds?.includes(comment.id));
  const elementIds = new Set(comments.map((comment) => comment.elementId).filter(Boolean));
  for (const element of session.elements) if (elementIds.has(element.id)) {
    const file = sourceFile(element); if (file) files.add(path.normalize(file));
    for (const comment of comments.filter((item) => item.elementId === element.id)) for (const ref of comment.codeRefs ?? []) files.add(path.normalize(ref.file));
  }
  return files;
}

function taskTouchesFiles(session, task, changedFiles) {
  const linked = relatedSourceFiles(session, task);
  return linked.size > 0 && [...linked].some((file) => changedFiles.some((changed) => changed === file || changed.startsWith(`${file}${path.sep}`) || file.startsWith(`${changed}${path.sep}`)));
}

/** Debounced project watcher for bounded, source-linked post-HMR anchor checks. */
export function createSelectiveVerifier({ cwd = process.cwd(), hub, quietPeriod = 700, onError = () => {} } = {}) {
  let watcher = null;
  let timer = null;
  let closed = false;
  const changed = new Set();
  const flush = () => {
    timer = null;
    if (closed || !changed.size) return;
    const files = [...changed].sort().slice(0, 100); changed.clear();
    const session = store.readSession(cwd);
    const active = session.tasks.filter((task) => !['accepted','cancelled','rejected'].includes(task.status));
    const impacted = active.filter((task) => taskTouchesFiles(session, task, files));
    const context = hub?.browserContext;
    const inspectionAllowed = store.readConfig(cwd)?.ui?.allowBrowserInspection === true;
    const normalizedRoute = context?.url ? routeIdentity(context.url) : null;
    const results = [];
    for (const task of impacted) {
      const linkedIds = new Set(session.comments.filter((comment) => task.commentIds?.includes(comment.id)).map((comment) => comment.elementId).filter(Boolean));
      const targets = session.elements.filter((element) => linkedIds.has(element.id) && (!normalizedRoute || routeIdentity(element.page) === normalizedRoute));
      let result = 'not_run';
      let summary = 'No matching live page context is available; manual review is needed.';
      const missing = [];
      if (inspectionAllowed && normalizedRoute && Array.isArray(context?.nodes) && targets.length) {
        const selectors = new Set(context.nodes.map((node) => node.selector));
        for (const target of targets) if (!selectors.has(target.selector)) missing.push(target.selector);
        if (missing.length) { result = 'failed'; summary = `HMR check could not find ${missing.length} linked element anchor${missing.length === 1 ? '' : 's'} on the observed route.`; }
        else { result = 'note'; summary = `HMR check found all ${targets.length} linked element anchor${targets.length === 1 ? '' : 's'} after the update. Visual and behavior correctness still need review.`; }
      }
      const evidence = taskStore.addEvidence(cwd, task.id, { type: 'diagnostic', result, summary, metadata: { trigger: 'hmr-file-change', files: files.slice(0, 30), route: normalizedRoute, missingSelectors: missing.slice(0, 20), checkedAnchors: targets.length } }, { actor: 'uidit-hmr-check' });
      results.push({ taskId: task.id, status: result, evidenceId: evidence?.id ?? null, summary });
    }
    hub?.notifyDev?.({ hmrVerification: { at: new Date().toISOString(), changedFiles: files, impactedTasks: impacted.length, results } });
    if (impacted.length) hub?.notify?.();
  };
  const add = (filename) => {
    const raw = filename?.toString();
    if (!raw || raw.length > 1000 || path.isAbsolute(raw)) return;
    const parts = raw.split(/[\\/]/);
    if (parts.some((part) => IGNORED.has(part) || part.startsWith('.'))) return;
    if (!CHECKED_EXTENSIONS.has(path.extname(raw).toLowerCase())) return;
    changed.add(path.normalize(raw));
    if (changed.size > 100) changed.delete(changed.values().next().value);
    clearTimeout(timer); timer = setTimeout(flush, Math.max(250, Math.min(5000, quietPeriod)));
  };
  const start = () => {
    if (watcher || closed) return;
    try { watcher = fs.watch(cwd, { recursive: true }, (_event, filename) => add(filename)); watcher.on('error', onError); }
    catch (error) { onError(error); }
  };
  const close = () => { closed = true; clearTimeout(timer); timer = null; watcher?.close(); watcher = null; changed.clear(); };
  return { start, close, flush, get watching() { return Boolean(watcher); } };
}
