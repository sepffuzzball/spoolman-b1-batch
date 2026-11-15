// src/usb-client.mjs
// B1-specific USB client that fixes a request/response ordering window and adds
// an explicit, opt-in compatibility mode for old B1 USB firmware.
//
// Ordering window:
// The upstream NiimbotAbstractClient.sendPacketWaitResponse waits for the
// response ONLY after the request has been written:
//
//   await this.sendPacket(packet, true);
//   if (packet.oneWay) return In_Invalid;
//   return this.waitForPacket(...);  // listener attached too late
//
// On a real USB/serial device the printer can answer while the write is still
// settling, so the "packetreceived" event may fire before the listener is
// registered and the real response is silently dropped, ending in a C2 (connect)
// timeout even though the printer answered. We register the waiter BEFORE the
// write so a response that arrives during the write is captured.
//
// Legacy USB connect:
// For devices that do not answer the C1/C2 handshake, an explicit compatibility
// mode can be tried; the cause/firmware support is unverified. We do NOT
// auto-fallback: the user must opt in with `legacyUsbConnect`, which skips ONLY
// the connect negotiation. The full printer-info fetch, B1 model identification
// and every later command remain fully required, so the strict handshake/identity
// guarantees are preserved unless the user knowingly opts out.

import { NiimbotNodeSerialClient, NiimbotPacket, ResponseCommandId } from '@mmote/niimbluelib';

export class B1UsbClient extends NiimbotNodeSerialClient {
  /**
   * @param {{ legacyUsbConnect?: boolean }} [options]
   */
  constructor({ legacyUsbConnect = false } = {}) {
    super();
    this.legacyUsbConnect = legacyUsbConnect;
  }

  /**
   * Skip the C1/C2 negotiation when legacyUsbConnect is set. We deliberately do
   * NOT fabricate a connectResult, protocolVersion or supportColor: nothing is
   * claimed that was not negotiated. The base negotiateAndGetPrinterInfo still
   * runs the required printer-model fetch before our B1 guard; the library's
   * best-effort RFID fetch swallows its own errors, so only a model-query failure
   * rejects here (never masked by a sentinel or fabricated value).
   *
   * @protected
   */
  async connectNegotiate() {
    if (!this.legacyUsbConnect) {
      await super.connectNegotiate();
      return;
    }
    console.warn('Legacy USB connect: skipping C1/C2 negotiation; B1 model identification is still required.');
  }

  /**
   * Send a packet and wait for the matching response.
   *
   * The waiter is started before the write so a response that arrives while the
   * request is still being flushed is not lost (the upstream order waits only
   * after the write). For one-way packets the upstream semantics are preserved
   * exactly: send, then return an In_Invalid packet with no waiter.
   *
   * @param {import('@mmote/niimbluelib').NiimbotPacket} packet
   * @param {number} [timeoutMs=1000]
   * @returns {Promise<import('@mmote/niimbluelib').NiimbotPacket>}
   */
  async sendPacketWaitResponse(packet, timeoutMs = 1000) {
    return this.mutex.runExclusive(async () => {
      if (packet.oneWay) {
        await this.sendPacket(packet, true);
        return new NiimbotPacket(ResponseCommandId.In_Invalid, []);
      }

      // Start listening for the response BEFORE flushing the request. Attach a
      // catch immediately so an early rejection (e.g. the waiter timing out while
      // the write is still pending) is never left as an unhandled rejection.
      const responsePromise = this.waitForPacket(packet.validResponseIds, true, timeoutMs);
      responsePromise.catch(() => {});

      try {
        await this.sendPacket(packet, true);
      } catch (err) {
        // A write failure must not leak a dangling waiter: let it settle (its
        // listener/timer) before releasing the mutex, then rethrow the ORIGINAL
        // error. We rethrow `err` directly, never a sentinel, so even a thrown
        // `undefined` value is preserved.
        await responsePromise.catch(() => {});
        throw err;
      }

      try {
        return await responsePromise;
      } catch (err) {
        // The waiter already settled; drain it so no timer/listener lingers.
        await responsePromise.catch(() => {});
        throw err;
      }
    });
  }
}
