import { useId, useState } from 'react';
import {
  Check, X, Copy, MousePointerClick, Trash2, RotateCcw, ClipboardCopy, Square,
} from 'lucide-react';

const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

function SelectionBox({ selected, onComment, onOverlay, busy }) {
  const [text, setText] = useState('');
  const [prop, setProp] = useState('padding');
  const [val, setVal] = useState('16px');
  const [cls, setCls] = useState('');
  const [attrName, setAttrName] = useState('');
  const [attrVal, setAttrVal] = useState('');
  const id = useId();

  if (!selected) {
    return (
      <section className="selection selection-empty" aria-label="Add page feedback">
        <div className="selection-intro"><strong>Leave page feedback</strong><span>Select an element to attach a note, or add a general page note.</span></div>
        <label className="sr-only" htmlFor={`${id}-comment`}>Add a note about this page</label>
        <textarea id={`${id}-comment`} data-testid="comment" className="comment" rows={2} value={text} placeholder="What should change on this page?" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && text.trim()) { e.preventDefault(); onComment(text.trim()).then(() => setText('')); } }} />
        <div className="row selection-actions"><span className="muted hint">Page-level note</span><button type="button" className="btn primary sm" disabled={!text.trim() || busy} onClick={async () => { await onComment(text.trim()); setText(''); }}>Add note</button></div>
      </section>
    );
  }

  return (
    <section className="selection" aria-label="Selected element">
      <div className="sel-head">
        <code id="sel-selector" title={selected.selector}>{selected.selector}</code>
        <button
          type="button"
          className="btn icon ghost"
          title="Copy selector"
          onClick={() => navigator.clipboard?.writeText(selected.selector)}
        >
          <Copy size={15} aria-hidden="true" />
          <span className="sr-only">Copy selector to clipboard</span>
        </button>
      </div>

      <div className="sel-text">{selected.text || <em>{selected.tag} (no text)</em>}</div>

      <label className="sr-only" htmlFor={`${id}-comment`}>Comment on the selected element</label>
      <textarea
        id={`${id}-comment`}
        data-testid="comment"
        className="comment"
        rows={3}
        value={text}
        placeholder="What should change here?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && text.trim()) {
            e.preventDefault();
            onComment(text.trim()).then(() => setText(''));
          }
        }}
      />
      <div className="row">
        <button
          type="button"
          id="comment-send"
          className="btn primary sm"
          disabled={!text.trim() || busy}
          onClick={async () => {
            await onComment(text.trim());
            setText('');
          }}
        >
          Comment
        </button>
        <span className="muted hint">{selected.tag} · {selected.page?.replace(/^https?:\/\//, '')}</span>
      </div>

      <details className="tools">
        <summary>Quick edits</summary>

        <div className="tool-row">
          <span className="sr-only" id={`${id}-text-label`}>Text editing</span>
          <label htmlFor={`${id}-text-label`}>Text</label>
          <div className="control">
            <button type="button" className="btn sm" onClick={() => onOverlay({ type: 'mode', mode: 'text' })}>
              Edit in place
            </button>
            <button type="button" className="btn sm" onClick={() => onOverlay({ type: 'commitText' })}>
              Save text
            </button>
          </div>
        </div>

        <div className="tool-row">
          <label htmlFor={`${id}-style-prop`}>Style</label>
          <div className="control">
            <input
              id={`${id}-style-prop`}
              data-testid="style-prop"
              value={prop}
              onChange={(e) => setProp(e.target.value)}
              placeholder="property"
              spellCheck="false"
            />
            <input
              id={`${id}-style-val`}
              data-testid="style-val"
              aria-label={`${prop || 'CSS'} value`}
              value={val}
              onChange={(e) => setVal(e.target.value)}
              placeholder="value"
              spellCheck="false"
            />
            <button
              type="button"
              className="btn sm"
              onClick={() => onOverlay({ type: 'style', property: prop, value: val })}
            >
              Apply
            </button>
          </div>
        </div>

        <div className="tool-row">
          <label htmlFor={`${id}-class`}>Class</label>
          <div className="control">
            <input
              id={`${id}-class`}
              value={cls}
              onChange={(e) => setCls(e.target.value)}
              placeholder="is-active"
              spellCheck="false"
            />
            <button
              type="button"
              className="btn sm"
              disabled={!cls}
              onClick={() => onOverlay({ type: 'toggleClass', name: cls })}
            >
              Toggle
            </button>
          </div>
        </div>

        <div className="tool-row">
          <label htmlFor={`${id}-attr`}>Attribute</label>
          <div className="control">
            <input
              id={`${id}-attr`}
              value={attrName}
              onChange={(e) => setAttrName(e.target.value)}
              placeholder="aria-label"
              spellCheck="false"
            />
            <input
              id={`${id}-attr-val`}
              aria-label={attrName ? `${attrName} value` : 'Attribute value'}
              value={attrVal}
              onChange={(e) => setAttrVal(e.target.value)}
              placeholder="Close"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && attrName) {
                  onOverlay({ type: 'attribute', property: attrName, value: attrVal });
                }
              }}
            />
            <button
              type="button"
              className="btn sm"
              disabled={!attrName}
              onClick={() => onOverlay({ type: 'attribute', property: attrName, value: attrVal })}
            >
              Set
            </button>
          </div>
        </div>

        <div className="tool-row">
          <span aria-hidden="true" />
          <div className="control">
            <button type="button" className="btn sm danger" onClick={() => onOverlay({ type: 'remove' })}>
              <Trash2 size={14} aria-hidden="true" />
              Hide element
            </button>
            <button type="button" className="btn sm ghost" onClick={() => onOverlay({ type: 'revert' })}>
              <RotateCcw size={14} aria-hidden="true" />
              Clear selection
            </button>
          </div>
        </div>
      </details>
    </section>
  );
}

function CommentItem({ comment, element, onToggle, onUpdate, onSelect }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(comment.text);
  return (
    <li className={`item${comment.resolved ? ' resolved' : ''}`}>
      <div className="item-top">
        <span className={`tag${comment.resolved ? ' done' : ''}`}>
          {comment.resolved ? <Check size={11} aria-hidden="true" /> : null}
          {comment.resolved ? 'Resolved' : 'Open'}
        </span>
        <button type="button" className="item-selector" onClick={() => element && onSelect(element.id)}>
          {element?.selector ?? 'page-level note'}
        </button>
        <span className="item-actions">
          <button type="button" className="btn sm ghost" onClick={() => { setText(comment.text); setEditing((x) => !x); }}>
            <span>{editing ? 'Cancel edit' : 'Edit note'}</span>
          </button>
          <button type="button" className="btn sm ghost" onClick={() => onToggle(comment)}>
            {comment.resolved ? <RotateCcw size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
            <span className="sr-only">{comment.resolved ? 'Reopen comment' : 'Resolve comment'}</span>
          </button>
        </span>
      </div>
      {editing ? <div className="edit-comment"><textarea aria-label="Edit comment" value={text} onChange={(ev) => setText(ev.target.value)} /><button className="btn sm primary" disabled={!text.trim()} onClick={async () => { await onUpdate(comment, text.trim()); setEditing(false); }}>Save note</button></div> : <div className="item-text">{comment.text}</div>}
      {comment.drawing && <div className="annotation-chip"><span aria-hidden="true">{comment.drawing.type === 'arrow' ? '↗' : comment.drawing.type === 'rectangle' ? '▱' : comment.drawing.type === 'ellipse' ? '◯' : '〰'}</span>{comment.drawing.type} annotation</div>}
      <div className="item-meta">
        <span>{fmt(comment.createdAt)}</span>
        {comment.page && <span>{comment.page.replace(/^https?:\/\//, '')}</span>}
      </div>
    </li>
  );
}

function ElementItem({ element, selected, commentCount, onSelect, onDelete }) {
  return (
    <li className={`item${selected ? ' selected' : ''}`}>
      <div className="item-top">
        <span className="tag">{element.tag}</span>
        <button type="button" className="item-selector" onClick={() => onSelect(element.id)}>
          {element.selector}
        </button>
        <span className="item-actions">
          <button
            type="button"
            className="btn sm ghost"
            onClick={(e) => { e.stopPropagation(); onDelete(element); }}
          >
            <X size={14} aria-hidden="true" />
            <span className="sr-only">Remove tagged element</span>
          </button>
        </span>
      </div>
      {element.text && <div className="item-text muted">{element.text.slice(0, 140)}</div>}
      <div className="item-meta">
        <span>{commentCount} comment{commentCount === 1 ? '' : 's'}</span>
        {element.ancestors?.length > 0 && <span>{element.ancestors.slice(-2).join(' ← ')}</span>}
      </div>
    </li>
  );
}

function EditItem({ edit, element, onToggle, onDelete }) {
  return (
    <li className="item">
      <div className="item-top">
        <span className={`tag${edit.applied ? ' done' : ''}`}>
          {edit.applied ? <Check size={11} aria-hidden="true" /> : null}
          {edit.kind}
        </span>
        <span className="item-selector" style={{ cursor: 'default' }}>
          {element?.selector ?? edit.elementId}{edit.property ? ` · ${edit.property}` : ''}
        </span>
        <span className="item-actions">
          <button type="button" className="btn sm ghost" onClick={() => onToggle(edit)}>
            {edit.applied ? <RotateCcw size={14} aria-hidden="true" /> : <Square size={12} aria-hidden="true" />}
            <span className="sr-only">{edit.applied ? 'Mark as not applied' : 'Mark as applied in source'}</span>
          </button>
          <button type="button" className="btn sm ghost" onClick={() => onDelete(edit)}>
            <X size={14} aria-hidden="true" />
            <span className="sr-only">Delete edit</span>
          </button>
        </span>
      </div>
      <div className="item-text">
        {edit.before != null && <span className="diff-before">{String(edit.before)}</span>}
        {edit.before != null && ' → '}
        {edit.after == null ? <em>removed</em> : <span className="diff-after">{String(edit.after)}</span>}
      </div>
      <div className="item-meta">
        <span>{edit.applied ? 'applied in source' : 'preview only'}</span>
        <span>{fmt(edit.createdAt)}</span>
      </div>
    </li>
  );
}

export function toMarkdown(session) {
  const lines = ['# uidit feedback', ''];
  const byElement = new Map(session.elements.map((e) => [e.id, e]));
  const open = session.comments.filter((c) => !c.resolved);
  lines.push(`${open.length} open comment(s), ${session.edits.length} pending edit(s).`, '');
  for (const c of session.comments) {
    const el = byElement.get(c.elementId);
    lines.push(`- ${c.resolved ? '[x]' : '[ ]'} ${el ? `\`${el.selector}\`` : '_page level_'}: ${c.text}`);
  }
  if (session.edits.length) {
    lines.push('', '## Requested edits', '');
    for (const e of session.edits) {
      const el = byElement.get(e.elementId);
      const what = e.property ? `${e.kind} ${e.property}` : e.kind;
      const change = e.after == null ? 'remove' : `\`${e.before}\` → \`${e.after}\``;
      lines.push(`- ${el ? `\`${el.selector}\`` : e.elementId} — ${what}: ${change}${e.applied ? ' (applied)' : ''}`);
    }
  }
  return lines.join('\n');
}

const TABS = [
  ['feedback', 'Feedback'],
  ['inspect', 'Inspect'],
  ['changes', 'Changes'],
];

export default function Sidebar({ session, selectedId, onSelect, actions, onOverlay, onStatus, page, tab: controlledTab, onTab, showTabs = true }) {
  const [localTab, setLocalTab] = useState('feedback');
  const tab = controlledTab ?? localTab;
  const setTab = onTab ?? setLocalTab;
  const [busy, setBusy] = useState(false);
  const selected = session.elements.find((e) => e.id === selectedId) ?? null;

  const run = (fn, message) => async (...args) => {
    try {
      setBusy(true);
      await fn(...args);
      if (message) onStatus(message, 'ok');
    } catch (err) {
      onStatus(err.message, 'error');
      throw err;
    } finally {
      setBusy(false);
    }
  };

  const comment = run(async (text) => {
    await actions.comment({ elementId: selectedId ?? null, text, page: selected?.page ?? page ?? null });
  }, 'Comment saved to .uidit');

  const toggleComment = run((c) => actions.patch('comments', c.id, { resolved: !c.resolved }));
  const toggleEdit = run(async (e) => {
    if (e.applied) return actions.patch('edits', e.id, { applied: false, provenance: null, appliedAt: null });
    const provenance = window.prompt('Describe the source change you made and verified:');
    if (!provenance?.trim()) return;
    return actions.patch('edits', e.id, { applied: true, appliedAt: new Date().toISOString(), provenance: provenance.trim() });
  });
  const drop = run((collection, id) => actions.remove(collection, id), 'Removed');
  const updateComment = run((comment, text) => actions.patch('comments', comment.id, { text }), 'Note updated');

  const [filter, setFilter] = useState('open');
  const [query, setQuery] = useState('');

  const openCount = session.comments.filter((c) => !c.resolved).length;
  const pendingEdits = session.edits.filter((e) => !e.applied).length;
  const counts = { feedback: openCount, inspect: session.elements.length, changes: pendingEdits };
  const filteredComments = [...session.comments].filter((c) => filter === 'all' || (filter === 'resolved' ? c.resolved : !c.resolved)).filter((c) => !query || [c.text, c.page, session.elements.find((element) => element.id === c.elementId)?.selector].filter(Boolean).join(' ').toLowerCase().includes(query.toLowerCase())).reverse();

  const copyFeedback = async () => {
    try {
      await navigator.clipboard.writeText(toMarkdown(session));
      onStatus('Feedback copied as Markdown', 'ok');
    } catch {
      onStatus('Clipboard blocked by the browser', 'error');
    }
  };

  return (
    <aside className="side" aria-label="Review panel">
      {showTabs && <div className="tabs" role="tablist" aria-label="Review views">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className="tab"
            role="tab"
            id={`tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`panel-${key}`}
            onClick={() => setTab(key)}
          >
            {label}
            {counts[key] > 0 && (
              <span className={`count${key === 'feedback' && openCount ? ' hot' : ''}`}>{counts[key]}</span>
            )}
          </button>
        ))}
      </div>}

      {tab === 'feedback' && (
        <div className="panel" role="tabpanel" id="panel-feedback" aria-labelledby={showTabs ? 'tab-feedback' : undefined}>
          <SelectionBox selected={selected} onComment={comment} onOverlay={onOverlay} busy={busy} />
          <div className="feedback-filters"><label><span className="sr-only">Filter comments</span><select value={filter} onChange={(e) => setFilter(e.target.value)}><option value="open">Open · {openCount}</option><option value="all">All · {session.comments.length}</option><option value="resolved">Resolved · {session.comments.length - openCount}</option></select></label><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search notes, pages, selectors" aria-label="Search notes, pages, and selectors" /></div>
          <ul className="list">
            {session.comments.length === 0 && (
              <li className="empty-state">
                No feedback yet. Add a page note above or select an element in the preview to leave a focused note.
              </li>
            )}
            {session.comments.length > 0 && filteredComments.length === 0 && <li className="empty-state filter-empty">No notes match these filters.<button type="button" className="btn sm ghost" onClick={() => { setFilter('all'); setQuery(''); }}>Clear filters</button></li>}
            {filteredComments.map((c) => (
              <CommentItem
                key={c.id}
                comment={c}
                element={session.elements.find((e) => e.id === c.elementId)}
                onToggle={toggleComment}
                onUpdate={updateComment}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </div>
      )}

      {tab === 'inspect' && (
        <div className="panel" role="tabpanel" id="panel-inspect" aria-labelledby={showTabs ? 'tab-inspect' : undefined}>
          <ul className="list">
            {session.elements.length === 0 && (
              <li className="empty-state">Click an element in the preview to tag it.</li>
            )}
            {session.elements.map((e) => (
              <ElementItem
                key={e.id}
                element={e}
                selected={e.id === selectedId}
                commentCount={session.comments.filter((c) => c.elementId === e.id).length}
                onSelect={onSelect}
                onDelete={drop.bind(null, 'elements', e.id)}
              />
            ))}
          </ul>
        </div>
      )}

      {tab === 'changes' && (
        <div className="panel" role="tabpanel" id="panel-changes" aria-labelledby={showTabs ? 'tab-changes' : undefined}>
          <ul className="list">
            {session.edits.length === 0 && (
              <li className="empty-state">
                No quick edits yet. Select an element and use Quick edits to try a change in the preview.
              </li>
            )}
            {[...session.edits].reverse().map((e) => (
              <EditItem
                key={e.id}
                edit={e}
                element={session.elements.find((x) => x.id === e.elementId)}
                onToggle={toggleEdit}
                onDelete={drop.bind(null, 'edits', e.id)}
              />
            ))}
          </ul>
        </div>
      )}

      <footer className="foot">
        <button type="button" className="btn sm ghost" onClick={copyFeedback}>
          <ClipboardCopy size={14} aria-hidden="true" />
          Copy as Markdown
        </button>
        <span className="spacer" />
        <span className="muted hint foot-sel" title={selected?.selector ?? 'No element selected'}>
          <MousePointerClick size={13} aria-hidden="true" />
          {selected ? selected.selector : 'no selection'}
        </span>
      </footer>
    </aside>
  );
}
