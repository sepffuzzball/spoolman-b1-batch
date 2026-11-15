// src/usb-probe.mjs
//
// A NON-PRINTING direct serial diagnostic for the NIIMBOT B1 USB printer.
//
// Problem being diagnosed: the B1 answers the model query, but the reply can
// arrive "late" - after the CLI's 5s handshake timeout - so the CLI reports a
// timeout even though the printer responded. This probe does NOT claim to be a
// fix and NEVER sends a print command. It opens the serial port directly (no
// C1/C2 negotiation, no printStart/pageEnd/RFID/reset/motor traffic), sends
// exactly ONE read-only model query packet, and timestamps every event so the
// transport can be isolated.
//
// It supports two independent receive modes and never uses more than one:
//   - "data":      a single 'data' event listener.
//   - "readable":  a single 'readable' listener that drains port.read().
// Both feed exactly one shared byte accumulator / frame decoder.
//
// The frame decoder validates head (55 55), length, total length (7 + len),
// tail (AA AA) and the XOR(command ^ len ^ data) checksum before a frame is
// accepted. Invalid bytes / frames are logged and discarded; a corrupt frame is
// NEVER accepted as a valid model id.
//
// This is a diagnostic, not a fix: nothing in the normal CLI/printer/print
// pipeline is changed.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { SerialPort } from 'serialport';
import {
  PacketGenerator,
  PacketParser,
  PrinterInfoType,
  ResponseCommandId,
} from '@mmote/niimbluelib';

const DEFAULT_PORT = '/dev/ttyACM0';
const DEFAULT_READ_MODE = 'data';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3000;
const BAUD_RATE = 115200;
const MAX_ACCUM_BYTES = 4096;
// The probe asks specifically for the printer model id. Only
// In_PrinterInfoPrinterCode (0x48) carries that value; every other PrinterInfo
// response (e.g. In_PrinterInfoArea) is NOT the model even when it also carries
// two data bytes, so it must be logged and ignored.
const MODEL_COMMAND = ResponseCommandId.In_PrinterInfoPrinterCode;
// A valid PrinterInfo model-id response carries exactly 2 data bytes (a 16-bit
// big-endian model id, e.g. 0x1000 = 4096 for B1).
const MODEL_DATA_LEN = 2;
const HEAD1 = 0x55;
const HEAD2 = 0x55;
const TAIL1 = 0xaa;
const TAIL2 = 0xaa;

function toHex(buf) {
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    if (i > 0) out += ' ';
    out += buf[i].toString(16).padStart(2, '0');
  }
  return out;
}

function validateOptions({ port, readMode, timeoutMs, closeTimeoutMs }) {
  if (typeof port !== 'string' || port.trim() === '') {
    throw new Error('port must be a non-empty string');
  }
  if (readMode !== 'data' && readMode !== 'readable') {
    throw new Error(`readMode must be "data" or "readable" (got ${JSON.stringify(readMode)})`);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) {
    throw new Error(`timeoutMs must be an integer between 100 and 60000 (got ${timeoutMs})`);
  }
  if (!Number.isInteger(closeTimeoutMs) || closeTimeoutMs <= 0) {
    throw new Error(`closeTimeoutMs must be a positive integer (got ${closeTimeoutMs})`);
  }
}

/**
 * Streaming frame decoder.
 *
 * Maintains a bounded byte accumulator. Each chunk is copied into an owned
 * buffer first (so a pooled Buffer with a non-zero byteOffset is safe), then
 * complete frames are extracted and validated. Returns the validated frames
 * (owned copies). Invalid frames / noise are logged and discarded.
 */
function createFrameDecoder({ log }) {
  let buf = Buffer.alloc(0);

  function headPos() {
    for (let i = 0; i + 1 < buf.length; i++) {
      if (buf[i] === HEAD1 && buf[i + 1] === HEAD2) return i;
    }
    return -1;
  }

  function feed(chunk) {
    buf = Buffer.concat([buf, Buffer.from(chunk)]);
    const frames = [];
    while (true) {
      const idx = headPos();
      if (idx === -1) {
        // No frame head present: keep only a trailing 0x55 in case the next
        // chunk completes a head, otherwise flush the noise.
        if (buf.length > 0 && buf[buf.length - 1] === HEAD1) {
          buf = buf.subarray(buf.length - 1);
        } else {
          buf = Buffer.alloc(0);
        }
        break;
      }
      if (idx > 0) {
        log(`usb-probe: discarding ${idx} noise byte(s) before frame head`);
        buf = buf.subarray(idx);
      }
      // Need head(2)+cmd(1)+len(1) before we can compute the total length.
      if (buf.length < 4) break;
      const len = buf[3];
      const totalLen = 7 + len;
      if (buf.length < totalLen) break;
      const frame = buf.subarray(0, totalLen);
      if (frame[totalLen - 2] !== TAIL1 || frame[totalLen - 1] !== TAIL2) {
        log(`usb-probe: invalid frame tail (${toHex(frame.subarray(totalLen - 4))}); dropping leading byte`);
        buf = buf.subarray(1);
        continue;
      }
      let checksum = 0;
      for (let i = 2; i < 4 + len; i++) checksum ^= frame[i];
      if (checksum !== frame[4 + len]) {
        log(
          `usb-probe: invalid checksum (computed 0x${checksum.toString(16)}, got 0x${frame[4 + len].toString(16)}); dropping frame`,
        );
        buf = buf.subarray(totalLen);
        continue;
      }
      frames.push(Uint8Array.from(frame));
      buf = buf.subarray(totalLen);
    }
    if (buf.length > MAX_ACCUM_BYTES) {
      const drop = buf.length - MAX_ACCUM_BYTES;
      log(`usb-probe: receiver buffer exceeded ${MAX_ACCUM_BYTES}B; dropping ${drop} byte(s)`);
      if (buf[drop - 1] === HEAD1) buf = buf.subarray(drop - 1);
      else buf = buf.subarray(drop);
    }
    return frames;
  }

  return { feed };
}

/**
 * Run the non-printing USB model probe.
 *
 * @param {{
 *   port?: string,
 *   readMode?: 'data' | 'readable',
 *   timeoutMs?: number,
 *   closeTimeoutMs?: number,
 *   signal?: AbortSignal,
 *   createPort?: (opts: Record<string, unknown>) => any,
 *   log?: (msg: string) => void,
 *   now?: () => number,
 * }} [options]
 * @returns {Promise<{ modelId: number, readMode: string, elapsedMs: number }>}
 */
export async function runUsbProbe(options = {}) {
  const portPath = options.port ?? DEFAULT_PORT;
  const readMode = options.readMode ?? DEFAULT_READ_MODE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  const signal = options.signal;
  const createPort =
    options.createPort ?? ((opts) => new SerialPort(opts));
  const log = options.log ?? ((msg) => console.log(msg));
  const now = options.now ?? (() => performance.now());

  // Validate BEFORE opening the port.
  validateOptions({ port: portPath, readMode, timeoutMs, closeTimeoutMs });

  // An already-aborted signal must reject immediately, BEFORE we create the
  // port or arm any timer, so no 10s hang-timer is left behind.
  if (signal && signal.aborted) {
    throw signal.reason ?? new Error('aborted');
  }

  const startedAt = now();
  const el = () => Math.round(now() - startedAt);

  // Build the ONE readonly model query and never send anything else.
  const query = PacketGenerator.getPrinterInfo(PrinterInfoType.PrinterModelId);
  const queryBytes = query.toBytes();

  const nativeOpts = { path: portPath, baudRate: BAUD_RATE, autoOpen: false, endOnClose: true };
  const port = createPort(nativeOpts);

  // Late-open guard: once the operation settles we never open-delay-write a
  // second query, and if the native open completes after disposal we close the
  // port immediately.
  let disposed = false;
  // Marks a close we initiated ourselves, so an equality 'close' event emitted
  // by the device before the probe completes is treated as unexpected.
  let closing = false;
  let settled = false;
  // Set immediately before the query is written; a model reply that arrives
  // BEFORE this (e.g. leftover from a previous attempt) is logged and ignored.
  let queryIssued = false;
  let deadlineTimer = null;
  let removeAbortListener = null;
  let receiveListenerRemover = null;
  let inFlightClose = null;

  const decoder = createFrameDecoder({ log });

  let resolveModel;
  let rejectModel;
  const modelPromise = new Promise((resolve, reject) => {
    resolveModel = resolve;
    rejectModel = reject;
  });
  // Do not let an early rejection surface as an unhandled rejection.
  modelPromise.catch(() => {});

  let outcomeResolve;
  let outcomeReject;
  const outcomePromise = new Promise((resolve, reject) => {
    outcomeResolve = resolve;
    outcomeReject = reject;
  });
  outcomePromise.catch(() => {});

  function clearTimers() {
    if (deadlineTimer !== null) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
  }

  function removeReceiveListener() {
    if (receiveListenerRemover) {
      const remove = receiveListenerRemover;
      receiveListenerRemover = null;
      remove();
    }
  }

  function cleanup() {
    clearTimers();
    if (removeAbortListener) {
      const remove = removeAbortListener;
      removeAbortListener = null;
      remove();
    }
  }

  function finish(result) {
    if (settled) return;
    settled = true;
    disposed = true;
    cleanup();
    outcomeResolve(result);
  }

  function fail(err) {
    if (settled) return;
    settled = true;
    disposed = true;
    cleanup();
    rejectModel(err);
    outcomeReject(err);
  }

  function onPortError(err) {
    log(`usb-probe: port error at ${el()}ms: ${err.message}`);
    if (!settled) fail(err);
  }

  function onPortClose(err) {
    log(`usb-probe: port close at ${el()}ms${err ? ` (${err.message})` : ''}`);
    if (closing) return; // our own cleanup close.
    if (settled) return; // already finished / failed; log only.
    fail(new Error('unexpected close before model query completed'));
  }

  // Register error/close handling BEFORE open so a native late callback never
  // surfaces as an unhandled error, and never use both receive modes at once.
  port.on('error', onPortError);
  port.on('close', onPortClose);

  function onChunk(chunk) {
    log(`usb-probe: RX ${chunk.length}B at ${el()}ms: ${toHex(chunk)}`);
    const frames = decoder.feed(chunk);
    for (const frame of frames) handleFrame(frame);
  }

  function handleFrame(frame) {
    let packets;
    try {
      packets = PacketParser.parsePacketBundle(frame);
    } catch (err) {
      log(`usb-probe: frame parse failed: ${err.message}`);
      return;
    }
    for (const packet of packets) {
      // Only In_PrinterInfoPrinterCode (0x48) is the model id. Any other
      // response - even another PrinterInfo value that carries two data bytes
      // (e.g. In_PrinterInfoArea) - is NOT the model and is logged/ignored,
      // despite having passed the frame CRC validation.
      if (packet.command !== MODEL_COMMAND) {
        log(
          `usb-probe: non-model frame cmd=0x${packet.command.toString(16)} data=${toHex(packet.data)} at ${el()}ms (ignored)`,
        );
        continue;
      }
      if (packet.data.length !== MODEL_DATA_LEN) {
        log(
          `usb-probe: printer-info response cmd=0x${packet.command.toString(16)} has ${packet.data.length} data byte(s), expected ${MODEL_DATA_LEN} at ${el()}ms`,
        );
        continue;
      }
      const modelId = PacketParser.parsePrinterInfoModelIdResponse(packet);
      const modelAt = el();
      if (!queryIssued) {
        log(
          `usb-probe: model reply before query sent cmd=0x${packet.command.toString(16)} modelId=${modelId} (0x${modelId.toString(16)}) at ${modelAt}ms; ignoring`,
        );
        continue;
      }
      log(
        `usb-probe: model response cmd=0x${packet.command.toString(16)} dataLen=${packet.data.length} modelId=${modelId} (0x${modelId.toString(16)}) at ${modelAt}ms`,
      );
      if (!settled) {
        resolveModel({ modelId, elapsedMs: modelAt });
      } else {
        log('usb-probe: model response arrived after result; ignoring (result unchanged)');
      }
    }
  }

  if (readMode === 'data') {
    const onData = (chunk) => onChunk(chunk);
    port.on('data', onData);
    receiveListenerRemover = () => port.off('data', onData);
  } else {
    const onReadable = () => {
      // port.read() can throw outside any async flow; never let that crash the
      // process - log and fail/clean up instead.
      try {
        let chunk;
        while ((chunk = port.read()) !== null) {
          onChunk(chunk);
        }
      } catch (err) {
        log(`usb-probe: port.read() error at ${el()}ms: ${err.message}`);
        if (!settled) fail(err);
      }
    };
    port.on('readable', onReadable);
    receiveListenerRemover = () => port.off('readable', onReadable);
  }

  function onAbort() {
    const reason = (signal && (signal.reason !== undefined ? signal.reason : null)) || new Error('aborted');
    log(`usb-probe: aborted at ${el()}ms`);
    if (!settled) fail(reason);
  }
  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  }

  deadlineTimer = setTimeout(() => {
    log(`usb-probe: TIMEOUT after ${timeoutMs}ms at ${el()}ms`);
    if (!settled) fail(new Error(`usb-probe: overall deadline exceeded after ${timeoutMs}ms`));
  }, timeoutMs);

  // Bounded close. Each actual close owns its own in-flight promise and local
  // timer (the old shared closeTimer could be cleared by a concurrent late-open
  // close). If the port is not currently open we do not call close() at all (a
  // still-pending open is closed by the late-open latch on its callback and
  // never writes), and we do NOT memoize that not-open no-op as a final close.
  function closePortBounded() {
    if (inFlightClose) return inFlightClose;
    if (!port.isOpen) {
      log(`usb-probe: close skipped (port not open) at ${el()}ms`);
      return Promise.resolve();
    }
    closing = true;
    inFlightClose = new Promise((resolve, reject) => {
      let done = false;
      const localTimer = setTimeout(() => {
        if (done) return;
        done = true;
        inFlightClose = null;
        log(`usb-probe: close timed out after ${closeTimeoutMs}ms at ${el()}ms`);
        reject(new Error(`usb-probe: close timed out after ${closeTimeoutMs}ms`));
      }, closeTimeoutMs);

      const finishOk = () => {
        if (done) return;
        if (port.isOpen) {
          // The close callback reported success, yet the port still reports
          // itself open: treat it as a cleanup failure (same policy as any other
          // close error - preserved by the caller when a primary error exists).
          const err = new Error('usb-probe: port remains open after close callback');
          done = true;
          clearTimeout(localTimer);
          inFlightClose = null;
          log(`usb-probe: close error at ${el()}ms: ${err.message}`);
          reject(err);
          return;
        }
        done = true;
        clearTimeout(localTimer);
        inFlightClose = null;
        log(`usb-probe: port close callback at ${el()}ms`);
        resolve();
      };
      const finishErr = (err) => {
        if (done) return;
        done = true;
        clearTimeout(localTimer);
        inFlightClose = null;
        log(`usb-probe: close error at ${el()}ms: ${err.message}`);
        reject(err);
      };

      try {
        port.close((err) => {
          if (err) finishErr(err);
          else finishOk();
        });
      } catch (err) {
        finishErr(err);
      }
    });
    return inFlightClose;
  }

  function openPort() {
    return new Promise((resolve) => {
      if (disposed) {
        log(`usb-probe: skip open (disposed) at ${el()}ms`);
        resolve();
        return;
      }
      log(`usb-probe: open-request ${portPath} at ${el()}ms`);
      port.open((err) => {
        if (err) {
          log(`usb-probe: open error at ${el()}ms: ${err.message}`);
          if (!settled) fail(err);
          resolve();
          return;
        }
        log(`usb-probe: open at ${el()}ms`);
        if (disposed) {
          // Late open: never write, close immediately.
          log(`usb-probe: opened after disposal; closing without writing at ${el()}ms`);
          closePortBounded().then(() => resolve(), () => resolve());
          return;
        }
        resolve();
      });
    });
  }

  function sendQuery() {
    return new Promise((resolve, reject) => {
      if (disposed) {
        log(`usb-probe: skip write (disposed) at ${el()}ms`);
        resolve();
        return;
      }
      log(`usb-probe: TX ${toHex(queryBytes)} at ${el()}ms`);
      // Arm the "query sent" latch BEFORE the write so a model reply that was
      // buffered before the query was issued is logged but ignored.
      queryIssued = true;
      port.write(queryBytes, (err) => {
        if (err) {
          log(`usb-probe: write error at ${el()}ms: ${err.message}`);
          if (!settled) fail(err);
          resolve();
          return;
        }
        if (disposed) {
          // The deadline/abort ended the probe while the write was settling:
          // do not issue any further I/O (drain) after disposal.
          log(`usb-probe: late write callback at ${el()}ms (disposed); skipping drain`);
          resolve();
          return;
        }
        log(`usb-probe: write callback ok at ${el()}ms`);
        port.drain((drainErr) => {
          if (drainErr) {
            log(`usb-probe: drain error at ${el()}ms: ${drainErr.message}`);
            if (!settled) fail(drainErr);
            resolve();
            return;
          }
          log(`usb-probe: drain complete at ${el()}ms`);
          resolve();
        });
      });
    });
  }

  // The runner drives open -> write/drain -> model wait. Any step error calls
  // fail(), which settles the outcome and rejects the model waiter. Because
  // fail() latches `settled`, the FIRST primary error is always preserved and
  // never replaced by a later one.
  (async () => {
    try {
      await openPort();
      await sendQuery();
      const model = await modelPromise;
      if (!settled) finish({ modelId: model.modelId, elapsedMs: model.elapsedMs });
    } catch (err) {
      if (!settled) fail(err);
    }
  })();

  let primaryError = null;
  let result = null;
  try {
    result = await outcomePromise;
  } catch (err) {
    primaryError = err;
  }

  let closeError = null;
  try {
    // Keep the receive listener attached through the bounded close so a late
    // model reply arriving during the close window is still logged (it does not
    // change a failed result).
    await closePortBounded();
  } catch (err) {
    closeError = err;
    log(`usb-probe: cleanup close failed at ${el()}ms: ${err.message}`);
  } finally {
    removeReceiveListener();
  }

  if (closeError && !primaryError) {
    // A valid model result but the cleanup close failed: that is a real failure.
    throw closeError;
  }
  // If a primary error exists, preserve it (a cleanup close failure is only
  // logged above).
  if (primaryError) throw primaryError;

  // SIGINT can arrive AFTER a valid model but during the bounded close. The
  // probe technically succeeded, yet the caller was interrupted, so honor the
  // abort and surface it (any earlier primary/cleanup error already threw above).
  if (signal && signal.aborted) {
    throw signal.reason ?? new Error('aborted');
  }

  return {
    modelId: result.modelId,
    readMode,
    elapsedMs: result.elapsedMs ?? Math.round(now() - startedAt),
  };
}

const USAGE = `usb-probe - NIIMBOT B1 USB diagnostic (non-printing)

Opens the serial port directly and sends exactly ONE read-only model query
(55 55 40 01 08 49 aa aa). Never sends a print command, never negotiates, never
touches C1/C2/RFID/reset/motor/label traffic. It timestamps every event so the
cause of a "valid but late" B1 reply can be isolated.

Usage:
  npm run usb:probe -- [options]

Options:
  --port <path>       Serial device path. Default: /dev/ttyACM0
  --read-mode <mode>  Receive path: "data" (default) or "readable".
  --timeout-ms <ms>   Overall deadline (open+write+drain+model wait), 100..60000. Default: 10000.
  --help              Show this help and exit.

Exit codes:
  0   valid model received
  1   error (timeout, open/write/drain/close failure, unexpected close, bad flags)
  130 interrupted (SIGINT)
`;

function parseUsbProbeArgs(args) {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string', default: DEFAULT_PORT },
      'read-mode': { type: 'string', default: DEFAULT_READ_MODE },
      'timeout-ms': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  return values;
}

async function main() {
  let values;
  try {
    values = parseUsbProbeArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.stderr.write('(run `npm run usb:probe -- --help` for usage)\n');
    return 1;
  }

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const readMode = values['read-mode'];
  if (readMode !== 'data' && readMode !== 'readable') {
    process.stderr.write(`error: --read-mode must be "data" or "readable" (got ${JSON.stringify(readMode)})\n`);
    return 1;
  }

  const timeoutMs = values['timeout-ms'] === undefined ? DEFAULT_TIMEOUT_MS : Number(values['timeout-ms']);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) {
    process.stderr.write(`error: --timeout-ms must be an integer between 100 and 60000 (got ${values['timeout-ms']})\n`);
    return 1;
  }

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on('SIGINT', onSigint);

  try {
    const result = await runUsbProbe({
      port: values.port,
      readMode,
      timeoutMs,
      signal: controller.signal,
    });
    // SIGINT may arrive after the probe obtained a valid model (e.g. during the
    // bounded close). Honor the interrupt and exit 130 even though the probe
    // itself reported success.
    if (controller.signal.aborted) return 130;
    process.stdout.write(
      `usb-probe: model ${result.modelId} (0x${result.modelId.toString(16)}) in ${result.elapsedMs}ms (readMode=${result.readMode})\n`,
    );
    return 0;
  } catch (err) {
    if (controller.signal.aborted) return 130;
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    return 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

const isDirect =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`error: ${err && err.message ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
