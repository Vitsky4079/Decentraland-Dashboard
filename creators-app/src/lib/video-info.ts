import { boxEnd, child, children, fourcc, readTopLevelBoxes } from "./faststart";

// Reads codec, bit depth and resolution of the first video track of an MP4/MOV from its
// `moov` index, without reading any media data. Returns null for anything it can't parse.
//
// Why bit depth: in testing, the Explorer's video player plays 8-bit H.264 (including 4K) and
// 8-bit HEVC, but does not play 10-bit HEVC (Main 10).

export type VideoInfo = { codec: string; bitDepth: number; width: number; height: number };

const MAX_MOOV_BYTES = 64 * 1024 * 1024;
const VISUAL_ENTRY_HEADER = 8 + 78; // box header + VisualSampleEntry fields before child boxes

function avcBitDepth(view: DataView, start: number, end: number): number {
  // avcC: version, profile, compat, level, lengthSize, numSPS, SPS..., numPPS, PPS..., [extension]
  const profile = view.getUint8(start + 8 + 1);
  let p = start + 8 + 5;
  const numSps = view.getUint8(p) & 0x1f;
  p += 1;
  for (let i = 0; i < numSps; i++) p += 2 + view.getUint16(p);
  const numPps = view.getUint8(p);
  p += 1;
  for (let i = 0; i < numPps; i++) p += 2 + view.getUint16(p);
  const hasExtension = profile === 100 || profile === 110 || profile === 122 || profile === 144;
  if (hasExtension && p + 3 <= end) return (view.getUint8(p + 1) & 0x7) + 8;
  return 8;
}

export async function readVideoInfo(file: Blob): Promise<VideoInfo | null> {
  try {
    const boxes = await readTopLevelBoxes(file);
    if (!boxes || boxes[0]?.type !== "ftyp") return null;
    const moov = boxes.find((b) => b.type === "moov");
    if (!moov || moov.size > MAX_MOOV_BYTES) return null;

    const view = new DataView(await file.slice(moov.start, moov.start + moov.size).arrayBuffer());
    for (const trak of children(view, 8, view.byteLength, "trak")) {
      const mdia = child(view, trak + 8, boxEnd(view, trak), "mdia");
      const hdlr = child(view, mdia + 8, boxEnd(view, mdia), "hdlr");
      if (fourcc(view, hdlr + 16) !== "vide") continue;

      const minf = child(view, mdia + 8, boxEnd(view, mdia), "minf");
      const stbl = child(view, minf + 8, boxEnd(view, minf), "stbl");
      const stsd = child(view, stbl + 8, boxEnd(view, stbl), "stsd");
      const entry = stsd + 16;
      const entryEnd = entry + view.getUint32(entry);
      const type = fourcc(view, entry + 4);
      const width = view.getUint16(entry + 8 + 24);
      const height = view.getUint16(entry + 8 + 26);

      let codec = type;
      let bitDepth = 8;
      if (type === "hvc1" || type === "hev1") {
        codec = "hevc";
        const hvcC = child(view, entry + VISUAL_ENTRY_HEADER, entryEnd, "hvcC");
        bitDepth = (view.getUint8(hvcC + 8 + 17) & 0x7) + 8;
      } else if (type === "avc1" || type === "avc3") {
        codec = "h264";
        bitDepth = avcBitDepth(view, child(view, entry + VISUAL_ENTRY_HEADER, entryEnd, "avcC"), entryEnd);
      }
      return { codec, bitDepth, width, height };
    }
    return null;
  } catch {
    return null;
  }
}
