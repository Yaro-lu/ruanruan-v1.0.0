import { fileURLToPath } from 'node:url';
import { planDesktopRecovery, type RecoveryDependencies, type RecoveryResult } from './model-recovery.js';

export async function recoveryCommand(body: string, dependencies: RecoveryDependencies = {}): Promise<RecoveryResult> {
  let input;
  try { input = JSON.parse(body); }
  catch { return { ok: false, elapsedMs: 0, error: { code: 'invalid_input', message: '视觉恢复请求必须为JSON' } }; }
  return planDesktopRecovery(input, dependencies);
}

// Single request, single JSON result; the host retains all UI authorization.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let body = '';
  for await (const chunk of process.stdin) body += chunk;
  process.stdout.write(JSON.stringify(await recoveryCommand(body)) + '\n');
}
