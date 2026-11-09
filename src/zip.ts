import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { skillFiles } from "./skill.js";

// The Claude Desktop uploader refuses a zip that carries a plugin manifest
// (reported in anthropics/claude-code#20697), so it never goes in.
const EXCLUDED_FROM_UPLOAD = new Set([".claude-plugin/plugin.json"]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// DOS date for 1980-01-01 00:00. A fixed timestamp makes the zip a pure
// function of the skill's bytes, so an unchanged skill yields an identical zip.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

// Layout `<name>/SKILL.md` at the top level, which is what the Desktop
// "Upload skill" dialog expects.
export function buildSkillZip(skillName: string, skillDir: string): { zip: Buffer; entries: string[] } {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  const entries: string[] = [];
  let offset = 0;
  for (const rel of skillFiles(skillDir)) {
    if (EXCLUDED_FROM_UPLOAD.has(rel)) continue;
    const name = Buffer.from(`${skillName}/${rel}`, "utf8");
    const raw = readFileSync(join(skillDir, ...rel.split("/")));
    const packed = deflateRawSync(raw);
    const crc = crc32(raw);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, packed);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt16LE(DOS_TIME, 12);
    record.writeUInt16LE(DOS_DATE, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(packed.length, 20);
    record.writeUInt32LE(raw.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);

    offset += header.length + name.length + packed.length;
    entries.push(name.toString("utf8"));
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return { zip: Buffer.concat([...local, centralBytes, end]), entries };
}
