#!/usr/bin/env python3
"""Resolve an existing room media reference; downloads use the WeChat direct network.
The caller supplies stored event metadata, never an arbitrary model-provided URL.
"""
import json
import hashlib
from pathlib import Path
import re
import sys
from wechat_gui import EXCHANGE, BASE, run


def inspect(value):
    key=value.get('key','')
    if not re.fullmatch(r'[a-f0-9]{32}|[a-f0-9]{64}',key):raise ValueError('Invalid media identity')
    folder=EXCHANGE/'media-cache';folder.mkdir(parents=True,exist_ok=True,mode=0o700)
    crop=value.get('crop')
    if crop is not None and (not isinstance(crop,list) or len(crop)!=4 or any(not isinstance(n,(float,int)) or not 0<=n<=1 for n in crop)
        or crop[2]<=0 or crop[3]<=0 or crop[0]+crop[2]>1 or crop[1]+crop[3]>1):raise ValueError('Invalid image crop')
    variant=hashlib.sha256(json.dumps([bool(value.get('detail')),crop]).encode()).hexdigest()[:12]
    preview=folder/(key+'-v2-'+variant+'.png')
    if not preview.exists():
        source=value.get('localPath')
        if source:
            path=Path(source).resolve()
            if not path.is_relative_to(EXCHANGE.resolve()) or not path.is_file():raise ValueError('Media is not a stored exchange file')
            source='/exchange/'+str(path.relative_to(EXCHANGE))
        request={'key':key,'source':source,'url':value.get('url'),'preview':'/exchange/media-cache/'+preview.name,
                 'edge':3072 if value.get('detail') else 1600,'crop':crop}
        code='''import io,json,sys,urllib.request,urllib.parse
from pathlib import Path
from PIL import Image
v=json.load(sys.stdin)
def allowed(url):
 p=urllib.parse.urlparse(url);h=(p.hostname or '').lower()
 return p.scheme in ('https','http') and (h=='qpic.cn' or h.endswith('.qpic.cn') or h=='wxapp.tc.qq.com' or h.endswith('.weixin.qq.com')) and not p.username
class Redirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl):
  if not allowed(newurl):raise ValueError('Unrecognized image redirect')
  return super().redirect_request(req,fp,code,msg,headers,newurl)
source=v.get('source')
if source:
 data=Path(source).read_bytes()
else:
 url=v.get('url') or ''
 if not allowed(url):raise ValueError('Actual media file is unavailable')
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),Redirect())
 with opener.open(url,timeout=8) as response:data=response.read(8*1024*1024+1)
if len(data)>8*1024*1024:raise ValueError('Media exceeds preview limit')
image=Image.open(io.BytesIO(data));frames=[]
count=getattr(image,'n_frames',1)
for index in sorted(set((0,count//2,count-1))):
 image.seek(index);frame=image.convert('RGB')
 if v.get('crop'):
  x,y,w,h=v['crop'];width,height=frame.size
  frame=frame.crop((round(x*width),round(y*height),round((x+w)*width),round((y+h)*height)))
 edge=v['edge'] if count==1 else min(v['edge'],800)
 frame.thumbnail((edge,edge));frames.append(frame.copy())
canvas=Image.new('RGB',(sum(f.width for f in frames),max(f.height for f in frames)),'white');x=0
for frame in frames:canvas.paste(frame,(x,0));x+=frame.width
canvas.save(v['preview'])
print(json.dumps({'frames':len(frames),'originalSize':image.size,'previewSize':canvas.size}))
'''
        result=json.loads(run(BASE[:2]+['-i']+BASE[2:]+['/lsiopy/bin/python3','-c',code],json.dumps(request).encode(),timeout=18))
    else:result={'cached':True}
    return {'status':'available','previewPath':str(preview),'key':key,**result}


if __name__=='__main__':
    try:print(json.dumps(inspect(json.load(sys.stdin))))
    except Exception as exc:
        print(json.dumps({'status':'unavailable','reason':type(exc).__name__,'instruction':'实际图片尚未取得；不要猜测图中内容。'}))
