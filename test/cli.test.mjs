import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const cliPath = path.join(projectRoot, 'src', 'cli.mjs');
const fixtures = path.join(__dirname, 'fixtures');
const labelsPdf = path.join(fixtures, 'labels-40x30-3pages.pdf');
const a4Pdf = path.join(fixtures, 'a4.pdf');

const STUB_PRINTER = `// Temporary stub used only by the CLI test suite (no hardware).
import fs from 'node:fs';
export async function encodePage(page) {
  return { page: page.page };
}
export function createPrinterSession(opts) {
  if (process.env.SPOOLMAN_OPTS_FILE) {
    fs.appendFileSync(process.env.SPOOLMAN_OPTS_FILE, JSON.stringify(opts) + '\\n');
  }
  return {
    async connect() {},
    async disconnect() {},
    cancelStatusPoll() {},
    createTask() {
      return {
        async printInit() {},
        async printPage() {},
        async waitForFinished() {},
        async printEnd() {},
      };
    },
  };
}
`;

const STUB_INFLIGHT_PRINTER = `// Temporary stub used by the SIGINT test (no hardware).
import fs from 'node:fs';
const traceFile = process.env.STUB_TRACE_FILE;
const inflightFile = process.env.STUB_INFLIGHT_FILE;
function trace(msg) { if (traceFile) fs.appendFileSync(traceFile, msg + '\\n'); }
export async function encodePage(page) {
  trace('encode ' + page.page);
  return { page: page.page };
}
export function createPrinterSession() {
  return {
    async connect() { trace('connect'); },
    async disconnect() { trace('disconnect'); },
    cancelStatusPoll() {},
    createTask() {
      return {
        async printInit() {},
        async printPage(encoded) {
          const p = encoded && encoded.page;
          trace('printPage ' + p);
          if (inflightFile && p !== undefined) fs.writeFileSync(inflightFile, String(p));
        },
        async waitForFinished() {
          trace('waitForFinished');
          await new Promise((resolve) => setTimeout(resolve, 300));
        },
        async printEnd() { trace('printEnd'); },
      };
    },
  };
}
`;

const FAKE_TTY_PRELOAD = `for (const stream of [process.stdin, process.stdout]) {
  if (stream == null) continue;
  Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
  if (typeof stream.setRawMode !== 'function') stream.setRawMode = () => {};
}
`;

const tempParents = [];

function makeParentDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spoolman-cli-test-'));
  tempParents.push(dir);
  return dir;
}

function run(args, { input, env } = {}) {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    cwd: projectRoot,
    env: { ...process.env, ...env },
    input,
  });
  return res;
}

function runWithPreload(preloadPath, args, { input, env } = {}) {
  const res = spawnSync(
    process.execPath,
    ['--import', preloadPath, cliPath, ...args],
    {
      encoding: 'utf8',
      cwd: projectRoot,
      env: { ...process.env, ...env },
      input,
    },
  );
  return res;
}

function spawnAsync(args, env) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  return { child, getStdout: () => stdout, getStderr: () => stderr };
}

async function waitUntil(fn, ms, label) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function childExit(child, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('child did not exit in time')),
      ms,
    );
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function pngSize(file) {
  const b = fs.readFileSync(file);
  assert.ok(b.length >= 24, 'file is too small to be a PNG');
  assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'not a PNG');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

after(() => {
  for (const dir of tempParents) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--help prints usage with NIIMBOT B1 and exits 0 without importing native modules', () => {
  const res = run(['--help']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /NIIMBOT B1/);
  assert.doesNotMatch(res.stdout, /Brother/);
  assert.match(res.stdout, /--dry-run/);
  assert.match(res.stdout, /--verbose/);
  assert.match(res.stdout, /--legacy-usb-connect/);
  assert.match(res.stdout, /Exit codes:/);
  assert.equal(res.stderr, '');
});

test('missing PDF file produces a friendly error', () => {
  const res = run([path.join(fixtures, 'does-not-exist.pdf')]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /PDF file not found/);
  assert.doesNotThrow(() => JSON.stringify(res.stdout));
});

test('unknown flag is rejected', () => {
  const res = run([labelsPdf, '--nonsense']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /argument/i);
});

test('bad --density is rejected', () => {
  const res = run([labelsPdf, '--density', '9']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--density must be an integer between 1 and 5/);
});

test('exactly one positional PDF is required', () => {
  const res = run([]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /exactly one PDF file/);
});

test('non-TTY print without --yes fails early (never opens serial)', () => {
  const res = run([labelsPdf]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /stdin is not a TTY/);
  assert.match(res.stderr, /--yes/);
});

test('--output-dir is rejected without --dry-run (fails before any serial import)', () => {
  const parent = makeParentDir();
  const out = path.join(parent, 'preview');
  const res = run([labelsPdf, '--yes', '--output-dir', out]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--output-dir is only valid with --dry-run/);
  assert.equal(fs.existsSync(out), false);
});

test('--pages "" is rejected in dry-run (empty spec is not silently all)', () => {
  const parent = makeParentDir();
  const out = path.join(parent, 'preview');
  const res = run([labelsPdf, '--dry-run', '--pages', '', '--output-dir', out]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /invalid --pages/);
  assert.equal(fs.existsSync(out), false);
});

test('--pages "" is rejected in normal mode with --yes before importing the adapter', () => {
  const res = run([labelsPdf, '--yes', '--pages', '']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /invalid --pages/);
  assert.doesNotMatch(res.stderr, /printer adapter/);
});

test('dry-run renders 2 pages with correct names, mapping and exactly 320x240 PNGs', () => {
  const parent = makeParentDir();
  const out = path.join(parent, 'preview');
  const res = run([labelsPdf, '--dry-run', '--pages', '1-2', '--output-dir', out]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /dry-run: rendered 2 preview\(s\)/);
  assert.match(res.stdout, /page 1: 1 copy -> label-1\.png \(320x240\)/);
  assert.match(res.stdout, /page 2: 1 copy -> label-2\.png \(320x240\)/);

  const d = path.join(out, 'label-1.png');
  assert.ok(fs.existsSync(d), 'label-1.png exists');
  assert.deepEqual(pngSize(d), { width: 320, height: 240 });
  const f2 = path.join(out, 'label-2.png');
  assert.deepEqual(pngSize(f2), { width: 320, height: 240 });

  const entries = fs.readdirSync(out).filter((n) => n.endsWith('.png')).sort();
  assert.deepEqual(entries, ['label-1.png', 'label-2.png']);
});

test('dry-run never overwrites an existing output directory and preserves its contents', () => {
  const parent = makeParentDir();
  const out = path.join(parent, 'preview');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'keep.txt'), 'keep-me');

  const res = run([labelsPdf, '--dry-run', '--pages', '1', '--output-dir', out]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /output directory already exists/);
  assert.equal(fs.readFileSync(path.join(out, 'keep.txt'), 'utf8'), 'keep-me');
  assert.equal(fs.existsSync(path.join(out, 'label-1.png')), false);
});

test('A4 page is rejected and no output directory is left behind', () => {
  const parent = makeParentDir();
  const out = path.join(parent, 'a4-preview');
  const res = run([a4Pdf, '--dry-run', '--output-dir', out]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /does not match 40x30mm/);
  assert.equal(fs.existsSync(out), false);
});

test('full normal print with --yes (non-TTY) prints sequentially through the adapter stub', () => {
  const parent = makeParentDir();
  const stubPath = path.join(parent, 'stub-printer.mjs');
  fs.writeFileSync(stubPath, STUB_PRINTER, 'utf8');

  const res = run([labelsPdf, '--yes', '--pages', '1'], {
    env: { SPOOLMAN_B1_ADAPTER: stubPath },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /About to print 1 label\(s\):/);
  assert.match(res.stdout, /port: \/dev\/ttyACM0/);
  assert.match(res.stdout, /density: 3/);
  assert.match(res.stdout, /printed page 1/);
  assert.match(res.stdout, /successfully printed 1 label\(s\)/);
});

test('normal print with --verbose passes a verbose flag through to createPrinterSession', () => {
  const parent = makeParentDir();
  const stubPath = path.join(parent, 'stub-printer.mjs');
  fs.writeFileSync(stubPath, STUB_PRINTER, 'utf8');
  const optsFile = path.join(parent, 'opts.txt');

  const res = run([labelsPdf, '--yes', '--pages', '1', '--verbose'], {
    env: { SPOOLMAN_B1_ADAPTER: stubPath, SPOOLMAN_OPTS_FILE: optsFile },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /successfully printed 1 label\(s\)/);

  const lines = fs.readFileSync(optsFile, 'utf8').trim().split('\n');
  const opts = JSON.parse(lines[lines.length - 1]);
  assert.equal(opts.verbose, true, '--verbose must reach createPrinterSession');
  assert.equal(opts.legacyUsbConnect, false, 'legacyUsbConnect defaults to false');
  assert.equal(opts.port, '/dev/ttyACM0');
  assert.equal(opts.density, 3);
});

test('normal print with --legacy-usb-connect passes the flag through to createPrinterSession', () => {
  const parent = makeParentDir();
  const stubPath = path.join(parent, 'stub-printer.mjs');
  fs.writeFileSync(stubPath, STUB_PRINTER, 'utf8');
  const optsFile = path.join(parent, 'opts.txt');

  const res = run([labelsPdf, '--yes', '--pages', '1', '--legacy-usb-connect'], {
    env: { SPOOLMAN_B1_ADAPTER: stubPath, SPOOLMAN_OPTS_FILE: optsFile },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /successfully printed 1 label\(s\)/);

  const lines = fs.readFileSync(optsFile, 'utf8').trim().split('\n');
  const opts = JSON.parse(lines[lines.length - 1]);
  assert.equal(opts.legacyUsbConnect, true, '--legacy-usb-connect must reach createPrinterSession');
  assert.equal(opts.verbose, false, 'verbose defaults to false');
  assert.equal(opts.port, '/dev/ttyACM0');
  assert.equal(opts.density, 3);
});

test('dry-run with --verbose still never imports the adapter (bogus module path)', () => {
  const parent = makeParentDir();
  const out = path.join(parent, 'preview');
  const res = run([labelsPdf, '--dry-run', '--pages', '1', '--verbose', '--output-dir', out], {
    env: { SPOOLMAN_B1_ADAPTER: '/tmp/spoolman-no-adapter.mjs' },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /dry-run: rendered 1 preview/);
  assert.equal(fs.existsSync(path.join(out, 'label-1.png')), true);
});

test('dry-run with --legacy-usb-connect still never imports the adapter (bogus module path)', () => {
  const parent = makeParentDir();
  const out = path.join(parent, 'preview');
  const res = run([labelsPdf, '--dry-run', '--pages', '1', '--legacy-usb-connect', '--output-dir', out], {
    env: { SPOOLMAN_B1_ADAPTER: '/tmp/spoolman-no-adapter.mjs' },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /dry-run: rendered 1 preview/);
  assert.equal(fs.existsSync(path.join(out, 'label-1.png')), true);
});

test('dry-run errors EEXIST and preserves a sentinel when the output directory appears during PDF preflight', () => {
  const parent = makeParentDir();
  const out = path.join(parent, 'preview');
  const wrapperDir = path.join(parent, 'wrapper');
  fs.mkdirSync(wrapperDir);

  const realPdfinfo = spawnSync('which', ['pdfinfo'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(realPdfinfo, 'pdfinfo must be resolvable via which');
  const wrapper = path.join(wrapperDir, 'pdfinfo');
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh
mkdir -p "$SPOOLMAN_OUTDIR"
printf "sentinel" > "$SPOOLMAN_OUTDIR/sentinel.txt"
exec "$SPOOLMAN_REAL_PDFINFO" "$@"
`,
    'utf8',
  );
  fs.chmodSync(wrapper, 0o755);

  const env = {
    SPOOLMAN_B1_ADAPTER: '/tmp/spoolman-no-adapter.mjs',
    SPOOLMAN_OUTDIR: out,
    SPOOLMAN_REAL_PDFINFO: realPdfinfo,
    PATH: wrapperDir + path.delimiter + process.env.PATH,
  };
  const res = run([labelsPdf, '--dry-run', '--pages', '1', '--output-dir', out], { env });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /output directory already exists/);
  assert.equal(fs.readFileSync(path.join(out, 'sentinel.txt'), 'utf8'), 'sentinel');
  assert.equal(fs.existsSync(path.join(out, 'label-1.png')), false);
});

test('SIGINT during an in-flight stub print finishes page 1, never starts page 2, and exits 130', { timeout: 15000 }, async () => {
  const parent = makeParentDir();
  const stubPath = path.join(parent, 'stub-printer.mjs');
  const trace = path.join(parent, 'trace.txt');
  const inflight = path.join(parent, 'inflight.txt');
  fs.writeFileSync(stubPath, STUB_INFLIGHT_PRINTER, 'utf8');

  const env = {
    SPOOLMAN_B1_ADAPTER: stubPath,
    STUB_TRACE_FILE: trace,
    STUB_INFLIGHT_FILE: inflight,
  };
  const { child, getStdout, getStderr } = spawnAsync(
    [labelsPdf, '--yes', '--pages', '1-2'],
    env,
  );

  try {
    await waitUntil(
      () => fs.existsSync(inflight) && fs.readFileSync(inflight, 'utf8').trim() === '1',
      5000,
      'stub to reach the in-flight marker',
    );
    child.kill('SIGINT');
    const { code } = await childExit(child, 8000);
    assert.equal(code, 130, `stdout=${getStdout()} stderr=${getStderr()}`);

    const stdout = getStdout();
    assert.match(stdout, /printed page 1/);
    assert.match(stdout, /interrupted after 1 printed page\(s\)/);

    const traceContent = fs.readFileSync(trace, 'utf8');
    assert.match(traceContent, /disconnect/);
    assert.match(traceContent, /printPage 1/);
    assert.doesNotMatch(traceContent, /printPage 2/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
});

test('interactive prompt (fake TTY) default No cancels and never imports the adapter', () => {
  const parent = makeParentDir();
  const preload = path.join(parent, 'preload.mjs');
  fs.writeFileSync(preload, FAKE_TTY_PRELOAD, 'utf8');

  const res = runWithPreload(preload, [labelsPdf, '--pages', '1'], {
    input: '\n',
    env: { SPOOLMAN_B1_ADAPTER: '/tmp/spoolman-no-adapter.mjs' },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Print now\?/);
  assert.match(res.stdout, /cancelled \(no labels printed\)/);
  assert.doesNotMatch(res.stderr, /failed to load printer adapter/);
});

test('interactive prompt (fake TTY) Ctrl-C exits 130 and never imports the adapter', () => {
  const parent = makeParentDir();
  const preload = path.join(parent, 'preload.mjs');
  fs.writeFileSync(preload, FAKE_TTY_PRELOAD, 'utf8');

  const res = runWithPreload(preload, [labelsPdf, '--pages', '1'], {
    input: '\x03',
    env: { SPOOLMAN_B1_ADAPTER: '/tmp/spoolman-no-adapter.mjs' },
  });
  assert.equal(res.status, 130);
  assert.match(res.stdout, /Print now\?/);
  assert.doesNotMatch(res.stderr, /failed to load printer adapter/);
});

test('interactive prompt (fake TTY) EOF does not hang and cancels', () => {
  const parent = makeParentDir();
  const preload = path.join(parent, 'preload.mjs');
  fs.writeFileSync(preload, FAKE_TTY_PRELOAD, 'utf8');

  const res = runWithPreload(preload, [labelsPdf, '--pages', '1'], {
    input: '',
    env: { SPOOLMAN_B1_ADAPTER: '/tmp/spoolman-no-adapter.mjs' },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /cancelled \(no labels printed\)/);
  assert.doesNotMatch(res.stderr, /failed to load printer adapter/);
});
