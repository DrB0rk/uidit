import { useId, useState } from 'react';
import {
  Check, X, Copy, MousePointerClick, Trash2, RotateCcw, ClipboardCopy, Square, Users, Link2, ImagePlus,
} from 'lucide-react';
import { triageFeedback } from '../../../src/server/triage.js';
import { readImageFiles } from '../lib/image-files.js';

const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

function PhotoAttachments({ attachments, onChange, onStatus }) {
  const [busy, setBusy] = useState(false);
  const add = async (files) => {
    const remaining = Math.max(0, 2 - attachments.length);
    if (!remaining) { onStatus('A comment can include up to 2 photos', 'error'); return; }
    setBusy(true);
    try {
      const next = await readImageFiles([...files].slice(0, remaining));
      onChange([...attachments, ...next]);
    } catch (error) { onStatus(error.message, 'error'); }
    finally { setBusy(false); }
  };
  return <div className="comment-photo-picker" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); add(event.dataTransfer.files); }}>
    <label className="photo-pick-button"><ImagePlus size={14} aria-hidden="true"/><span>{busy ? 'Preparing…' : 'Add photo'}</span><input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple onChange={(event) => { add(event.target.files); event.target.value = ''; }} /></label>
    <span className="photo-hint">or paste / drop · up to 2</span>
    {attachments.map((image, index) => <span className="comment-photo-thumb" key={`${image.name}:${index}`}><img src={image.dataUrl} alt={`Attached reference ${index + 1}`} /><button type="button" aria-label={`Remove ${image.name}`} onClick={() => onChange(attachments.filter((_, itemIndex) => itemIndex !== index))}>×</button></span>)}
  </div>;
}

async function pasteCommentImages(event, attachments, setAttachments, onStatus) {
  const files = [...(event.clipboardData?.items ?? [])].map((item) => item.getAsFile?.()).filter(Boolean);
  if (!files.length) return;
  event.preventDefault();
  const remaining = Math.max(0, 2 - attachments.length);
  if (!remaining) { onStatus('A comment can include up to 2 photos', 'error'); return; }
  try { setAttachments([...attachments, ...(await readImageFiles(files.slice(0, remaining)))]); }
  catch (error) { onStatus(error.message, 'error'); }
}

function ShareReview({ collaboration, actions, onStatus, busy, setBusy }) {
  const create = async () => {
    try {
      setBusy(true);
      await actions.createCollaborationRoom({});
      onStatus('Share link created', 'ok');
    } catch (error) { onStatus(error.message, 'error'); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(collaboration.inviteUrl); onStatus('Share link copied', 'ok'); }
    catch { onStatus('Clipboard blocked by the browser', 'error'); }
  };
  const revoke = async () => {
    if (!window.confirm('Rotate this review link and disconnect everyone currently reviewing? The old link will stop working.')) return;
    try { setBusy(true); await actions.revokeCollaborationInvite(); onStatus('Review link rotated; previous participants disconnected', 'ok'); }
    catch (error) { onStatus(error.message, 'error'); }
    finally { setBusy(false); }
  };
  const stopSharing = async () => {
    if (!window.confirm('Stop sharing this review completely? Everyone will be disconnected, the link will stop working, and the shared page snapshot will be deleted.')) return;
    try { setBusy(true); await actions.stopCollaborationSharing(); onStatus('Review sharing stopped; the link is permanently invalid', 'ok'); }
    catch (error) { onStatus(error.message, 'error'); }
    finally { setBusy(false); }
  };
  const sharePageView = async () => {
    try { setBusy(true); await actions.createCollaborationPageView(); onStatus('HTML snapshot shared with reviewers', 'ok'); }
    catch (error) { onStatus(error.message, 'error'); }
    finally { setBusy(false); }
  };
  return <section className="share-review" aria-label="Share team review">
    <div className="share-review-top"><span className="share-review-icon"><Users size={15} aria-hidden="true" /></span><div><strong>Team review</strong><small>{collaboration?.enabled ? `${collaboration.participants?.length ?? 0} online · ${collaboration.connected ? 'Live' : 'Reconnecting'}` : 'Invite someone to review this page'}</small></div>
      {collaboration?.inviteUrl ? <button type="button" className="btn primary sm" onClick={copy}><Copy size={13} />Copy link</button> : <button type="button" className="btn sm" onClick={create} disabled={busy}><Link2 size={13} />{busy ? 'Creating…' : 'Create link'}</button>}
    </div>
    {!collaboration?.inviteUrl && <p className="share-review-help">Create a comment-only link on uidit.app. Anyone with the link can join for 7 days.</p>}
    {collaboration?.inviteUrl && <div className="share-review-link"><input aria-label="Team review share link" readOnly value={collaboration.inviteUrl} onFocus={(event) => event.target.select()} /><span>{collaboration.error || collaboration.project} · share a static HTML snapshot for reviewers; scripts and controls are disabled · no tunnel or local server access needed · expires {collaboration.inviteExpiresAt ? new Date(collaboration.inviteExpiresAt).toLocaleDateString() : 'unknown'}</span><div className="share-review-actions"><button type="button" className="btn sm" disabled={busy} onClick={sharePageView}><MousePointerClick size={13}/>{busy ? 'Capturing…' : collaboration.pageView?.capturedAt ? 'Refresh HTML snapshot' : 'Share HTML snapshot'}</button>{collaboration.pageView?.capturedAt && <span>Updated {fmt(collaboration.pageView.capturedAt)}</span>}<button type="button" className="btn sm danger" disabled={busy} onClick={revoke}>Revoke and rotate link</button><button type="button" className="btn sm danger" disabled={busy} onClick={stopSharing}>Stop sharing</button></div></div>}
    {collaboration?.activity?.length > 0 && <details className="share-review-activity"><summary>Recent review activity</summary><ul>{collaboration.activity.slice(0, 5).map((item) => <li key={item.id ?? `${item.type}-${item.at}`}><strong>{item.name}</strong> {item.type.replaceAll('-', ' ')} · <time>{new Date(item.at).toLocaleTimeString()}</time></li>)}</ul></details>}
  </section>;
}

function SelectionBox({ selected, onComment, onOverlay, busy, onStatus }) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [prop, setProp] = useState('padding');
  const [val, setVal] = useState('16px');
  const [cls, setCls] = useState('');
  const [attrName, setAttrName] = useState('');
  const [attrVal, setAttrVal] = useState('');
  const id = useId();
  const submitComment = () => {
    if (busy || (!text.trim() && !attachments.length)) return;
    return onComment(text.trim() || 'See attached reference photo.', attachments).then(() => { setText(''); setAttachments([]); });
  };
  const onCommentKeyDown = (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || (!text.trim() && !attachments.length)) return;
    event.preventDefault();
    submitComment();
  };

  if (!selected) {
    return (
      <section className="selection selection-empty" aria-label="Add page feedback">
        <div className="selection-intro"><strong>Leave page feedback</strong><span>Select an element to attach a note, or add a general page note.</span></div>
        <label className="sr-only" htmlFor={`${id}-comment`}>Add a note about this page</label>
        <textarea id={`${id}-comment`} data-testid="comment" className="comment" rows={2} value={text} placeholder="What should change on this page?" onChange={(e) => setText(e.target.value)} onPaste={(event) => pasteCommentImages(event, attachments, setAttachments, onStatus)} onKeyDown={onCommentKeyDown} />
        <PhotoAttachments attachments={attachments} onChange={setAttachments} onStatus={onStatus} />
        <div className="row selection-actions"><span className="muted hint">Page-level note · Enter to send · Shift+Enter for a new line</span><button type="button" className="btn primary sm" disabled={(!text.trim() && !attachments.length) || busy} onClick={submitComment}>Add note</button></div>
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
        onPaste={(event) => pasteCommentImages(event, attachments, setAttachments, onStatus)}
        onKeyDown={onCommentKeyDown}
      />
      <PhotoAttachments attachments={attachments} onChange={setAttachments} onStatus={onStatus} />
      <div className="row">
        <button
          type="button"
          id="comment-send"
          className="btn primary sm"
          disabled={(!text.trim() && !attachments.length) || busy}
          onClick={submitComment}
        >
          Comment
        </button>
        <span className="muted hint">{selected.tag} · Enter to send · Shift+Enter for a new line</span>
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

function CommentItem({ comment, element, anchorStatus, hasTask, onCreateTask, onReattach, onToggle, onDelete, onUpdate, onReply, onSelect, onCodeRef, onStatus, onAssign, collaborators = [] }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(comment.text);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [codeOpen, setCodeOpen] = useState(false);
  const [codeFile, setCodeFile] = useState('');
  const [codeStart, setCodeStart] = useState('');
  const [codeEnd, setCodeEnd] = useState('');
  return (
    <li className={`item${comment.resolved ? ' resolved' : ''}`}>
      <div className="item-top">
        {comment.resolved ? <span className="tag done"><Check size={11} aria-hidden="true" />Resolved</span> : <label className="tag comment-status"><span className="sr-only">Feedback status</span><select aria-label="Feedback status" value={comment.status ?? 'open'} onChange={(event) => onStatus(comment, event.target.value)}><option value="open">Open</option><option value="in_progress">In progress</option><option value="needs_info">Needs info</option></select></label>}
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
          <button type="button" className="btn sm ghost danger" aria-label="Delete note" title="Delete note" onClick={() => onDelete(comment)}>
            <Trash2 size={14} aria-hidden="true" />
          </button>
        </span>
      </div>
      {anchorStatus?.status === 'missing' && <div className="anchor-notice">Element not found on this page. Its original comment and location are preserved.</div>}
      {anchorStatus?.status === 'recovered' && anchorStatus.candidates?.[0] && <div className="anchor-notice">Possible match · {anchorStatus.candidates[0].selector}<button type="button" className="btn sm ghost" onClick={() => onReattach(comment, anchorStatus.candidates[0])}>Reattach comment</button></div>}
      {anchorStatus?.status === 'ambiguous' && <div className="anchor-notice">Several possible matches. Choose the correct element:<div className="anchor-candidates">{anchorStatus.candidates?.map((candidate) => <button key={candidate.selector} type="button" className="btn sm ghost" onClick={() => onReattach(comment, candidate)}>{candidate.accessibleName || candidate.selector}</button>)}</div></div>}
      {editing ? <div className="edit-comment"><textarea aria-label="Edit comment" value={text} onChange={(ev) => setText(ev.target.value)} /><button className="btn sm primary" disabled={!text.trim()} onClick={async () => { await onUpdate(comment, text.trim()); setEditing(false); }}>Save note</button></div> : <div className="item-text">{comment.text}</div>}
      {comment.attachments?.length > 0 && <div className="comment-attachments" aria-label="Comment reference photos">{comment.attachments.map((image, index) => <a key={`${image.name}:${index}`} href={image.dataUrl} target="_blank" rel="noreferrer" title={image.name}><img src={image.dataUrl} alt={image.name || `Comment reference ${index + 1}`} loading="lazy" /><span>{image.name || `Reference ${index + 1}`}</span></a>)}</div>}
      {(comment.replies ?? []).map((reply) => <div className="comment-reply" key={reply.id}><strong>{reply.displayName || (reply.author === 'agent' ? 'Agent' : 'You')}</strong><span>{reply.text}</span></div>)}
      {(comment.codeRefs ?? []).map((reference, index) => <div className="code-reference" key={`${reference.file}:${reference.startLine}:${index}`}><span>Code</span><code>{reference.file}:{reference.startLine}{reference.endLine !== reference.startLine ? `–${reference.endLine}` : ''}</code></div>)}
      {collaborators.length > 0 && <label className="assignee-picker">Assigned to <select aria-label="Assign feedback" value={comment.assignee ?? ''} onChange={(event) => onAssign(comment, event.target.value || null)}><option value="">Unassigned</option>{comment.assignee && !collaborators.some((person) => person.name === comment.assignee) && <option value={comment.assignee}>{comment.assignee}</option>}{collaborators.map((person) => <option key={person.memberId} value={person.name}>{person.name}</option>)}</select></label>}
      <div className="reply-tools"><button type="button" className="btn sm ghost" onClick={() => setReplyOpen((open) => !open)}>{replyOpen ? 'Cancel reply' : 'Reply'}</button><button type="button" className="btn sm ghost" onClick={() => setCodeOpen((open) => !open)}>{codeOpen ? 'Cancel link' : 'Link code'}</button>{!hasTask && <button type="button" className="btn sm ghost" onClick={() => onCreateTask(comment)}>Create task</button>}</div>
      {replyOpen && <div className="edit-comment"><textarea aria-label="Reply to comment" value={replyText} onChange={(ev) => setReplyText(ev.target.value)} placeholder="Reply or ask the agent a question" /><button type="button" className="btn sm primary" disabled={!replyText.trim()} onClick={async () => { await onReply(comment, replyText.trim()); setReplyText(''); setReplyOpen(false); }}>Send reply</button></div>}
      {codeOpen && <form className="code-reference-form" onSubmit={async (event) => { event.preventDefault(); await onCodeRef(comment, { file: codeFile, startLine: Number(codeStart), endLine: Number(codeEnd || codeStart) }); setCodeFile(''); setCodeStart(''); setCodeEnd(''); setCodeOpen(false); }}><input required maxLength={500} value={codeFile} onChange={(event) => setCodeFile(event.target.value)} placeholder="src/components/Card.tsx" aria-label="Project relative file path" /><input required type="number" min="1" value={codeStart} onChange={(event) => setCodeStart(event.target.value)} placeholder="Line" aria-label="Start line" /><input type="number" min={codeStart || 1} value={codeEnd} onChange={(event) => setCodeEnd(event.target.value)} placeholder="To" aria-label="End line" /><button className="btn sm primary" type="submit">Add link</button></form>}
      {comment.drawing && <div className="annotation-chip"><span aria-hidden="true">{comment.drawing.type === 'arrow' ? '↗' : comment.drawing.type === 'rectangle' ? '▱' : comment.drawing.type === 'ellipse' ? '◯' : '〰'}</span>{comment.drawing.type} annotation</div>}
      <div className="item-meta">
        {comment.author && <span>{comment.author}</span>}
        <span>{fmt(comment.createdAt)}</span>
        {comment.page && <span>{comment.page.replace(/^https?:\/\//, '')}</span>}
      </div>
    </li>
  );
}

function AgentTaskQueue({ tasks = [], evidence = [], onUpdate, onStatus }) {
  const update = async (task, status) => { try { await onUpdate(task.id, { status, expectedRevision: task.revision }); onStatus(status === 'accepted' ? 'Task accepted' : status === 'cancelled' ? 'Task cancelled' : 'Task reopened', 'ok'); } catch (error) { onStatus(error.message, 'error'); } };
  return <details className="agent-task-queue"><summary>Agent tasks · {tasks.length}</summary>{tasks.length ? <ul>{[...tasks].reverse().map((task) => <li key={task.id}><div><strong>{task.title}</strong><small>{task.status.replaceAll('_', ' ')}{task.owner ? ` · ${task.owner}` : ''}</small></div><span>{task.evidenceIds?.length ?? 0} evidence</span>{(task.evidenceIds ?? []).map((id) => evidence.find((item) => item.id === id)).filter(Boolean).slice(-2).map((item) => <small key={item.id}>{item.type}: {item.result} · {item.summary}</small>)}{task.events?.length > 0 && <details className="task-activity"><summary>Activity · {task.events.length}</summary><ol>{task.events.slice(-8).reverse().map((event) => <li key={event.id ?? `${event.type}:${event.at}`}><strong>{event.type.replaceAll('_', ' ')}</strong><span>{event.detail || event.actor}</span><time dateTime={event.at}>{fmt(event.at)}</time></li>)}</ol></details>}{task.status === 'verified' && <button type="button" className="btn sm primary" onClick={() => update(task, 'accepted')}>Accept verified work</button>}{['open','acknowledged','in_progress','blocked','reopened'].includes(task.status) && <button type="button" className="btn sm ghost" onClick={() => update(task, 'cancelled')}>Cancel task</button>}{task.status === 'accepted' && <button type="button" className="btn sm ghost" onClick={() => update(task, 'reopened')}>Reopen task</button>}</li>)}</ul> : <p>Create a task from a feedback note to track progress and evidence.</p>}</details>;
}

function FeedbackTriage({ comments, elements }) {
  const triage = triageFeedback(comments, elements);
  return <section className="feedback-triage" aria-label="Feedback triage suggestions">
    <strong>Suggested order</strong><p>{triage.method}</p>
    <ol>{triage.suggestedOrder.map((item) => <li key={item.id}><span className={`priority ${item.priority}`}>{item.priority}</span><span>{item.text}</span><small>{item.element?.selector ?? item.page ?? 'Page feedback'} · {item.status.replace('_', ' ')}</small></li>)}</ol>
    {triage.relatedGroups.length > 0 && <div className="triage-groups"><strong>Related groups</strong>{triage.relatedGroups.map((group) => <p key={group.id}>{group.label} · {group.commentIds.length} notes</p>)}</div>}
    {triage.possibleDuplicates.length > 0 && <div className="triage-groups"><strong>Possible duplicates</strong>{triage.possibleDuplicates.map(([left, right]) => <p key={`${left}:${right}`}>{triage.suggestedOrder.find((item) => item.id === left)?.text} ↔ {triage.suggestedOrder.find((item) => item.id === right)?.text}</p>)}</div>}
  </section>;
}

function ElementItem({ element, selected, commentCount, onSelect, onDelete, findSource, onStatus }) {
  const [source, setSource] = useState(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const inspectSource = async () => {
    setSourceBusy(true);
    try { setSource(await findSource(element.id)); }
    catch (error) { onStatus(error.message, 'error'); }
    finally { setSourceBusy(false); }
  };
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
      {element.accessibleName && <div className="element-context"><strong>{element.role ?? element.tag}</strong><span>{element.accessibleName}</span>{element.component && <small>{element.component.framework} · {element.component.name}</small>}</div>}
      {element.text && <div className="item-text muted">{element.text.slice(0, 140)}</div>}
      {element.nearbyText && element.nearbyText !== element.text && <div className="element-nearby" title={element.nearbyText}>Nearby: {element.nearbyText.slice(0, 140)}</div>}
      <div className="element-source-actions"><button type="button" className="btn sm ghost" onClick={inspectSource}>{sourceBusy ? 'Searching…' : source ? 'Refresh source suggestions' : 'Find source'}</button><button type="button" className="btn sm ghost" onClick={() => navigator.clipboard?.writeText(JSON.stringify({ selector: element.selector, role: element.role, accessibleName: element.accessibleName, component: element.component, ancestors: element.ancestors }, null, 2))}>Copy agent context</button></div>
      {source && <div className="source-suggestions"><strong>{source.status === 'inferred' ? 'Suggested source · confirm manually' : 'Source unavailable'}</strong>{source.candidates?.map((candidate) => <div key={`${candidate.file}:${candidate.line}`}><code>{candidate.file}:{candidate.line}</code><small>{candidate.snippet}</small></div>)}<small>{source.limitation}</small></div>}
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

function ProposalItem({ proposal, element, selected, onOverlay, onUpdate, onStatus }) {
  const preview = async () => {
    if (!selected) return;
    try {
      onOverlay({ type: 'proposalPreview', operation: proposal.operation, changes: proposal.changes });
      await onUpdate(proposal.id, 'previewed');
      onStatus('Proposal previewed on the selected element; source is unchanged', 'ok');
    } catch (error) { onStatus(error.message, 'error'); }
  };
  return <li className="item proposal-item"><div className="item-top"><span className="tag">Agent proposal</span><span className="item-selector">{element?.selector ?? 'Unknown element'}</span><span className="tag">{proposal.status}</span></div><strong>{proposal.title}</strong><ul className="proposal-changes">{proposal.changes.map((change, index) => <li key={`${change.property}:${index}`}><code>{change.property}</code><span>{change.before ?? '—'} → {change.value}</span></li>)}</ul><div className="reply-tools"><button type="button" className="btn sm" disabled={!selected} onClick={preview}>{selected ? 'Preview on selected element' : 'Select the tagged element to preview'}</button>{proposal.status === 'previewed' && <button type="button" className="btn sm ghost" onClick={() => { onOverlay({ type: 'proposalReset' }); onStatus('Proposal preview reverted', 'ok'); }}>Revert preview</button>}</div>{proposal.status !== 'rejected' && proposal.status !== 'accepted' && <div className="reply-tools"><button type="button" className="btn sm primary" onClick={() => onUpdate(proposal.id, 'accepted')}>Accept request</button><button type="button" className="btn sm ghost" onClick={() => onUpdate(proposal.id, 'rejected')}>Reject</button></div>}<small className="muted">Preview changes are temporary. Accepting records approval; source changes still need implementation.</small></li>;
}

export function toMarkdown(session) {
  const lines = ['# uidit feedback', ''];
  const byElement = new Map(session.elements.map((e) => [e.id, e]));
  const open = session.comments.filter((c) => !c.resolved);
  lines.push(`${open.length} open comment(s), ${session.edits.length} pending edit(s).`, '');
  for (const c of session.comments) {
    const el = byElement.get(c.elementId);
    lines.push(`- ${c.resolved ? '[x]' : '[ ]'} **${c.status ?? 'open'}** ${el ? `\`${el.selector}\`` : '_page level_'}: ${c.text}`);
    for (const ref of c.codeRefs ?? []) lines.push(`  - Code: \`${ref.file}:${ref.startLine}${ref.endLine !== ref.startLine ? `-${ref.endLine}` : ''}\``);
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

export default function Sidebar({ session, selectedId, anchorStatuses = {}, onSelect, actions, onOverlay, onStatus, page, collaboration, tab: controlledTab, onTab, showTabs = true }) {
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

  const comment = run(async (text, attachments = []) => {
    await actions.comment({ elementId: selectedId ?? null, text, page: selected?.page ?? page ?? null, attachments });
  }, 'Comment saved to .uidit');

  const toggleComment = run((c) => actions.patch('comments', c.id, { resolved: !c.resolved }));
  const toggleEdit = run(async (e) => {
    if (e.applied) return actions.patch('edits', e.id, { applied: false, provenance: null, appliedAt: null });
    const provenance = window.prompt('Describe the source change you made and verified:');
    if (!provenance?.trim()) return;
    return actions.patch('edits', e.id, { applied: true, appliedAt: new Date().toISOString(), provenance: provenance.trim() });
  });
  const drop = run((collection, id) => actions.remove(collection, id), 'Removed');
  const deleteComment = run((c) => actions.remove('comments', c.id), 'Note deleted');
  const updateComment = run((comment, text) => actions.patch('comments', comment.id, { text }), 'Note updated');
  const replyComment = run((comment, text) => actions.reply(comment.id, { text, author: 'reviewer' }), 'Reply added');
  const addCodeReference = run((comment, reference) => actions.patch('comments', comment.id, { codeRefs: [...(comment.codeRefs ?? []), reference] }), 'Code reference added');
  const setCommentStatus = run((comment, status) => actions.patch('comments', comment.id, { status }), 'Feedback status updated');
  const assignComment = run((comment, assignee) => actions.patch('comments', comment.id, { assignee }), 'Feedback assignment updated');
  const createTask = run((comment) => actions.createTask({ title: comment.text.slice(0, 200), commentIds: [comment.id] }), 'Agent task created');
  const reattachComment = run(async (comment, candidate) => { const { element } = await actions.element(candidate); return actions.reattachComment(comment.id, element.id); }, 'Comment reattached');

  const [filter, setFilter] = useState('open');
  const [query, setQuery] = useState('');
  const [showTriage, setShowTriage] = useState(false);

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
          <div className="panel-heading"><h2>Feedback</h2><span>{openCount} open</span></div>
          <ShareReview collaboration={collaboration} actions={actions} onStatus={onStatus} busy={busy} setBusy={setBusy} />
          <SelectionBox selected={selected} onComment={comment} onOverlay={onOverlay} busy={busy} onStatus={onStatus} />
          <div className="feedback-filters"><label><span className="sr-only">Filter comments</span><select value={filter} onChange={(e) => setFilter(e.target.value)}><option value="open">Open · {openCount}</option><option value="all">All · {session.comments.length}</option><option value="resolved">Resolved · {session.comments.length - openCount}</option></select></label><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search notes, pages, selectors" aria-label="Search notes, pages, and selectors" /><button type="button" className="btn sm ghost" onClick={() => setShowTriage((shown) => !shown)}>{showTriage ? 'Hide triage' : 'Triage'}</button></div>
          {showTriage && <FeedbackTriage comments={session.comments} elements={session.elements} />}
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
                anchorStatus={anchorStatuses[c.id]}
                hasTask={(session.tasks ?? []).some((task) => task.commentIds?.includes(c.id))}
                onCreateTask={createTask}
                onReattach={reattachComment}
                onToggle={toggleComment}
                onDelete={deleteComment}
                onUpdate={updateComment}
                onReply={replyComment}
                onSelect={onSelect}
                onCodeRef={addCodeReference}
                onStatus={setCommentStatus}
                onAssign={assignComment}
                collaborators={collaboration?.participants ?? []}
              />
            ))}
          </ul>
          <AgentTaskQueue tasks={session.tasks} evidence={session.evidence} onUpdate={actions.updateTask} onStatus={onStatus} />
        </div>
      )}

      {tab === 'inspect' && (
        <div className="panel" role="tabpanel" id="panel-inspect" aria-labelledby={showTabs ? 'tab-inspect' : undefined}>
          <div className="panel-heading"><h2>Tagged elements</h2><span>{session.elements.length}</span></div>
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
                findSource={actions.elementSource}
                onStatus={onStatus}
              />
            ))}
          </ul>
        </div>
      )}

      {tab === 'changes' && (
        <div className="panel" role="tabpanel" id="panel-changes" aria-labelledby={showTabs ? 'tab-changes' : undefined}>
          <div className="panel-heading"><h2>Preview changes</h2><span>{session.edits.filter((edit) => !edit.applied).length} pending</span></div>
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
            {[...session.proposals].reverse().map((proposal) => <ProposalItem key={proposal.id} proposal={proposal} element={session.elements.find((item) => item.id === proposal.elementId)} selected={selected?.id === proposal.elementId} onOverlay={onOverlay} onUpdate={actions.updateProposal} onStatus={onStatus} />)}
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
