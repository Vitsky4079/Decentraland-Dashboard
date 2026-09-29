// Minimal magic-byte sniffer for exactly the formats this platform accepts (see
// media-types.ts). Deliberately not a general-purpose file-type library -- a small,
// auditable check for a small, fixed set of formats is easier to trust than a big
// dependency for this one job. Never trust a client's declared Content-Type/extension;
// this looks at the actual bytes.

function bytesEqual(buf: Uint8Array, offset: number, expected: number[]): boolean {
  if (buf.length < offset + expected.length) return false;
  return expected.every((b, i) => buf[offset + i] === b);
}

function ascii(buf: Uint8Array, offset: number, len: number): string {
  return Array.from(buf.slice(offset, offset + len))
    .map((b) => String.fromCharCode(b))
    .join("");
}

export function sniffMime(buf: Uint8Array): string | null {
  if (bytesEqual(buf, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytesEqual(buf, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 4) === "WEBP") return "image/webp";
  if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 4) === "WAVE") return "audio/wav";
  if (ascii(buf, 0, 3) === "ID3") return "audio/mpeg";
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "audio/mpeg";
  if (ascii(buf, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(buf, 4, 4) === "ftyp") return "video/mp4";
  if (bytesEqual(buf, 0, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  return null;
}
