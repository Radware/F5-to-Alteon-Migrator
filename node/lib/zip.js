'use strict';
// Minimal in-memory zip writer for the HTTP service, so the project keeps zero
// runtime dependencies. Output files are small text, so no zip64 and no
// streaming are needed.
const zlib = require('zlib');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

// files: {name: string}. Returns the zip archive as a Buffer.
function zip(files) {
  const { time, date } = dosDateTime(new Date());
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const packed = zlib.deflateRawSync(data);
    // fields shared by the local and central headers, from "version needed" on
    const common = Buffer.alloc(26);
    common.writeUInt16LE(20, 0);                 // version needed
    common.writeUInt16LE(0x0800, 2);             // flags: UTF-8 names
    common.writeUInt16LE(8, 4);                  // method: deflate
    common.writeUInt16LE(time, 6);
    common.writeUInt16LE(date, 8);
    common.writeUInt32LE(crc32(data), 10);
    common.writeUInt32LE(packed.length, 14);
    common.writeUInt32LE(data.length, 18);
    common.writeUInt16LE(nameBuf.length, 22);    // extra length stays 0

    const localSig = Buffer.alloc(4);
    localSig.writeUInt32LE(0x04034b50, 0);
    const local = Buffer.concat([localSig, common, nameBuf, packed]);

    const centralHead = Buffer.alloc(6);
    centralHead.writeUInt32LE(0x02014b50, 0);
    centralHead.writeUInt16LE(20, 4);            // version made by
    const centralTail = Buffer.alloc(14);        // comment/disk/attrs stay 0
    centralTail.writeUInt32LE(offset, 10);
    centrals.push(Buffer.concat([centralHead, common, centralTail, nameBuf]));

    locals.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length, 8);
  end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

module.exports = { zip };
