import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrinterModel, LabelType, PageColorType } from '@mmote/niimbluelib';
import { encodePage, createPrinterSession } from '../src/printer.mjs';

const WIDTH = 320;
const HEIGHT = 240;

function rawImage() {
  return { raw: { width: WIDTH, height: HEIGHT, channels: 1 } };
}

// Create a PNG whose top-left 20x20 block is black, everything else white.
function markerBuffer() {
  const buf = Buffer.alloc(WIDTH * HEIGHT, 255);
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      buf[y * WIDTH + x] = 0;
    }
  }
  return buf;
}

describe('encodePage', () => {
  let dir;
  let markerPath;
  let gray128Path;
  let whitePath;
  let transparentPath;
  let smallPath;
  let jpegPath;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'niim-printer-'));
    markerPath = join(dir, 'marker.png');
    gray128Path = join(dir, 'gray128.png');
    whitePath = join(dir, 'white.png');
    transparentPath = join(dir, 'transparent.png');
    smallPath = join(dir, 'small.png');
    jpegPath = join(dir, 'page.jpg');

    await sharp(markerBuffer(), rawImage()).png().toFile(markerPath);
    await sharp(Buffer.alloc(WIDTH * HEIGHT, 128), rawImage()).png().toFile(gray128Path);
    await sharp(Buffer.alloc(WIDTH * HEIGHT, 255), rawImage()).png().toFile(whitePath);
    // Fully transparent page (RGB black, alpha 0) so only flatten-over-white
    // can turn it into a white page.
    await sharp({
      create: { width: WIDTH, height: HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toFile(transparentPath);

    await sharp(Buffer.alloc(10 * 10, 255), { raw: { width: 10, height: 10, channels: 1 } })
      .png()
      .toFile(smallPath);

    await sharp(Buffer.alloc(WIDTH * HEIGHT, 200), rawImage()).jpeg().toFile(jpegPath);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns an encoder image with the original dimensions and marker orientation', async () => {
    const encoded = await encodePage({ path: markerPath });
    // 'top' print direction keeps cols = width and rows = height. A 'left'
    // direction would swap these (240x320), so this asserts orientation.
    assert.equal(encoded.cols, WIDTH);
    assert.equal(encoded.rows, HEIGHT);
    assert.ok(Array.isArray(encoded.rowsData) && encoded.rowsData.length > 0);

    const first = encoded.rowsData[0];
    assert.equal(first.dataType, 'pixels');
    assert.equal(first.rowNumber, 0, 'marker must appear in the top row');
    assert.equal(first.blackPixelsCount, 20, 'only the 20px-wide marker is black');
    // The top-left 8 marker columns must all be black (0xff) in the first row byte.
    assert.equal(first.rowDataBlack[0], 0xff);
  });

  test('mid-gray (128) is kept as black while white stays white', async () => {
    const gray = await encodePage({ path: gray128Path });
    assert.equal(gray.rowsData[0].dataType, 'pixels');
    assert.equal(gray.rowsData[0].blackPixelsCount, WIDTH, 'all 320 columns are black');

    const white = await encodePage({ path: whitePath });
    assert.equal(white.rowsData[0].dataType, 'void');
    for (const segment of white.rowsData) {
      if (segment.dataType === 'pixels') {
        assert.fail('white page must not contain black pixels');
      }
    }
  });

  test('composites transparent pixels over white before threshold', async () => {
    const encoded = await encodePage({ path: transparentPath });
    for (const segment of encoded.rowsData) {
      if (segment.dataType === 'pixels') {
        assert.fail('a fully transparent page must be composited over white and stay white');
      }
    }
  });

  test('rejects a PNG that is not exactly 320x240', async () => {
    await assert.rejects(() => encodePage({ path: smallPath }), /Expected 320x240 PNG, got 10x10/);
  });

  test('rejects a non-PNG image', async () => {
    await assert.rejects(() => encodePage({ path: jpegPath }), /Expected PNG image, got "jpeg"/);
  });
});

function makeFakeClient(meta, { connectDeferred, connectError } = {}) {
  const calls = {
    port: undefined,
    rfid: undefined,
    packetTimeout: undefined,
    connected: false,
    disconnects: 0,
    cancelled: 0,
    tasks: [],
    debug: undefined,
    sequence: [],
  };
  const protocol = {
    setPacketTimeout(value) {
      calls.packetTimeout = value;
    },
    newPrintTask(name, options) {
      const task = { name, options };
      calls.tasks.push(task);
      return task;
    },
    cancelStatusPoll() {
      calls.cancelled++;
    },
  };
  const client = {
    protocol,
    setPort(port) {
      calls.port = port;
    },
    setFetchRfidOnPrintEnd(value) {
      calls.rfid = value;
    },
    setDebug(value) {
      calls.debug = value;
      calls.sequence.push('setDebug');
    },
    async connect() {
      calls.connected = true;
      calls.sequence.push('connect');
      if (connectDeferred) {
        return connectDeferred.promise;
      }
      if (connectError) {
        throw connectError;
      }
    },
    disconnect() {
      calls.disconnects++;
      return Promise.resolve();
    },
    getModelMetadata() {
      return meta;
    },
  };
  return { client, calls };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createPrinterSession', () => {
  test('applies port, disables RFID on print end, and sets packet timeout', async () => {
    const { client, calls } = makeFakeClient({ model: PrinterModel.B1 });
    const session = createPrinterSession({
      port: '/dev/ttyUSB0',
      density: 3,
      clientFactory: () => client,
    });

    await session.connect();

    assert.equal(calls.port, '/dev/ttyUSB0');
    assert.equal(calls.rfid, false);
    assert.equal(calls.packetTimeout, 5000);
    assert.equal(calls.connected, true);
  });

  test('verbose enables the public setDebug(true) before connect', async () => {
    const { client, calls } = makeFakeClient({ model: PrinterModel.B1 });
    const session = createPrinterSession({
      port: 'port',
      density: 3,
      verbose: true,
      clientFactory: () => client,
    });

    await session.connect();

    assert.equal(calls.debug, true, 'verbose must enable debug on the client');
    const setDebugAt = calls.sequence.indexOf('setDebug');
    const connectAt = calls.sequence.indexOf('connect');
    assert.ok(setDebugAt !== -1, 'setDebug must be called');
    assert.ok(setDebugAt < connectAt, 'setDebug must be called before the native connect');
  });

  test('verbose defaults to false and does not call setDebug', async () => {
    const { client, calls } = makeFakeClient({ model: PrinterModel.B1 });
    const session = createPrinterSession({
      port: 'port',
      density: 3,
      clientFactory: () => client,
    });

    await session.connect();

    assert.equal(calls.debug, undefined, 'setDebug must not be called by default');
    assert.ok(!calls.sequence.includes('setDebug'));
  });

  test('accepts a B1 device', async () => {
    const { client } = makeFakeClient({ model: PrinterModel.B1 });
    const session = createPrinterSession({ port: 'port', density: 2, clientFactory: () => client });
    await session.connect();
  });

  test('rejects unknown/missing model before any job is prepared', async () => {
    for (const meta of [{ model: PrinterModel.UNKNOWN }, undefined]) {
      const { client } = makeFakeClient(meta);
      const session = createPrinterSession({ port: 'port', density: 2, clientFactory: () => client });
      await assert.rejects(() => session.connect(), /Unsupported printer model/);
      // Because connect() failed, createTask must refuse to build a job.
      assert.throws(() => session.createTask(), /requires a successful connect/);
    }
  });

  test('with legacy-usb-connect the strict B1 model guard still rejects before any task', async () => {
    for (const meta of [{ model: PrinterModel.UNKNOWN }, undefined]) {
      const { client } = makeFakeClient(meta);
      const session = createPrinterSession({
        port: 'port',
        density: 2,
        legacyUsbConnect: true,
        clientFactory: () => client,
      });
      await assert.rejects(() => session.connect(), /Unsupported printer model/);
      assert.throws(() => session.createTask(), /requires a successful connect/);
    }
  });

  test('propagates the original connect error (not a model error) when the native open fails', async () => {
    const boom = new Error('EACCES: permission denied');
    const { client, calls } = makeFakeClient({ model: PrinterModel.B1 }, { connectError: boom });
    const session = createPrinterSession({ port: 'port', density: 2, clientFactory: () => client });

    // The exact error object must be rethrown, not rewritten as "Unsupported model".
    await assert.rejects(() => session.connect(), (err) => {
      assert.equal(err, boom, 'the original connect error identity must be preserved');
      return true;
    });

    assert.equal(calls.connected, true);
    assert.equal(calls.tasks.length, 0, 'no print job may be prepared after a failed connect');
    assert.throws(() => session.createTask(), /requires a successful connect/);
  });

  test('connect after disconnect rejects immediately without opening the port', async () => {
    const { client, calls } = makeFakeClient({ model: PrinterModel.B1 });
    const session = createPrinterSession({ port: 'port', density: 2, clientFactory: () => client });

    await session.disconnect();

    await assert.rejects(() => session.connect(), /printer session is closed/);
    // No setPort / packet-timeout / native open may have been attempted.
    assert.equal(calls.port, undefined);
    assert.equal(calls.rfid, undefined);
    assert.equal(calls.packetTimeout, undefined);
    assert.equal(calls.connected, false, 'client.connect() must not be called');
  });

  test('validates port and density', () => {
    const clientFactory = () => makeFakeClient({ model: PrinterModel.B1 }).client;
    assert.throws(() => createPrinterSession({ port: '', density: 1, clientFactory }), /port/);
    assert.throws(() => createPrinterSession({ port: 'port', density: 0, clientFactory }), /density/);
    assert.throws(() => createPrinterSession({ port: 'port', density: 6, clientFactory }), /density/);
    assert.throws(() => createPrinterSession({ port: 'port', density: 1.5, clientFactory }), /density/);
  });

  test('createTask builds a single-page B1 task with the configured settings', async () => {
    const { client, calls } = makeFakeClient({ model: PrinterModel.B1 });
    const session = createPrinterSession({ port: 'port', density: 4, clientFactory: () => client });

    await session.connect();
    const task = session.createTask();

    assert.equal(calls.tasks.length, 1);
    const created = calls.tasks[0];
    assert.equal(task, created, 'createTask must return the task from newPrintTask');
    assert.equal(created.name, 'B1');
    assert.equal(created.options.totalPages, 1);
    assert.equal(created.options.density, 4);
    assert.equal(created.options.labelType, LabelType.WithGaps);
    assert.equal(created.options.pageColor, PageColorType.SingleColor);
    assert.equal(created.options.statusPollIntervalMs, 250);
    assert.equal(created.options.statusTimeoutMs, 3000);
    assert.equal(created.options.pageTimeoutMs, 10000);
  });

  test('delegates cancelStatusPoll and disconnect', async () => {
    const { client, calls } = makeFakeClient({ model: PrinterModel.B1 });
    const session = createPrinterSession({ port: 'port', density: 2, clientFactory: () => client });

    await session.connect();
    session.cancelStatusPoll();
    session.cancelStatusPoll();
    assert.equal(calls.cancelled, 2);

    await session.disconnect();
    assert.equal(calls.disconnects, 1);
    // Even after a successful connect, a closed session refuses new print jobs.
    assert.throws(() => session.createTask(), /printer session is closed/);
  });

  test('disconnecting during a pending connect closes any late-open port and never yields a usable session', async () => {
    const open = deferred();
    const { client, calls } = makeFakeClient({ model: PrinterModel.B1 }, { connectDeferred: open });
    const session = createPrinterSession({ port: 'port', density: 2, clientFactory: () => client });

    const connectPromise = session.connect();
    // Guard against an unhandled rejection before we attach the assertion.
    connectPromise.catch(() => {});

    await session.disconnect();
    assert.equal(calls.disconnects, 1, 'disconnect closes the client immediately');

    // The native open settles only after the session was closed.
    open.resolve();
    await assert.rejects(connectPromise, /printer session was closed during connect/);

    // A second best-effort close must have been issued for the late-open port.
    assert.equal(calls.disconnects, 2);
    // No print command may have been prepared.
    assert.equal(calls.tasks.length, 0);
    assert.throws(() => session.createTask(), /printer session is closed/);
  });

  test('a late connect rejection after disconnect is cleaned up and not left unhandled', async () => {
    const open = deferred();
    const { client, calls } = makeFakeClient({ model: PrinterModel.B1 }, { connectDeferred: open });
    const session = createPrinterSession({ port: 'port', density: 2, clientFactory: () => client });

    const connectPromise = session.connect();
    connectPromise.catch(() => {});

    await session.disconnect();
    assert.equal(calls.disconnects, 1);

    open.reject(new Error('connect failed'));
    await assert.rejects(connectPromise, /connect failed/);

    // Cleanup still happened for the pending open.
    assert.equal(calls.disconnects, 2);
    assert.equal(calls.tasks.length, 0);
    assert.throws(() => session.createTask(), /printer session is closed/);
  });
});
