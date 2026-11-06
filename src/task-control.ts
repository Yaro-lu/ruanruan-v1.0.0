export function controlCommand(text: string, naturalAliases = true): 'progress' | 'stop' | 'resume' | 'update' | undefined {
  const t = text.trim().toLowerCase().replace(/[。！!]+$/, '');
  if (!naturalAliases && !t.startsWith('/')) return undefined;
  if (['/progress', '查看进度', '任务进度'].includes(t)) return 'progress';
  if (['/stop', '停止', '停止任务', '停止当前任务'].includes(t)) return 'stop';
  if (['/resume', '恢复任务', '继续任务'].includes(t)) return 'resume';
  if (t === '/update-cli' || /^(请|帮我|请帮我)?(升级|更新)\s*(codex\s*)?cli(到最新版|到最新版本)?$/.test(t)) return 'update';
  return undefined;
}
