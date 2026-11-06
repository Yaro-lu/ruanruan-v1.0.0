import test from 'node:test';
import assert from 'node:assert/strict';
import {tokenUsage,sumReportedUsage} from '../src/usage.js';
test('usage keeps missing cache writes unknown and never adds cache input twice',()=>{
 const first=tokenUsage({input_tokens:100,input_tokens_details:{cached_tokens:70},output_tokens:5});
 const totals=sumReportedUsage([first,tokenUsage({inputTokens:50,cachedInputTokens:20,outputTokens:2})]);
 assert.equal(totals.inputTokens,150);assert.equal(totals.cachedInputTokens,90);assert.equal(totals.outputTokens,7);
 assert.equal(totals.cacheWriteInputTokens,undefined);
 assert.equal(sumReportedUsage([first,{}]).inputTokens,undefined);
});
