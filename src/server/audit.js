const readRgb = (value) => {
  const match = String(value ?? '').match(/rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*([\d.]+))?\s*\)/i);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] == null ? 1 : Number(match[4])] : null;
};
const luminance = ([r, g, b]) => {
  const channels = [r,g,b].map((value) => { const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; });
  return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
};

export function auditBrowserContext(context) {
  const nodes = Array.isArray(context?.nodes) ? context.nodes : [];
  const viewport = context?.viewport ?? { width: 0, height: 0 };
  const findings = [];
  const add = (rule, node, severity, evidence, confidence = 'high') => findings.push({ id: `${rule}:${node.selector}`, rule, severity, confidence, selector: node.selector, name: node.name || null, evidence });
  for (const node of nodes) {
    const tag = String(node.tag ?? '').toLowerCase(); const role = String(node.role ?? '').toLowerCase();
    if (['button','a','input','select','textarea'].includes(tag) || ['button','link','checkbox','radio','textbox','combobox'].includes(role)) {
      if (!String(node.name ?? '').trim()) add('accessible-name', node, 'serious', `${tag || role} has no observed accessible name`);
    }
    if (tag === 'img' && !Object.hasOwn(node, 'alt')) add('image-alt', node, 'serious', 'Image has no observed alt attribute');
    if (['input','select','textarea'].includes(tag) && !String(node.name ?? '').trim()) add('form-label', node, 'serious', 'Form control has no observed accessible name');
    if (node.bounds && Number(node.bounds.width) > 0 && Number(node.bounds.height) > 0 && (node.bounds.x < -1 || node.bounds.x + node.bounds.width > viewport.width + 1)) add('horizontal-overflow', node, 'moderate', `Element bounds extend past the ${viewport.width}px viewport`);
    if ((tag === 'button' || role === 'button') && node.bounds && (node.bounds.width < 24 || node.bounds.height < 24)) add('target-size', node, 'manual-review', `Observed target is ${Math.round(node.bounds.width)}×${Math.round(node.bounds.height)} CSS pixels; check spacing and the applicable WCAG target-size criterion`, 'medium');
    const foreground = readRgb(node.styles?.color); const background = readRgb(node.styles?.backgroundColor);
    if (foreground && background && foreground[3] >= .99 && background[3] >= .99) {
      const a = luminance(foreground); const b = luminance(background); const ratio = (Math.max(a,b) + .05) / (Math.min(a,b) + .05);
      if (ratio < 4.5) add('text-contrast', node, 'manual-review', `Computed foreground/background contrast is ${ratio.toFixed(2)}:1; verify text size, opacity, and compositing before concluding nonconformance`, 'medium');
    }
  }
  return { status: context ? 'completed' : 'not_run', ruleSet: 'uidit-browser-audit/1', url: context?.url ?? null, viewport, checkedNodes: nodes.length, coverage: { accessibleNames: nodes.length > 0 ? 'checked-for-observed-controls' : 'not_checked', contrast: nodes.some((node) => node.styles?.color && node.styles?.backgroundColor) ? 'partial-computed-color-pairs' : 'not_checked', keyboard: 'not_checked', screenReader: 'not_checked', applicationStates: 'not_checked' }, findings, note: 'Automated DOM and computed-style checks only. Contrast results are candidates when backgrounds are translucent, layered, or images; this is not a complete WCAG conformance evaluation.' };
}
