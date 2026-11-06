import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { MEDIA_ROOT } from './media-catalog.js';

export interface SceneReference {
  reference_id: string; kind: 'scene_reference'; file: string; title: string;
  description: string; tags: string[]; location_aliases: string[];
  area: string; time_of_day: string; orientation: 'portrait' | 'landscape';
}
export function sceneReferenceFile(reference: SceneReference, root = MEDIA_ROOT): string | undefined {
  try {
    const base = realpathSync(join(root, '杂货店')), path = realpathSync(resolve(root, reference.file));
    const rel = relative(base, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !statSync(path).isFile() || !/\.(?:jpe?g|png|webp)$/iu.test(path)) return;
    return path;
  } catch { return; }
}
export function loadSceneReferences(root = MEDIA_ROOT): SceneReference[] {
  try {
    const data = JSON.parse(readFileSync(join(root, '素材索引.json'), 'utf8'));
    return (data.references ?? []).filter((ref: SceneReference) => ref.kind === 'scene_reference'
      && /^rr_scene_[a-z0-9_]+$/u.test(ref.reference_id) && typeof ref.title === 'string'
      && typeof ref.description === 'string' && typeof ref.area === 'string'
      && Array.isArray(ref.tags) && Array.isArray(ref.location_aliases)
      && ['portrait','landscape'].includes(ref.orientation) && sceneReferenceFile(ref, root));
  } catch { return []; }
}
// Location aliases live with the references. Adding another setting does not
// require a new collection of keyword branches in the conversation pipeline.
export function searchSceneReferences(query: string, options: { referenceId?: string; size?: string } = {}, root = MEDIA_ROOT): SceneReference[] {
  const all = loadSceneReferences(root);
  if (options.referenceId) {
    const found = all.find(ref => ref.reference_id === options.referenceId);
    if (!found) throw new Error('场景参考不存在或文件不可用');
    return [found];
  }
  const text = query.toLowerCase(), [width, height] = (options.size ?? '').split('x').map(Number);
  const orientation = width > height ? 'landscape' : 'portrait';
  const ranked = all.filter(ref => !text.trim() || ref.location_aliases.some(alias => text.includes(alias.toLowerCase())))
    .map(ref => ({ ref, score: ref.tags.reduce((score, tag) => score + (text.includes(tag.toLowerCase()) ? 3 : 0), 0)
      + Number(ref.orientation === orientation) }));
  ranked.sort((a, b) => b.score - a.score);
  const areas = new Set<string>();
  return ranked.filter(({ ref }) => { if (areas.has(ref.area)) return false; areas.add(ref.area); return true; }).slice(0, 4).map(row => row.ref);
}
export function describeSceneReference(ref: SceneReference) {
  return { referenceId: ref.reference_id, title: ref.title, description: ref.description,
    area: ref.area, timeOfDay: ref.time_of_day, orientation: ref.orientation };
}
