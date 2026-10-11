import { useState } from 'react';
import { Eye, ImagePlus, RotateCcw, WandSparkles } from 'lucide-react';
import { readImageFiles } from '../lib/image-files.js';

const variants = [
  { id: 'soft', name: 'Soft card', description: 'Gentle depth, generous spacing', styles: [['border-radius', '16px'], ['box-shadow', '0 8px 26px rgb(28 35 52 / 14%)'], ['padding', '20px']] },
  { id: 'compact', name: 'Compact', description: 'Tighter, more information dense', styles: [['border-radius', '8px'], ['box-shadow', 'none'], ['padding', '12px']] },
  { id: 'warm', name: 'Warm', description: 'Soft cream with ink text', styles: [['border-radius', '14px'], ['background-color', '#fff7ed'], ['color', '#431407'], ['padding', '18px']] },
  { id: 'bold', name: 'Bold accent', description: 'High contrast violet treatment', styles: [['border-radius', '12px'], ['background-color', '#ede9fe'], ['color', '#312e81'], ['padding', '18px'], ['font-weight', '650']] },
];

export function DesignPanel({ selected, onOverlay, onStatus, onClearSelection, reference, onReferenceChange, compareMode, onCompareMode, opacity, onOpacity }) {
  const [property, setProperty] = useState('border-radius');
  const [value, setValue] = useState('12px');
  const [busy, setBusy] = useState(false);
  const setReferenceFile = async (files) => {
    setBusy(true);
    try {
      const [image] = await readImageFiles(files, { maxDimension: 2400, maxBytes: 1_800_000 });
      onReferenceChange(image);
      onStatus('Reference image added to the preview', 'ok');
    } catch (error) { onStatus(error.message, 'error'); }
    finally { setBusy(false); }
  };
  const apply = (styles) => {
    if (!selected) return;
    for (const [name, next] of styles) onOverlay({ type: 'style', property: name, value: next });
    onStatus('Design preview applied; use Undo preview to restore the original styles', 'ok');
  };
  const pasteReference = (event) => {
    const files = [...(event.clipboardData?.items ?? [])].map((item) => item.getAsFile?.()).filter(Boolean);
    if (files.length) { event.preventDefault(); setReferenceFile(files); }
  };
  const dropReference = (event) => { event.preventDefault(); setReferenceFile(event.dataTransfer.files); };
  return <section className="runtime-panel design-panel" aria-label="Design studio">
    <header className="design-panel-heading"><div><span className="design-kicker">VISUAL WORKSPACE</span><h2>Design studio</h2></div><WandSparkles size={19} aria-hidden="true" /></header>
    <p>Explore a treatment on the live component, then tune its spacing, shape, and color. Changes stay in the preview until you implement them in your app.</p>

    <div className="runtime-card design-target">
      <div className="runtime-status"><span className={`status-dot ${selected ? 'online' : ''}`} /><strong>{selected ? 'Component selected' : 'Select a component'}</strong></div>
      <code>{selected?.selector ?? 'Choose an element in the preview to begin'}</code>
    </div>
    <h3>Component states</h3>
    <p>Preview generic browser states on the selected element. These are temporary DOM changes and do not alter your app source.</p>
    <div className="runtime-card component-state-tools">
      <div className="runtime-status"><strong>{selected ? 'Browser states' : 'Select an element to preview states'}</strong><span className="spacer"/><span className="tag">Temporary</span></div>
      <div className="component-state-actions">{[['focus','Focus'],['disabled','Disabled'],['loading','Loading'],['error','Error'],['empty','Empty'],['success','Success'],['open','Open'],['closed','Closed'],['selected','Selected']].map(([state,label]) => <button type="button" key={state} className="btn sm" disabled={!selected} onClick={() => onOverlay({ type: 'componentStatePreview', state })}>{label}</button>)}<button type="button" className="btn sm ghost" disabled={!selected} onClick={() => onOverlay({ type: 'componentStatePreview', state: 'reset' })}>Reset</button></div>
      <div className="runtime-muted">App-owned states call a reversible fixture at <code>window.__UIDIT_STATE_FIXTURES__</code>; see docs for the restore-function contract. Hover and active require real pointer input. All previews are temporary.</div>
    </div>
    <h3>Style directions</h3>
    <div className="variant-grid">{variants.map((variant) => <button type="button" key={variant.id} className={`variant-card variant-${variant.id}`} disabled={!selected} onClick={() => apply(variant.styles)}><span className="variant-sample"><i /><i /><i /></span><strong>{variant.name}</strong><small>{variant.description}</small><span className="sr-only">Apply {variant.name}</span></button>)}</div>
    <button type="button" className="btn design-compare-button" disabled={!selected} onClick={() => onOverlay({ type: 'variantCompare', variants })}>Compare all four on page</button>

    <div className="design-tools-heading"><h3>Component makeover</h3><button type="button" className="btn sm ghost" disabled={!selected} onClick={() => { onOverlay({ type: 'revert' }); onClearSelection(); onStatus('Preview styles reset', 'ok'); }}><RotateCcw size={13} />Undo preview</button></div>
    <div className="design-controls"><label>Property<select value={property} onChange={(event) => { setProperty(event.target.value); setValue(({ 'border-radius': '12px', padding: '16px', margin: '8px', gap: '12px', color: '#1f2937', 'background-color': '#ffffff', 'font-size': '16px', 'font-weight': '600', 'line-height': '1.5', 'letter-spacing': '0.01em', 'box-shadow': '0 8px 24px rgb(15 23 42 / 12%)', display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', width: '100%', 'max-width': '32rem', 'min-height': '44px', border: '1px solid #d7dce5', 'text-align': 'left' })[event.target.value]); }}><option value="border-radius">Corner radius</option><option value="padding">Padding</option><option value="margin">Margin</option><option value="gap">Gap</option><option value="display">Display</option><option value="align-items">Align items</option><option value="justify-content">Justify content</option><option value="width">Width</option><option value="max-width">Maximum width</option><option value="min-height">Minimum height</option><option value="border">Border</option><option value="color">Text color</option><option value="background-color">Background</option><option value="font-size">Font size</option><option value="font-weight">Font weight</option><option value="line-height">Line height</option><option value="letter-spacing">Letter spacing</option><option value="text-align">Text alignment</option><option value="box-shadow">Shadow</option></select></label><label>Value<input value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') apply([[property, value]]); }} /></label><button type="button" className="btn primary" disabled={!selected || !value.trim()} onClick={() => apply([[property, value.trim()]])}>Apply to preview</button></div>
    <p className="design-hint">Every change is recorded in <strong>Changes</strong>. Undo preview restores the selected component's original inline styles.</p>

    <div className="design-tools-heading reference-heading"><div><h3>Match a reference</h3><small>Compare a screenshot or design image with this page.</small></div><Eye size={16} aria-hidden="true" /></div>
    <label className="reference-drop" onDragOver={(event) => event.preventDefault()} onDrop={dropReference} onPaste={pasteReference} tabIndex={0}>
      <ImagePlus size={18} aria-hidden="true" />
      <span>{busy ? 'Preparing image…' : 'Drop, paste, or choose a reference'}</span>
      <small>JPEG, PNG, WebP or GIF</small>
      <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={(event) => { setReferenceFile(event.target.files); event.target.value = ''; }} />
    </label>
    {reference && <div className="reference-card"><img src={reference.dataUrl} alt={`Design reference: ${reference.name}`} /><div><strong>{reference.name}</strong><button type="button" className="btn sm ghost" onClick={() => onReferenceChange(null)}>Remove</button></div><label className="reference-mode">Compare<select value={compareMode} onChange={(event) => onCompareMode(event.target.value)}><option value="overlay">Overlay</option><option value="side">Side by side</option></select></label>{compareMode === 'overlay' && <label className="reference-opacity">Reference opacity<input aria-label="Reference opacity" type="range" min="10" max="90" value={opacity} onChange={(event) => onOpacity(Number(event.target.value))} /><span>{opacity}%</span></label>}</div>}
  </section>;
}
