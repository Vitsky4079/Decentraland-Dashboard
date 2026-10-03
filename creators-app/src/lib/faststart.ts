// Moves an MP4/MOV's `moov` index in front of its `mdat` data, without re-encoding.
//
// A file with `moov` at the very end (the default for most encoders) stalls in the
// Explorer's video player once it gets big: it plays ~15 s and then freezes. The same
// file re-muxed with the index first (ffmpeg -movflags +faststart) plays fine.
//
// The new file is a lazy Blob of slices of the original -- the video data is never copied
// into memory; only the small `moov` box (typically well under 5 MB) is read and patched.
// Anything unusual (fragmented MP4, already fast-start, huge index, files over 4 GiB whose
// chunk offsets would overflow 32 bits, parse errors) returns the original file untouched.

const MAX_MOOV_BYTES = 64 * 1024 * 1024;
const MAX_TOP_LEVEL_BOXES = 64;
const UINT32_MAX = 0xffffffff;

// Boxes that contain other boxes and sit on the path from `moov` to the chunk offset tables.
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl"]);

type Box = { type: string; start: number; size: number };

function fourcc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

async function readTopLevelBoxes(file: Blob): Promise<Box[] | null> {
  const boxes: Box[] = [];
  let offset = 0;
  while (offset < file.size) {
    if (boxes.length >= MAX_TOP_LEVEL_BOXES) return null;
    const head = new DataView(await file.slice(offset, offset + 16).arrayBuffer());
    if (head.byteLength < 8) return null;
    let size = head.getUint32(0);
    const type = fourcc(head, 4);
    if (size === 1) {
      if (head.byteLength < 16) return null;
      const big = head.getBigUint64(8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(big);
    } else if (size === 0) {
      size = file.size - offset;
    }
    if (size < 8 || offset + size > file.size) return null;
    boxes.push({ type, start: offset, size });
    offset += size;
  }
  return boxes;
}

// Adds `delta` to every chunk offset in stco/co64 boxes inside `moov`, in place.
// Returns false if any 32-bit offset would overflow.
function shiftChunkOffsets(moov: DataView, delta: number): boolean {
  const walk = (start: number, end: number): boolean => {
    let pos = start;
    while (pos + 8 <= end) {
      const size = moov.getUint32(pos);
      const type = fourcc(moov, pos + 4);
      if (size < 8 || pos + size > end) return false;
      if (CONTAINERS.has(type)) {
        if (!walk(pos + 8, pos + size)) return false;
      } else if (type === "stco") {
        const count = moov.getUint32(pos + 12);
        let p = pos + 16;
        if (p + count * 4 > pos + size) return false;
        for (let i = 0; i < count; i++, p += 4) {
          const shifted = moov.getUint32(p) + delta;
          if (shifted > UINT32_MAX) return false;
          moov.setUint32(p, shifted);
        }
      } else if (type === "co64") {
        const count = moov.getUint32(pos + 12);
        let p = pos + 16;
        if (p + count * 8 > pos + size) return false;
        for (let i = 0; i < count; i++, p += 8) {
          moov.setBigUint64(p, moov.getBigUint64(p) + BigInt(delta));
        }
      }
      pos += size;
    }
    return true;
  };
  return walk(8, moov.byteLength);
}

export async function ensureFaststart(file: File): Promise<File> {
  try {
    if (file.size < 32) return file;
    const boxes = await readTopLevelBoxes(file);
    if (!boxes || boxes[0].type !== "ftyp") return file;

    const moovIndex = boxes.findIndex((b) => b.type === "moov");
    const mdatIndex = boxes.findIndex((b) => b.type === "mdat");
    if (moovIndex === -1 || mdatIndex === -1) return file;
    if (boxes.some((b) => b.type === "moof")) return file; // fragmented MP4: no single index to move
    if (moovIndex < mdatIndex) return file; // already fast-start

    const moov = boxes[moovIndex];
    if (moov.size > MAX_MOOV_BYTES) return file;
    const moovBytes = new Uint8Array(await file.slice(moov.start, moov.start + moov.size).arrayBuffer());
    const view = new DataView(moovBytes.buffer);
    // The index moves in front of everything that currently sits between ftyp and the old
    // index, so every absolute chunk offset shifts by exactly the size of the index.
    if (!shiftChunkOffsets(view, moov.size)) return file;

    const ftypEnd = boxes[0].start + boxes[0].size;
    const parts: BlobPart[] = [
      file.slice(0, ftypEnd),
      moovBytes,
      file.slice(ftypEnd, moov.start),
      file.slice(moov.start + moov.size),
    ];
    const rewritten = new File(parts, file.name, { type: file.type, lastModified: file.lastModified });
    return rewritten.size === file.size ? rewritten : file;
  } catch {
    return file;
  }
}
