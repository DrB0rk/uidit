/**
 * uidit — Oh My Pi extension.
 *
 * Registers always-available access to the local UIDIT review state so an agent can
 * read the user's UI feedback without a running dashboard. The live MCP server (see
 * mcp.json) adds the interactive tools once `uidit` is running in the project.
 */
import { DEFAULT_CONTROL_PORT, isInitialized, readConfig, readSession } from '../src/server/store.js';

const MAX_TEXT = 600;

function collapse(value, limit = MAX_TEXT) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function anchorLabel(element) {
  if (!element) return 'page-level';
  const name = element.accessibleName || element.component || element.tag || 'element';
  return `${name} · ${element.selector ?? '(no selector)'}`;
}

function readWork(cwd) {
  if (!isInitialized(cwd)) return null;
  const config = readConfig(cwd) ?? {};
  const session = readSession(cwd);
  const elements = new Map(session.elements.map((element) => [element.id, element]));
  return {
    revision: session.revision,
    updatedAt: session.updatedAt,
    controlPort: config.controlPort ?? config.dashboardPort ?? DEFAULT_CONTROL_PORT,
    comments: session.comments.map((comment) => ({
      id: comment.id,
      status: comment.status ?? (comment.resolved ? 'resolved' : 'open'),
      resolved: Boolean(comment.resolved),
      text: collapse(comment.text),
      page: comment.page ?? null,
      element: comment.elementId ? anchorLabel(elements.get(comment.elementId)) : 'page-level',
      codeRefs: comment.codeRefs ?? [],
      replies: (comment.replies ?? []).length,
      createdAt: comment.createdAt ?? null,
    })),
    edits: session.edits.filter((edit) => !edit.applied).map((edit) => ({
      id: edit.id,
      kind: edit.kind ?? 'edit',
      property: edit.property ?? null,
      target: edit.elementId ? anchorLabel(elements.get(edit.elementId)) : collapse(edit.page ?? 'page', 160),
      before: collapse(edit.before, 160),
      after: collapse(edit.after, 160),
      note: collapse(edit.note, 160),
    })),
    tasks: session.tasks.filter((task) => !['accepted', 'cancelled', 'rejected'].includes(task.status)).map((task) => ({
      id: task.id,
      title: collapse(task.title, 160),
      status: task.status,
      owner: task.owner ?? null,
    })),
  };
}

function brief(work, { includeResolved = false, limit = 25 } = {}) {
  const comments = work.comments
    .filter((comment) => includeResolved || (!comment.resolved && comment.status !== 'cancelled'))
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
    .slice(0, limit);
  const lines = [
    `# uidit feedback (revision ${work.revision}${work.updatedAt ? `, updated ${work.updatedAt}` : ''})`,
    '',
    `${comments.length} of ${work.comments.length} comment(s) shown · ${work.edits.length} pending preview edit(s) · ${work.tasks.length} open task(s)`,
    `Dashboard: http://127.0.0.1:${work.controlPort} — run \`uidit\` in this project for the live UI.`,
  ];
  if (!comments.length && !work.edits.length) lines.push('', 'No open feedback. Everything captured so far is resolved.');
  if (comments.length) {
    lines.push('', '## Comments');
    for (const comment of comments) {
      lines.push(`- \`${comment.id}\` [${comment.status}${comment.resolved ? ' · resolved' : ''}] ${comment.text}`);
      lines.push(`  anchor: ${comment.element}${comment.page ? ` · page ${comment.page}` : ''}${comment.replies ? ` · ${comment.replies} repl${comment.replies === 1 ? 'y' : 'ies'}` : ''}`);
      if (comment.codeRefs.length) lines.push(`  source: ${comment.codeRefs.map((ref) => `${ref.file}:${ref.startLine ?? '?'}${ref.endLine ? `-${ref.endLine}` : ''}`).join(', ')}`);
    }
  }
  if (work.edits.length) {
    lines.push('', '## Pending preview edits (the user already saw these in the browser)');
    for (const edit of work.edits) {
      const subject = [edit.kind, edit.property].filter(Boolean).join(' ');
      lines.push(`- \`${edit.id}\` ${subject} on ${edit.target}: "${edit.before}" → "${edit.after}"${edit.note ? ` (note: ${edit.note})` : ''}`);
    }
  }
  if (work.tasks.length) {
    lines.push('', '## Open agent tasks');
    for (const task of work.tasks) lines.push(`- \`${task.id}\` [${task.status}] ${task.title}${task.owner ? ` · ${task.owner}` : ''}`);
  }
  lines.push('', 'Apply these in source (the dashboard is only a preview), then reply or resolve through the uidit MCP tools or `uidit resolve <ids>`.');
  return lines.join('\n');
}

function counts(cwd) {
  try {
    const work = readWork(cwd);
    if (!work) return null;
    return {
      open: work.comments.filter((comment) => !comment.resolved && comment.status !== 'cancelled').length,
      edits: work.edits.length,
      tasks: work.tasks.length,
    };
  } catch {
    return null;
  }
}

export default function uiditExtension(pi) {
  const z = pi.zod;
  pi.setLabel('uidit');

  pi.registerTool({
    name: 'uidit_feedback',
    label: 'uidit feedback',
    description:
      'Read the UI feedback, pending preview edits and agent tasks the uidit dashboard captured for this project in .uidit/. Works without a running dashboard; use the uidit MCP tools when one is running.',
    parameters: z.object({
      includeResolved: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const work = readWork(ctx.cwd);
      if (!work) {
        return {
          content: [{ type: 'text', text: `No .uidit/ directory in ${ctx.cwd}. Run \`uidit init\` there, then \`uidit\` to start reviewing UI.` }],
          details: { initialized: false },
        };
      }
      return {
        content: [{ type: 'text', text: brief(work, params ?? {}) }],
        details: {
          revision: work.revision,
          openComments: work.comments.filter((comment) => !comment.resolved).length,
          pendingEdits: work.edits.length,
          dashboard: `http://127.0.0.1:${work.controlPort}`,
        },
      };
    },
  });

  pi.registerCommand('uidit', {
    description: 'Show open UIDIT review feedback for this project',
    handler: async (_args, ctx) => {
      const summary = counts(ctx.cwd);
      if (!summary) {
        ctx.ui.notify('uidit: no .uidit/ review state in this project', 'info');
        return;
      }
      ctx.ui.notify(`uidit: ${summary.open} open comment(s), ${summary.edits} pending edit(s), ${summary.tasks} open task(s) — ask for uidit_feedback for details`, 'info');
    },
  });

  pi.on('session_start', async (_event, ctx) => {
    const summary = counts(ctx.cwd);
    if (!summary || (!summary.open && !summary.edits)) return;
    const parts = [];
    if (summary.open) parts.push(`${summary.open} open comment${summary.open === 1 ? '' : 's'}`);
    if (summary.edits) parts.push(`${summary.edits} pending preview edit${summary.edits === 1 ? '' : 's'}`);
    ctx.ui.notify(`uidit: ${parts.join(', ')} in .uidit/ — read uidit_feedback before UI changes`, 'info');
  });
}
