import test from 'node:test';
import assert from 'node:assert/strict';
import { imageDimensions, validateImageDimensions } from '../src/beadify/image-header';

test('bounded PNG, JPEG and WebP headers disclose dimensions before image allocation', () => {
  const png = new Uint8Array(24), pv = new DataView(png.buffer);
  png.set([137,80,78,71,13,10,26,10]); png.set(new TextEncoder().encode('IHDR'), 12);
  pv.setUint32(16, 1280); pv.setUint32(20, 720);
  assert.deepEqual(imageDimensions(png), { width: 1280, height: 720 });
  const jpg = new Uint8Array([255,216,255,224,0,4,0,0,255,194,0,8,8,2,208,5,0,0]);
  assert.deepEqual(imageDimensions(jpg), { width: 1280, height: 720 });
  const webp = new Uint8Array(30); webp.set(new TextEncoder().encode('RIFF'), 0); webp.set(new TextEncoder().encode('WEBPVP8X'), 8);
  webp[24] = 255; webp[25] = 4; webp[27] = 207; webp[28] = 2;
  assert.deepEqual(imageDimensions(webp), { width: 1280, height: 720 });
  webp.set(new TextEncoder().encode('VP8L'), 12); webp[20] = 47;
  new DataView(webp.buffer).setUint32(21, 1279 | (719 << 14), true);
  assert.deepEqual(imageDimensions(webp), { width: 1280, height: 720 });
  validateImageDimensions(imageDimensions(png));
  pv.setUint32(16, 100_000);
  assert.throws(() => validateImageDimensions(imageDimensions(png)), /4096/);
});

test('truncated, ambiguous and oversized image headers are rejected', () => {
  for (const bytes of [new Uint8Array(0), new Uint8Array([255,216,255,224,0,1]), new Uint8Array(24)]) assert.throws(() => imageDimensions(bytes), /尺寸/);
  for (const dims of [{ width: 0, height: 1 }, { width: 4096, height: 4096 }, { width: 1.1, height: 2 }]) assert.throws(() => validateImageDimensions(dims));
});
