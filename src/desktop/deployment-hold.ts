import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from '../constants.js';

// A short deployment handoff, separate from the latched account-safety pause.
export function deploymentHeld(path = join(dirname(DATA_DIR), 'auto-repair', 'deploy-hold.json'), now = Date.now()): boolean {
  try {
    const hold = JSON.parse(readFileSync(path, 'utf8'));
    if (!Number.isInteger(hold.pid) || hold.pid <= 0 || !Number.isFinite(hold.until) || hold.until <= now) return false;
    try { process.kill(hold.pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  } catch { return false; }
}
