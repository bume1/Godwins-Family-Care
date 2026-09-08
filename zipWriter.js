// ============================================================
// GODWINS FAMILY CARE — minimal ZIP writer (Session 4.6, Scope C)
//
// Builds a standard PKZIP archive in memory so a client can download every
// consent they signed in one file. Deliberately dependency-free: the repo
// already avoids adding packages for things Node can do (zlib gives us DEFLATE
// and the rest is a well-specified header layout), and a PHI-bearing download
// path is not where you want a new transitive dependency tree.
//
// Scope: store + deflate, no encryption, no ZIP64. A consent packet is a
// handful of small PDFs; if an archive ever needs to exceed 4 GB or 65,535
// entries, reach for a real library instead of extending this.
// ============================================================

'use strict';

const zlib = require('zlib');

// CRC-32 (IEEE 802.3), table built once.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// MS-DOS date/time, the only timestamp the base ZIP header carries.
function dosDateTime(date) {
  const d = date instanceof Date && !isNaN(date) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() / 2) & 0x1F),
    date: (((year - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F)
  };
}

/**
 * Build a ZIP archive.
 * @param {Array<{name: string, data: Buffer, date?: Date}>} entries
 * @returns {Buffer}
 */
function createZip(entries) {
  if (!Array.isArray(entries) || !entries.length) {
    throw new Error('createZip needs at least one entry');
  }
  const parts = [];
  const central = [];
  let offset = 0;

  entries.forEach(entry => {
    const name = Buffer.from(String(entry.name), 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '');
    const crc = crc32(raw);
    // Deflate unless it makes the payload bigger (already-compressed content).
    const deflated = zlib.deflateRawSync(raw, { level: 6 });
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const { time, date } = dosDateTime(entry.date);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // flags: bit 11 = UTF-8 filenames
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);           // extra field length
    parts.push(local, name, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);      // central directory header signature
    cd.writeUInt16LE(20, 4);              // version made by
    cd.writeUInt16LE(20, 6);              // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);              // extra length
    cd.writeUInt16LE(0, 32);              // comment length
    cd.writeUInt16LE(0, 34);              // disk number start
    cd.writeUInt16LE(0, 36);              // internal attributes
    cd.writeUInt32LE(0, 38);              // external attributes
    cd.writeUInt32LE(offset, 42);         // relative offset of local header
    central.push(cd, name);

    offset += local.length + name.length + payload.length;
  });

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);      // end of central directory signature
  eocd.writeUInt16LE(0, 4);               // disk number
  eocd.writeUInt16LE(0, 6);               // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);              // comment length

  return Buffer.concat([...parts, centralBuf, eocd]);
}

module.exports = { createZip, crc32 };
