import fs from 'node:fs/promises';
import path from 'node:path';

const EXTENSIONS = new Set(['.html', '.htm', '.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.astro', '.css', '.scss', '.sass', '.less']);
const IGNORED = new Set(['node_modules', '.git', '.uidit', 'dist', 'build', 'coverage', '.astro', '.next', '.svelte-kit', '.nuxt']);

async function* sourceFiles(root, { maxFiles = 2500, maxBytes = 48 * 1024 * 1024 } = {}) {
  const queue = [root]; let count = 0; let bytes = 0;
  while (queue.length && count < maxFiles && bytes < maxBytes) {
    const directory = queue.shift(); let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (IGNORED.has(entry.name) || entry.name.startsWith('.')) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { queue.push(file); continue; }
      if (!entry.isFile() || !EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      let stat; try { stat = await fs.stat(file); } catch { continue; }
      if (stat.size > 1024 * 1024 || bytes + stat.size > maxBytes) continue;
      count += 1; bytes += stat.size; yield { file, size: stat.size };
      if (count >= maxFiles || bytes >= maxBytes) break;
    }
  }
}

export async function resolveElementSource(cwd, element) {
  const root = path.resolve(cwd);
  const needles = [...new Set([element.accessibleName, element.text, element.attributes?.['data-testid'], element.attributes?.['data-test'], element.attributes?.id, element.component?.name].map((value) => String(value ?? '').trim()).filter((value) => value.length >= 4 && value.length <= 100))].slice(0, 5);
  const candidates = [];
  if (!needles.length) return { status: 'unavailable', method: 'source-search', confidence: 'none', candidates: [], limitation: 'The selected element has no stable text or identifier to search for.' };
  for await (const { file } of sourceFiles(root)) {
    let source; try { source = await fs.readFile(file, 'utf8'); } catch { continue; }
    const lines = source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const hits = needles.filter((needle) => line.toLowerCase().includes(needle.toLowerCase()));
      if (!hits.length) continue;
      const relative = path.relative(root, file).split(path.sep).join('/');
      candidates.push({ file: relative, line: index + 1, endLine: index + 1, matched: hits, snippet: line.trim().slice(0, 240), confidence: 'inferred', provenance: 'literal source search' });
      if (candidates.length >= 20) break;
    }
    if (candidates.length >= 20) break;
  }
  candidates.sort((a, b) => b.matched.length - a.matched.length);
  return { status: candidates.length ? 'inferred' : 'unavailable', method: 'literal source search', confidence: candidates[0] ? 'inferred' : 'none', component: element.component ?? null, selector: element.selector, candidates, limitation: candidates.length ? 'Matches are suggestions from source text. Confirm the component and style rule; no source mapping is guaranteed.' : 'No literal source match was found. Framework source maps or generated class names may prevent lookup.' };
}
