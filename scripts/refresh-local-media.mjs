import { readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import sharp from 'sharp';

const { values } = parseArgs({ options: { root: { type: 'string' } } });
const root = values.root ?? process.env.WCB_MEDIA_ROOT ?? '/mnt/D-2TB/.codex/阮阮素材';
const path = join(root, '素材索引.json'), index = JSON.parse(readFileSync(path, 'utf8'));
const managed = 'ruanruan-local-reactions-and-scenes';
const assets = (index.media_assets ?? []).filter(row => row.managed_by !== managed);
const references = (index.references ?? []).filter(row => row.managed_by !== managed);
const seen = new Set(assets.map(row => row.asset_id));
const reactions = [], scenes = [];
async function info(file) {
  const bytes = readFileSync(file), metadata = await sharp(bytes).metadata();
  return { file: relative(root, file), sha256: createHash('sha256').update(bytes).digest('hex'),
    width: metadata.width, height: metadata.height, bytes: bytes.length, managed_by: managed };
}
const cues = {
  温柔微笑: ['微笑','笑一笑'], 开怀大笑: ['开心','大笑','笑死','哈哈'], 惊讶: ['吃惊','震惊'], 生气: ['不爽','气鼓鼓'],
  害羞眨眼: ['害羞','眨眼','俏皮'], 思考: ['想一想','思索'], 眼睛发光: ['期待','心动','好想要'], 委屈大哭: ['委屈','哭哭','难过'],
  困困睡觉: ['困了','睡觉','晚安'], 捂嘴害羞: ['害羞','不好意思'], 疑惑: ['疑问','问号','不懂'], 甜甜开心: ['开心','高兴'],
  无奈: ['叹气','没办法'], 喝热饮: ['喝水','喝茶','休息'], 突然愣住: ['发呆','愣住'], 无语: ['无话可说','吐槽'],
  双手比心: ['比心','喜欢'], 开心挥手: ['挥手','你好','再见'], 热情打招呼: ['你好','打招呼'], 俏皮比耶: ['比耶','调皮','得意'],
  坐下休息: ['累了','休息'], 抱膝委屈: ['委屈','难过'], 伸懒腰: ['放松','累了'], 开心转圈: ['开心','高兴'],
  欢呼雀跃: ['开心','庆祝'], 抱着小熊: ['小熊','抱抱'], 弯腰鞠躬: ['谢谢','感谢'],
};
for (const [folder, prefix] of [['表情','90'],['动作','91']]) {
  for (const name of readdirSync(join(root,'卡通形象',folder)).sort()) {
    const match = name.match(/^(\d{2})_(.+)\.png$/u); if (!match) continue;
    const [, number, label] = match, id = `rr_image_${prefix}${number}`;
    if (seen.has(id)) throw new Error(`Existing asset ID conflicts with ${id}`);
    seen.add(id);
    reactions.push({ ...(await info(join(root,'卡通形象',folder,name))), asset_id: id, kind: 'image',
      title: `阮阮Q版·${label}`, description: `阮阮的Q版${folder}：${label}。用于表达聊天语气，不代表实际动作或穿搭。`,
      purpose: 'reaction', character_id: 'ruanruan_v1', visual_style: 'chibi',
      tags: ['Q版','表情包',folder,label,...(cues[label] ?? [])], suggested_use_tags: cues[label] ?? [label] });
  }
}
const areas = {
  checkout: ['收银台','木色收银柜台、显示器、小黄鸭和绿植，邻近玻璃门。',['收银台','柜台','收银']],
  main_aisle: ['货架通道','木色货架围出的店内主通道，摆有纸品、清洁用品和日用品。',['货架通道','主通道','货架','理货']],
  mugs: ['杯子区','木色货架陈列马克杯和玻璃瓶，旁有绿植与小黄鸭。',['杯子区','杯子货架','杯子','马克杯']],
  storefront: ['店面','绿白遮阳篷、玻璃门与门口盆栽，从门外能看到店内货架。',['店面','店门口','门面','门口']],
};
const times = { morning: ['早上','上午','早晨'], noon: ['中午','正午','午间'], afternoon: ['下午','午后'] };
for (const [folder, orientation] of [['竖版','portrait'],['横版','landscape']]) {
  for (const area of Object.keys(areas)) for (const time of Object.keys(times)) {
    const n = String(Object.keys(areas).indexOf(area)+1).padStart(2,'0'), [label, description, tags] = areas[area];
    const file = join(root,'杂货店',folder,`${n}_${area}_${time}.jpg`);
    scenes.push({ ...(await info(file)), reference_id: `rr_scene_grocery_${area}_${time}_${orientation}`,
      kind: 'scene_reference', title: `杂货店·${label}·${times[time][0]}·${folder}`, description,
      area, time_of_day: time, orientation, location_id: 'ruanruan_grocery_v1',
      location_aliases: ['杂货店','店里','店内','小店','上班的店','店门口','收银台','货架通道'],
      tags: ['杂货店',...tags,...times[time],folder] });
  }
}
index.media_assets = [...assets,...reactions]; index.references = [...references,...scenes];
index.updated_at = new Date().toISOString();
writeFileSync(path+'.tmp',JSON.stringify(index,null,2)+'\n'); renameSync(path+'.tmp',path);
console.log(JSON.stringify({ reactions: reactions.length, sceneReferences: scenes.length,
  preservedAssets: assets.length, preservedReferences: references.length, index: path }));
