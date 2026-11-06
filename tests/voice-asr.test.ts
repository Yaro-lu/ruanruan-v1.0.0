import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readAsrConfig, transcribeAudioDetailed, VoiceTranscriptionError, voiceInterpretationContext, type AsrConfig } from '../src/media/asr.js';
import { prepareMediaForCodex } from '../src/wechat/media.js';
import { MessageItemType } from '../src/wechat/types.js';

const config: AsrConfig = { provider: 'openai', model: 'gpt-transcribe', baseUrl: 'https://example.invalid/v1', apiKey: 'fixture-secret', timeoutMs: 5000 };
function fixture(t: {after(callback:()=>void):void}) {
  const directory = mkdtempSync(join(tmpdir(), 'voice-asr-')); t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const audio = join(directory,'voice.wav'); writeFileSync(audio,'synthetic-audio-fixture');
  return {directory,audio};
}

test('ASR reads only explicitly enabled existing provider and separate credentials', t => {
  const {directory} = fixture(t); assert.equal(readAsrConfig(directory),undefined);
  mkdirSync(join(directory,'providers'));
  writeFileSync(join(directory,'providers','asr.json'),JSON.stringify({enabled:true,provider:'openai',model:'gpt-transcribe'}));
  writeFileSync(join(directory,'providers','llm.json'),JSON.stringify({active:'openai',providers:{openai:{baseUrl:'https://example.invalid/v1',model:'chat',reasoningEffort:'medium'}}}));
  writeFileSync(join(directory,'providers','openai.json'),JSON.stringify({apiKey:'fixture-secret'}));
  assert.equal(readAsrConfig(directory)?.model,'gpt-transcribe');
  writeFileSync(join(directory,'providers','asr.json'),JSON.stringify({enabled:true,provider:'unknown',model:'x'}));
  assert.throws(()=>readAsrConfig(directory),/configured provider/);
});

test('ASR keeps original transcript, actual usage and unknown confidence and caches by occurrence', async t => {
  const {directory,audio} = fixture(t); let requests=0;
  const request:typeof fetch=async (url,init)=>{
    requests++;assert.equal(url,'https://example.invalid/v1/audio/transcriptions');
    assert.equal((init!.body as FormData).get('model'),'gpt-transcribe');
    assert.equal((init!.body as FormData).get('include[]'),null);
    return new Response(JSON.stringify({text:' 三点，不要转给小张。 ',usage:{input_tokens:12,output_tokens:8,total_tokens:20}}),{headers:{'x-request-id':'request-one'}});
  };
  const first=await transcribeAudioDetailed(audio,{directory,config,request,sourceId:'source:one'});
  const cached=await transcribeAudioDetailed(audio,{directory,config,request,sourceId:'source:one'});
  assert.equal(first.rawText,' 三点，不要转给小张。 ');assert.equal(first.text,'三点，不要转给小张。');
  assert.equal(first.confidence,null);assert.deepEqual(first.usage,{input_tokens:12,output_tokens:8,total_tokens:20});
  assert.deepEqual(first,cached);assert.equal(requests,1);
  await transcribeAudioDetailed(audio,{directory,config,request,sourceId:'source:two'});assert.equal(requests,2);
  const db=new DatabaseSync(join(directory,'voice-transcription/cache.sqlite3'));
  try { assert.equal(db.prepare('SELECT count(*) n FROM transcriptions').get()!.n,2); }
  finally {db.close();}
  assert.equal(readFileSync(join(directory,'voice-transcription/cache.sqlite3')).includes(Buffer.from('fixture-secret')),false);
});

test('concurrent ASR deliveries for the same voice share one request',async t=>{
  const {directory,audio}=fixture(t);let requests=0;let finish!:()=>void;
  const blocked=new Promise<void>(resolve=>{finish=resolve;});
  const request:typeof fetch=async()=>{requests++;await blocked;return new Response('{"text":"hello"}');};
  const first=transcribeAudioDetailed(audio,{directory,config,request,sourceId:'same'});
  const second=transcribeAudioDetailed(audio,{directory,config,request,sourceId:'same'});
  finish();assert.deepEqual(await first,await second);assert.equal(requests,1);
});

test('network interruption is recorded as uncertain and never recharged on replay',async t=>{
  const {directory,audio}=fixture(t);let requests=0;
  const request:typeof fetch=async()=>{requests++;throw new Error('network secret must not leak');};
  for(let i=0;i<2;i++)await assert.rejects(transcribeAudioDetailed(audio,{directory,config,request,sourceId:'lost'}),
    (error:unknown)=>error instanceof VoiceTranscriptionError&&error.code==='uncertain'&&!error.message.includes('secret'));
  assert.equal(requests,1);
});

test('crashed requesting row remains uncertain instead of issuing another request',async t=>{
  const {directory,audio}=fixture(t);const request:typeof fetch=async()=>new Response('{"text":"old"}');
  await transcribeAudioDetailed(audio,{directory,config,request,sourceId:'crash'});
  const db=new DatabaseSync(join(directory,'voice-transcription/cache.sqlite3'));
  db.prepare("UPDATE transcriptions SET status='requesting',pid=99999999,result=NULL").run();db.close();
  let count=0;
  await assert.rejects(transcribeAudioDetailed(audio,{directory,config,sourceId:'crash',request:async()=>{count++;return new Response('{}');}}),
    (error:unknown)=>error instanceof VoiceTranscriptionError&&error.code==='uncertain');
  assert.equal(count,0);
});

test('rate limit retries once within the original budget and persists its attempt count',async t=>{
  const {directory,audio}=fixture(t);let calls=0;
  const result=await transcribeAudioDetailed(audio,{directory,config,request:async()=>{
    calls++;return calls===1?new Response('{}',{status:429,headers:{'retry-after':'0'}}):new Response('{"text":"重试成功"}');
  }});
  assert.equal(result.text,'重试成功');assert.equal(calls,2);
  const db=new DatabaseSync(join(directory,'voice-transcription/cache.sqlite3'));
  try{assert.equal(db.prepare('SELECT attempts FROM transcriptions').get()!.attempts,2);}finally{db.close();}
});

test('actual provider confidence/logprobs retained, no confidence derived from language guesses',async t=>{
  const {directory,audio}=fixture(t);
  const transcript=await transcribeAudioDetailed(audio,{directory,config:{...config,model:'gpt-4o-mini-transcribe'},request:async(_url,init)=>{
    assert.equal((init!.body as FormData).get('include[]'),'logprobs');
    return new Response(JSON.stringify({text:'小张',logprobs:[{token:'小',logprob:-.2},{token:'张',logprob:-1.2}],confidence:.7}));
  }});
  assert.equal(transcript.confidence,.7);assert.equal(transcript.logprobs?.length,2);
  const prompt=voiceInterpretationContext(transcript);
  assert.match(prompt,/金额、时间、否定词/);assert.match(prompt,/未确认/);assert.match(prompt,/原始转写/);
});

test('native transcript avoids ASR and local decoded voice does not need host ffmpeg',async()=>{
  let calls=0;
  const deps={transcribeVoice:async()=>{calls++;return {text:'三点见',rawText:'三点见',source:'asr' as const,confidence:null};}};
  const native=await prepareMediaForCodex({kind:'voice',item:{type:MessageItemType.VOICE,voice_item:{text:'已经转好了'}},sourceId:'native'},deps);
  assert.equal(native.voiceStatus,'ready');assert.equal(calls,0);assert.equal(native.voiceTranscript?.source,'wechat');
  const audio=await prepareMediaForCodex({kind:'voice',item:{type:MessageItemType.VOICE},sourceId:'audio',localPath:'/synthetic/voice.wav'},deps);
  assert.equal(calls,1);assert.equal(audio.voiceTranscript?.text,'三点见');assert.deepEqual(audio.tempFiles,[]);
});

test('unavailable or silent voice becomes honest unknown input rather than backend failure response',async()=>{
  for(const transcribeVoice of [async()=>{throw new VoiceTranscriptionError('unconfigured','technical provider secret');},
    async()=>({text:'',rawText:'',source:'asr' as const,confidence:null})]) {
    const prepared=await prepareMediaForCodex({kind:'voice',item:{type:MessageItemType.VOICE},localPath:'/synthetic/audio.wav'}, {transcribeVoice});
    assert.equal(prepared.voiceStatus,'unavailable');assert.equal(prepared.immediateReply,undefined);
    assert.equal(prepared.promptFragments.some(p=>p.includes('secret')),false);
  }
});
