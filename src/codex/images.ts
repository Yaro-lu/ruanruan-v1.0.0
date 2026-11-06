import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Use only files explicitly attached to the final answer, never scan historical
// image directories or interpret command output as permission to send a file.
export function extractReplyImages(reply: string, cwd: string): { text: string; images: string[] } {
  const images = new Set<string>();
  const text = reply.split(/(```[\s\S]*?```)/g).map(part => {
    if (part.startsWith('```')) return part;
    return part.replace(/!?\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]+)\)/g, (link, destination: string) => {
      let path = destination.startsWith('<') ? destination.slice(1, -1) : destination.trim();
      try {
        if (path.startsWith('file://')) path = fileURLToPath(path);
        else if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return link;
        else path = decodeURI(path);
      } catch { return link; }
      if (!/\.(?:png|jpe?g|gif|webp)$/i.test(path)) return link;
      images.add(resolve(cwd, path));
      return '';
    });
  }).join('').replace(/\n{3,}/g, '\n\n').trim();
  return { text, images: [...images] };
}

export const IMAGE_REPLY_INSTRUCTIONS = `微信图片回传：用户要求生成或编辑图片时使用当前Codex内置生图能力，不擅自改用需要独立API Key的付费接口。仅生成新的图片附件可以在聊天档完成；修改已有业务文件仍按修改任务规则。成功后在最终正文用 ![图片说明](/绝对路径/图片.png) 明确列出要交付的本轮图片；也可交付用户明确要求发送的已有图片。不把用户输入图片、工具读到的无关图片或历史目录里的图片自动当成输出。不要只返回生成成功或目录名。桥接负责上传和发送这些附件，你不自行调用微信接口；正文不声称已送达微信，实际送达由桥接检查回执。`;
