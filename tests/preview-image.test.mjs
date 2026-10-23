import test from 'node:test';
import assert from 'node:assert/strict';
import {previewPNG, rawPNG} from './preview-png-fixture.mjs';
import {pngInfo, imageInfo, imageBlob, samplePNG, fitImage, decodePreview} from '../src/preview-image.mjs';

test('embedded image native and fallback decoding preserve exact bytes and MIME types', async t => {
  const bytes = Buffer.from(Array.from({length:4097}, (_,i) => i % 256)), base64 = bytes.toString('base64');
  for (const encoded of [base64, base64.replace(/=+$/, ''), base64.replace(/.{80}/g, '$&\n')]) {
    const blob = await imageBlob(`data:image/bmp;base64,${encoded}`);
    assert.equal(blob.type, 'image/bmp'); assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes);
  }
  const descriptor = Object.getOwnPropertyDescriptor(Uint8Array, 'fromBase64');
  Object.defineProperty(Uint8Array, 'fromBase64', {configurable:true, value:undefined});
  t.after(() => {if (descriptor) Object.defineProperty(Uint8Array, 'fromBase64', descriptor); else delete Uint8Array.fromBase64;});
  assert.deepEqual(Buffer.from(await (await imageBlob(`data:image/bmp;base64,${base64}`)).arrayBuffer()), bytes);
  assert.deepEqual([...new Uint8Array(await (await imageBlob('data:image/png,%00%7F')).arrayBuffer())], [0,127]);
});

test('extreme image aspect ratios respect the actual pixel allowance', () => {
  for (const [width, height] of [[1, 100000], [100000, 1], [3, 200000], [200000, 3]]) {
    for (const pixels of [1, 4, 128, 1024]) {
      const size = fitImage(width, height, pixels, 8192);
      assert.ok(size.width * size.height <= pixels);
      assert.ok(size.width >= 1 && size.height >= 1);
      assert.ok(size.width <= 8192 && size.height <= 8192);
    }
  }
});

test('native BMP, GIF and JPEG headers supply actual dimensions without decoding pixels', async () => {
  for(const topDown of [false,true]){
    const bmp=Buffer.alloc(54);bmp.write('BM');bmp.writeUInt32LE(40,14);bmp.writeInt32LE(720,18);bmp.writeInt32LE(topDown?-405:405,22);
    assert.deepEqual(await imageInfo(new Blob([bmp])),{width:720,height:405,format:'bmp'});
    assert.equal(await imageInfo(new Blob([bmp.subarray(0,25)])),null);
  }
  const core=Buffer.alloc(26);core.write('BM');core.writeUInt32LE(12,14);core.writeUInt16LE(45,18);core.writeUInt16LE(23,20);
  assert.deepEqual(await imageInfo(new Blob([core])),{width:45,height:23,format:'bmp'});
  const gif=Buffer.alloc(13);gif.write('GIF89a');gif.writeUInt16LE(45,6);gif.writeUInt16LE(23,8);
  assert.deepEqual(await imageInfo(new Blob([gif])),{width:45,height:23,format:'gif'});
  const sof=Buffer.from([255,192,0,17,8,1,149,2,208,3,1,17,0,2,17,0,3,17,0]),end=Buffer.from([255,218,0,2]);
  const jpeg=parts=>new Blob([Buffer.from([255,216]),...parts,sof,end]);
  assert.deepEqual(await imageInfo(jpeg([])),{width:720,height:405,format:'jpeg'});
  for(const little of [false,true]){
    const exif=Buffer.alloc(36);exif.set([255,225,0,34]);exif.write('Exif\0\0',4);exif.write(little?'II':'MM',10);
    const v=new DataView(exif.buffer,exif.byteOffset+10,26);v.setUint16(2,42,little);v.setUint32(4,8,little);v.setUint16(8,1,little);
    v.setUint16(10,0x112,little);v.setUint16(12,3,little);v.setUint32(14,1,little);v.setUint16(18,6,little);
    assert.deepEqual(await imageInfo(jpeg([exif])),{width:405,height:720,format:'jpeg'});
    v.setUint32(4,0xffffffff,little);
    assert.deepEqual(await imageInfo(jpeg([exif])),{width:720,height:405,format:'jpeg'},'invalid optional EXIF offsets cannot escape the metadata buffer');
  }
  assert.equal(await imageInfo(new Blob([Buffer.from([255,216,255,225,255,255])])),null);
});

test('PNG previews and native crops retain exact source pixels with bounded output', async () => {
  const blob = new Blob([await previewPNG(128, 64)]), info = await pngInfo(blob);
  assert.equal(info.width, 128); assert.equal(info.height, 64);
  const pixels = await samplePNG(blob, info, 8, 4);
  assert.equal(pixels.length, 128);
  assert.deepEqual([...pixels.slice(0, 4)], [230,70,90,255]);
  assert.deepEqual([...pixels.slice(28, 32)], [35,180,90,255]);
  const crop = await samplePNG(blob, info, 4, 4, {crop: {x: 80, y: 20, width: 4, height: 4}});
  assert.deepEqual([...crop.slice(0, 4)], [35,180,90,255]);
});

test('ordinary cropped PNGs use bounded native decoding while tiny crops retain scanline decoding',async t=>{
  const bitmap=globalThis.createImageBitmap,imageData=globalThis.ImageData,calls=[];
  t.after(()=>{if(bitmap===undefined)delete globalThis.createImageBitmap;else globalThis.createImageBitmap=bitmap;if(imageData===undefined)delete globalThis.ImageData;else globalThis.ImageData=imageData;});
  globalThis.ImageData=class {constructor(data,width,height){Object.assign(this,{data,width,height});}};
  globalThis.createImageBitmap=async(source,...args)=>{calls.push(source);const o=args.at(-1);return {width:o?.resizeWidth||source.width,height:o?.resizeHeight||source.height,close(){}};};
  const blob=new Blob([await previewPNG(128,64)]);
  const native=await decodePreview(blob,{maxPixels:127*64,crop:{x:1,y:0,width:127,height:64}});
  assert.equal(calls[0],blob);assert.equal(native.srcX,1);assert.equal(native.srcW,127);assert.equal(native.naturalWidth,128);
  const crop=await decodePreview(blob,{maxPixels:4*4,crop:{x:80,y:20,width:4,height:4}});
  assert.ok(calls[1] instanceof ImageData);assert.deepEqual([...calls[1].data.slice(0,4)],[35,180,90,255]);assert.equal(crop.width*crop.height,16);
});

test('streamed decoding yields and can be cancelled without completing an image', async () => {
  const blob = new Blob([await previewPNG(128, 512)]), info = await pngInfo(blob); let checks = 0;
  await assert.rejects(samplePNG(blob, info, 16, 64, {check() {if (++checks > 8) throw new DOMException('Cancelled', 'AbortError');}}), {name: 'AbortError'});
});

test('preview dimensions preserve proportions and both allocation limits', () => {
  assert.deepEqual(fitImage(8192, 4096, 512 * 256, 4096), {width: 512, height: 256});
  assert.deepEqual(fitImage(8192, 1, 128, 64), {width: 64, height: 1});
});

test('all five PNG scanline filters reconstruct colour and alpha exactly', async () => {
  const width = 7, height = 5, expected = Uint8Array.from({length: width * height * 4}, (_, i) => (i * 31 + Math.floor(i / 7) * 17) % 256);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = y;
    for (let x = 0; x < width * 4; x++) {
      const i = y * width * 4 + x, a = x >= 4 ? expected[i - 4] : 0, b = y ? expected[i - width * 4] : 0, c = y && x >= 4 ? expected[i - width * 4 - 4] : 0;
      const prediction = a + b - c, distances = [a,b,c].map(n => Math.abs(prediction - n));
      const p = [a,b,c][distances.indexOf(Math.min(...distances))];
      const filter = [0, a, b, Math.floor((a + b) / 2), p][y];
      raw[y * (width * 4 + 1) + x + 1] = (expected[i] - filter + 256) % 256;
    }
  }
  const blob = new Blob([rawPNG({width, height, raw})]);
  assert.deepEqual([...await samplePNG(blob, await pngInfo(blob), width, height)], [...expected]);
});

test('packed palette transparency and 16-bit grayscale retain their native values', async () => {
  const palette = new Blob([rawPNG({width: 4, height: 1, depth: 1, color: 3, raw: Buffer.from([0, 0b01010000]),
    palette: Buffer.from([255,20,0, 0,30,255]), alpha: Buffer.from([255,0])})]);
  assert.deepEqual([...await samplePNG(palette, await pngInfo(palette), 4, 1)], [255,20,0,255, 0,30,255,0, 255,20,0,255, 0,30,255,0]);
  const gray = new Blob([rawPNG({width: 2, height: 1, depth: 16, color: 0, raw: Buffer.from([0, 128,128, 255,255]), alpha: Buffer.from([255,255])})]);
  assert.deepEqual([...await samplePNG(gray, await pngInfo(gray), 2, 1)], [128,128,128,255, 255,255,255,0]);
});
