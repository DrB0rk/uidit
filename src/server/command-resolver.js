import fs from 'node:fs';
import path from 'node:path';

function packageManager(root, pkg) {
  const declared = pkg.packageManager?.split('@')[0];
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(declared)) return declared;
  for (const [file, manager] of [['bun.lockb', 'bun'], ['bun.lock', 'bun'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['package-lock.json', 'npm']]) {
    if (fs.existsSync(path.join(root, file))) return manager;
  }
  return 'npm';
}

/** Resolve a project command without invoking a shell or installing dependencies. */
export function resolveDevCommand(cwd = process.cwd(), explicit = null) {
  if (explicit?.length) return { command: explicit[0], args: explicit.slice(1), cwd: path.resolve(cwd), source: 'argument' };
  const configPath = path.join(cwd, '.uidit', 'config.json');
  if (fs.existsSync(configPath)) {
    const dev = JSON.parse(fs.readFileSync(configPath, 'utf8')).dev;
    if (Array.isArray(dev?.command) && dev.command.length) return {
      command: dev.command[0], args: dev.command.slice(1), cwd: path.resolve(cwd, dev.cwd ?? '.'), source: 'config', url: dev.url ?? null,
    };
  }
  const manifestPath = path.join(cwd, 'package.json');
  if (fs.existsSync(manifestPath)) {
    const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (pkg.scripts?.dev) {
      const manager = packageManager(cwd, pkg);
      return { command: manager, args: manager === 'npm' ? ['run', 'dev'] : ['run', 'dev'], cwd: path.resolve(cwd), source: 'package.json' };
    }
  }
  return null;
}

