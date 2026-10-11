const quote = (value) => JSON.stringify(String(value));

export function exportFlowAsPlaywright(flow) {
  if (!flow || !Array.isArray(flow.steps) || flow.steps.length > 500) throw new Error('flow is invalid or exceeds 500 steps');
  const lines = ["import { test, expect } from '@playwright/test';", '', `test(${quote(flow.name || 'UIDIT recorded flow')}, async ({ page }) => {`, "  const baseURL = process.env.UIDIT_BASE_URL;", "  if (!baseURL) throw new Error('Set UIDIT_BASE_URL to the local development server URL');"];
  let valueIndex = 0;
  for (const [index, step] of flow.steps.entries()) {
    lines.push('', `  // Step ${index + 1}: ${String(step.label || step.action || step.type).replace(/[\r\n]/g, ' ').slice(0, 120)}`);
    if (step.type === 'assertion') {
      if (step.action === 'assertUrl') {
        let pathname = '/'; try { pathname = new URL(step.value).pathname || step.value; } catch { pathname = step.value || '/'; }
        lines.push(`  await expect(page).toHaveURL(new RegExp(${quote(pathname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))}));`);
      } else if (typeof step.selector === 'string' && step.selector && step.selector.length <= 1000) {
        const locator = `step${index + 1}`;
        lines.push(`  const ${locator} = page.locator(${quote(step.selector)});`, `  await expect(${locator}, 'Selector drift at recorded assertion ${index + 1}').toHaveCount(1);`);
        if (step.action === 'assertVisible') lines.push(`  await expect(${locator}).toBeVisible();`);
        else if (step.action === 'assertText') lines.push(`  await expect(${locator}).toContainText(${quote(step.value)});`);
        else if (step.action === 'assertEnabled') lines.push(`  await expect(${locator}).toBeEnabled();`);
        else lines.push('  // Unsupported assertion; review it before running this export.');
      } else lines.push('  // Unsupported assertion: no safe selector was recorded.');
      continue;
    }
    if (step.action === 'navigate' || step.type === 'navigation') {
      let pathname = '/';
      try { pathname = new URL(step.page).pathname || '/'; } catch {}
      lines.push(`  await page.goto(new URL(${quote(pathname)}, baseURL).href);`);
      continue;
    }
    if (typeof step.selector !== 'string' || !step.selector || step.selector.length > 1000) { lines.push('  // Unsupported step: no stable selector was recorded.'); continue; }
    const locator = `step${index + 1}`;
    lines.push(`  const ${locator} = page.locator(${quote(step.selector)});`, `  await expect(${locator}, 'Selector drift at recorded step ${index + 1}').toHaveCount(1);`);
    if (step.action === 'click') lines.push(`  await ${locator}.click();`);
    else if (step.action === 'fill' && !step.sensitive) {
      valueIndex += 1;
      lines.push(`  await ${locator}.fill(process.env.UIDIT_FLOW_VALUE_${valueIndex} ?? ''); // Supply fixture data; recorded values are deliberately omitted.`);
    } else if (step.action === 'check') lines.push(`  await ${locator}.check();`);
    else if (step.action === 'submit') lines.push(`  await ${locator}.evaluate((element) => { if (element instanceof HTMLFormElement) element.requestSubmit(); else throw new Error('Recorded submit target is no longer a form'); });`);
    else lines.push('  // Unsupported or sensitive step; review and add a safe fixture/assertion manually.');
  }
  lines.push('});', '');
  return lines.join('\n');
}
