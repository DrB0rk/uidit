import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { uiditDir } from './store.js';

function processIsUidit(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('bin/uidit.js');
    return true;
  } catch { return false; }
}

/** A project-local owner lock prevents two review servers from controlling one session. */
export function acquireProjectLock(cwd = process.cwd()) {
  const directory = path.join(uiditDir(cwd), 'runtime');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'uidit.lock');
  const owner = { pid: process.pid, cwd: path.resolve(cwd), nonce: crypto.randomBytes(16).toString('hex'), startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`);
      fs.closeSync(fd);
      let released = false;
      return { file, release() {
        if (released) return; released = true;
        try { const current = JSON.parse(fs.readFileSync(file, 'utf8')); if (current.nonce === owner.nonce) fs.unlinkSync(file); } catch {}
      } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let current = null;
      try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      if (current && processIsUidit(Number(current.pid))) throw new Error(`UIDIT is already running for ${path.resolve(cwd)} (pid ${current.pid}). Stop that instance before starting another.`);
      try { fs.unlinkSync(file); } catch {}
    }
  }
  throw new Error('Could not acquire the UIDIT project runtime lock');
}
