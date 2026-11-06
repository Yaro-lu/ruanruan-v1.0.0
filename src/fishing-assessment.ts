// Local website API; it owns the shared HTML core and weather/result caches.
export const FISHING_ASSESS_SPEC = {type:'function',name:'fishing_assess',
 description:'调用四季鲫鱼网站同源算法，评估出钓时段、水层、天气影响与参考评分。默认南京浦口；未知水深等沿网站默认假设。鱼口分不是上鱼概率，水温/缺氧风险是估计。返回较好与相对较弱时段；完整作钓建议时启用深度比较。资料不写长期记忆。',
 inputSchema:{type:'object',properties:{
  location:{type:'string',maxLength:100},latitude:{type:'number',minimum:-90,maximum:90},longitude:{type:'number',minimum:-180,maximum:180},
  date:{type:'string',description:'目标地点当地日期 YYYY-MM-DD，省略从今天起'},days:{type:'integer',minimum:1,maximum:7},
  windowMode:{type:'string',enum:['all','day','night']},compareDepths:{type:'boolean',description:'完整作钓建议、询问水深或钓深钓浅时启用；返回真实深度比较，date选择单日，days为1或省略'},
  params:{type:'object',properties:{
   H:{type:'number',minimum:.4,maximum:12,description:'水底深度，米；默认2.5'},
   z:{type:'number',minimum:.1,maximum:12,description:'钓浮的饵深，米；不得超过H'},
   bottom:{type:'boolean',description:'默认true钓底，false钓浮'},
   type:{type:'string',enum:['pond','lake','slowRiver','river']},
   shelter:{type:'number',minimum:.2,maximum:1,description:'风暴露系数'},
   fetch:{type:'number',minimum:10,maximum:5000,description:'迎风水面长度，米'},
   secchi:{type:'number',minimum:.15,maximum:4,description:'透明度，米'},clarityKnown:{type:'boolean'},
   shade:{type:'number',minimum:0,maximum:.85},nutrients:{type:'string',enum:['low','normal','high','unknown']},
   plants:{type:'string',enum:['open','sparse','dense']},mixed:{type:'boolean'},rhythmStrength:{type:'number',minimum:0,maximum:1},
   obsT:{type:'number',minimum:0,maximum:36,description:'用户实测水温℃'},obsDO:{type:'number',minimum:0,maximum:20,description:'用户实测溶氧mg/L'},
   obsDepth:{type:'number',minimum:0,maximum:12},obsTime:{type:'number',description:'真实取样时间，Unix秒，最近72小时'}
  },additionalProperties:false}
 },additionalProperties:false}};

export async function fetchFishingAssessment(input: unknown, options: {fetch?: typeof fetch; endpoint?: string}={}) {
 try {
  const response=await (options.fetch??fetch)(new URL('/v1/assess',options.endpoint??process.env.WCB_FISHING_API_URL??'http://127.0.0.1:18186'),{
   method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(30000),redirect:'error'});
  const result=await response.json() as {ok?:boolean;error?:unknown;source?:{name?:string};referenceOnly?:boolean;days?:unknown[]};
  if(response.ok&&result.ok===true&&result.source?.name==='FishingCore'&&result.referenceOnly===true&&Array.isArray(result.days)) return result;
  if(result.ok===false&&result.error)return result;
  return {ok:false,error:{code:'invalid_response',message:'网站评估未返回可用结果'}};
 }catch{return {ok:false,error:{code:'assessment_unavailable',message:'网站评估暂时不可用，本次没有鱼情计算结果'}};}
}
