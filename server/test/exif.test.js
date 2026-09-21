// ── EXIF parsing, fed the input an attacker controls ─────────────────────────
// exifTakenAt walks bytes straight off the wire with no library behind it, and a
// throw here would reject an honest upload — or, in the other direction, a wrong
// date would let a year-old photo through. It must never throw, on anything.

import { test } from "node:test";
import assert from "node:assert/strict";
import { exifTakenAt } from "../exif.js";

// Minimal JPEG carrying an APP1/TIFF block with one dated tag.
function jpegWithDate(dateStr, { tag = 0x9003, little = true } = {}) {
  const ascii = Buffer.from(dateStr + "\0", "ascii");     // 20 bytes
  const tiff = Buffer.alloc(8 + 2 + 12 + 4 + ascii.length);
  let o = 0;
  tiff.write(little ? "II" : "MM", o); o += 2;
  little ? tiff.writeUInt16LE(42, o) : tiff.writeUInt16BE(42, o); o += 2;
  little ? tiff.writeUInt32LE(8, o) : tiff.writeUInt32BE(8, o); o += 4;  // IFD0 at 8
  little ? tiff.writeUInt16LE(1, o) : tiff.writeUInt16BE(1, o); o += 2;  // one entry
  little ? tiff.writeUInt16LE(tag, o) : tiff.writeUInt16BE(tag, o); o += 2;
  little ? tiff.writeUInt16LE(2, o) : tiff.writeUInt16BE(2, o); o += 2;  // ASCII
  little ? tiff.writeUInt32LE(ascii.length, o) : tiff.writeUInt32BE(ascii.length, o); o += 4;
  const valueOffset = 8 + 2 + 12 + 4;
  little ? tiff.writeUInt32LE(valueOffset, o) : tiff.writeUInt32BE(valueOffset, o); o += 4;
  o += 4;                                                  // next-IFD pointer = 0
  ascii.copy(tiff, valueOffset);

  const exifHdr = Buffer.from("Exif\0\0", "ascii");
  const payload = Buffer.concat([exifHdr, tiff]);
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    Buffer.from([(payload.length + 2) >> 8, (payload.length + 2) & 0xff]),
    payload,
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xd9])]);
}

test("reads DateTimeOriginal out of a real APP1 block", () => {
  const r = exifTakenAt(jpegWithDate("2026:09:21 14:30:00"));
  assert.equal(r.hasExif, true);
  assert.equal(new Date(r.taken).getFullYear(), 2026);
  assert.equal(new Date(r.taken).getMonth(), 8);   // September
  assert.equal(new Date(r.taken).getDate(), 21);
});

test("handles big-endian files, which half the camera world writes", () => {
  const r = exifTakenAt(jpegWithDate("2026:01:02 03:04:05", { little: false }));
  assert.equal(r.hasExif, true);
  assert.equal(new Date(r.taken).getFullYear(), 2026);
});

test("falls back to DateTime when DateTimeOriginal is absent", () => {
  const r = exifTakenAt(jpegWithDate("2025:12:31 23:59:59", { tag: 0x0132 }));
  assert.equal(r.hasExif, true);
  assert.equal(new Date(r.taken).getFullYear(), 2025);
});

test("a camera with no clock set reports no date rather than the year zero", () => {
  const r = exifTakenAt(jpegWithDate("0000:00:00 00:00:00"));
  assert.equal(r.hasExif, true);
  assert.equal(r.taken, null);
});

test("a JPEG without EXIF is reported as such, not as an error", () => {
  const plain = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(200, 1), Buffer.from([0xff, 0xd9])]);
  assert.deepEqual(exifTakenAt(plain), { taken: null, hasExif: false });
});

test("never throws, whatever it is handed", () => {
  const nasty = [
    null, undefined, "not a buffer", 42, {},
    Buffer.alloc(0),
    Buffer.from([0xff, 0xd8]),                                  // truncated
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]),          // length beyond the file
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66]), // half a header
    Buffer.alloc(5000, 0xff),                                   // all markers
  ];
  for (const input of nasty) {
    const r = exifTakenAt(input);
    assert.equal(typeof r.hasExif, "boolean", `bad shape for ${String(input).slice(0, 20)}`);
    assert.ok(r.taken === null || Number.isFinite(r.taken));
  }
});

test("a byte count that would run past the buffer is refused, not read", () => {
  // Claims 512 IFD entries in a file that holds one.
  const buf = jpegWithDate("2026:09:21 14:30:00");
  const tiffStart = 2 + 4 + 6;        // SOI + APP1 marker/length + "Exif\0\0"
  buf.writeUInt16LE(600, tiffStart + 8);
  const r = exifTakenAt(buf);
  assert.equal(r.hasExif, true);
  assert.equal(r.taken, null);
});
