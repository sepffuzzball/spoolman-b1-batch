import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';

const execFileP = promisify(execFile);

// Physical paper geometry (points per inch = 72 by definition).
const PT_PER_INCH = 72;
const MM_PER_INCH = 25.4;

// Expected Niimbot B1 label page size in millimetres.
const EXPECTED_WIDTH_MM = 40;
const EXPECTED_HEIGHT_MM = 30;
const TOLERANCE_MM = 0.5;

const MAX_PAGES = 1000;
const PROC_TIMEOUT_MS = 30000;
const PROC_MAX_BUFFER = 20 * 1024 * 1024;

// Should be 320x240 for the B1 output raster.
const RENDER_WIDTH = 320;
const RENDER_HEIGHT = 240;

function ptsToMm(pts) {
  return (pts * MM_PER_INCH) / PT_PER_INCH;
}

function isAbortError(err) {
  return Boolean(
    err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'),
  );
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    throw new DOMException('The operation was aborted', 'AbortError');
  }
}

/**
 * Run a Poppler command with no shell, a hard timeout and bounded output.
 * An optional AbortSignal is forwarded to the child process and re-checked
 * so an abort interrupts the command without producing partial output.
 * @param {string} cmd
 * @param {string[]} args
 * @param {AbortSignal} [signal]
 * @returns {Promise<{stdout: string}>}
 */
async function runPoppler(cmd, args, signal) {
  try {
    const { stdout } = await execFileP(cmd, args, {
      encoding: 'utf8',
      timeout: PROC_TIMEOUT_MS,
      maxBuffer: PROC_MAX_BUFFER,
      windowsHide: true,
      shell: false,
      signal,
      // Force the C locale so pdfinfo/pdftoppm emit English keys with a
      // period decimal separator, independent of the system locale. PATH and
      // every other environment variable are preserved.
      env: { ...process.env, LC_ALL: 'C' },
    });
    return { stdout };
  } catch (err) {
    if (isAbortError(err)) {
      throw err;
    }
    const code = err && err.code;
    if (code === 'ENOENT') {
      throw new Error(
        `${cmd} not found: the Poppler utilities (${cmd}) are required`,
      );
    }
    const stderr = (err && err.stderr) || '';
    const stdout = (err && err.stdout) || '';
    const detail = `${stderr}${stdout}`.trim();
    const isMalformed =
      /Syntax (Error|Warning)|trailer dictionary|xref table|Couldn't open file|Unknown command/i.test(
        detail,
      );
    if (isMalformed) {
      throw new Error(`Malformed or unreadable PDF (${cmd}): ${detail}`);
    }
    const reason =
      detail || (err && err.message ? err.message : `exit code ${code}`);
    throw new Error(`${cmd} failed: ${reason}`);
  }
}

function validateTotalPages(totalPages) {
  if (
    !Number.isInteger(totalPages) ||
    totalPages < 1 ||
    totalPages > MAX_PAGES
  ) {
    throw new Error(
      `totalPages must be an integer between 1 and ${MAX_PAGES}, got ${totalPages}`,
    );
  }
}

function addPage(n, totalPages, out) {
  if (!Number.isInteger(n)) {
    throw new Error(`page number must be an integer, got ${n}`);
  }
  if (n < 1) {
    throw new Error(`page numbers are 1-based, got ${n}`);
  }
  if (n > totalPages) {
    throw new Error(`page number ${n} is out of range (total ${totalPages})`);
  }
  out.add(n);
}

function parseSegment(seg, totalPages, out) {
  if (typeof seg === 'number') {
    addPage(seg, totalPages, out);
    return;
  }
  if (typeof seg !== 'string') {
    throw new Error(`invalid page spec segment: ${JSON.stringify(seg)}`);
  }
  const trimmed = seg.trim();
  if (trimmed === '') {
    throw new Error('empty page spec segment');
  }
  const m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(trimmed);
  if (!m) {
    throw new Error(`invalid page spec segment: "${seg}"`);
  }
  const a = parseInt(m[1], 10);
  if (a === 0) {
    throw new Error(`page numbers are 1-based, got 0 in "${seg}"`);
  }
  if (m[2] !== undefined) {
    const b = parseInt(m[2], 10);
    if (b === 0) {
      throw new Error(`page numbers are 1-based, got 0 in "${seg}"`);
    }
    if (a > b) {
      throw new Error(`reversed page range "${seg}"`);
    }
    if (b > totalPages) {
      throw new Error(
        `page number ${b} is out of range (total ${totalPages})`,
      );
    }
    for (let p = a; p <= b; p++) {
      out.add(p);
    }
  } else {
    if (a > totalPages) {
      throw new Error(
        `page number ${a} is out of range (total ${totalPages})`,
      );
    }
    out.add(a);
  }
}

function toSegments(spec) {
  if (Array.isArray(spec)) {
    const segs = [];
    for (const e of spec) {
      if (typeof e === 'string') {
        segs.push(...e.split(','));
      } else {
        segs.push(e);
      }
    }
    return segs;
  }
  if (typeof spec === 'string') {
    return spec.split(',');
  }
  if (typeof spec === 'number') {
    return [spec];
  }
  throw new Error(`invalid page spec: ${JSON.stringify(spec)}`);
}

/**
 * Parse a page-selection spec into a sorted, unique array of 1-based page
 * indices. An `undefined` (or `null`) spec means "all pages".
 * Supported spec forms:
 *   - undefined / null -> every page 1..totalPages
 *   - string such as "1-3,5"
 *   - a single page number
 *   - an array of numbers/segments, e.g. [1, "2-3", 5]
 * @param {string|number|Array|undefined|null} spec
 * @param {number} totalPages
 * @returns {number[]}
 */
export function parsePages(spec, totalPages) {
  validateTotalPages(totalPages);
  if (spec === undefined || spec === null) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const out = new Set();
  for (const seg of toSegments(spec)) {
    parseSegment(seg, totalPages, out);
  }
  return Array.from(out).sort((a, b) => a - b);
}

/**
 * Inspect a PDF file. Rejects nonexistent/non-file paths, PDFs with no pages,
 * and PDFs with more than MAX_PAGES pages.
 * @param {string} pdfPath
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<{path: string, totalPages: number}>}
 */
export async function inspectPdf(pdfPath, { signal } = {}) {
  throwIfAborted(signal);
  const abs = path.resolve(pdfPath);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error(`PDF file not found: ${pdfPath}`);
  }
  if (!st.isFile()) {
    throw new Error(`PDF path is not a file: ${pdfPath}`);
  }
  const { stdout } = await runPoppler('pdfinfo', [abs], signal);
  const m = /^Pages:\s*(\d+)/m.exec(stdout);
  if (!m) {
    throw new Error(`Malformed PDF: could not determine page count (${abs})`);
  }
  const totalPages = parseInt(m[1], 10);
  if (totalPages < 1) {
    throw new Error(`PDF has no pages (${abs})`);
  }
  if (totalPages > MAX_PAGES) {
    throw new Error(
      `PDF has ${totalPages} pages (max ${MAX_PAGES}) (${abs})`,
    );
  }
  return { path: abs, totalPages };
}

/**
 * Query the effective visible box (CropBox, or MediaBox when the page has no
 * CropBox) dimensions and rotation for a single page via
 * `pdfinfo -f N -l N`. Robustly handles both the `Page N size`/`Page N rot`
 * lines and the generic `Page size`/`Page rot` lines. pdfinfo reports the
 * CropBox, so validation is based on the visible box.
 * @param {string} pdfPath
 * @param {number} pageNum
 * @returns {Promise<{widthPt: number, heightPt: number, rot: number}>}
 */
async function getPageInfo(pdfPath, pageNum, signal) {
  throwIfAborted(signal);
  const { stdout } = await runPoppler(
    'pdfinfo',
    ['-f', String(pageNum), '-l', String(pageNum), pdfPath],
    signal,
  );
  const pageSizeRe = new RegExp(
    `^Page\\s+${pageNum}\\s+size:\\s*([\\d.]+)\\s*x\\s*([\\d.]+)\\s*pts`,
    'm',
  );
  const pageRotRe = new RegExp(
    `^Page\\s+${pageNum}\\s+rot:\\s*(-?\\d+)`,
    'm',
  );
  const genericSizeRe = /^Page size:\s*([\d.]+)\s*x\s*([\d.]+)\s*pts/m;
  const genericRotRe = /^Page rot:\s*(-?\d+)/m;

  let m = pageSizeRe.exec(stdout);
  if (m) {
    var widthPt = parseFloat(m[1]);
    var heightPt = parseFloat(m[2]);
  } else {
    m = genericSizeRe.exec(stdout);
    if (m) {
      widthPt = parseFloat(m[1]);
      heightPt = parseFloat(m[2]);
    } else {
      throw new Error(`Could not determine size of page ${pageNum}`);
    }
  }
  let rot = 0;
  m = pageRotRe.exec(stdout);
  if (m) {
    rot = parseInt(m[1], 10);
  } else {
    m = genericRotRe.exec(stdout);
    if (m) {
      rot = parseInt(m[1], 10);
    }
  }
  return { widthPt, heightPt, rot };
}

/**
 * Validate that a page's *displayed* physical size is 40x30mm (within
 * tolerance). A 90/270 degree rotation swaps the displayed width and height,
 * so a rotated page must be 30x40mm in the visible box (CropBox, defaulting to
 * MediaBox) to display as 40x30mm.
 * @returns {{ok: boolean, widthMm: number, heightMm: number, rotated: boolean}}
 */
function validatePageSize(info) {
  const rotated = info.rot % 180 !== 0;
  const wPt = rotated ? info.heightPt : info.widthPt;
  const hPt = rotated ? info.widthPt : info.heightPt;
  const widthMm = ptsToMm(wPt);
  const heightMm = ptsToMm(hPt);
  const ok =
    Math.abs(widthMm - EXPECTED_WIDTH_MM) <= TOLERANCE_MM &&
    Math.abs(heightMm - EXPECTED_HEIGHT_MM) <= TOLERANCE_MM;
  return { ok, widthMm, heightMm, rotated };
}

/**
 * Validate a PNG's IHDR chunk and return its pixel dimensions.
 * @param {string} filePath
 * @returns {{width: number, height: number}}
 */
function readPngSize(filePath) {
  const buf = fs.readFileSync(filePath);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(sig)) {
    throw new Error(`Not a PNG file: ${filePath}`);
  }
  const chunkType = buf.subarray(12, 16).toString('ascii');
  if (chunkType !== 'IHDR') {
    throw new Error(`First PNG chunk is not IHDR: ${filePath}`);
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

/**
 * Render selected pages of a PDF into PNGs in an existing, empty directory.
 * Every selected page's physical size is validated (40x30mm +/- 0.5mm, and
 * rotation taken into account) BEFORE any page is rasterised, so a wrong-sized
 * page anywhere in the selection produces no partial rasters. Validation and
 * rasterisation both use the page's visible box (CropBox, defaulting to
 * MediaBox): pdfinfo reports the CropBox and pdftoppm is invoked with
 * -cropbox, so a page whose CropBox is 40x30mm is never rendered from its
 * (possibly larger) MediaBox. The input PDF is never modified; on a rendering
 * error the caller owns cleanup.
 * @param {{pdfPath: string, pages?: *, outputDir: string, signal?: AbortSignal}} opts
 * @returns {Promise<Array<{page: number, path: string, width: number, height: number}>>}
 */
export async function renderPdfPages({ pdfPath, pages, outputDir, signal }) {
  throwIfAborted(signal);
  const outDir = path.resolve(outputDir);
  let st;
  try {
    st = fs.statSync(outDir);
  } catch {
    throw new Error(`outputDir does not exist: ${outputDir}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`outputDir is not a directory: ${outputDir}`);
  }
  if (fs.readdirSync(outDir).length !== 0) {
    throw new Error(`outputDir must be empty: ${outputDir}`);
  }

  const absPdf = path.resolve(pdfPath);
  const pdf = await inspectPdf(absPdf, { signal });
  const totalPages = pdf.totalPages;
  const selected = parsePages(pages, totalPages);

  // Preflight: validate every selected page's size before rasterising any.
  const validated = [];
  for (const page of selected) {
    throwIfAborted(signal);
    const info = await getPageInfo(absPdf, page, signal);
    const v = validatePageSize(info);
    if (!v.ok) {
      throw new Error(
        `page ${page} size ${v.widthMm.toFixed(2)}x${v.heightMm.toFixed(2)}mm does not match ` +
          `${EXPECTED_WIDTH_MM}x${EXPECTED_HEIGHT_MM}mm (+/-${TOLERANCE_MM}mm)`,
      );
    }
    validated.push({ page, info: v });
  }

  const results = [];
  for (const { page, info } of validated) {
    throwIfAborted(signal);
    const name = `page-${String(page).padStart(3, '0')}`;
    const prefix = path.join(outDir, name);
    // Render the *visible* box (CropBox, defaulting to MediaBox) so the raster
    // matches the box pdfinfo validated. pdftoppm applies -scale-to-x/-y along
    // the visible-box axes and then rotates the raster, so a 90/270-degree page
    // swaps the output dimensions. Invert the scale targets for such pages so
    // the final PNG is always 320x240 regardless of the page's rotation.
    const swapped = info.rotated;
    const scaleToX = swapped ? RENDER_HEIGHT : RENDER_WIDTH;
    const scaleToY = swapped ? RENDER_WIDTH : RENDER_HEIGHT;
    await runPoppler(
      'pdftoppm',
      [
        '-f',
        String(page),
        '-l',
        String(page),
        '-singlefile',
        '-cropbox',
        '-scale-to-x',
        String(scaleToX),
        '-scale-to-y',
        String(scaleToY),
        '-png',
        absPdf,
        prefix,
      ],
      signal,
    );
    const pngPath = `${prefix}.png`;
    const png = readPngSize(pngPath);
    if (png.width !== RENDER_WIDTH || png.height !== RENDER_HEIGHT) {
      throw new Error(
        `rendered page ${page} is ${png.width}x${png.height}, expected ${RENDER_WIDTH}x${RENDER_HEIGHT}`,
      );
    }
    results.push({
      page,
      path: pngPath,
      width: RENDER_WIDTH,
      height: RENDER_HEIGHT,
    });
  }
  return results;
}
