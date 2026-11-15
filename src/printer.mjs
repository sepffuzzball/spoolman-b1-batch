import sharp from 'sharp';
import {
  NiimbotNodeSerialClient,
  ImageEncoder,
  PageColorType,
  LabelType,
  PrinterModel,
} from '@mmote/niimbluelib';

const PNG_WIDTH = 320;
const PNG_HEIGHT = 240;
const THRESHOLD = 180;

/**
 * Encode a 320x240 PNG label page into the library's EncodedImage.
 *
 * The source PNG is required to be exactly 320x240. Alpha is composited over
 * white, the result is converted to grayscale and thresholded (pixels below
 * THRESHOLD become black, everything else stays white) before being handed to
 * the library's ImageEncoder with printDirection "top". Pixels at or above
 * the threshold stay white so that light backgrounds do not get dropped, while
 * medium-gray content is kept as black.
 *
 * @param {{ path: string }} params
 * @returns {Promise<import('@mmote/niimbluelib').EncodedImage>}
 */
export async function encodePage({ path }) {
  const image = sharp(path);
  const meta = await image.metadata();
  if (meta.format !== 'png') {
    throw new Error(`Expected PNG image, got "${meta.format}"`);
  }
  if (meta.width !== PNG_WIDTH || meta.height !== PNG_HEIGHT) {
    throw new Error(`Expected ${PNG_WIDTH}x${PNG_HEIGHT} PNG, got ${meta.width}x${meta.height}`);
  }

  const { data, info } = await image
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .grayscale()
    .threshold(THRESHOLD)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const source = {
    width,
    height,
    // "top" direction: pixel coordinates are used as-is. The raw output is a
    // single grayscale byte per pixel (0 or 255 after thresholding), so map it
    // back to a packed RGB value: 0 -> 0x000000 (black), 255 -> 0xffffff (white).
    getPixelColor(x, y) {
      const gray = data[y * width + x];
      return (gray << 16) | (gray << 8) | gray;
    },
  };

  return ImageEncoder.encode(source, PageColorType.SingleColor, 'top');
}

/**
 * Create a printer session bound to a single B1 device.
 *
 * The client is created once via clientFactory (injected only for tests).
 * Configuration that is safe to perform without hardware is applied lazily
 * inside connect(), which also verifies the device model before any print job
 * is prepared.
 *
 * The session is permanently closed by disconnect(): after that, createTask()
 * rejects and any still-pending connect() is cleaned up best-effort (a second
 * client.disconnect()) so a port that gets assigned late is released.
 *
 * @param {{
 *   port: string,
 *   density: number,
 *   clientFactory?: () => import('@mmote/niimbluelib').NiimbotNodeSerialClient
 * }} options
 * @returns {{
 *   connect: () => Promise<void>,
 *   disconnect: () => Promise<void>,
 *   cancelStatusPoll: () => void,
 *   createTask: () => import('@mmote/niimbluelib').AbstractPrintTask
 * }}
 */
export function createPrinterSession({ port, density, clientFactory = () => new NiimbotNodeSerialClient() }) {
  if (typeof port !== 'string' || port.trim() === '') {
    throw new Error('port must be a non-empty string');
  }
  if (!Number.isInteger(density) || density < 1 || density > 5) {
    throw new Error('density must be an integer 1..5');
  }

  const client = clientFactory();
  // Permanently set once the session is closed. Used both to reject any later
  // use of the session and to clean up a native open that is still pending.
  let disposed = false;
  let connected = false;

  return {
    async connect() {
      // If the session is already closed, reject immediately without touching
      // the port or attempting a native open.
      if (disposed) {
        throw new Error('printer session is closed');
      }

      client.setPort(port);
      // Avoid background RFID traffic after a print completes.
      client.setFetchRfidOnPrintEnd(false);
      client.protocol.setPacketTimeout(5000);

      let fulfilled = false;
      let connectError;
      try {
        await client.connect();
        fulfilled = true;
      } catch (err) {
        connectError = err;
      }

      if (disposed) {
        // The session was closed while the native port open was still pending.
        // Close again best-effort so a port assigned late is always released;
        // the underlying public API cannot abort a pending open, so this is the
        // only best-effort cleanup available.
        try {
          await client.disconnect();
        } catch {
          // Best-effort close; a pending open may have nothing to close yet.
        }
        if (fulfilled) {
          // The open actually succeeded but the caller no longer wants it.
          throw new Error('printer session was closed during connect');
        }
        throw connectError;
      }

      if (!fulfilled) {
        throw connectError;
      }

      const meta = client.getModelMetadata();
      if (meta?.model !== PrinterModel.B1) {
        throw new Error(`Unsupported printer model "${meta?.model ?? 'UNKNOWN'}"; expected B1`);
      }
      connected = true;
    },
    async disconnect() {
      // Latch the closed state before handing off to the client so that a
      // concurrent connect() can observe it as soon as it settles.
      disposed = true;
      return client.disconnect();
    },
    cancelStatusPoll() {
      client.protocol.cancelStatusPoll();
    },
    createTask() {
      if (disposed) {
        throw new Error('printer session is closed');
      }
      if (!connected) {
        throw new Error('createTask requires a successful connect()');
      }
      return client.protocol.newPrintTask('B1', {
        density,
        labelType: LabelType.WithGaps,
        totalPages: 1,
        pageColor: PageColorType.SingleColor,
        statusPollIntervalMs: 250,
        statusTimeoutMs: 3000,
        pageTimeoutMs: 10000,
      });
    },
  };
}
