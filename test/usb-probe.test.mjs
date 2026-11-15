// test/usb-probe.test.mjs
//
// Unit tests for the non-printing B1 USB diagnostic (src/usb-probe.mjs).
//
// No real hardware is used. A fake serial port (EventEmitter) fakes the
// SerialPort surface the probe talks to (open/write/drain/close/read plus the
// open/close/error/data/readable events) and records every call. The probe is
// driven through its injected createPort option.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { runUsbProbe } from '../src/usb-probe.mjs';

const QUERY_BYTES = Uint8Array.from([0x55, 0x55, 0x40, 0x01, 0x08, 0x49, 0xaa, 0xaa]);
// Exact model response the user observed for B1: cmd=0x48 (PrinterInfoPrinterCode),
// data=[0x10,0x00] => model id 0x1000 = 4096.
const MODEL_FRAME = Uint8Array.from([0x55, 0x55, 0x48, 0x02, 0x10, 0x00, 0x5a, 0xaa, 0xaa]);
// A different but valid model response (model id 0x0800 = 2048), used to prove a
// reply that arrives before the query is sent is ignored.
const OTHER_MODEL_FRAME = Uint8Array.from([0x55, 0x55, 0x48, 0x02, 0x08, 0x00, 0x42, 0xaa, 0xaa]);
// Same frame but with a corrupted checksum byte (0x00 instead of 0x5a).
const BAD_CHECKSUM_FRAME = Uint8Array.from([0x55, 0x55, 0x48, 0x02, 0x10, 0x00, 0x00, 0xaa, 0xaa]);
// A valid, well-formed frame whose command is unrelated to the model query
// (In_GetPaperInfo = 0x69, zero data bytes).
const UNRELATED_FRAME = Uint8Array.from([0x55, 0x55, 0x69, 0x00, 0x69, 0xaa, 0xaa]);
// A PrinterInfo response with only one data byte; must NOT be accepted as the
// model id (valid model responses must carry two data bytes).
const ONE_BYTE_INFO_FRAME = Uint8Array.from([0x55, 0x55, 0x48, 0x01, 0x10, 0x59, 0xaa, 0xaa]);
// A valid, well-formed In_PrinterInfoArea response (cmd=0x4f) that carries TWO
// data bytes - exactly like a model response - but is NOT the model id. It must
// be logged and ignored, never accepted as the model.
//   cmd=0x4f ^ len=0x02 ^ data[0]=0x00 ^ data[1]=0x00 => checksum 0x4d.
const AREA_FRAME = Uint8Array.from([0x55, 0x55, 0x4f, 0x02, 0x00, 0x00, 0x4d, 0xaa, 0xaa]);

const NO_LOG = () => {};

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) {
    out.set(a, pos);
    pos += a.length;
  }
  return out;
}

class FakeSerialPort extends EventEmitter {
  constructor() {
    super();
    this.openCalls = 0;
    this.writeCalls = [];
    this.drainCalls = 0;
    this.closeCalls = 0;
    this.readCalls = 0;
    this.isOpen = false;
    this.openErr = null;
    this.writeErr = null;
    this.drainErr = null;
    this.closeErr = null;
    this.readErr = null;
    this.deferOpen = false;
    this.deferWrite = false;
    this.deferClose = false;
    this.neverClose = false;
    this.neverDrain = false;
    this.closeLeavesOpen = false;
    this.onOpen = null;
    this.onWrite = null;
    this.readQueue = [];
    this.addedEvents = [];
    this._openCb = null;
    this._writeCb = null;
    this._closeCb = null;
  }

  on(event, fn) {
    super.on(event, fn);
    this.addedEvents.push(event);
    return this;
  }

  open(cb) {
    this.openCalls++;
    this._openCb = cb;
    if (this.openErr) {
      cb(this.openErr);
      return;
    }
    if (this.deferOpen) return;
    this.completeOpen();
  }

  completeOpen() {
    this.isOpen = true;
    if (this.onOpen) this.onOpen();
    this.emit('open');
    const cb = this._openCb;
    this._openCb = null;
    if (cb) cb(null);
  }

  write(data, cb) {
    this.writeCalls.push(Buffer.from(data));
    if (this.onWrite) this.onWrite();
    if (this.deferWrite) {
      this._writeCb = cb;
      return;
    }
    process.nextTick(() => {
      if (this.writeErr) cb(this.writeErr);
      else cb(null);
    });
  }

  completeWrite() {
    const cb = this._writeCb;
    this._writeCb = null;
    if (!cb) return;
    if (this.writeErr) cb(this.writeErr);
    else cb(null);
  }

  drain(cb) {
    this.drainCalls++;
    if (this.neverDrain) return; // the drain callback never fires
    process.nextTick(() => {
      if (this.drainErr) cb(this.drainErr);
      else cb(null);
    });
  }

  close(cb) {
    this.closeCalls++;
    if (!this.isOpen) {
      process.nextTick(() => cb(new Error('Port is not open')));
      return;
    }
    if (this.neverClose) {
      this._closeCb = cb;
      return;
    }
    if (this.deferClose) {
      if (!this.closeLeavesOpen) this.isOpen = false;
      this._closeCb = cb;
      return;
    }
    if (!this.closeLeavesOpen) this.isOpen = false;
    if (this.closeErr) {
      process.nextTick(() => cb(this.closeErr));
      return;
    }
    process.nextTick(() => {
      this.emit('close');
      cb(null);
    });
  }

  completeClose() {
    this.emit('close');
    const cb = this._closeCb;
    this._closeCb = null;
    if (cb) cb(this.closeErr ?? null);
  }

  read() {
    this.readCalls++;
    if (this.readErr) throw this.readErr;
    return this.readQueue.shift() ?? null;
  }

  pushData(chunk) {
    this.emit('data', chunk);
  }

  pushReadable(chunk) {
    this.readQueue.push(chunk);
    this.emit('readable');
  }

  emitUnexpectedClose() {
    this.isOpen = false;
    this.emit('close');
  }
}

function baseOptions(overrides = {}) {
  return {
    port: '/dev/ttyACM0',
    timeoutMs: 10000,
    closeTimeoutMs: 3000,
    log: NO_LOG,
    ...overrides,
  };
}

describe('runUsbProbe (data mode)', () => {
  test('sends exactly one readonly query and returns 4096 for the observed user frame', async () => {
    const fake = new FakeSerialPort();
    const p = runUsbProbe(baseOptions({ createPort: () => fake, readMode: 'data' }));
    await new Promise((r) => setImmediate(r));
    fake.pushData(MODEL_FRAME);
    const result = await p;

    assert.equal(result.modelId, 4096, 'must return the numeric model id (0x1000)');
    assert.equal(result.readMode, 'data');
    assert.ok(Number.isInteger(result.elapsedMs) && result.elapsedMs >= 0);

    assert.equal(fake.writeCalls.length, 1, 'exactly ONE readonly query must be sent');
    assert.deepEqual(fake.writeCalls[0], Buffer.from(QUERY_BYTES), 'the query must be 55 55 40 01 08 49 aa aa');
    assert.equal(fake.drainCalls, 1);
    assert.ok(fake.closeCalls >= 1, 'the port must be closed after the probe');

    // data mode must not attach a readable listener nor call port.read().
    assert.ok(fake.addedEvents.includes('data'), 'data mode registers a data listener');
    assert.ok(!fake.addedEvents.includes('readable'), 'data mode must not register a readable listener');
    assert.equal(fake.readCalls, 0, 'data mode must never call port.read()');
  });

  test('fragmented model frame is reassembled across chunks', async () => {
    const fake = new FakeSerialPort();
    const p = runUsbProbe(baseOptions({ createPort: () => fake, readMode: 'data' }));
    // Fragment the 9-byte frame across several chunks, including a partial head.
    await new Promise((r) => setImmediate(r));
    fake.pushData(MODEL_FRAME.subarray(0, 2));
    fake.pushData(MODEL_FRAME.subarray(2, 4));
    fake.pushData(MODEL_FRAME.subarray(4, 7));
    fake.pushData(MODEL_FRAME.subarray(7));
    const result = await p;
    assert.equal(result.modelId, 4096);
    assert.equal(fake.writeCalls.length, 1);
  });

  test('a pooled Buffer with a non-zero offset is handled', async () => {
    const fake = new FakeSerialPort();
    const p = runUsbProbe(baseOptions({ createPort: () => fake, readMode: 'data' }));
    await new Promise((r) => setImmediate(r));
    // Simulate a pooled allocation: the frame lives at a non-zero offset inside
    // a larger shared buffer and is handed to the probe as a view.
    const pool = new Uint8Array(64);
    pool.set(MODEL_FRAME, 12);
    fake.pushData(pool.subarray(12, 12 + MODEL_FRAME.length));
    const result = await p;
    assert.equal(result.modelId, 4096, 'a pooled/offset Buffer must be copied and decoded');
  });

  test('a synchronous response during the write is captured (pre-armed waiter)', async () => {
    const fake = new FakeSerialPort();
    fake.onWrite = () => fake.pushData(MODEL_FRAME);
    const result = await runUsbProbe(baseOptions({ createPort: () => fake, readMode: 'data' }));
    assert.equal(result.modelId, 4096, 'the response emitted inside write must not be dropped');
    assert.equal(fake.writeCalls.length, 1);
  });

  test('a model reply that arrives BEFORE the query is sent is ignored', async () => {
    const fake = new FakeSerialPort();
    const logs = [];
    fake.onOpen = () => fake.pushData(OTHER_MODEL_FRAME); // valid but different (0x0800)
    fake.onWrite = () => fake.pushData(MODEL_FRAME); // the real B1 reply (0x1000)
    const result = await runUsbProbe(
      baseOptions({ createPort: () => fake, readMode: 'data', log: (m) => logs.push(m) }),
    );
    assert.equal(result.modelId, 4096, 'the pre-query reply must be ignored, not accepted');
    assert.ok(
      logs.some((l) => l.includes('model reply before query sent') && l.includes('modelId=2048')),
      'the pre-query model reply must be logged as ignored',
    );
  });

  test('coalesced unrelated frame plus valid model frame in one chunk', async () => {
    const fake = new FakeSerialPort();
    const p = runUsbProbe(baseOptions({ createPort: () => fake, readMode: 'data' }));
    await new Promise((r) => setImmediate(r));
    fake.pushData(concat(UNRELATED_FRAME, MODEL_FRAME));
    const result = await p;
    assert.equal(result.modelId, 4096, 'the unrelated frame must be ignored and the model still accepted');
    assert.equal(fake.writeCalls.length, 1);
  });

  test('a 2-byte non-model PrinterInfo frame (Area) is ignored before the real model in the same chunk', async () => {
    const fake = new FakeSerialPort();
    const logs = [];
    const p = runUsbProbe(
      baseOptions({ createPort: () => fake, readMode: 'data', log: (m) => logs.push(m) }),
    );
    await new Promise((r) => setImmediate(r));
    fake.pushData(concat(AREA_FRAME, MODEL_FRAME));
    const result = await p;
    assert.equal(result.modelId, 4096, 'the 2-byte Area frame must be ignored and the real model (0x1000) accepted');
    assert.ok(
      logs.some((l) => l.includes('non-model frame') && l.includes('cmd=0x4f')),
      'the 2-byte non-model frame must be logged as ignored',
    );
  });

  test('a valid 2-byte non-model-only PrinterInfo stream times out (does not return a wrong model)', async () => {
    const fake = new FakeSerialPort();
    const p = runUsbProbe(
      baseOptions({ createPort: () => fake, readMode: 'data', timeoutMs: 200 }),
    );
    await new Promise((r) => setImmediate(r));
    fake.pushData(AREA_FRAME);
    await assert.rejects(p, /overall deadline exceeded after 200ms/);
    assert.ok(fake.closeCalls >= 1, 'a non-model-only timeout must still close the port');
  });

  test('malformed checksum frame immediately followed by a valid model (no hang)', async () => {
    const fake = new FakeSerialPort();
    const p = runUsbProbe(baseOptions({ createPort: () => fake, readMode: 'data' }));
    await new Promise((r) => setImmediate(r));
    fake.pushData(concat(BAD_CHECKSUM_FRAME, MODEL_FRAME));
    const result = await p;
    assert.equal(result.modelId, 4096, 'the bad-checksum frame must be discarded and the next valid frame accepted');
  });

  test('buffer is bounded and the model is found after more than 4KB of noise', async () => {
    const fake = new FakeSerialPort();
    const p = runUsbProbe(baseOptions({ createPort: () => fake, readMode: 'data' }));
    await new Promise((r) => setImmediate(r));
    const noise = new Uint8Array(5000);
    const chunk = new Uint8Array(5000 + MODEL_FRAME.length);
    chunk.set(noise, 0);
    chunk.set(MODEL_FRAME, 5000);
    fake.pushData(chunk);
    const result = await p;
    assert.equal(result.modelId, 4096, 'noise must be discarded and the trailing model frame accepted');
  });

  test('an invalid-checksum-only stream is never accepted as the model (times out)', async () => {
    const fake = new FakeSerialPort();
    const p = runUsbProbe(
      baseOptions({ createPort: () => fake, readMode: 'data', timeoutMs: 200 }),
    );
    await new Promise((r) => setImmediate(r));
    fake.pushData(BAD_CHECKSUM_FRAME);
    await assert.rejects(p, /overall deadline exceeded after 200ms/);
    assert.ok(fake.closeCalls >= 1, 'a timeout must still close the port');
  });

  test('a one-data-byte printer-info response is not accepted as the model', async () => {
    const fake = new FakeSerialPort();
    const p = runUsbProbe(
      baseOptions({ createPort: () => fake, readMode: 'data', timeoutMs: 200 }),
    );
    await new Promise((r) => setImmediate(r));
    fake.pushData(ONE_BYTE_INFO_FRAME);
    await assert.rejects(p, /overall deadline exceeded after 200ms/);
  });

  test('an unrelated-only frame does not satisfy the model query', async () => {
    const fake = new FakeSerialPort();
    const p = runUsbProbe(
      baseOptions({ createPort: () => fake, readMode: 'data', timeoutMs: 200 }),
    );
    await new Promise((r) => setImmediate(r));
    fake.pushData(UNRELATED_FRAME);
    await assert.rejects(p, /overall deadline exceeded after 200ms/);
  });

  test('no response times out (bounded) and closes the port', async () => {
    const fake = new FakeSerialPort();
    await assert.rejects(
      runUsbProbe(baseOptions({ createPort: () => fake, readMode: 'data', timeoutMs: 200 })),
      /overall deadline exceeded after 200ms/,
    );
    assert.equal(fake.writeCalls.length, 1, 'the query must still be sent even on timeout');
    assert.ok(fake.closeCalls >= 1, 'the port must be closed on timeout');
  });

  test('a model received but drain never returns fails with the OVERALL deadline (not "no model")', async () => {
    const fake = new FakeSerialPort();
    fake.neverDrain = true;
    const logs = [];
    const p = runUsbProbe(
      baseOptions({
        createPort: () => fake,
        readMode: 'data',
        timeoutMs: 200,
        log: (m) => logs.push(m),
      }),
    );
    // The model arrives while the write callback is pending; drain never calls
    // back, so the runner can never reach the model waiter.
    fake.onWrite = () => fake.pushData(MODEL_FRAME);
    const assertion = assert.rejects(
      p,
      (err) => err && err.message.includes('overall deadline exceeded after 200ms'),
    );
    await assertion;
    assert.ok(
      logs.some((l) => l.includes('model response') && l.includes('modelId=4096')),
      'the RX model must still be logged even though the run timed out on the overall deadline',
    );
    assert.ok(fake.closeCalls >= 1, 'an overall-deadline failure must still clean up/close the port');
  });

  test('a late model response during the close window is logged but does not change the failed result', async () => {
    const fake = new FakeSerialPort();
    fake.deferClose = true;
    const logs = [];
    const p = runUsbProbe(
      baseOptions({
        createPort: () => fake,
        readMode: 'data',
        timeoutMs: 200,
        closeTimeoutMs: 5000,
        log: (m) => logs.push(m),
      }),
    );
    await new Promise((r) => setImmediate(r));
    // Let the deadline fire; the probe enters the bounded close (deferred).
    await new Promise((r) => setTimeout(r, 300));
    // The device answers while we are closing.
    fake.pushData(MODEL_FRAME);
    await new Promise((r) => setImmediate(r));
    fake.completeClose();
    await assert.rejects(p, /overall deadline exceeded after 200ms/);
    assert.ok(
      logs.some((l) => l.includes('model response') && l.includes('modelId=4096')),
      'the late model response must still be logged',
    );
    assert.ok(
      logs.some((l) => l.includes('arrived after result')),
      'the late response must be reported as after the result',
    );
  });

  test('a cleanup close error on an otherwise valid model is a real failure', async () => {
    const fake = new FakeSerialPort();
    fake.closeErr = new Error('EIO: close failed');
    const p = runUsbProbe(baseOptions({ createPort: () => fake, readMode: 'data' }));
    await new Promise((r) => setImmediate(r));
    fake.pushData(MODEL_FRAME);
    await assert.rejects(p, /EIO: close failed/);
    assert.ok(fake.closeCalls >= 1);
  });

  test('a close callback that never fires is bounded by the close timeout', async () => {
    const fake = new FakeSerialPort();
    fake.neverClose = true;
    const p = runUsbProbe(
      baseOptions({ createPort: () => fake, readMode: 'data', closeTimeoutMs: 200 }),
    );
    await new Promise((r) => setImmediate(r));
    fake.pushData(MODEL_FRAME);
    await assert.rejects(p, /close timed out after 200ms/);
  });

  test('a primary timeout error is preserved even when cleanup close also fails', async () => {
    const fake = new FakeSerialPort();
    fake.neverClose = true;
    const logs = [];
    const p = runUsbProbe(
      baseOptions({
        createPort: () => fake,
        readMode: 'data',
        timeoutMs: 200,
        closeTimeoutMs: 200,
        log: (m) => logs.push(m),
      }),
    );
    await assert.rejects(p, /overall deadline exceeded after 200ms/);
    assert.ok(
      logs.some((l) => l.includes('cleanup close failed') && l.includes('close timed out after 200ms')),
      'the cleanup close failure must be logged while the primary timeout is preserved',
    );
  });

  test('open error rejects with the original error', async () => {
    const fake = new FakeSerialPort();
    fake.openErr = new Error('EACCES: cannot open /dev/ttyACM0');
    await assert.rejects(
      runUsbProbe(baseOptions({ createPort: () => fake, readMode: 'data' })),
      /EACCES: cannot open/,
    );
    assert.equal(fake.writeCalls.length, 0, 'no query may be sent if the port never opened');
  });

  test('write error rejects with the original error', async () => {
    const fake = new FakeSerialPort();
    fake.writeErr = new Error('EIO: write failed');
    await assert.rejects(
      runUsbProbe(baseOptions({ createPort: () => fake, readMode: 'data', timeoutMs: 5000 })),
      /EIO: write failed/,
    );
  });

  test('drain error rejects with the original error', async () => {
    const fake = new FakeSerialPort();
    fake.drainErr = new Error('EIO: drain failed');
    await assert.rejects(
      runUsbProbe(baseOptions({ createPort: () => fake, readMode: 'data', timeoutMs: 5000 })),
      /EIO: drain failed/,
    );
  });

  test('a late write callback after timeout does not issue drain (no I/O after disposal)', async () => {
    const fake = new FakeSerialPort();
    fake.deferWrite = true;
    const logs = [];
    const p = runUsbProbe(
      baseOptions({
        createPort: () => fake,
        readMode: 'data',
        timeoutMs: 200,
        log: (m) => logs.push(m),
      }),
    );
    // Attach the rejection handler immediately so the timeout rejection at 200ms
    // is never reported as an unhandled rejection.
    const assertion = assert.rejects(p, /overall deadline exceeded after 200ms/);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 300)); // deadline fires while write is pending
    fake.completeWrite();
    await assertion;
    assert.equal(fake.drainCalls, 0, 'drain must be skipped after disposal');
    assert.ok(
      logs.some((l) => l.includes('late write callback') && l.includes('skipping drain')),
      'the late write callback must be logged',
    );
  });

  test('unexpected close before the model query completes fails promptly', async () => {
    const fake = new FakeSerialPort();
    const p = runUsbProbe(baseOptions({ createPort: () => fake, readMode: 'data', timeoutMs: 5000 }));
    await new Promise((r) => setImmediate(r));
    assert.equal(fake.writeCalls.length, 1, 'the query must have been sent before the device closed');
    fake.emitUnexpectedClose();
    await assert.rejects(p, /unexpected close before model query completed/);
  });

  test('abort during the wait rejects and closes the port', async () => {
    const fake = new FakeSerialPort();
    const controller = new AbortController();
    const p = runUsbProbe(
      baseOptions({ createPort: () => fake, readMode: 'data', timeoutMs: 5000, signal: controller.signal }),
    );
    await new Promise((r) => setImmediate(r));
    controller.abort();
    await assert.rejects(p, (err) => controller.signal.aborted && err && err.name === 'AbortError');
    assert.ok(fake.closeCalls >= 1);
  });

  test('abort before open rejects without opening the port or writing', async () => {
    const fake = new FakeSerialPort();
    const controller = new AbortController();
    controller.abort();
    let createCalls = 0;
    await assert.rejects(
      runUsbProbe(baseOptions({ createPort: () => { createCalls++; return fake; }, readMode: 'data', signal: controller.signal })),
      (err) => controller.signal.aborted && err && err.name === 'AbortError',
    );
    assert.equal(createCalls, 0, 'an already-aborted probe must not even construct the port');
    assert.equal(fake.openCalls, 0, 'an already-aborted probe must not attempt an open');
    assert.equal(fake.writeCalls.length, 0, 'no query may be sent on abort');
  });
});

describe('runUsbProbe (readable mode)', () => {
  test('drains port.read() and never registers a data listener', async () => {
    const fake = new FakeSerialPort();
    const p = runUsbProbe(baseOptions({ createPort: () => fake, readMode: 'readable' }));
    await new Promise((r) => setImmediate(r));
    assert.ok(fake.addedEvents.includes('readable'), 'readable mode registers a readable listener');
    assert.ok(!fake.addedEvents.includes('data'), 'readable mode must not register a data listener');
    fake.pushReadable(MODEL_FRAME);
    const result = await p;
    assert.equal(result.modelId, 4096);
    assert.ok(fake.readCalls > 0, 'readable mode must call port.read()');
    assert.equal(fake.writeCalls.length, 1);
  });

  test('a pooled offset Buffer is handled in readable mode too', async () => {
    const fake = new FakeSerialPort();
    const p = runUsbProbe(baseOptions({ createPort: () => fake, readMode: 'readable' }));
    await new Promise((r) => setImmediate(r));
    const pool = Buffer.alloc(64);
    Buffer.from(MODEL_FRAME).copy(pool, 9);
    fake.pushReadable(pool.subarray(9, 9 + MODEL_FRAME.length));
    const result = await p;
    assert.equal(result.modelId, 4096);
  });

  test('a port.read() throw is caught and fails the probe (no process crash)', async () => {
    const fake = new FakeSerialPort();
    fake.readErr = new Error('read boom');
    const logs = [];
    const p = runUsbProbe(
      baseOptions({ createPort: () => fake, readMode: 'readable', timeoutMs: 5000, log: (m) => logs.push(m) }),
    );
    await new Promise((r) => setImmediate(r));
    fake.pushReadable(MODEL_FRAME); // triggers 'readable'; read() throws
    await assert.rejects(p, /read boom/);
    assert.ok(logs.some((l) => l.includes('port.read() error')), 'the read() throw must be logged');
  });
});

describe('late open guard and cleanup', () => {
  test('no query is written after a late open (timeout during open)', async () => {
    const fake = new FakeSerialPort();
    fake.deferOpen = true;
    const p = runUsbProbe(
      baseOptions({ createPort: () => fake, readMode: 'data', timeoutMs: 200 }),
    );
    await assert.rejects(p, /overall deadline exceeded after 200ms/);
    assert.equal(fake.openCalls, 1, 'the open must have been initiated');
    assert.equal(fake.writeCalls.length, 0, 'no query may be written after disposal');

    fake.completeOpen();
    await new Promise((r) => setImmediate(r));
    assert.equal(fake.writeCalls.length, 0, 'a late-open must never write the query');
    // Exactly one close for the late-opened port: no double close, no timer leak.
    assert.equal(fake.closeCalls, 1, 'the late-opened port must be closed exactly once');
  });

  test('intentional cleanup close does not replace a valid result', async () => {
    const fake = new FakeSerialPort();
    const p = runUsbProbe(baseOptions({ createPort: () => fake, readMode: 'data' }));
    await new Promise((r) => setImmediate(r));
    fake.pushData(MODEL_FRAME);
    const result = await p;
    assert.equal(result.modelId, 4096, 'a valid model result must survive the cleanup close');
    assert.ok(fake.closeCalls >= 1);
  });

  test('close callback succeeds but the port still reports open is a cleanup failure', async () => {
    const fake = new FakeSerialPort();
    fake.closeLeavesOpen = true;
    const p = runUsbProbe(baseOptions({ createPort: () => fake, readMode: 'data' }));
    await new Promise((r) => setImmediate(r));
    fake.pushData(MODEL_FRAME);
    await assert.rejects(p, /port remains open after close callback/);
    assert.ok(fake.closeCalls >= 1, 'the cleanup close must still have been attempted');
  });

  test('SIGINT after a valid model but during the bounded close rejects with AbortError', async () => {
    const fake = new FakeSerialPort();
    fake.deferClose = true;
    const controller = new AbortController();
    const p = runUsbProbe(
      baseOptions({
        createPort: () => fake,
        readMode: 'data',
        closeTimeoutMs: 5000,
        signal: controller.signal,
      }),
    );
    await new Promise((r) => setImmediate(r));
    // A valid model arrives; the probe resolves and enters the bounded close.
    fake.pushData(MODEL_FRAME);
    await new Promise((r) => setImmediate(r));
    assert.equal(fake.closeCalls, 1, 'the cleanup close must have been initiated');
    // SIGINT fires while the close is still deferred.
    controller.abort();
    fake.completeClose();
    await assert.rejects(p, (err) => controller.signal.aborted && err && err.name === 'AbortError');
  });

  test('an earlier primary error is preserved even though the signal aborts during close', async () => {
    const fake = new FakeSerialPort();
    fake.deferClose = true;
    const controller = new AbortController();
    const p = runUsbProbe(
      baseOptions({
        createPort: () => fake,
        readMode: 'data',
        timeoutMs: 200,
        closeTimeoutMs: 5000,
        signal: controller.signal,
      }),
    );
    await new Promise((r) => setImmediate(r));
    // Deadline fires while the close is deferred: primary timeout error is set.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(fake.closeCalls, 1, 'the cleanup close must have been initiated');
    // Abort during the deferred close must not replace the primary timeout.
    controller.abort();
    fake.completeClose();
    await assert.rejects(p, /overall deadline exceeded after 200ms/);
  });
});

describe('validation and CLI', () => {
  test('rejects an invalid readMode before opening', async () => {
    const fake = new FakeSerialPort();
    await assert.rejects(
      runUsbProbe(baseOptions({ createPort: () => fake, readMode: 'nope' })),
      /readMode must be "data" or "readable"/,
    );
    assert.equal(fake.openCalls, 0, 'validation must happen before open');
  });

  test('rejects an out-of-range timeoutMs before opening', async () => {
    const fake = new FakeSerialPort();
    await assert.rejects(
      runUsbProbe(baseOptions({ createPort: () => fake, timeoutMs: 50 })),
      /timeoutMs must be an integer between 100 and 60000/,
    );
    assert.equal(fake.openCalls, 0);
  });

  test('CLI --help prints usage and exits 0', () => {
    const res = spawnSync(process.execPath, ['src/usb-probe.mjs', '--help'], {
      encoding: 'utf8',
      cwd: new URL('..', import.meta.url).pathname,
    });
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}: ${res.stderr}`);
    assert.match(res.stdout, /Usage:/);
    assert.match(res.stdout, /--read-mode/);
    assert.match(res.stdout, /--timeout-ms/);
  });
});
