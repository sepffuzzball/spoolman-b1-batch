// test/usb-client.test.mjs
//
// These tests exercise the B1UsbClient request/response ordering fix. They use
// the real public packet/event classes and mock ONLY the sendPacket method, so
// no serial port is opened and no protocol negotiation runs. The behaviour under
// test is the ordering window: the response waiter must be registered BEFORE the
// request is flushed, so a response that arrives while the write is settling is
// captured rather than dropped.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NiimbotPacket,
  NiimbotNodeSerialClient,
  PacketReceivedEvent,
  RequestCommandId,
  ResponseCommandId,
  PrinterErrorCode,
} from '@mmote/niimbluelib';
import { B1UsbClient } from '../src/usb-client.mjs';

// A request that expects the mandatory C2 (In_Connect) response.
function c2Request() {
  return new NiimbotPacket(RequestCommandId.Connect, [], [ResponseCommandId.In_Connect]);
}

describe('B1UsbClient', () => {
  test('is a NiimbotNodeSerialClient (pinned Node serial implementation)', () => {
    const client = new B1UsbClient();
    assert.ok(client instanceof NiimbotNodeSerialClient);
    assert.equal(client.getType(), 'node-serial', 'must use the Node serial impl, not the browser serial_impl');
  });

  test('captures a C2 response emitted synchronously inside sendPacket', async () => {
    const client = new B1UsbClient();
    const req = c2Request();
    const c2 = new NiimbotPacket(ResponseCommandId.In_Connect, []);
    let emittedInside = false;
    client.sendPacket = async (packet, force) => {
      assert.equal(force, true, 'requests are always sent with force=true');
      emittedInside = true;
      // The response is emitted before sendPacket returns, i.e. during the write
      // settle. The old base would register its waiter only after this and miss it.
      client.emit('packetreceived', new PacketReceivedEvent(c2));
    };

    const res = await client.sendPacketWaitResponse(req, 1000);
    assert.equal(emittedInside, true);
    assert.equal(res, c2, 'the response emitted during the write must be returned');
  });

  test('a missing C2 still times out (no forged response or bypass)', async () => {
    const client = new B1UsbClient();
    client.sendPacket = async () => {};
    await assert.rejects(client.sendPacketWaitResponse(c2Request(), 30), /Timeout waiting response/);
  });

  test('ignores a wrong-command response and still resolves on the real one', async () => {
    const client = new B1UsbClient();
    const req = c2Request();
    const wrong = new NiimbotPacket(ResponseCommandId.In_GetPaperInfo, []);
    const c2 = new NiimbotPacket(ResponseCommandId.In_Connect, []);
    client.sendPacket = async () => {
      client.emit('packetreceived', new PacketReceivedEvent(wrong));
      client.emit('packetreceived', new PacketReceivedEvent(c2));
    };

    const res = await client.sendPacketWaitResponse(req, 1000);
    assert.equal(res, c2, 'an unrelated response must not satisfy the waiter');
  });

  test('PrintError response rejects with PrintError unchanged', async () => {
    const client = new B1UsbClient();
    client.sendPacket = async () => {
      client.emit(
        'packetreceived',
        new PacketReceivedEvent(new NiimbotPacket(ResponseCommandId.In_PrintError, [PrinterErrorCode.CoverOpen])),
      );
    };
    await assert.rejects(client.sendPacketWaitResponse(c2Request(), 1000), /Print error 1: CoverOpen/);
  });

  test('NotSupported response rejects with PrintError unchanged', async () => {
    const client = new B1UsbClient();
    client.sendPacket = async () => {
      client.emit('packetreceived', new PacketReceivedEvent(new NiimbotPacket(ResponseCommandId.In_NotSupported, [])));
    };
    await assert.rejects(client.sendPacketWaitResponse(c2Request(), 1000), /Feature not supported/);
  });

  test('write failure preserves the original error and settles the pending waiter', async () => {
    const client = new B1UsbClient();
    const req = c2Request();
    const boom = new Error('EACCES: write failed');
    client.sendPacket = async () => {
      throw boom;
    };

    const listenersBefore = client.listenerCount('packetreceived');
    await assert.rejects(client.sendPacketWaitResponse(req, 30), (err) => {
      assert.equal(err, boom, 'the original write error identity must be preserved');
      return true;
    });
    // The bounded waiter (timer + listener) must have settled before the mutex
    // was released.
    assert.equal(client.listenerCount('packetreceived'), listenersBefore);
  });

  test('write failure preserves a thrown non-Error (undefined) value and settles the waiter', async () => {
    const client = new B1UsbClient();
    const req = c2Request();
    client.sendPacket = async () => {
      throw undefined;
    };

    const listenersBefore = client.listenerCount('packetreceived');
    let rejectedWith;
    try {
      await client.sendPacketWaitResponse(req, 30);
    } catch (err) {
      rejectedWith = err;
    }
    assert.equal(rejectedWith, undefined, 'a thrown undefined must be preserved, not swallowed');
    assert.equal(client.listenerCount('packetreceived'), listenersBefore);
  });

  test('an early response timeout while the write is pending is handled, not an unhandled rejection', async () => {
    const client = new B1UsbClient();
    const req = c2Request();
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    let releaseWrite;
    const gate = new Promise((resolve) => {
      releaseWrite = resolve;
    });
    client.sendPacket = async () => {
      await gate;
    };

    try {
      const call = client.sendPacketWaitResponse(req, 20);
      // Let the 20ms waiter reject while the write is still pending.
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(unhandled.length, 0, 'the early rejection must not surface as unhandled');

      releaseWrite();
      await assert.rejects(call, /Timeout waiting response/);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('concurrent requests are serialized by the mutex', async () => {
    const client = new B1UsbClient();
    const order = [];
    const reqA = c2Request();
    const reqB = new NiimbotPacket(RequestCommandId.GetPaperInfo, [], [ResponseCommandId.In_GetPaperInfo]);
    const respA = new NiimbotPacket(ResponseCommandId.In_Connect, []);
    const respB = new NiimbotPacket(ResponseCommandId.In_GetPaperInfo, []);

    let releaseA;
    const gateA = new Promise((resolve) => {
      releaseA = resolve;
    });
    client.sendPacket = async (packet, force) => {
      order.push('start:' + packet.command);
      if (packet.command === RequestCommandId.Connect) {
        await gateA;
        client.emit('packetreceived', new PacketReceivedEvent(respA));
      } else {
        client.emit('packetreceived', new PacketReceivedEvent(respB));
      }
      order.push('end:' + packet.command);
    };

    const pA = client.sendPacketWaitResponse(reqA, 1000);
    const pB = client.sendPacketWaitResponse(reqB, 1000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, [`start:${RequestCommandId.Connect}`], 'B must not start while A holds the mutex');

    releaseA();
    await Promise.all([pA, pB]);
    assert.deepEqual(order, [
      `start:${RequestCommandId.Connect}`,
      `end:${RequestCommandId.Connect}`,
      `start:${RequestCommandId.GetPaperInfo}`,
      `end:${RequestCommandId.GetPaperInfo}`,
    ]);
  });

  test('one-way packets are sent and return In_Invalid with no waiter', async () => {
    const client = new B1UsbClient();
    const req = new NiimbotPacket(RequestCommandId.PageEnd, []);
    req.oneWay = true;
    let sentForce;
    client.sendPacket = async (packet, force) => {
      sentForce = force;
    };

    const listenersBefore = client.listenerCount('packetreceived');
    const res = await client.sendPacketWaitResponse(req, 1000);
    assert.equal(sentForce, true, 'one-way packets are still sent with force=true');
    assert.ok(res instanceof NiimbotPacket);
    assert.equal(res.command, ResponseCommandId.In_Invalid);
    assert.equal(res.data.length, 0);
    assert.equal(client.listenerCount('packetreceived'), listenersBefore, 'one-way must not register a waiter');
  });
});

describe('B1UsbClient connectNegotiate / legacy USB connect', () => {
  function captureWarnings(run) {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (msg) => warnings.push(String(msg));
    return Promise.resolve()
      .then(run)
      .finally(() => {
        console.warn = origWarn;
      })
      .then(() => warnings);
  }

  test('default connectNegotiate calls the standard protocol and stores negotiated fields', async () => {
    const client = new B1UsbClient();
    const result = { connectResult: 1, protocolVersion: 3, supportColor: true };
    let protocolCalls = 0;
    client.protocol.connectNegotiate = async () => {
      protocolCalls++;
      return result;
    };

    const warnings = await captureWarnings(() => client.connectNegotiate());

    assert.equal(protocolCalls, 1, 'the C1/C2 protocol must be called by default');
    assert.deepEqual(warnings, [], 'no legacy warning must be emitted by default');
    assert.equal(client.printerInfo.connectResult, result.connectResult);
    assert.equal(client.printerInfo.protocolVersion, result.protocolVersion);
    assert.equal(client.printerInfo.supportColor, result.supportColor);
  });

  test('default connectNegotiate propagates a C2 timeout (never auto-falls back)', async () => {
    const client = new B1UsbClient();
    client.protocol.connectNegotiate = async () => {
      throw new Error('Timeout waiting response (waited for 193, 194)');
    };
    await assert.rejects(client.connectNegotiate(), /Timeout waiting response/);
  });

  test('legacy connectNegotiate warns and skips the protocol without fabricating negotiated fields', async () => {
    const client = new B1UsbClient({ legacyUsbConnect: true });
    let protocolCalls = 0;
    client.protocol.connectNegotiate = async () => {
      protocolCalls++;
      return { connectResult: 1, protocolVersion: 3, supportColor: true };
    };

    const warnings = await captureWarnings(() => client.connectNegotiate());

    assert.equal(protocolCalls, 0, 'the C1/C2 protocol must NOT be called in legacy mode');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Legacy USB connect: skipping C1\/C2 negotiation/);
    assert.equal(client.printerInfo.connectResult, undefined, 'connectResult must not be fabricated');
    assert.equal(client.printerInfo.protocolVersion, undefined, 'protocolVersion must not be fabricated');
    assert.equal(client.printerInfo.supportColor, undefined, 'supportColor must not be fabricated');
  });

  test('default mode negotiateAndGetPrinterInfo runs negotiation, printer-info and RFID fetch', async () => {
    const client = new B1UsbClient();
    let protocolCalls = 0;
    client.protocol.connectNegotiate = async () => {
      protocolCalls++;
      return { connectResult: 1, protocolVersion: 1, supportColor: false };
    };
    let infoCalls = 0;
    let rfidCalls = 0;
    client.fetchPrinterInfo = async () => {
      infoCalls++;
      return client.printerInfo;
    };
    client.fetchRfidInfo = async () => {
      rfidCalls++;
      return {};
    };

    await client.negotiateAndGetPrinterInfo();

    assert.equal(protocolCalls, 1);
    assert.equal(infoCalls, 1);
    assert.equal(rfidCalls, 1);
    assert.equal(client.skipNextHeartbeatRfidCheck, true);
  });

  test('legacy mode skips only connectNegotiate; printer-info and RFID fetch still run', async () => {
    const client = new B1UsbClient({ legacyUsbConnect: true });
    let protocolCalls = 0;
    client.protocol.connectNegotiate = async () => {
      protocolCalls++;
      return { connectResult: 1, protocolVersion: 1, supportColor: false };
    };
    let infoCalls = 0;
    let rfidCalls = 0;
    client.fetchPrinterInfo = async () => {
      infoCalls++;
      return client.printerInfo;
    };
    client.fetchRfidInfo = async () => {
      rfidCalls++;
      return {};
    };

    const warnings = await captureWarnings(() => client.negotiateAndGetPrinterInfo());

    assert.equal(protocolCalls, 0, 'connect negotiation must be skipped in legacy mode');
    assert.equal(infoCalls, 1, 'printer-info fetch must still be required');
    assert.equal(rfidCalls, 1, 'RFID fetch must still be required');
    assert.equal(client.skipNextHeartbeatRfidCheck, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Legacy USB connect: skipping C1\/C2 negotiation/);
  });

  test('legacy mode: a printer-info (model query) error still rejects', async () => {
    const client = new B1UsbClient({ legacyUsbConnect: true });
    client.protocol.connectNegotiate = async () => {
      throw new Error('should not be called');
    };
    client.fetchPrinterInfo = async () => {
      throw new Error('model query failed');
    };
    client.fetchRfidInfo = async () => {
      throw new Error('should not be called');
    };
    const warnings = await captureWarnings(() =>
      assert.rejects(client.negotiateAndGetPrinterInfo(), /model query failed/),
    );
    assert.equal(warnings.length, 1, 'the legacy warning must still be emitted before the fetch fails');
  });
});
