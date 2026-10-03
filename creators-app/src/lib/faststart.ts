// Makes an MP4/MOV safe to stream over HTTP, losslessly and without re-encoding:
//   1. the `moov` index goes in front of the `mdat` data, and
//   2. audio and video chunks are re-ordered by timestamp (interleaved).
//
// Both matter. Large files with `moov` at the end, or with audio stored far ahead of video
// (the file we debugged had audio ~19 s ahead of its video), play ~15 s in the Explorer's
// video player and then freeze with the audio dropping. Moving only the index was not enough;
// the same file re-muxed by ffmpeg (index first AND interleaved) plays fine.
//
// The new file is a lazy Blob of slices of the original: the media data is never read into
// memory. Only the small `moov` box (typically well under 5 MB) is parsed and its chunk
// offsets rewritten. Sample tables other than the chunk offsets are untouched, because chunks
// are moved whole. Anything unusual (fragmented MP4, extra top-level boxes, inconsistent
// tables, files whose 32-bit offsets would overflow, parse errors) returns the original file.

const MAX_MOOV_BYTES = 64 * 1024 * 1024;
const MAX_TOP_LEVEL_BOXES = 64;
const UINT32_MAX = 0xffffffff;
// A file that already has the index first and keeps audio/video within this many seconds of
// each other is left exactly as it is.
const ACCEPTABLE_SKEW_SEC = 1.5;
const IGNORABLE_BOXES = new Set(["free", "skip", "wide"]);

type Box = { type: string; start: number; size: number };

type Chunk = { track: number; index: number; start: number; length: number; time: number };

type TrackTables = {
  stcoPos: number; // position of the stco/co64 box in the moov buffer
  is64: boolean;
  chunkCount: number;
};

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

// Child box positions of type `type` inside [start, end).
function children(view: DataView, start: number, end: number, type: string): number[] {
  const out: number[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    const size = view.getUint32(pos);
    if (size < 8 || pos + size > end) throw new Error("bad box");
    if (fourcc(view, pos + 4) === type) out.push(pos);
    pos += size;
  }
  return out;
}

function child(view: DataView, start: number, end: number, type: string): number {
  const found = children(view, start, end, type);
  if (found.length !== 1) throw new Error(`expected one ${type}`);
  return found[0];
}

function boxEnd(view: DataView, pos: number): number {
  return pos + view.getUint32(pos);
}

// Reads every chunk of every track out of the moov buffer.
function readChunks(view: DataView): { chunks: Chunk[]; tracks: TrackTables[] } {
  const chunks: Chunk[] = [];
  const tracks: TrackTables[] = [];
  const traks = children(view, 8, view.byteLength, "trak");
  if (traks.length === 0) throw new Error("no tracks");

  traks.forEach((trak, trackIndex) => {
    const mdia = child(view, trak + 8, boxEnd(view, trak), "mdia");
    const mdhd = child(view, mdia + 8, boxEnd(view, mdia), "mdhd");
    const timescale = view.getUint8(mdhd + 8) === 1 ? view.getUint32(mdhd + 28) : view.getUint32(mdhd + 20);
    if (!timescale) throw new Error("bad timescale");
    const minf = child(view, mdia + 8, boxEnd(view, mdia), "minf");
    const stbl = child(view, minf + 8, boxEnd(view, minf), "stbl");
    const sEnd = boxEnd(view, stbl);

    // sample sizes
    const stsz = child(view, stbl + 8, sEnd, "stsz");
    const fixedSize = view.getUint32(stsz + 12);
    const sampleCount = view.getUint32(stsz + 16);
    const prefix = new Float64Array(sampleCount + 1);
    for (let i = 0; i < sampleCount; i++) {
      prefix[i + 1] = prefix[i] + (fixedSize || view.getUint32(stsz + 20 + i * 4));
    }

    // decode times of each sample
    const stts = child(view, stbl + 8, sEnd, "stts");
    const sttsCount = view.getUint32(stts + 12);
    const dts = new Float64Array(sampleCount + 1);
    let s = 0;
    let t = 0;
    for (let i = 0; i < sttsCount; i++) {
      const count = view.getUint32(stts + 16 + i * 8);
      const delta = view.getUint32(stts + 20 + i * 8);
      for (let j = 0; j < count && s < sampleCount; j++, s++) {
        dts[s] = t;
        t += delta;
      }
    }
    if (s !== sampleCount) throw new Error("stts/stsz mismatch");

    // chunk offsets
    const stcoList = children(view, stbl + 8, sEnd, "stco");
    const co64List = children(view, stbl + 8, sEnd, "co64");
    if (stcoList.length + co64List.length !== 1) throw new Error("expected one chunk offset table");
    const is64 = co64List.length === 1;
    const stcoPos = is64 ? co64List[0] : stcoList[0];
    const chunkCount = view.getUint32(stcoPos + 12);
    const offsetAt = (i: number) =>
      is64 ? Number(view.getBigUint64(stcoPos + 16 + i * 8)) : view.getUint32(stcoPos + 16 + i * 4);
    tracks.push({ stcoPos, is64, chunkCount });

    // sample -> chunk mapping
    const stsc = child(view, stbl + 8, sEnd, "stsc");
    const entryCount = view.getUint32(stsc + 12);
    let sampleIndex = 0;
    for (let e = 0; e < entryCount; e++) {
      const firstChunk = view.getUint32(stsc + 16 + e * 12);
      const perChunk = view.getUint32(stsc + 20 + e * 12);
      const nextFirst = e + 1 < entryCount ? view.getUint32(stsc + 16 + (e + 1) * 12) : chunkCount + 1;
      for (let c = firstChunk; c < nextFirst; c++) {
        const lastSample = sampleIndex + perChunk;
        if (c < 1 || c > chunkCount || lastSample > sampleCount) throw new Error("bad stsc");
        chunks.push({
          track: trackIndex,
          index: c - 1,
          start: offsetAt(c - 1),
          length: prefix[lastSample] - prefix[sampleIndex],
          time: dts[sampleIndex] / timescale,
        });
        sampleIndex = lastSample;
      }
    }
    if (sampleIndex !== sampleCount) throw new Error("stsc does not cover all samples");
  });
  return { chunks, tracks };
}

// Largest amount of time, in seconds, by which a chunk is stored earlier in the file than
// chunks that play before it (i.e. how far audio/video are out of step on disk).
function interleaveSkew(chunks: Chunk[]): number {
  const byOffset = [...chunks].sort((a, b) => a.start - b.start);
  const suffixMin = new Float64Array(byOffset.length + 1);
  suffixMin[byOffset.length] = Infinity;
  for (let i = byOffset.length - 1; i >= 0; i--) suffixMin[i] = Math.min(byOffset[i].time, suffixMin[i + 1]);
  let worst = 0;
  for (let i = 0; i < byOffset.length; i++) worst = Math.max(worst, byOffset[i].time - suffixMin[i]);
  return worst;
}

export async function prepareVideoForStreaming(file: File): Promise<File> {
  try {
    if (file.size < 32) return file;
    const boxes = await readTopLevelBoxes(file);
    if (!boxes || boxes[0].type !== "ftyp") return file;

    const moovBoxes = boxes.filter((b) => b.type === "moov");
    const mdatBoxes = boxes.filter((b) => b.type === "mdat");
    if (moovBoxes.length !== 1 || mdatBoxes.length !== 1) return file;
    if (boxes.some((b) => !["ftyp", "moov", "mdat"].includes(b.type) && !IGNORABLE_BOXES.has(b.type))) return file;

    const moov = moovBoxes[0];
    const mdat = mdatBoxes[0];
    if (moov.size > MAX_MOOV_BYTES) return file;

    const moovBytes = new Uint8Array(await file.slice(moov.start, moov.start + moov.size).arrayBuffer());
    const view = new DataView(moovBytes.buffer);
    const { chunks, tracks } = readChunks(view);

    // Every chunk must sit inside the mdat payload and no two may overlap.
    const payloadStart = mdat.start + (await mdatHeaderSize(file, mdat));
    const payloadEnd = mdat.start + mdat.size;
    const byOffset = [...chunks].sort((a, b) => a.start - b.start);
    let cursor = payloadStart;
    for (const c of byOffset) {
      if (c.length <= 0 || c.start < cursor || c.start + c.length > payloadEnd) return file;
      cursor = c.start + c.length;
    }

    const moovFirst = moov.start < mdat.start;
    if (moovFirst && interleaveSkew(chunks) <= ACCEPTABLE_SKEW_SEC) return file;

    // New layout: ftyp, moov, mdat header, then every chunk ordered by playback time.
    const ordered = [...chunks].sort((a, b) => a.time - b.time || a.track - b.track || a.index - b.index);
    const payload = ordered.reduce((sum, c) => sum + c.length, 0);
    const largeHeader = payload + 8 > UINT32_MAX;
    const newHeaderSize = largeHeader ? 16 : 8;
    const ftypEnd = boxes[0].start + boxes[0].size;
    const newPayloadStart = ftypEnd + moov.size + newHeaderSize;

    const newOffsets: number[][] = tracks.map((t) => new Array<number>(t.chunkCount).fill(-1));
    let pos = newPayloadStart;
    for (const c of ordered) {
      newOffsets[c.track][c.index] = pos;
      pos += c.length;
    }
    for (let ti = 0; ti < tracks.length; ti++) {
      const t = tracks[ti];
      for (let i = 0; i < t.chunkCount; i++) {
        const off = newOffsets[ti][i];
        if (off < 0) return file;
        if (t.is64) view.setBigUint64(t.stcoPos + 16 + i * 8, BigInt(off));
        else if (off > UINT32_MAX) return file;
        else view.setUint32(t.stcoPos + 16 + i * 4, off);
      }
    }

    const header = new Uint8Array(newHeaderSize);
    const hv = new DataView(header.buffer);
    if (largeHeader) {
      hv.setUint32(0, 1);
      header.set([0x6d, 0x64, 0x61, 0x74], 4); // "mdat"
      hv.setBigUint64(8, BigInt(payload + 16));
    } else {
      hv.setUint32(0, payload + 8);
      header.set([0x6d, 0x64, 0x61, 0x74], 4);
    }

    const parts: BlobPart[] = [file.slice(0, ftypEnd), moovBytes, header];
    // Merge neighbours that are also adjacent in the original so the Blob has fewer parts.
    let runStart = ordered[0].start;
    let runEnd = runStart + ordered[0].length;
    for (let i = 1; i < ordered.length; i++) {
      const c = ordered[i];
      if (c.start === runEnd) {
        runEnd += c.length;
      } else {
        parts.push(file.slice(runStart, runEnd));
        runStart = c.start;
        runEnd = c.start + c.length;
      }
    }
    parts.push(file.slice(runStart, runEnd));

    return new File(parts, file.name, { type: file.type, lastModified: file.lastModified });
  } catch {
    return file;
  }
}

async function mdatHeaderSize(file: Blob, mdat: Box): Promise<number> {
  const head = new DataView(await file.slice(mdat.start, mdat.start + 8).arrayBuffer());
  return head.getUint32(0) === 1 ? 16 : 8;
}
