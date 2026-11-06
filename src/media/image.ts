import { open } from 'node:fs/promises';

// Local limit, not a claim about the platform's maximum image size.
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export async function readImage(path: string): Promise<Buffer> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES) throw new Error('图片必须是非空文件且不超过20MiB');
    const data = await file.readFile();
    const png = data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    const jpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    const gif = /^GIF8[79]a$/.test(data.subarray(0, 6).toString('ascii'));
    const webp = data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!png && !jpeg && !gif && !webp) throw new Error('仅支持PNG、JPEG、GIF、WebP图片');
    return data;
  } finally { await file.close(); }
}

