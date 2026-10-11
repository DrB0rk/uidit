import { useState } from 'react';

const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : '');

function SelectionBox({ selected, onComment, onOverlay, busy }) {
  const [text, setText] = useState('');
  const [prop, setProp] = useState('padding');
  const [val, setVal] = useState('16px');
  const [cls, setCls] = useState('');
  const [attrName, setAttrName] = useState('');
  const [attrVal, setAttrVal] = useState('');

  if (!selected) {
    return (
      <div className="empty-state">
        Click any element in the preview to tag it.
        <br />
        Hold <kbd>Text</kbd> mode to edit copy in place.
      </div>
    );
  }

  return (
    <div className="selection">
      <div className="sel-head">
        <code id="sel-selector">{selected.selector}</code>
        <button
          className="btn tiny"
          onClick={() => navigator.clipboard?.writeText(selected.selector)}
        >
          copy
        </button>
      </div>
      <div className="sel-text">{selected.text || <em>{selected.tag} (no text)</em>}</div>
      <textarea
        id="comment"
        className="comment"
        rows={3}
        value={text}
        placeholder="Comment on the selected element…"
        onChange={(e) => setText(e.target.value)}
      />
      <div className="row">
        <button
          id="comment-send"
          className="btn primary small"
          disabled={!text.trim() || busy}
          onClick={async () => { await onComment(text.trim()); setText(''); }}
        >
          Comment
        </button>
        <span className="muted">{selected.tag} · {selected.page?.replace(/^https?:\/\//, '')}</span>
      </div>

      <details className="tools">
        <summary>Quick edits</summary>
        <div className="tool-row">
          <label>Text</label>
          <button className="btn small" onClick={() => onOverlay({ type: 'mode', mode: 'text' })}>Edit in place</button>
          <button className="btn small" onClick={() => onOverlay({ type: 'commitText' })}>Save text</button>
        </div>
        <div className="tool-row">
          <label>Style</label>
          <input id="style-prop" value={prop} onChange={(e) => setProp(e.target.value)} placeholder="padding" />
          <input id="style-val" value={val} onChange={(e) => setVal(e.target.value)} placeholder="16px" />
          <button className="btn small" onClick={() => onOverlay({ type: 'style', property: prop, value: val })}>
            Apply
          </button>
        </div>
        <div className="tool-row">
          <label>Class</label>
          <input value={cls} onChange={(e) => setCls(e.target.value)} placeholder="is-active" />
          <button className="btn small" disabled={!cls} onClick={() => onOverlay({ type: 'toggleClass', name: cls })}>
            Toggle
          </button>
        </div>
        <div className="tool-row">
          <label>Attr</label>
          <input value={attrName} onChange={(e) => setAttrName(e.target.value)} placeholder="aria-label" />
          <input value={attrVal} onChange={(e) => setAttrVal(e.target.value)} placeholder="Close" />
          <button
            className="btn small"
            disabled={!attrName}
            onClick={() => onOverlay({ type: 'attribute', property: attrName, value: attrVal })}
          >
            Set
          </button>
        </div>
        <div className="tool-row">
          <button className="btn small danger" onClick={() => onOverlay({ type: 'remove' })}>
            Remove (preview only)
          </button>
          <button className="btn small" onClick={() => onOverlay({ type: 'revert' })}>Revert selection</button>
        </div>
      </details>
    </div>
  );
}

function CommentItem({ comment, element, onToggle, onDelete, onSelect }) {
  return (
    <li className={`item${comment.resolved ? ' resolved' : ''}`}>
      <div className="item-top">
        <span className="tag">{comment.resolved ? 'resolved' : 'open'}</span>
        <code className="item-selector" onClick={() => element && onSelect(element.id)}>
          {element?.selector ?? 'page'}
        </code>
        <span className="item-actions">
          <button className="btn tiny" onClick={() => onToggle(comment)}>
            {comment.resolved ? 'Reopen' : 'Resolve'}
          </button>
          <button className="btn tiny" onClick={() => onDelete(comment)}>✕</button>
        </span>
      </div>
      <div className="item-text">{comment.text}</div>
      <div className="item-meta"><span>{fmt(comment.createdAt)}</span>{comment.page && <span>{comment.page}</span>}</div>
    </li>
  );
}

function ElementItem({ element, selected, commentCount, onSelect, onDelete }) {
  return (
    <li className={`item${selected ? ' selected' : ''}`} onClick={() => onSelect(element.id)}>
      <div className="item-top">
        <span className="tag">{element.tag}</span>
        <code className="item-selector">{element.selector}</code>
        <span className="item-actions">
          <button className="btn tiny" onClick={(e) => { e.stopPropagation(); onDelete(element); }}>✕</button>
        </span>
      </div>
      {element.text && <div className="item-text muted">{element.text.slice(0, 140)}</div>}
      <div className="item-meta">
        <span>{commentCount} comment(s)</span>
        <span>{element.ancestors?.slice(-2).join(' ← ')}</span>
      </div>
    </li>
  );
}

function EditItem({ edit, element, onToggle, onDelete }) {
  return (
    <li className="item">
      <div className="item-top">
        <span className="tag">{edit.kind}</span>
        <code className="item-selector">
          {element?.selector ?? edit.elementId}{edit.property ? ` · ${edit.property}` : ''}
        </code>
        <span className="item-actions">
          <button className="btn tiny" onClick={() => onToggle(edit)}>{edit.applied ? 'applied ✓' : 'mark applied'}</button>
          <button className="btn tiny" onClick={() => onDelete(edit)}>✕</button>
        </span>
      </div>
      <div className="item-text">
        {edit.before != null && <span className="diff-before">{String(edit.before)}</span>}
        {edit.before != null && ' → '}
        {edit.after == null ? <em>removed</em> : <span className="diff-after">{String(edit.after)}</span>}
      </div>
      <div className="item-meta"><span>{fmt(edit.createdAt)}</span></div>
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

export default function Sidebar({ session, selectedId, onSelect, actions, onOverlay, onStatus }) {
  const [tab, setTab] = useState('feedback');
  const [busy, setBusy] = useState(false);
  const selected = session.elements.find((e) => e.id === selectedId) ?? null;

  const run = (fn, message) => async (...args) => {
    try {
      setBusy(true);
      await fn(...args);
      onStatus(message, 'ok');
    } catch (err) {
      onStatus(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const comment = run(async (text) => {
    await actions.comment({ elementId: selectedId ?? null, text, page: selected?.page ?? null });
  }, 'comment saved to .uidit');

  const toggleComment = run((c) => actions.patch('comments', c.id, { resolved: !c.resolved }), 'comment updated');
  const toggleEdit = run((e) => actions.patch('edits', e.id, { applied: !e.applied }), 'edit updated');
  const drop = run((collection, id) => actions.remove(collection, id), 'removed');

  const openCount = session.comments.filter((c) => !c.resolved).length;

  return (
    <aside className="side">
      <div className="tabs" role="tablist">
        {[
          ['feedback', `Feedback${openCount ? ` (${openCount})` : ''}`],
          ['elements', `Elements (${session.elements.length})`],
          ['edits', `Edits (${session.edits.filter((e) => !e.applied).length})`],
        ].map(([key, label]) => (
          <button
            key={key}
            className={`tab${tab === key ? ' active' : ''}`}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'feedback' && (
        <div className="panel">
          <SelectionBox selected={selected} onComment={comment} onOverlay={onOverlay} busy={busy} />
          <ul className="list">
            {session.comments.length === 0 && <li className="empty-state">No feedback yet.</li>}
            {[...session.comments].reverse().map((c) => (
              <CommentItem
                key={c.id}
                comment={c}
                element={session.elements.find((e) => e.id === c.elementId)}
                onToggle={toggleComment}
                onDelete={drop.bind(null, 'comments', c.id)}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </div>
      )}

      {tab === 'elements' && (
        <div className="panel">
          <ul className="list">
            {session.elements.length === 0 && <li className="empty-state">Click an element in the preview to tag it.</li>}
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

      {tab === 'edits' && (
        <div className="panel">
          <ul className="list">
            {session.edits.length === 0 && <li className="empty-state">No edits yet — use Quick edits on a selected element.</li>}
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
        <button
          className="btn tiny"
          onClick={() => {
            navigator.clipboard?.writeText(toMarkdown(session));
            onStatus('feedback copied as Markdown', 'ok');
          }}
        >
          Copy feedback as Markdown
        </button>
      </footer>
    </aside>
  );
}