import sharp, {type Sharp} from 'sharp';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DATA_DIR} from './constants.js';
import {catalogFile, describeMedia, loadCatalog, MEDIA_ROOT} from './media-catalog.js';

interface Signature {hash:string; pixels:string}
interface Reference extends Signature {assetId:string; file:string; sha256:string; stamp:string; description:ReturnType<typeof describeMedia>}
export interface RecognizedMedia {
  inputImage:number; region?:number[]; assetId:string; title:string; description?:string;
  subject:ReturnType<typeof describeMedia>['subject'];
  source:'local_character_catalog'; match:'same_file'|'same_image'; distance:number;
}
const active=new Map<string,Promise<Reference[]>>();
const ready=new Map<string,{stamp:string; rows:Reference[]}>();
const fileStamp=(file:string)=>{const s=statSync(file);return `${s.size}:${s.mtimeMs}`;};

async function signature(pipeline:Sharp):Promise<Signature> {
  const data=await pipeline.resize(17,16,{fit:'fill'}).removeAlpha().toColourspace('srgb').raw().toBuffer();
  let hash=0n;
  const gray=(i:number)=>data[i]*299+data[i+1]*587+data[i+2]*114;
  for(let y=0;y<16;y++)for(let x=0;x<16;x++) {
    const i=(y*17+x)*3;hash=(hash<<1n)|BigInt(gray(i)>gray(i+3));
  }
  return {hash:hash.toString(16).padStart(64,'0'),pixels:data.toString('base64')};
}
function distance(a:string,b:string) {let v=BigInt('0x'+a)^BigInt('0x'+b),n=0;while(v){v&=v-1n;n++;}return n;}
function colorDifference(a:string,b:string) {
  const x=Buffer.from(a,'base64'),y=Buffer.from(b,'base64');
  if(x.length!==y.length||!x.length)return Infinity;
  let sum=0;for(let i=0;i<x.length;i++)sum+=Math.abs(x[i]-y[i]);return sum/x.length;
}

async function references(root:string,directory:string):Promise<Reference[]> {
  const key=root+'\0'+directory;
  if(active.has(key))return active.get(key)!;
  const task=(async()=>{
    const assets=loadCatalog(root).filter(a=>a.kind==='image').map(asset=>{
      const file=catalogFile(asset,root)!;return {asset,file,stamp:fileStamp(file)};
    });
    const stamp=createHash('sha256').update(JSON.stringify(assets.map(a=>[a.asset,a.stamp]))).digest('hex');
    if(ready.get(key)?.stamp===stamp)return ready.get(key)!.rows;
    const folder=join(directory,'media-fingerprints');
    const path=join(folder,createHash('sha256').update(root).digest('hex').slice(0,16)+'.json');
    let previous:{version?:number;stamp?:string;rows?:Reference[]}={};
    try {previous=JSON.parse(readFileSync(path,'utf8'));}catch{}
    if(previous.version===1&&previous.stamp===stamp&&Array.isArray(previous.rows)) {
      ready.set(key,{stamp,rows:previous.rows});return previous.rows;
    }
    const old=new Map((previous.version===1?previous.rows??[]:[]).map(row=>[row.assetId,row]));
    const rows:Reference[]=[];
    for(const {asset,file,stamp} of assets) {
      try {
        const cached=old.get(asset.asset_id);
        const fingerprint=cached?.file===file&&cached.stamp===stamp?cached:
          {...await signature(sharp(file).rotate()),sha256:createHash('sha256').update(readFileSync(file)).digest('hex')};
        rows.push({...fingerprint,assetId:asset.asset_id,file,stamp,description:describeMedia(asset)});
      }catch { /* An unreadable library image is not an identity claim. */ }
    }
    mkdirSync(folder,{recursive:true,mode:0o700});
    const temp=path+'.'+process.pid+'.tmp';
    writeFileSync(temp,JSON.stringify({version:1,stamp,rows}),{mode:0o600});renameSync(temp,path);
    ready.set(key,{stamp,rows});return rows;
  })();
  active.set(key,task);
  try{return await task;}finally{active.delete(key);}
}

function bestMatch(value:Signature,refs:Reference[]) {
  const ranked=refs.map(row=>({row,distance:distance(value.hash,row.hash)})).sort((a,b)=>a.distance-b.distance);
  const first=ranked[0];
  if(!first||first.distance>32||colorDifference(value.pixels,first.row.pixels)>20)return;
  const other=ranked.find(item=>item.row.sha256!==first.row.sha256);
  if(other&&other.distance-first.distance<24)return;
  return first;
}

// Extract substantial non-background rectangles from screenshots. This compares
// whole embedded images, never faces, people, or biometric features.
function screenshotRegions(data:Buffer,width:number,height:number):number[][] {
  const total=width*height,bins=new Map<number,number>();
  for(let i=0;i<total;i++) {
    const p=i*3,k=(data[p]>>4)*256+(data[p+1]>>4)*16+(data[p+2]>>4);
    bins.set(k,(bins.get(k)??0)+1);
  }
  const dominant=[...bins].sort((a,b)=>b[1]-a[1])[0];
  if(!dominant||dominant[1]/total<.4)return [];
  const bg=[((dominant[0]>>8)&15)*16+8,((dominant[0]>>4)&15)*16+8,(dominant[0]&15)*16+8];
  const mask=new Uint8Array(total),queue=new Int32Array(total),regions:number[][]=[];
  for(let i=0;i<total;i++)mask[i]=Number(Math.max(...bg.map((c,k)=>Math.abs(c-data[i*3+k])))>26);
  for(let start=0;start<total;start++) {
    if(!mask[start])continue;
    let read=0,end=1,minX=width,maxX=0,minY=height,maxY=0;queue[0]=start;mask[start]=0;
    while(read<end) {
      const p=queue[read++],x=p%width,y=Math.floor(p/width);
      minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
      for(const q of [x?p-1:-1,x+1<width?p+1:-1,y?p-width:-1,y+1<height?p+width:-1]) {
        if(q>=0&&mask[q]){mask[q]=0;queue[end++]=q;}
      }
    }
    const w=maxX-minX+1,h=maxY-minY+1;
    if(w>=40&&h>=55&&w*h<total*.85&&end/(w*h)>.3)regions.push([minX,minY,w,h]);
  }
  return regions.sort((a,b)=>b[2]*b[3]-a[2]*a[3]).slice(0,8);
}

export async function recognizeMedia(images:string[],options:{mediaRoot?:string;directory?:string}={}):Promise<RecognizedMedia[]> {
  if(!images.length)return [];
  let refs:Reference[];
  try {refs=await references(options.mediaRoot??MEDIA_ROOT,options.directory??DATA_DIR);}catch{return [];}
  const matches:RecognizedMedia[]=[];
  const add=(inputImage:number,row:Reference,match:RecognizedMedia['match'],distance:number,region?:number[])=>{
    matches.push({inputImage,...(region?{region}:{}),assetId:row.assetId,title:row.description.title,
      description:row.description.description,subject:row.description.subject,source:'local_character_catalog',match,distance});
  };
  for(const [index,file] of images.entries())try {
    const bytes=readFileSync(file),digest=createHash('sha256').update(bytes).digest('hex');
    const exact=refs.find(row=>row.sha256===digest);
    if(exact){add(index+1,exact,'same_file',0);continue;}
    const matched=bestMatch(await signature(sharp(bytes).rotate()),refs);
    if(matched){add(index+1,matched.row,'same_image',matched.distance);continue;}
    const {data,info}=await sharp(bytes).rotate().resize({width:640,height:640,fit:'inside',withoutEnlargement:true})
      .removeAlpha().toColourspace('srgb').raw().toBuffer({resolveWithObject:true});
    for(const [left,top,width,height] of screenshotRegions(data,info.width,info.height)) {
      const found=bestMatch(await signature(sharp(data,{raw:{width:info.width,height:info.height,channels:3}})
        .extract({left,top,width,height})),refs);
      if(found)add(index+1,found.row,'same_image',found.distance,
        [left/info.width,top/info.height,width/info.width,height/info.height]);
    }
  }catch { /* Unknown/cropped/unreadable inputs remain unknown. */ }
  return matches;
}

export function recognizedMediaContext(matches:RecognizedMedia[]) {
  return matches.length?`【收到图片的角色素材归属】\n${JSON.stringify(matches)}\n这是入口按图片文件及整图内容匹配本地相册得到的资料。subject.relation=self对应阮阮自己的角色相册画面，可以自然认出自己；expression对应Q版反应图。region是截图中图片区域的归一化坐标。归属不说明照片刚拍、当前穿着或拍摄时间；本轮未命中的其他画面保持未知。编号用于识别收到的旧图，不授予重发素材的权限。\n`:'';
}
