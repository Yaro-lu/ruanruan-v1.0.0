import { createHash } from 'node:crypto';

// A scope names one independently correctable fact, not a topic or a paragraph.
export interface FactScope { subject: string; attribute: string }
export interface AtomicFact extends FactScope {
  id?: string; evidence: string; value?: string;
  assertion?: 'fact'|'plan'|'reported'|'uncertain'; validFrom?:string; validTo?:string;
  supersedes?:string; topics?:string[]; stable?:boolean;
}
export interface ForgottenFact { id: string; text: string; at: string; fact?: FactScope }
export function factScope(value: any): FactScope {
  if (!value || !['subject', 'attribute'].every(key => typeof value[key] === 'string'
    && value[key].trim().length > 0 && value[key].length <= 80)) throw new Error('事实需要独立主体和属性');
  return { subject: value.subject.normalize('NFKC').trim(), attribute: value.attribute.normalize('NFKC').trim() };
}
export function factId(scope: FactScope): string {
  return 'fact_' + createHash('sha256').update(JSON.stringify([scope.subject, scope.attribute])).digest('hex').slice(0, 20);
}
export function sameFact(a?: FactScope, b?: FactScope) {
  return !!a && !!b && a.subject === b.subject && a.attribute === b.attribute;
}
