// Provider facts only. Missing fields stay unknown; no prices or inferred cache writes.
export interface TokenUsage {
  inputTokens?:number; cachedInputTokens?:number; cacheWriteInputTokens?:number;
  outputTokens?:number; reasoningOutputTokens?:number;
}
export interface UsageDetails { source:string; scope:string; raw:unknown[]; observedCalls?:number }
const count=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:undefined;
export function tokenUsage(value:any):TokenUsage {
  if(!value||typeof value!=='object')return {};
  return {
    inputTokens:count(value.inputTokens??value.input_tokens??value.prompt_tokens),
    cachedInputTokens:count(value.cachedInputTokens??value.input_tokens_details?.cached_tokens??value.prompt_tokens_details?.cached_tokens),
    cacheWriteInputTokens:count(value.cacheWriteInputTokens??value.cache_creation_input_tokens),
    outputTokens:count(value.outputTokens??value.output_tokens??value.completion_tokens),
    reasoningOutputTokens:count(value.reasoningOutputTokens??value.output_tokens_details?.reasoning_tokens??value.completion_tokens_details?.reasoning_tokens),
  };
}
export function sumReportedUsage(rows:TokenUsage[]):TokenUsage {
  const result:TokenUsage={};
  for(const field of ['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens'] as const){
    if(rows.length&&rows.every(row=>row[field]!==undefined))result[field]=rows.reduce((sum,row)=>sum+row[field]!,0);
  }
  return result;
}
