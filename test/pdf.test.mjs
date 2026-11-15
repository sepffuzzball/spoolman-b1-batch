import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

import { parsePages, inspectPdf, renderPdfPages } from '../src/pdf.mjs';

// --- Test helper: generate a real (dependency-free) PDF ----------------------
// 40x30mm label in points: 40mm = 40*72/25.4 = 113.3858 pt, 30mm = 85.0394 pt.
const PT_PER_MM = 72 / 25.4;
const pt = (mm) => mm * PT_PER_MM;
const LABEL_W = pt(40); // 113.38582677
const LABEL_H = pt(30); // 85.03937007
const SWAP_W = pt(30); // 85.03937007 (30x40)
const SWAP_H = pt(40); // 113.38582677
const A4_W = pt(210);
const A4_H = pt(297);

// Builds a minimal but valid multi-page PDF. Each page: { w, h, rot?, crop?,
// content? } in pts. `crop` sets a CropBox (defaults to MediaBox); `content`
// is a PDF content stream (defaults to an empty stream).
function makePdf(pages) {
  const N = pages.length;
  const objects = [];
  const kids = [];
  for (let i = 1; i <= N; i++) {
    const pageObj = 3 + (i - 1) * 2;
    const contentObj = pageObj + 1;
    kids.push(`${pageObj} 0 R`);
    const p = pages[i - 1];
    const cropAttr = p.crop
      ? ` /CropBox [0 0 ${p.crop.w} ${p.crop.h}]`
      : '';
    const rotAttr = p.rot ? ` /Rotate ${p.rot}` : '';
    const content = p.content || '';
    objects.push({
      num: pageObj,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.w} ${p.h}]${cropAttr}${rotAttr} /Contents ${contentObj} 0 R /Resources << >> >>`,
    });
    objects.push({
      num: contentObj,
      body: `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    });
  }
  let out = '%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n';
  const offsets = new Array(N * 2 + 3).fill(0);
  offsets[1] = Buffer.byteLength(out, 'latin1');
  out += '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  offsets[2] = Buffer.byteLength(out, 'latin1');
  out += `2 0 obj\n<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${N} >>\nendobj\n`;
  for (const o of objects.sort((a, b) => a.num - b.num)) {
    offsets[o.num] = Buffer.byteLength(out, 'latin1');
    out += `${o.num} 0 obj\n${o.body}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(out, 'latin1');
  let xref = `xref\n0 ${N * 2 + 3}\n`;
  xref += '0000000000 65535 f \r\n';
  for (let n = 1; n <= N * 2 + 2; n++) {
    xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \r\n`;
  }
  xref += `trailer\n<< /Size ${N * 2 + 3} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  out += xref;
  return Buffer.from(out, 'latin1');
}

// A content stream that fills a [0 0 w h] rectangle with solid red.
const redFill = (wPt, hPt) =>
  `q\n1 0 0 rg\n0 0 ${wPt.toFixed(4)} ${hPt.toFixed(4)} re\nf\nQ\n`;

// --- Test helpers: temp dirs and PNG parsing ---------------------------------
function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'niim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePdf(t, pages, name = 'input.pdf') {
  const dir = makeTempDir(t);
  const p = path.join(dir, name);
  fs.writeFileSync(p, makePdf(pages));
  return p;
}

function readPngSize(file) {
  const buf = fs.readFileSync(file);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(sig)) {
    throw new Error(`Not a PNG file: ${file}`);
  }
  const chunkType = buf.subarray(12, 16).toString('ascii');
  if (chunkType !== 'IHDR') {
    throw new Error(`First PNG chunk is not IHDR: ${file}`);
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Decode an 8-bit RGB/RGBA non-interlaced PNG so tests can inspect pixels.
function decodePng(file) {
  const buf = fs.readFileSync(file);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(sig)) {
    throw new Error(`Not a PNG file: ${file}`);
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    pos += 4;
    const type = buf.subarray(pos, pos + 4).toString('ascii');
    pos += 4;
    const data = buf.subarray(pos, pos + len);
    pos += len + 4;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) {
        throw new Error(`Interlaced PNG not supported: ${file}`);
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (bitDepth !== 8) {
    throw new Error(`Unsupported bit depth ${bitDepth}: ${file}`);
  }
  if (colorType !== 2 && colorType !== 6) {
    throw new Error(`Unsupported color type ${colorType}: ${file}`);
  }
  const channels = colorType === 2 ? 3 : 4;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const rowStart = y * stride;
    const prevRowStart = rowStart - stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rp++];
      const left = x >= channels ? out[rowStart + x - channels] : 0;
      const up = y > 0 ? out[prevRowStart + x] : 0;
      const upLeft = y > 0 && x >= channels
        ? out[prevRowStart + x - channels]
        : 0;
      let val;
      switch (filter) {
        case 0:
          val = rawByte;
          break;
        case 1:
          val = rawByte + left;
          break;
        case 2:
          val = rawByte + up;
          break;
        case 3:
          val = rawByte + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const pred =
            pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          val = rawByte + pred;
          break;
        }
        default:
          throw new Error(`Bad PNG filter ${filter}: ${file}`);
      }
      out[rowStart + x] = val & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

function pixelAt(img, x, y) {
  const off = (y * img.width + x) * img.channels;
  return [img.data[off], img.data[off + 1], img.data[off + 2]];
}

// --- parsePages: selection parsing and validation ----------------------------
test('parsePages: undefined means all pages', () => {
  assert.deepEqual(parsePages(undefined, 5), [1, 2, 3, 4, 5]);
});

test('parsePages: null is treated as all pages', () => {
  assert.deepEqual(parsePages(null, 3), [1, 2, 3]);
});

test('parsePages: single range expands', () => {
  assert.deepEqual(parsePages('1-3', 5), [1, 2, 3]);
});

test('parsePages: a range plus a single page', () => {
  assert.deepEqual(parsePages('1-3,5', 5), [1, 2, 3, 5]);
});

test('parsePages: duplicates are deduped and result is sorted', () => {
  assert.deepEqual(parsePages('5,3,3-4,1-2', 5), [1, 2, 3, 4, 5]);
});

test('parsePages: surrounding whitespace is tolerated', () => {
  assert.deepEqual(parsePages(' 1 - 3 , 5 ', 5), [1, 2, 3, 5]);
});

test('parsePages: a bare page number is accepted', () => {
  assert.deepEqual(parsePages(3, 5), [3]);
});

test('parsePages: an array of numbers and segments is accepted', () => {
  assert.deepEqual(parsePages([1, '2-3', 5], 5), [1, 2, 3, 5]);
});

test('parsePages: rejects an empty string', () => {
  assert.throws(() => parsePages('', 5), /empty page spec segment/);
});

test('parsePages: rejects an empty segment', () => {
  assert.throws(() => parsePages('1,,3', 5), /empty page spec segment/);
});

test('parsePages: rejects zero', () => {
  assert.throws(() => parsePages('0', 5), /1-based/);
});

test('parsePages: rejects a range starting at zero', () => {
  assert.throws(() => parsePages('0-3', 5), /1-based/);
});

test('parsePages: rejects a range ending at zero', () => {
  assert.throws(() => parsePages('1-0', 5), /1-based/);
});

test('parsePages: rejects negative page numbers', () => {
  assert.throws(() => parsePages('-1', 5), /invalid page spec segment/);
});

test('parsePages: rejects non-integer single page', () => {
  assert.throws(() => parsePages('1.5', 5), /invalid page spec segment/);
});

test('parsePages: rejects non-integer range bound', () => {
  assert.throws(() => parsePages('1.5-2', 5), /invalid page spec segment/);
});

test('parsePages: rejects a reversed range', () => {
  assert.throws(() => parsePages('3-1', 5), /reversed page range/);
});

test('parsePages: rejects an out-of-range single page', () => {
  assert.throws(() => parsePages('6', 5), /out of range/);
});

test('parsePages: rejects an out-of-range range end', () => {
  assert.throws(() => parsePages('1-6', 5), /out of range/);
});

test('parsePages: rejects a trailing dash', () => {
  assert.throws(() => parsePages('1-', 5), /invalid page spec segment/);
});

test('parsePages: rejects a leading dash', () => {
  assert.throws(() => parsePages('-3', 5), /invalid page spec segment/);
});

test('parsePages: rejects a double dash', () => {
  assert.throws(() => parsePages('1-3-5', 6), /invalid page spec segment/);
});

test('parsePages: rejects totalPages of zero', () => {
  assert.throws(() => parsePages('1-3', 0), /totalPages/);
});

test('parsePages: rejects totalPages above 1000', () => {
  assert.throws(() => parsePages('1-3', 1001), /totalPages/);
});

test('parsePages: rejects a non-integer totalPages', () => {
  assert.throws(() => parsePages('1-3', 2.5), /totalPages/);
});

test('parsePages: single page at the upper bound is valid', () => {
  assert.deepEqual(parsePages('5', 5), [5]);
});

test('parsePages: a range equal to the total is valid', () => {
  assert.deepEqual(parsePages('1-5', 5), [1, 2, 3, 4, 5]);
});

// --- inspectPdf --------------------------------------------------------------
test('inspectPdf returns an absolute path and the page count', async (t) => {
  const pdfPath = writePdf(t, [
    { w: LABEL_W, h: LABEL_H },
    { w: LABEL_W, h: LABEL_H },
    { w: LABEL_W, h: LABEL_H },
  ]);
  const info = await inspectPdf(pdfPath);
  assert.equal(info.totalPages, 3);
  assert.equal(info.path, path.resolve(pdfPath));
});

test('inspectPdf rejects a nonexistent path', async () => {
  const missing = path.join(os.tmpdir(), 'no-such-niim-file.pdf');
  await assert.rejects(() => inspectPdf(missing), /not found/);
});

test('inspectPdf rejects a directory', async (t) => {
  const dir = makeTempDir(t);
  await assert.rejects(() => inspectPdf(dir), /not a file/);
});

test('inspectPdf rejects a malformed PDF', async (t) => {
  const dir = makeTempDir(t);
  const p = path.join(dir, 'junk.pdf');
  fs.writeFileSync(p, 'this is definitely not a pdf');
  await assert.rejects(() => inspectPdf(p), /Malformed|PDF/);
});

test('inspectPdf with an already-aborted signal throws AbortError', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => inspectPdf('/whatever.pdf', { signal: controller.signal }),
    { name: 'AbortError' },
  );
});

// --- renderPdfPages ----------------------------------------------------------
test('renderPdfPages renders selected pages to exactly 320x240', async (t) => {
  const pdfPath = writePdf(t, [
    { w: LABEL_W, h: LABEL_H },
    { w: LABEL_W, h: LABEL_H },
    { w: LABEL_W, h: LABEL_H },
  ]);
  const before = fs.readFileSync(pdfPath);
  const outDir = makeTempDir(t);

  const results = await renderPdfPages({
    pdfPath,
    pages: '1-2',
    outputDir: outDir,
  });

  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map((r) => [r.page, r.width, r.height]),
    [
      [1, 320, 240],
      [2, 320, 240],
    ],
  );
  for (const r of results) {
    assert.ok(r.path.startsWith(path.resolve(outDir)));
    assert.ok(fs.existsSync(r.path));
    assert.deepEqual(readPngSize(r.path), { width: 320, height: 240 });
  }
  assert.equal(path.basename(results[0].path), 'page-001.png');
  assert.equal(path.basename(results[1].path), 'page-002.png');
  assert.deepEqual(fs.readdirSync(outDir).sort(), [
    'page-001.png',
    'page-002.png',
  ]);
  // The input PDF must never be modified.
  assert.deepEqual(fs.readFileSync(pdfPath), before);
});

test('renderPdfPages renders every page when pages is undefined', async (t) => {
  const pdfPath = writePdf(t, [
    { w: LABEL_W, h: LABEL_H },
    { w: LABEL_W, h: LABEL_H },
  ]);
  const outDir = makeTempDir(t);

  const results = await renderPdfPages({
    pdfPath,
    pages: undefined,
    outputDir: outDir,
  });

  assert.equal(results.length, 2);
  assert.deepEqual(fs.readdirSync(outDir).sort(), [
    'page-001.png',
    'page-002.png',
  ]);
});

test('renderPdfPages rejects an A4 page and creates no rasters', async (t) => {
  const pdfPath = writePdf(t, [
    { w: LABEL_W, h: LABEL_H },
    { w: A4_W, h: A4_H },
  ]);
  const outDir = makeTempDir(t);

  await assert.rejects(
    () => renderPdfPages({ pdfPath, pages: '1-2', outputDir: outDir }),
    /does not match/,
  );
  assert.deepEqual(fs.readdirSync(outDir), []);
});

test('renderPdfPages preflights all pages: a later wrong size creates no rasters', async (t) => {
  const pdfPath = writePdf(t, [
    { w: LABEL_W, h: LABEL_H },
    { w: LABEL_W, h: LABEL_H },
    { w: SWAP_W, h: SWAP_H },
  ]);
  const outDir = makeTempDir(t);

  await assert.rejects(
    () => renderPdfPages({ pdfPath, pages: '1-3', outputDir: outDir }),
    /does not match/,
  );
  assert.deepEqual(fs.readdirSync(outDir), []);
});

test('renderPdfPages rejects a 30x40 page (swapped orientation)', async (t) => {
  const pdfPath = writePdf(t, [{ w: SWAP_W, h: SWAP_H }]);
  const outDir = makeTempDir(t);

  await assert.rejects(
    () => renderPdfPages({ pdfPath, pages: '1', outputDir: outDir }),
    /does not match/,
  );
  assert.deepEqual(fs.readdirSync(outDir), []);
});

test('renderPdfPages accepts a 30x40 page rotated 90 (displays 40x30)', async (t) => {
  const pdfPath = writePdf(t, [{ w: SWAP_W, h: SWAP_H, rot: 90 }]);
  const outDir = makeTempDir(t);

  const results = await renderPdfPages({
    pdfPath,
    pages: '1',
    outputDir: outDir,
  });

  assert.equal(results.length, 1);
  assert.deepEqual(readPngSize(results[0].path), { width: 320, height: 240 });
});

test('renderPdfPages rejects a 40x30 page rotated 90 (displays 30x40)', async (t) => {
  const pdfPath = writePdf(t, [{ w: LABEL_W, h: LABEL_H, rot: 90 }]);
  const outDir = makeTempDir(t);

  await assert.rejects(
    () => renderPdfPages({ pdfPath, pages: '1', outputDir: outDir }),
    /does not match/,
  );
  assert.deepEqual(fs.readdirSync(outDir), []);
});

test('renderPdfPages rejects a nonexistent output directory', async (t) => {
  const pdfPath = writePdf(t, [{ w: LABEL_W, h: LABEL_H }]);
  const missing = path.join(os.tmpdir(), 'no-such-niim-output-dir');

  await assert.rejects(
    () => renderPdfPages({ pdfPath, pages: '1', outputDir: missing }),
    /does not exist/,
  );
});

test('renderPdfPages rejects a non-empty output directory', async (t) => {
  const pdfPath = writePdf(t, [{ w: LABEL_W, h: LABEL_H }]);
  const outDir = makeTempDir(t);
  fs.writeFileSync(path.join(outDir, 'existing.txt'), 'x');

  await assert.rejects(
    () => renderPdfPages({ pdfPath, pages: '1', outputDir: outDir }),
    /must be empty/,
  );
});

test('renderPdfPages with an already-aborted signal creates no rasters', async (t) => {
  const pdfPath = writePdf(t, [
    { w: LABEL_W, h: LABEL_H },
    { w: LABEL_W, h: LABEL_H },
    { w: LABEL_W, h: LABEL_H },
  ]);
  const outDir = makeTempDir(t);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () =>
      renderPdfPages({
        pdfPath,
        pages: '1-3',
        outputDir: outDir,
        signal: controller.signal,
      }),
    { name: 'AbortError' },
  );
  assert.deepEqual(fs.readdirSync(outDir), []);
});

test('renderPdfPages renders the CropBox, not a larger MediaBox (no A4 shrink)', async (t) => {
  // MediaBox is A4 but the visible CropBox is exactly 40x30mm, so it passes
  // validation. If pdftoppm used the A4 MediaBox, the full-CropBox red content
  // would be shrunken, leaving the raster mostly white. We require the content
  // to reach the frame edges.
  const pdfPath = writePdf(t, [
    {
      w: A4_W,
      h: A4_H,
      crop: { w: LABEL_W, h: LABEL_H },
      content: redFill(LABEL_W, LABEL_H),
    },
  ]);
  const outDir = makeTempDir(t);

  const results = await renderPdfPages({
    pdfPath,
    pages: '1',
    outputDir: outDir,
  });

  const png = decodePng(results[0].path);
  assert.equal(png.width, 320);
  assert.equal(png.height, 240);
  for (const [x, y] of [
    [160, 120],
    [302, 234],
    [18, 18],
    [160, 10],
  ]) {
    assert.deepEqual(
      pixelAt(png, Math.min(x, png.width - 1), Math.min(y, png.height - 1)),
      [255, 0, 0],
      `expected content at (${x}, ${y})`,
    );
  }
});

test('renderPdfPages renders the CropBox for a rotated page (no A4 shrink)', async (t) => {
  // A4 MediaBox, 30x40mm CropBox rotated 90 -> displays as 40x30mm, which
  // passes validation. Rendering must use the rotated CropBox and never the
  // larger A4 MediaBox; the red content must reach every edge of the 320x240
  // frame.
  const pdfPath = writePdf(t, [
    {
      w: A4_W,
      h: A4_H,
      crop: { w: SWAP_W, h: SWAP_H },
      rot: 90,
      content: redFill(SWAP_W, SWAP_H),
    },
  ]);
  const outDir = makeTempDir(t);

  const results = await renderPdfPages({
    pdfPath,
    pages: '1',
    outputDir: outDir,
  });

  const png = decodePng(results[0].path);
  assert.equal(png.width, 320);
  assert.equal(png.height, 240);
  for (const [x, y] of [
    [160, 120],
    [302, 234],
    [18, 18],
  ]) {
    assert.deepEqual(
      pixelAt(png, Math.min(x, png.width - 1), Math.min(y, png.height - 1)),
      [255, 0, 0],
      `expected content at (${x}, ${y})`,
    );
  }
});
