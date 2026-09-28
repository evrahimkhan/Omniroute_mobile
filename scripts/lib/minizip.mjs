/**
 * Minimal, dependency-free ZIP reader.
 *
 * Why not a library: these scripts run in CI (and in the Android build step)
 * before/after `npm ci` has necessarily settled, and pulling a zip package just
 * to copy one file out of a 74 MB archive is not worth the dependency surface.
 * Node ships `zlib`, which is all we need for method 8 (deflate).
 *
 * Supports the two compression methods that matter in practice:
 *   0 = stored, 8 = deflate. Anything else throws with the method number.
 *
 * Only reads the central directory for listing (cheap even for huge archives)
 * and decompresses individual entries on demand.
 */

import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x0605_4b50;
const CENTRAL_SIG = 0x0201_4b50;
const LOCAL_SIG = 0x0403_4b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x0706_4b50;

/** CRC-32 (IEEE 802.3), table built once. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** Locate the End Of Central Directory record, scanning back over the comment. */
function findEocd(buf) {
  const min = Math.max(0, buf.length - (0xffff + 22));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('not a zip archive (no End Of Central Directory record found)');
}

/**
 * List every entry in the archive.
 * @returns {{name: string, method: number, compSize: number, uncompSize: number, offset: number, crc: number}[]}
 */
export function listEntries(buf) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  // Best-effort guard: if the values are saturated, the archive needs ZIP64.
  if (offset === 0xffff_ffff || count === 0xffff) {
    for (let i = eocd - 20; i >= 0; i--) {
      if (buf.readUInt32LE(i) === ZIP64_EOCD_LOCATOR_SIG) {
        throw new Error('zip64 archives are not supported by this reader');
      }
    }
  }

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new Error(`corrupt central directory at offset ${offset}`);
    }
    const method = buf.readUInt16LE(offset + 10);
    const crc = buf.readUInt32LE(offset + 16);
    const compSize = buf.readUInt32LE(offset + 20);
    const uncompSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    entries.push({ name, method, compSize, uncompSize, offset: localOffset, crc });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Extract one entry to a Buffer, verifying size and CRC. */
export function extractEntry(buf, entry) {
  const local = entry.offset;
  if (buf.readUInt32LE(local) !== LOCAL_SIG) {
    throw new Error(`corrupt local header for ${entry.name}`);
  }
  const nameLen = buf.readUInt16LE(local + 26);
  const extraLen = buf.readUInt16LE(local + 28);
  const start = local + 30 + nameLen + extraLen;
  // Trust the central directory's compSize: the local header may carry 0 when a
  // data descriptor is used.
  const raw = buf.subarray(start, start + entry.compSize);

  let out;
  if (entry.method === 0) out = Buffer.from(raw);
  else if (entry.method === 8) out = inflateRawSync(raw);
  else throw new Error(`${entry.name}: unsupported compression method ${entry.method}`);

  if (out.length !== entry.uncompSize) {
    throw new Error(`${entry.name}: size mismatch (expected ${entry.uncompSize}, got ${out.length})`);
  }
  if (entry.crc && crc32(out) !== entry.crc) {
    throw new Error(`${entry.name}: CRC mismatch`);
  }
  return out;
}

/** Convenience: every entry name in the archive. */
export function listNames(buf) {
  return listEntries(buf).map((e) => e.name);
}
