import {createDeflate, crc32, deflateSync} from 'node:zlib';
import {once} from 'node:events';

export function rawPNG({width, height, raw, color = 6, depth = 8, palette, alpha}) {
  const chunk = (type, data) => {
    const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4); length.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([length, name, data, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = depth; header[9] = color;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header),
    ...(palette ? [chunk('PLTE', palette)] : []), ...(alpha ? [chunk('tRNS', alpha)] : []), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export async function previewPNG(width, height) {
  const deflater = createDeflate(), chunks = [];
  deflater.on('data', chunk => chunks.push(chunk));
  const row = Buffer.alloc(width * 4 + 1);
  for (let x = 0; x < width; x++) {row[1 + x * 4] = x < width / 2 ? 230 : 35; row[2 + x * 4] = x < width / 2 ? 70 : 180; row[3 + x * 4] = 90; row[4 + x * 4] = 255;}
  for (let y = 0; y < height; y++) if (!deflater.write(row)) await once(deflater, 'drain');
  const ended = once(deflater, 'end'); deflater.end(); await ended;
  const chunk = (type, data) => {
    const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4); length.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([length, name, data, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', Buffer.concat(chunks)), chunk('IEND', Buffer.alloc(0))]);
}
