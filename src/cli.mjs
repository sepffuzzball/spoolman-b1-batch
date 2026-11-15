#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  existsSync,
  constants as fsConstants,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_PORT = '/dev/ttyACM0';
const DEFAULT_DENSITY = 3;
const DEFAULT_OUTPUT_DIR = './label-preview';
const TIMEOUT_MS = 60000;
const CLEANUP_TIMEOUT_MS = 5000;
// Adapter module path; overridable for tests. Defaults to the in-repo adapter.
const PRINTER_MODULE = process.env.SPOOLMAN_B1_ADAPTER || './printer.mjs';

const USAGE = `spoolman-b1-batch - render multi-page 40x30mm label PDFs and print them
sequentially to an NIIMBOT B1 USB label printer.

Usage:
  spoolman-b1-batch <labels.pdf> [options]

Positional:
  <labels.pdf>   Input PDF containing exactly one 40x30mm label per page.

Options:
  --port <path>       Serial device path. Default: /dev/ttyACM0
  --density <1-5>     Print density (1-5). Default: 3
  --pages <spec>      Page selection, e.g. "1" or "1,3-5". Default: all pages.
  --dry-run           Render 320x240 preview PNGs without printing (no serial needed).
  --output-dir <dir>  Dry-run destination (must not already exist). Default: ./label-preview
  --yes               Skip the interactive confirmation (required when stdin is not a TTY).
  --help              Show this help and exit.

Exit codes:
  0   success
  1   error
  130 interrupted (SIGINT)
`;

const OPTIONS = {
  port: { type: 'string', default: DEFAULT_PORT },
  density: { type: 'string', default: String(DEFAULT_DENSITY) },
  pages: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  'output-dir': { type: 'string' },
  yes: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
};

function allPages(totalPages) {
  const pages = [];
  for (let i = 1; i <= totalPages; i++) pages.push(i);
  return pages;
}

function formatPages(pages) {
  return pages.join(', ');
}

async function promptYesNo(question, { signal, onInterrupt }) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // In a real TTY the readline interface consumes Ctrl-C itself and emits
  // "SIGINT" on the interface (the process does not necessarily receive it),
  // so we must bridge it to the caller's AbortController explicitly. A pending
  // question must never hang if the stream closes (EOF) or an abort lands.
  const local = new AbortController();
  const onSigint = () => {
    if (onInterrupt) onInterrupt();
    local.abort();
  };
  const onClose = () => local.abort();
  rl.on('SIGINT', onSigint);
  rl.on('close', onClose);
  if (signal) {
    if (signal.aborted) local.abort();
    else signal.addEventListener('abort', () => local.abort(), { once: true });
  }
  try {
    const answer = await rl.question(question, { signal: local.signal });
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

async function runDryRun({ pdfPath, pagesSpec, outputDir }) {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on('SIGINT', onSigint);

  try {
    const pdf = await import('./pdf.mjs');
    const { inspectPdf, parsePages, renderPdfPages } = pdf;

    let pdfInfo;
    try {
      pdfInfo = await inspectPdf(pdfPath, { signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) return 130;
      process.stderr.write(`error: failed to inspect PDF: ${err.message}\n`);
      return 1;
    }

    const totalPages = pdfInfo.totalPages;
    let pages;
    try {
      pages = pagesSpec !== undefined ? parsePages(pagesSpec, totalPages) : allPages(totalPages);
    } catch (err) {
      if (controller.signal.aborted) return 130;
      process.stderr.write(`error: invalid --pages: ${err.message}\n`);
      return 1;
    }

    if (controller.signal.aborted) return 130;

    const tempDir = mkdtempSync(path.join(tmpdir(), 'spoolman-b1-batch-'));
    let outputCreated = false;
    try {
      let rendered;
      try {
        rendered = await renderPdfPages({ pdfPath, pages, outputDir: tempDir, signal: controller.signal });
      } catch (err) {
        if (controller.signal.aborted) return 130;
        process.stderr.write(`error: ${err.message}\n`);
        return 1;
      }

      if (controller.signal.aborted) return 130;

      // Create the final output directory exclusively (non-recursive) so we can
      // prove we created it: if a directory appears while we rendered, mkdirSync
      // throws EEXIST and we never claim ownership or delete someone else's
      // data. The parent directory must already exist.
      try {
        mkdirSync(outputDir);
      } catch (err) {
        if (err && err.code === 'EEXIST') {
          process.stderr.write(`error: output directory already exists: ${outputDir}\n`);
          process.stderr.write('       (use a new directory or remove the existing one; existing files are not overwritten)\n');
          return 1;
        }
        throw err;
      }
      outputCreated = true;

      const renderedSorted = [...rendered].sort((a, b) => a.page - b.page);
      const summaries = [];
      for (const item of renderedSorted) {
        const destName = `label-${item.page}.png`;
        const dest = path.join(outputDir, destName);
        copyFileSync(item.path, dest, fsConstants.COPYFILE_EXCL);
        summaries.push({
          page: item.page,
          preview: destName,
          count: 1,
          width: item.width,
          height: item.height,
        });
      }

      process.stdout.write(`dry-run: rendered ${summaries.length} preview(s) to ${path.resolve(outputDir)}\n`);
      for (const s of summaries) {
        process.stdout.write(`  page ${s.page}: ${s.count} copy -> ${s.preview} (${s.width}x${s.height})\n`);
      }
      return 0;
    } catch (err) {
      if (outputCreated) {
        try { rmSync(outputDir, { recursive: true, force: true }); } catch {}
      }
      process.stderr.write(`error: ${err.message}\n`);
      return 1;
    } finally {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

async function runPrint({ pdfPath, pagesSpec, port, density, yes }) {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on('SIGINT', onSigint);

  const isTTY = process.stdin.isTTY === true;

  if (!yes && !isTTY) {
    process.stderr.write('error: stdin is not a TTY; pass --yes to confirm printing\n');
    process.removeListener('SIGINT', onSigint);
    return 1;
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), 'spoolman-b1-batch-'));
  try {
    const pdf = await import('./pdf.mjs');
    const { inspectPdf, parsePages, renderPdfPages } = pdf;

    let pdfInfo;
    try {
      pdfInfo = await inspectPdf(pdfPath, { signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) return 130;
      process.stderr.write(`error: failed to inspect PDF: ${err.message}\n`);
      return 1;
    }

    const totalPages = pdfInfo.totalPages;
    let pages;
    try {
      pages = pagesSpec !== undefined ? parsePages(pagesSpec, totalPages) : allPages(totalPages);
    } catch (err) {
      if (controller.signal.aborted) return 130;
      process.stderr.write(`error: invalid --pages: ${err.message}\n`);
      return 1;
    }

    let rendered;
    try {
      rendered = await renderPdfPages({ pdfPath, pages, outputDir: tempDir, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) return 130;
      process.stderr.write(`error: ${err.message}\n`);
      return 1;
    }

    // Abort paused the preflight/raster: stop before prompting or importing the adapter.
    if (controller.signal.aborted) return 130;

    if (rendered.length !== pages.length) {
      process.stderr.write(`error: expected ${pages.length} rendered page(s) but received ${rendered.length}\n`);
      return 1;
    }

    process.stdout.write(`About to print ${pages.length} label(s):\n`);
    process.stdout.write(`  pages: ${formatPages(pages)}\n`);
    process.stdout.write(`  size: 40x30 mm (203 DPI -> 320x240 px)\n`);
    process.stdout.write(`  port: ${port}\n`);
    process.stdout.write(`  density: ${density}\n`);

    let confirmed = yes;
    if (!confirmed && isTTY) {
      try {
        confirmed = await promptYesNo('Print now? [y/N] ', {
          signal: controller.signal,
          onInterrupt: () => controller.abort(),
        });
      } catch (err) {
        if (controller.signal.aborted) return 130;
        process.stderr.write(`error: ${err.message}\n`);
        return 1;
      }
    }

    if (controller.signal.aborted) return 130;

    if (!confirmed) {
      process.stdout.write('cancelled (no labels printed)\n');
      return 0;
    }

    // Only after explicit confirmation do we touch the serial/printer adapter.
    let printer;
    try {
      printer = await import(PRINTER_MODULE);
    } catch (err) {
      if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
        process.stderr.write(`error: failed to load printer adapter (${PRINTER_MODULE}): ${err.message}\n`);
        process.stderr.write('       (run `npm ci` to install the pinned dependencies, then try again)\n');
        return 1;
      }
      throw err;
    }

    if (controller.signal.aborted) return 130;

    const { runBatch, BatchPrintError } = await import('./batch.mjs');

    const createSession = () => printer.createPrinterSession({ port, density });
    const onProgress = ({ page }) => {
      process.stdout.write(`  printed page ${page}\n`);
    };

    let result;
    try {
      result = await runBatch({
        pages: rendered,
        encodePage: printer.encodePage,
        createSession,
        signal: controller.signal,
        onProgress,
        timeoutMs: TIMEOUT_MS,
        cleanupTimeoutMs: CLEANUP_TIMEOUT_MS,
      });
    } catch (err) {
      if (err instanceof BatchPrintError) {
        const completedPages = err.completedPages || [];
        process.stdout.write(`print failed after ${completedPages.length} confirmed page(s)\n`);
        if (err.uncertainPage != null) {
          process.stdout.write(`  page ${err.uncertainPage} may have printed (device/firmware untested; no automatic retry)\n`);
        }
        process.stdout.write(`  completed: ${formatPages(completedPages)}\n`);
        if (err.cause) {
          process.stderr.write(`error: ${err.cause && err.cause.message ? err.cause.message : err.cause}\n`);
        } else {
          process.stderr.write(`error: ${err.message}\n`);
        }
        // If the failure is a side effect of an interrupt (SIGINT), report the
        // interrupt exit code after the diagnostics.
        return controller.signal.aborted ? 130 : 1;
      }
      throw err;
    }

    if (result.interrupted || controller.signal.aborted) {
      const done = Array.isArray(result.completedPages) ? result.completedPages.length : 0;
      process.stdout.write(`interrupted after ${done} printed page(s)\n`);
      return 130;
    }

    const done = Array.isArray(result.completedPages) ? result.completedPages.length : 0;
    process.stdout.write(`successfully printed ${done} label(s)\n`);
    return 0;
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    process.removeListener('SIGINT', onSigint);
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: OPTIONS,
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    return 1;
  }

  const { values, positionals } = parsed;

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (positionals.length !== 1) {
    process.stderr.write('error: expected exactly one PDF file argument (run --help for usage)\n');
    return 1;
  }

  const pdfPath = positionals[0];

  if (!existsSync(pdfPath)) {
    process.stderr.write(`error: PDF file not found: ${pdfPath}\n`);
    return 1;
  }

  const densityNum = Number(values.density);
  if (!Number.isInteger(densityNum) || densityNum < 1 || densityNum > 5) {
    process.stderr.write(`error: --density must be an integer between 1 and 5 (got: ${values.density})\n`);
    return 1;
  }

  const dryRun = values['dry-run'];
  if (dryRun) {
    return runDryRun({
      pdfPath,
      pagesSpec: values.pages,
      outputDir: values['output-dir'] ?? DEFAULT_OUTPUT_DIR,
    });
  }

  if (values['output-dir'] !== undefined) {
    process.stderr.write('error: --output-dir is only valid with --dry-run\n');
    return 1;
  }

  return runPrint({
    pdfPath,
    pagesSpec: values.pages,
    port: values.port,
    density: densityNum,
    yes: values.yes,
  });
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`error: ${err && err.message ? err.message : err}\n`);
    process.exitCode = 1;
  },
);
