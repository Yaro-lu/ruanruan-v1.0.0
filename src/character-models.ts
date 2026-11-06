import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './constants.js';
import { isReasoningEffort, type ReasoningEffort } from './reasoning.js';

export interface ModelTarget {
  model: string;
  reasoningEffort: ReasoningEffort;
  serviceTier: 'default' | 'fast';
}
export type CharacterModels = Partial<Record<'generation' | 'review' | 'repair', ModelTarget>>;

// Read once when a foreground job is created. Jobs keep their chosen targets;
// the independent server-control entry and life runtime use their own settings.
export function loadCharacterModels(directory = DATA_DIR): CharacterModels {
  let value: CharacterModels;
  try { value = JSON.parse(readFileSync(join(directory, 'providers', 'character-models.json'), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('Invalid character model configuration');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid character model configuration');
  for (const [role, target] of Object.entries(value)) {
    if (!['generation', 'review', 'repair'].includes(role) || !target || typeof target.model !== 'string'
      || !/^[a-zA-Z0-9._-]+$/u.test(target.model) || !isReasoningEffort(target.reasoningEffort)
      || !['default', 'fast'].includes(target.serviceTier)) throw new Error('Invalid character model target');
  }
  return value;
}
