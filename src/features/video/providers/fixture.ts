/**
 * Offline MP4 Test Fixtures & Binary Validator.
 *
 * Provides two deterministic test fixtures:
 *
 * 1. STRUCTURAL FIXTURE (`MOCK_MP4_STRUCTURAL_FIXTURE_BUFFER` / `MOCK_MP4_FIXTURE_BUFFER`, 631 bytes):
 *    - Syntactically conforming ISOBMFF MP4 container conforming to ISO/IEC 14496-12/14.
 *    - Contains 'ftyp', 'moov' (with mvhd, trak, tkhd, mdia, mdhd, hdlr, minf, vmhd, dinf, stbl), and 'mdat'.
 *    - Defines track dimensions (1280x720, 5.0s, 16fps container header).
 *    - NOT decodable by video renderers: does not contain H.264 avcC decoder configuration or macroblock frames.
 *    - Retained for fast, ultra-compact unit tests and box parser validation.
 *
 * 2. PLAYABLE FIXTURE (`MOCK_MP4_PLAYABLE_FIXTURE_BUFFER`, 19,190 bytes):
 *    - Genuinely decodable and playable H.264 MP4 video container.
 *    - Baseline Profile Level 1.0, SQCIF 128x96, 1.0s duration at 1000 timescale.
 *    - Contains authentic 'avcC' box with SPS and PPS parameter sets in sample description.
 *    - Contains valid H.264 IDR slice with uncompressed I_PCM luma/chroma macroblocks in 'mdat'.
 *    - Fully decodable and playable in HTML5 <video>, Chromium, and Windows Media Foundation.
 *    - Provided for video player rendering, browser testing, and storage integration workflows.
 */

function buildBox(type: string, ...payloads: Buffer[]): Buffer {
  const payload = Buffer.concat(payloads);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, 4, "ascii");
  return Buffer.concat([header, payload]);
}

function buildFullBox(
  type: string,
  version: number,
  flags: number,
  ...payloads: Buffer[]
): Buffer {
  const vf = Buffer.alloc(4);
  vf.writeUInt8(version, 0);
  vf.writeUIntBE(flags, 1, 3);
  return buildBox(type, vf, ...payloads);
}

// ---------------------------------------------------------------------------
// 1. Structural MP4 Container Generator (631 bytes)
// ---------------------------------------------------------------------------
/**
 * Constructs a structurally valid 1280x720 5-second MP4 container.
 * Lacks H.264 avcC configuration records; suitable for container parsing tests only.
 */
export function createMockMp4Buffer(params?: {
  width?: number;
  height?: number;
  durationSeconds?: number;
}): Buffer {
  const width = params?.width ?? 1280;
  const height = params?.height ?? 720;
  const durationSec = params?.durationSeconds ?? 5;
  const timescale = 1000;
  const durationUnits = durationSec * timescale;

  // 1. ftyp box
  const ftyp = buildBox(
    "ftyp",
    Buffer.from("isom", "ascii"),
    Buffer.from([0, 0, 0x02, 0]),
    Buffer.from("isomiso2mp41", "ascii")
  );

  // 2. mvhd box (Movie Header)
  const mvhdPayload = Buffer.alloc(96);
  mvhdPayload.writeUInt32BE(timescale, 8);
  mvhdPayload.writeUInt32BE(durationUnits, 12);
  mvhdPayload.writeInt32BE(0x00010000, 16);
  mvhdPayload.writeInt16BE(0x0100, 20);
  mvhdPayload.writeInt32BE(0x00010000, 32);
  mvhdPayload.writeInt32BE(0x00010000, 48);
  mvhdPayload.writeInt32BE(0x40000000, 68);
  mvhdPayload.writeUInt32BE(2, 92);
  const mvhd = buildFullBox("mvhd", 0, 0, mvhdPayload);

  // 3. trak / tkhd (Track Header)
  const tkhdPayload = Buffer.alloc(80);
  tkhdPayload.writeUInt32BE(1, 12);
  tkhdPayload.writeUInt32BE(durationUnits, 20);
  tkhdPayload.writeInt32BE(0x00010000, 36);
  tkhdPayload.writeInt32BE(0x00010000, 52);
  tkhdPayload.writeInt32BE(0x40000000, 72);
  const tkhdDimensions = Buffer.alloc(8);
  tkhdDimensions.writeUInt32BE(width << 16, 0);
  tkhdDimensions.writeUInt32BE(height << 16, 4);
  const tkhd = buildFullBox("tkhd", 0, 3, tkhdPayload, tkhdDimensions);

  // mdia / mdhd (Media Header)
  const mdhdPayload = Buffer.alloc(20);
  mdhdPayload.writeUInt32BE(timescale, 8);
  mdhdPayload.writeUInt32BE(durationUnits, 12);
  mdhdPayload.writeUInt16BE(0x55c4, 16);
  const mdhd = buildFullBox("mdhd", 0, 0, mdhdPayload);

  // hdlr (Handler Reference)
  const hdlrPayload = Buffer.alloc(20);
  hdlrPayload.write("vide", 4, 4, "ascii");
  const hdlr = buildFullBox("hdlr", 0, 0, hdlrPayload, Buffer.from("VideoHandler\0", "ascii"));

  // minf (Media Information)
  const vmhd = buildFullBox("vmhd", 0, 1, Buffer.alloc(8));
  const urlBox = buildFullBox("url ", 0, 1);
  const dref = buildFullBox("dref", 0, 0, Buffer.from([0, 0, 0, 1]), urlBox);
  const dinf = buildBox("dinf", dref);

  // stbl (Sample Table)
  const avc1Payload = Buffer.alloc(78);
  avc1Payload.writeUInt16BE(width, 24);
  avc1Payload.writeUInt16BE(height, 26);
  avc1Payload.writeUInt32BE(0x00480000, 28);
  avc1Payload.writeUInt32BE(0x00480000, 32);
  avc1Payload.writeUInt16BE(1, 40);
  // Offset 74 is depth: 0x0018 specifies standard 24-bit RGB/YUV color depth (bpp), not frame rate
  avc1Payload.writeUInt16BE(24, 74);
  const avc1 = buildBox("avc1", Buffer.alloc(6), Buffer.from([0, 1]), avc1Payload);
  const stsd = buildFullBox("stsd", 0, 0, Buffer.from([0, 0, 0, 1]), avc1);

  const stts = buildFullBox("stts", 0, 0, Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0x13, 0x88]));
  const stsc = buildFullBox("stsc", 0, 0, Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]));
  const stsz = buildFullBox("stsz", 0, 0, Buffer.from([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 8]));
  const stco = buildFullBox("stco", 0, 0, Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]));

  const stbl = buildBox("stbl", stsd, stts, stsc, stsz, stco);
  const minf = buildBox("minf", vmhd, dinf, stbl);
  const mdia = buildBox("mdia", mdhd, hdlr, minf);
  const trak = buildBox("trak", tkhd, mdia);
  const moov = buildBox("moov", mvhd, trak);

  // mdat box with small NAL payload placeholder
  const mdat = buildBox("mdat", Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f]));

  return Buffer.concat([ftyp, moov, mdat]);
}

/** Pre-built standard 1280x720 5s structural MP4 fixture buffer. */
export const MOCK_MP4_STRUCTURAL_FIXTURE_BUFFER: Buffer = createMockMp4Buffer();
export const MOCK_MP4_FIXTURE_BUFFER: Buffer = MOCK_MP4_STRUCTURAL_FIXTURE_BUFFER;
export const MOCK_MP4_BASE64: string = MOCK_MP4_FIXTURE_BUFFER.toString("base64");
export const MOCK_MP4_DATA_URI = `data:video/mp4;base64,${MOCK_MP4_BASE64}`;

// ---------------------------------------------------------------------------
// 2. Playable H.264 MP4 Container Generator (19,190 bytes)
// ---------------------------------------------------------------------------
/**
 * Constructs a fully decodable and playable H.264 MP4 container.
 * Features Baseline Profile SQCIF (128x96) with genuine SPS, PPS, avcC box,
 * and valid uncompressed I_PCM IDR slice.
 */
export function createPlayableMp4Buffer(): Buffer {
  const width = 128;
  const height = 96;
  const numMBs = (width / 16) * (height / 16); // 48 macroblocks
  const timescale = 1000;
  const durationMs = 1000; // 1.0 second

  // H.264 Baseline parameters for 128x96
  const sps = Buffer.from([0x67, 0x42, 0x00, 0x0a, 0xf8, 0x41, 0xa2]);
  const pps = Buffer.from([0x68, 0xce, 0x38, 0x80]);
  const sliceHeader = Buffer.from([0x05, 0x88, 0x84, 0x21, 0xa0]);
  const mbHeader = Buffer.from([0x0d, 0x00]);

  // Construct IDR frame payload (all-I uncompressed macroblocks)
  const mbBuffers: Buffer[] = [];
  const yData = Buffer.alloc(256, 0x10); // black
  const uvData = Buffer.alloc(64, 0x80); // neutral chroma

  for (let i = 0; i < numMBs; i++) {
    mbBuffers.push(mbHeader, yData, uvData, uvData);
  }
  const idrSlice = Buffer.concat([sliceHeader, ...mbBuffers]);

  // avcC Box (AVC Configuration Record)
  const avcCPayload = Buffer.alloc(11 + sps.length + pps.length);
  let p = 0;
  avcCPayload.writeUInt8(1, p++); // configurationVersion
  avcCPayload.writeUInt8(0x42, p++); // AVCProfileIndication (Baseline)
  avcCPayload.writeUInt8(0x00, p++); // profile_compatibility
  avcCPayload.writeUInt8(0x0a, p++); // AVCLevelIndication (1.0)
  avcCPayload.writeUInt8(0xff, p++); // lengthSizeMinusOne (4 bytes)
  avcCPayload.writeUInt8(0xe1, p++); // numOfSequenceParameterSets (1)
  avcCPayload.writeUInt16BE(sps.length, p); p += 2;
  sps.copy(avcCPayload, p); p += sps.length;
  avcCPayload.writeUInt8(1, p++); // numOfPictureParameterSets (1)
  avcCPayload.writeUInt16BE(pps.length, p); p += 2;
  pps.copy(avcCPayload, p); p += pps.length;

  const avcC = buildBox("avcC", avcCPayload);

  // ftyp Box
  const ftyp = buildBox(
    "ftyp",
    Buffer.from("isom", "ascii"),
    Buffer.from([0, 0, 0x02, 0]),
    Buffer.from("isomiso2avc1mp41", "ascii")
  );

  // mdat Box
  const nalPrefix = Buffer.alloc(4);
  nalPrefix.writeUInt32BE(idrSlice.length, 0);
  const mdat = buildBox("mdat", nalPrefix, idrSlice);

  // moov Box components
  const mvhdPayload = Buffer.alloc(96);
  mvhdPayload.writeUInt32BE(timescale, 8);
  mvhdPayload.writeUInt32BE(durationMs, 12);
  mvhdPayload.writeInt32BE(0x00010000, 16);
  mvhdPayload.writeInt16BE(0x0100, 20);
  mvhdPayload.writeInt32BE(0x00010000, 32);
  mvhdPayload.writeInt32BE(0x00010000, 48);
  mvhdPayload.writeInt32BE(0x40000000, 68);
  mvhdPayload.writeUInt32BE(2, 92);
  const mvhd = buildFullBox("mvhd", 0, 0, mvhdPayload);

  const tkhdPayload = Buffer.alloc(80);
  tkhdPayload.writeUInt32BE(1, 12);
  tkhdPayload.writeUInt32BE(durationMs, 20);
  tkhdPayload.writeInt32BE(0x00010000, 36);
  tkhdPayload.writeInt32BE(0x00010000, 52);
  tkhdPayload.writeInt32BE(0x40000000, 72);
  const tkhdDimensions = Buffer.alloc(8);
  tkhdDimensions.writeUInt32BE(width << 16, 0);
  tkhdDimensions.writeUInt32BE(height << 16, 4);
  const tkhd = buildFullBox("tkhd", 0, 3, tkhdPayload, tkhdDimensions);

  const mdhdPayload = Buffer.alloc(20);
  mdhdPayload.writeUInt32BE(timescale, 8);
  mdhdPayload.writeUInt32BE(durationMs, 12);
  mdhdPayload.writeUInt16BE(0x55c4, 16);
  const mdhd = buildFullBox("mdhd", 0, 0, mdhdPayload);

  const hdlrPayload = Buffer.alloc(20);
  hdlrPayload.write("vide", 4, 4, "ascii");
  const hdlr = buildFullBox("hdlr", 0, 0, hdlrPayload, Buffer.from("VideoHandler\0", "ascii"));

  const vmhd = buildFullBox("vmhd", 0, 1, Buffer.alloc(8));
  const urlBox = buildFullBox("url ", 0, 1);
  const dref = buildFullBox("dref", 0, 0, Buffer.from([0, 0, 0, 1]), urlBox);
  const dinf = buildBox("dinf", dref);

  const avc1Payload = Buffer.alloc(78);
  avc1Payload.writeUInt16BE(width, 24);
  avc1Payload.writeUInt16BE(height, 26);
  avc1Payload.writeUInt32BE(0x00480000, 28);
  avc1Payload.writeUInt32BE(0x00480000, 32);
  avc1Payload.writeUInt16BE(1, 40);
  // Offset 74 is depth: 0x0018 specifies standard 24-bit RGB/YUV color depth (bpp), not frame rate
  avc1Payload.writeUInt16BE(24, 74);
  avc1Payload.writeInt16BE(-1, 76);
  const avc1 = buildBox("avc1", Buffer.alloc(6), Buffer.from([0, 1]), avc1Payload, avcC);
  const stsd = buildFullBox("stsd", 0, 0, Buffer.from([0, 0, 0, 1]), avc1);

  const stts = buildFullBox("stts", 0, 0, Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0x03, 0xe8]));
  const stsc = buildFullBox("stsc", 0, 0, Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]));

  const sampleSize = 4 + idrSlice.length;
  const stszPayload = Buffer.alloc(8);
  stszPayload.writeUInt32BE(sampleSize, 0);
  stszPayload.writeUInt32BE(1, 4);
  const stsz = buildFullBox("stsz", 0, 0, stszPayload);

  // Compute exact chunk offset pointing into mdat
  const dummyStco = buildFullBox("stco", 0, 0, Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]));
  const stblPre = buildBox("stbl", stsd, stts, stsc, stsz, dummyStco);
  const minfPre = buildBox("minf", vmhd, dinf, stblPre);
  const mdiaPre = buildBox("mdia", mdhd, hdlr, minfPre);
  const trakPre = buildBox("trak", tkhd, mdiaPre);
  const moovPre = buildBox("moov", mvhd, trakPre);

  const sampleOffset = ftyp.length + moovPre.length + 8; // ftyp + moov + mdat_header(8)

  const realStcoPayload = Buffer.alloc(8);
  realStcoPayload.writeUInt32BE(1, 0);
  realStcoPayload.writeUInt32BE(sampleOffset, 4);
  const realStco = buildFullBox("stco", 0, 0, realStcoPayload);

  const stbl = buildBox("stbl", stsd, stts, stsc, stsz, realStco);
  const minf = buildBox("minf", vmhd, dinf, stbl);
  const mdia = buildBox("mdia", mdhd, hdlr, minf);
  const trak = buildBox("trak", tkhd, mdia);
  const moov = buildBox("moov", mvhd, trak);

  return Buffer.concat([ftyp, moov, mdat]);
}

/** Pre-built genuinely playable H.264 MP4 fixture buffer (19,190 bytes). */
export const MOCK_MP4_PLAYABLE_FIXTURE_BUFFER: Buffer = createPlayableMp4Buffer();
export const MOCK_MP4_PLAYABLE_BASE64: string = MOCK_MP4_PLAYABLE_FIXTURE_BUFFER.toString("base64");
export const MOCK_MP4_PLAYABLE_DATA_URI = `data:video/mp4;base64,${MOCK_MP4_PLAYABLE_BASE64}`;

// ---------------------------------------------------------------------------
// 3. Binary Box Inspector
// ---------------------------------------------------------------------------
export interface Mp4Box {
  type: string;
  size: number;
  offset: number;
}

export interface Mp4InspectionResult {
  isValid: boolean;
  isPlayableH264: boolean;
  totalBytes: number;
  boxes: Mp4Box[];
  hasFtyp: boolean;
  hasMoov: boolean;
  hasMdat: boolean;
  hasAvcC: boolean;
  error?: string;
}

/**
 * Validates whether a buffer is a valid ISOBMFF MP4 container and checks
 * whether it contains the H.264 avcC box required for real video decoding.
 */
export function inspectMp4Buffer(buffer: Buffer): Mp4InspectionResult {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) {
    return {
      isValid: false,
      isPlayableH264: false,
      totalBytes: buffer?.length ?? 0,
      boxes: [],
      hasFtyp: false,
      hasMoov: false,
      hasMdat: false,
      hasAvcC: false,
      error: "Buffer is too small to be a valid MP4 container.",
    };
  }

  const boxes: Mp4Box[] = [];
  let offset = 0;
  let hasFtyp = false;
  let hasMoov = false;
  let hasMdat = false;

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) {
      return {
        isValid: false,
        isPlayableH264: false,
        totalBytes: buffer.length,
        boxes,
        hasFtyp,
        hasMoov,
        hasMdat,
        hasAvcC: false,
        error: "Truncated box header in MP4 container.",
      };
    }

    const size = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);

    if (size < 8 && size !== 0) {
      return {
        isValid: false,
        isPlayableH264: false,
        totalBytes: buffer.length,
        boxes,
        hasFtyp,
        hasMoov,
        hasMdat,
        hasAvcC: false,
        error: `Invalid box size ${size} for box '${type}'.`,
      };
    }

    const boxSize = size === 0 ? buffer.length - offset : size;
    boxes.push({ type, size: boxSize, offset });

    if (type === "ftyp") hasFtyp = true;
    if (type === "moov") hasMoov = true;
    if (type === "mdat") hasMdat = true;

    offset += boxSize;
  }

  const isValid = hasFtyp && hasMoov && boxes[0]?.type === "ftyp";

  // Check for presence of 'avcC' atom inside container (indicates decodable H.264 stream)
  const hasAvcC = buffer.includes(Buffer.from("avcC", "ascii"));
  const isPlayableH264 = isValid && hasAvcC && hasMdat;

  return {
    isValid,
    isPlayableH264,
    totalBytes: buffer.length,
    boxes,
    hasFtyp,
    hasMoov,
    hasMdat,
    hasAvcC,
    error: isValid ? undefined : "Container missing mandatory ftyp or moov box.",
  };
}
