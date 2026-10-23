const { messageError, validationLabel } = require('./localization.cjs');
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const MAX_CHUNK_BYTES = 256 * 1024,
  MAX_FRAME_BYTES = 256 * 1024 * 1024,
  MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;
const FORMATS = Object.freeze({
  webm: {defaultCodec:"vp9",codecs:["vp9"],muxer:"webm",mimeType:"video/webm",extension:"webm"},
  mp4: {
    defaultCodec: "h264",
    codecs: ["h264", "mpeg4"],
    muxer: "mp4",
    mimeType: "video/mp4",
    extension: "mp4",
  },
  avi: {
    defaultCodec: "mpeg4",
    codecs: ["mpeg4", "ffv1", "rawvideo"],
    muxer: "avi",
    mimeType: "video/x-msvideo",
    extension: "avi",
  },
  wmv: {
    defaultCodec: "wmv2",
    codecs: ["wmv2"],
    muxer: "asf",
    mimeType: "video/x-ms-wmv",
    extension: "wmv",
  },
});
const CODECS = Object.freeze({
  vp9: {encoder:"libvpx-vp9",label:"VP9 with transparency",displayName:"VP9",pixelFormat:"yuva420p",quality:true,lossless:false,alpha:true},
  h264: {
    encoder: "libx264",
    label: "H.264",
    pixelFormat: "yuv420p",
    quality: true,
    lossless: false,
  },
  mpeg4: {
    encoder: "mpeg4",
    label: "MPEG-4 Part 2",
    pixelFormat: "yuv420p",
    quality: true,
    lossless: false,
  },
  wmv2: {
    encoder: "wmv2",
    label: "Windows Media Video 8",
    pixelFormat: "yuv420p",
    quality: true,
    lossless: false,
  },
  ffv1: {
    encoder: "ffv1",
    label: "FFV1 (lossless)",
    displayName: "FFV1",
    pixelFormat: "bgr0",
    quality: false,
    lossless: true,
  },
  rawvideo: {
    encoder: "rawvideo",
    label: "Uncompressed RGB", labelKey: "desktop.videoExportService.uncompressedRgb",
    pixelFormat: "bgr24",
    quality: false,
    lossless: true,
  },
});

function codecDimensions(codec, width, height) {
  const pad = CODECS[codec].pixelFormat === "yuv420p";
  const padRight = pad && width % 2,
    padBottom = pad && height % 2;
  return {
    encodedWidth: width + Number(padRight),
    encodedHeight: height + Number(padBottom),
    noticeKey: padRight || padBottom ? "desktop.videoExportService.edgeNotice" : undefined,
    noticeParams: {edge: {messageKey: padRight && padBottom ? "desktop.videoExportService.edge.both" : padRight ? "desktop.videoExportService.edge.right" : "desktop.videoExportService.edge.bottom"}, width: {format:'number',value:width+Number(padRight),options:{useGrouping:false}}, height:{format:'number',value:height+Number(padBottom),options:{useGrouping:false}}},
    notice:
      padRight || padBottom
        ? `Video will include a one-pixel black edge on the ${padRight && padBottom ? "right and bottom" : padRight ? "right" : "bottom"} (${width + Number(padRight)}×${height + Number(padBottom)}).`
        : null,
  };
}
const aborted = () =>
  Object.assign(messageError(new Error(''), 'desktop.videoExportService.errors.videoExportCancelled', {}), { name: "AbortError" });
const integer = (value, min, max, name) => {
  if (!Number.isInteger(value) || value < min || value > max)
    throw messageError(new Error(''), 'desktop.videoExportService.errors.nameMustBeAnIntegerBetweenMinAndMax', {name: validationLabel(name), min: min, max: max});
  return value;
};
const finite = (value, min, max, name) => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw messageError(new Error(''), 'desktop.videoExportService.errors.nameMustBeBetweenMinAndMax', {name: validationLabel(name), min: min, max: max});
  return value;
};
const binary = (value) =>
  value instanceof ArrayBuffer
    ? Buffer.from(value)
    : ArrayBuffer.isView(value) && !(value instanceof DataView)
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : null;
const removeFile = (filename) =>
  fs.unlink(filename).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
const moveFile = async (source, destination) => {
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    // Cross-volume: stage beside the destination so a failed copy never
    // leaves a truncated file at the chosen path.
    const staged = path.join(
      path.dirname(destination),
      `.${path.basename(destination)}.${randomUUID()}.tmp`,
    );
    try {
      await fs.copyFile(source, staged);
      await fs.rename(staged, destination);
    } finally {
      await removeFile(staged);
    }
    await fs.unlink(source);
  }
};

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc = (value, bytes) => {
  for (const byte of bytes)
    value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8);
  return value >>> 0;
};

/** Validates exactly one bounded, non-animated PNG without buffering its pixels. */
class PNGFrameValidator {
  constructor({ width, height, size }) {
    Object.assign(this, {
      width,
      height,
      size,
      position: 0,
      stage: "signature",
      buffer: Buffer.alloc(8),
      filled: 0,
      remaining: 0,
      chunkIndex: 0,
      sawData: false,
      ended: false,
    });
  }
  push(bytes) {
    if (
      this.position + bytes.length > this.size ||
      (this.ended && bytes.length)
    )
      throw messageError(new Error(''), 'desktop.videoExportService.errors.pngFrameContainsTrailingData', {});
    this.position += bytes.length;
    let offset = 0;
    while (offset < bytes.length) {
      if (this.ended) throw messageError(new Error(''), 'desktop.videoExportService.errors.pngFrameContainsTrailingData', {});
      if (this.stage === "body") {
        const count = Math.min(this.remaining, bytes.length - offset),
          part = bytes.subarray(offset, offset + count);
        this.checksum = crc(this.checksum, part);
        if (this.type === "IHDR")
          part.copy(this.ihdr, this.length - this.remaining);
        this.remaining -= count;
        offset += count;
        if (!this.remaining) {
          this.stage = "crc";
          this.buffer = Buffer.alloc(4);
          this.filled = 0;
        }
        continue;
      }
      const count = Math.min(
        this.buffer.length - this.filled,
        bytes.length - offset,
      );
      bytes.copy(this.buffer, this.filled, offset, offset + count);
      this.filled += count;
      offset += count;
      if (this.filled < this.buffer.length) continue;
      if (this.stage === "signature") {
        if (!this.buffer.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
          throw messageError(new Error(''), 'desktop.videoExportService.errors.videoFrameMustBeAPNGImage', {});
        this.stage = "header";
        this.buffer = Buffer.alloc(8);
        this.filled = 0;
      } else if (this.stage === "header") {
        this.length = this.buffer.readUInt32BE(0);
        this.type = this.buffer.toString("latin1", 4, 8);
        if (
          !/^[A-Za-z]{4}$/.test(this.type) ||
          this.length > this.size - 12 ||
          (this.chunkIndex === 0 &&
            (this.type !== "IHDR" || this.length !== 13))
        )
          throw messageError(new Error(''), 'desktop.videoExportService.errors.invalidPNGFrameChunk', {});
        if (["acTL", "fcTL", "fdAT"].includes(this.type))
          throw messageError(new Error(''), 'desktop.videoExportService.errors.videoFramesMustBeStillPNGImages', {});
        if (
          !["IHDR", "IDAT", "IEND", "sRGB", "gAMA", "cHRM", "pHYs"].includes(
            this.type,
          ) ||
          (!["IHDR", "IDAT"].includes(this.type) && this.length > 64)
        )
          throw messageError(new Error(''), 'desktop.videoExportService.errors.pngFrameContainsUnsupportedMetadata', {});
        if (this.chunkIndex && this.type === "IHDR")
          throw messageError(new Error(''), 'desktop.videoExportService.errors.pngFrameHasARepeatedHeader', {});
        if (this.type === "IEND" && (this.length || !this.sawData))
          throw messageError(new Error(''), 'desktop.videoExportService.errors.pngFrameIsIncomplete', {});
        if (this.type === "IDAT") this.sawData = true;
        this.chunkIndex++;
        this.checksum = crc(0xffffffff, this.buffer.subarray(4));
        this.remaining = this.length;
        if (this.type === "IHDR") this.ihdr = Buffer.alloc(13);
        this.stage = this.remaining ? "body" : "crc";
        this.buffer = this.remaining ? null : Buffer.alloc(4);
        this.filled = 0;
      } else {
        if ((this.checksum ^ 0xffffffff) >>> 0 !== this.buffer.readUInt32BE(0))
          throw messageError(new Error(''), 'desktop.videoExportService.errors.pngFrameChecksumIsInvalid', {});
        if (this.type === "IHDR") {
          if (
            this.ihdr.readUInt32BE(0) !== this.width ||
            this.ihdr.readUInt32BE(4) !== this.height
          )
            throw messageError(new Error(''), 'desktop.videoExportService.errors.pngFrameDimensionsDoNotMatchTheExport', {});
          if (
            this.ihdr[8] !== 8 ||
            ![2, 6].includes(this.ihdr[9]) ||
            this.ihdr[10] ||
            this.ihdr[11] ||
            this.ihdr[12] > 1
          )
            throw messageError(new Error(''), 'desktop.videoExportService.errors.videoFramesRequireStandard8BitRGBOrRGBAPNGImages', {});
        }
        this.ended = this.type === "IEND";
        this.stage = "header";
        this.buffer = Buffer.alloc(8);
        this.filled = 0;
      }
    }
  }
  finish() {
    if (!this.ended || this.position !== this.size)
      throw messageError(new Error(''), 'desktop.videoExportService.errors.pngFrameIsIncomplete', {});
  }
}

function validateConfig(value = {}) {
  if (value.audio !== undefined && typeof value.audio !== 'boolean') throw messageError(new Error(''), 'desktop.videoExportService.errors.audioExportMustBeEnabledOrDisabled', {});
  if (value.audio && value.totalFrames / value.fps > 3600) throw messageError(new Error(''), 'desktop.videoExportService.errors.audioVideoExportsSupportUpToOneHour', {});
  if (!Object.hasOwn(FORMATS, value.format))
    throw messageError(new Error(''), 'desktop.videoExportService.errors.chooseWebMMP4AVIOrWMVVideo', {});
  const codec =
    value.codec === undefined
      ? FORMATS[value.format].defaultCodec
      : value.codec;
  if (!FORMATS[value.format].codecs.includes(codec))
    throw messageError(new Error(''), 'desktop.videoExportService.errors.chooseASupportedCodecForTheSelectedVideoFormat', {});
  const width = integer(value.width, 1, 16384, "Video width"),
    height = integer(value.height, 1, 16384, "Video height");
  if (width * height > 16 * 1024 * 1024)
    throw messageError(new Error(''), 'desktop.videoExportService.errors.nativeVideoExportSupportsUpTo16MillionPixelsPerFrame', {});
  return {
    format: value.format,
    ...(value.audio ? {audio: true} : {}),
    codec,
    width,
    height,
    ...codecDimensions(codec, width, height),
    fps: finite(value.fps, 1, 1000, "Video frame rate"),
    totalFrames: integer(value.totalFrames, 1, 1000000, "Video frame count"),
    quality: finite(value.quality ?? 0.8, 0, 1, "Video quality"),
    maxBytes: integer(
      value.maxBytes ?? MAX_OUTPUT_BYTES,
      1024,
      MAX_OUTPUT_BYTES,
      "Video size limit",
    ),
    ...(value.bitrate === undefined
      ? {}
      : { bitrate: finite(value.bitrate, 1000, 200000000, "Video bitrate") }),
  };
}

function encoderArguments(config, output) {
  const format = FORMATS[config.format];
  const codec = CODECS[config.codec];
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-filter_threads",
    "1",
    "-y",
    "-threads",
    "1",
    "-f",
    "image2pipe",
    "-c:v",
    "png",
    "-framerate",
    String(config.fps),
    "-i",
    "pipe:0",
    "-an",
    "-sn",
    "-dn",
    "-map",
    "0:v:0",
  ];
  if (
    config.encodedWidth !== config.width ||
    config.encodedHeight !== config.height
  )
    args.push(
      "-vf",
      `pad=${config.encodedWidth}:${config.encodedHeight}:0:0:color=black`,
    );
  // Packed RGB-to-YUVA conversion rounds alpha 128..254 up by one.
  // Keep the original 8-bit alpha plane separate from chroma conversion.
  if (config.codec === "vp9") args.push("-vf", "format=rgba,split[c][a];[a]alphaextract[mask];[c]format=yuv420p[color];[color][mask]alphamerge");
  args.push(
    "-c:v",
    codec.encoder,
    "-threads",
    "2",
    "-pix_fmt",
    codec.pixelFormat,
  );
  if (config.codec === "h264")
    args.push(
      "-preset",
      "fast",
      // Better motion analysis compresses dense artwork much more efficiently
      // than veryfast. Keep lookahead/B-frame queues disabled at every size.
      "-tune", "zerolatency",
      ...(config.bitrate
        ? ["-b:v", String(Math.round(config.bitrate))]
        : ["-crf", String(Math.round(38 - config.quality * 20))]),
    );
  else if (config.codec === "vp9")
    args.push("-deadline","good","-cpu-used","4","-row-mt","1","-auto-alt-ref","0","-lag-in-frames","0",
      // With a CRF and zero target bitrate, VP9 adjusts data to scene complexity.
      "-b:v",String(config.bitrate === undefined ? 0 : Math.round(config.bitrate)),
      "-crf",String(Math.round((1-config.quality)*48)));
  else if (codec.quality)
    args.push(
      ...(config.bitrate
        ? ["-b:v", String(Math.round(config.bitrate))]
        : ["-q:v", String(Math.round(31 - config.quality * 29))]),
    );
  if (config.codec === "vp9" && config.quality === 1) args.push("-lossless", "1");
  if (config.format === "mp4") args.push("-movflags", "+faststart");
  if (config.format === "avi" && config.codec === "mpeg4")
    args.push("-vtag", "XVID");
  // RGB FFV1 and rawvideo avoid chroma subsampling and dimension padding.
  if (config.codec === "ffv1") {
    // FFV1 v3's slice grid loses pixels on tiny dimensions in FFmpeg 7.1.
    // Its v1 single-slice format preserves those RGB frames exactly.
    const tiny = config.width < 4 || config.height < 4;
    args.push(
      "-level",
      tiny ? "1" : "3",
      "-coder",
      "1",
      "-slices",
      tiny ? "1" : "4",
    );
  }
  args.push(
    "-fps_mode",
    "cfr",
    "-fs",
    String(config.maxBytes),
    "-progress",
    "pipe:1",
    "-f",
    format.muxer,
    output,
  );
  return args;
}

function probe(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(messageError(new Error(''), 'desktop.videoExportService.errors.nativeEncoderDidNotRespond', {}));
    }, 10000);
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        text += chunk.toString();
        if (text.length > 256 * 1024) {
          child.kill("SIGKILL");
          reject(
            messageError(new Error(''), 'desktop.videoExportService.errors.nativeEncoderReturnedAnInvalidCapabilityList', {}),
          );
        }
      });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(text)
        : reject(messageError(new Error(''), 'desktop.videoExportService.errors.nativeEncoderIsUnavailable', {}));
    });
  });
}

class VideoExportService {
  constructor({
    encoderPath,
    tempRoot = os.tmpdir(),
    ttlMs = 120000,
    operationTimeoutMs = 120000,
  } = {}) {
    if (
      encoderPath !== undefined &&
      (typeof encoderPath !== "string" || !path.isAbsolute(encoderPath))
    )
      throw messageError(new Error(''), 'desktop.videoExportService.errors.aNativeApprovedEncoderIsRequired', {});
    if (typeof tempRoot !== "string" || !path.isAbsolute(tempRoot))
      throw messageError(new Error(''), 'desktop.videoExportService.errors.aNativeApprovedTemporaryFolderIsRequired', {});
    Object.assign(this, { encoderPath, tempRoot, ttlMs, operationTimeoutMs });
    this.jobs = new Map();
    this.starting = false;
    this.capabilityPromise = null;
  }
  async capabilities(options = {}) {
    if (!this.capabilityPromise)
      this.capabilityPromise = (async () => {
        let version = "",
          encoders = "",
          muxers = "",
          reason = "";
        try {
          if (
            !this.encoderPath ||
            (await fs.stat(this.encoderPath)).isFile() !== true
          )
            throw messageError(new Error(''), 'desktop.videoExportService.errors.missing', {});
          [version, encoders, muxers] = await Promise.all([
            probe(this.encoderPath, ["-version"]),
            probe(this.encoderPath, ["-hide_banner", "-encoders"]),
            probe(this.encoderPath, ["-hide_banner", "-muxers"]),
          ]);
        } catch {
          reason =
            "This desktop build does not include a working native video encoder. Export WebM or use a build with native video support.";
        }
        const formats = Object.entries(FORMATS).map(([id, format]) => {
          const codecs = format.codecs.map((id) => {
            const codec = CODECS[id];
            const supported =
              !reason &&
              new RegExp(`\\b${codec.encoder}\\b`).test(encoders) &&
              new RegExp(`\\b${format.muxer}\\b`).test(muxers);
            return {
              id,
              label: codec.label, labelKey: codec.labelKey, displayName: codec.displayName,
              supported,
              quality: codec.quality,
              lossless: codec.lossless,
              alpha: Boolean(codec.alpha),
              matte: codec.alpha ? null : "black",
              reasonKey: supported ? undefined : reason ? "desktop.videoExportService.unavailable" : "desktop.videoExportService.unsupportedCodec",
              reasonParams: {codec: codec.labelKey ? {messageKey:codec.labelKey} : codec.displayName ?? codec.label},
              reason: supported
                ? null
                : reason ||
                  `The native encoder does not support ${codec.label} in this format.`,
            };
          });
          const supported = codecs.some((codec) => codec.supported);
          return {
            id,
            codec: CODECS[format.defaultCodec].label,
            defaultCodec: format.defaultCodec,
            alpha: Boolean(CODECS[format.defaultCodec].alpha),
            matte: CODECS[format.defaultCodec].alpha ? null : "black",
            codecs,
            mimeType: format.mimeType,
            supported,
            reasonKey: supported ? undefined : reason ? "desktop.videoExportService.unavailable" : "desktop.videoExportService.unsupportedFormat",
            reasonParams: {format: id.toUpperCase()},
            reason: supported
              ? null
              : reason ||
                `The native encoder does not support ${id.toUpperCase()}.`,
          };
        });
        return {
          available: formats.some((format) => format.supported),
          reason: reason || null, reasonKey: reason ? "desktop.videoExportService.unavailable" : undefined,
          version: version.split(/\r?\n/)[0],
          formats,
          maxChunkBytes: MAX_CHUNK_BYTES,
          maxFrameBytes: MAX_FRAME_BYTES,
          maxBytes: MAX_OUTPUT_BYTES,
        };
      })();
    const value = await this.capabilityPromise;
    const width =
        Number.isInteger(options.width) && options.width > 0
          ? options.width
          : null,
      height =
        Number.isInteger(options.height) && options.height > 0
          ? options.height
          : null;
    return {
      ...value,
      formats: value.formats.map((format) => ({
        ...format,
        ...(width && height
          ? codecDimensions(format.defaultCodec, width, height)
          : { notice: null }),
        codecs: format.codecs.map((codec) => ({
          ...codec,
          ...(width && height
            ? codecDimensions(codec.id, width, height)
            : { notice: null }),
        })),
      })),
    };
  }
  touch(job) {
    clearTimeout(job.timer);
    job.timer = setTimeout(
      () => void this.cancel(job.token).catch(() => {}),
      this.ttlMs,
    );
    job.timer.unref?.();
  }
  async begin(value) {
    const config = validateConfig(value);
    if (this.starting || this.jobs.size)
      throw messageError(new Error(''), 'desktop.videoExportService.errors.finishOrCancelTheCurrentVideoExportFirst', {});
    this.starting = true;
    let directory;
    try {
      const capabilities = await this.capabilities(config),
        available = capabilities.formats.find(
          (format) => format.id === config.format,
        ),
        selectedCodec = available?.codecs.find(
          (codec) => codec.id === config.codec,
        );
      if (!selectedCodec?.supported)
        throw new Error(
          selectedCodec?.reason || available?.reason || capabilities.reason,
        );
      if (config.audio) {
        const audioCodec = {mp4:'aac',webm:'libopus',avi:'pcm_s16le',wmv:'wmav2'}[config.format];
        const encoders = await probe(this.encoderPath, ['-hide_banner','-encoders']);
        if (!new RegExp(`\\b${audioCodec}\\b`).test(encoders)) throw messageError(new Error(''), 'desktop.videoExportService.errors.thisEncoderDoesNotSupportAudioCodecAudio', {audioCodec: audioCodec});
      }
      await fs.mkdir(this.tempRoot, { recursive: true });
      directory = await fs.mkdtemp(
        path.join(this.tempRoot, "stykanimate-video-"),
      );
      const output = path.join(
        directory,
        `output.${FORMATS[config.format].extension}`,
      );
      const child = spawn(this.encoderPath, encoderArguments(config, output), {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const job = {
        token: randomUUID(),
        phase: "writing",
        config,
        directory,
        output,
        child,
        frames: 0,
        encodedFrames: 0,
        stderr: "",
        progress: "",
        busy: false,
        cancelled: false,
        exit: null,
      };
      job.closed = new Promise((resolve) =>
        child.once("close", (code, signal) => {
          job.exit = { code, signal };
          resolve(job.exit);
        }),
      );
      child.on("error", (error) => {
        job.failure = messageError(new Error(''), 'desktop.videoExportService.errors.nativeVideoEncoderCouldNotStartMessage', {message: error.message});
      });
      child.stdin.on("error", (error) => {
        if (!job.cancelled)
          job.failure ||= messageError(new Error(''), 'desktop.videoExportService.errors.nativeVideoEncoderStoppedAcceptingFramesMessage', {message: error.message});
      });
      child.stderr.on("data", (chunk) => {
        job.stderr = (job.stderr + chunk.toString()).slice(-8192);
      });
      child.stdout.on("data", (chunk) => {
        job.progress += chunk.toString();
        let newline;
        while ((newline = job.progress.indexOf("\n")) >= 0) {
          const line = job.progress.slice(0, newline).trim();
          job.progress = job.progress.slice(newline + 1);
          if (line.startsWith("frame="))
            job.encodedFrames = Number(line.slice(6));
        }
        if (job.progress.length > 4096)
          job.progress = job.progress.slice(-4096);
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      this.jobs.set(job.token, job);
      this.touch(job);
      return {
        token: job.token,
        maxChunkBytes: MAX_CHUNK_BYTES,
        maxFrameBytes: MAX_FRAME_BYTES,
        inputWidth: config.width,
        inputHeight: config.height,
        width: config.encodedWidth,
        height: config.encodedHeight,
        codec: config.codec,
        notice: selectedCodec.notice,
      };
    } catch (error) {
      if (directory) await fs.rmdir(directory).catch(() => {});
      throw error;
    } finally {
      this.starting = false;
    }
  }
  async use(token, phase, operation) {
    const job = this.jobs.get(token);
    if (!job || job.phase !== phase || job.cancelled)
      throw messageError(new Error(''), 'desktop.videoExportService.errors.thisVideoExportIsNoLongerActive', {});
    if (job.busy)
      throw messageError(new Error(''), 'desktop.videoExportService.errors.waitForThePreviousVideoChunkToFinish', {});
    job.busy = true;
    clearTimeout(job.timer);
    job.idle = new Promise((resolve) => (job.resolveIdle = resolve));
    let result, failure;
    try {
      if (job.failure) throw job.failure;
      result = await operation(job);
      if (job.cancelled) throw aborted();
    } catch (error) {
      failure = error;
    } finally {
      job.busy = false;
      job.resolveIdle();
      job.idle = null;
      if (this.jobs.has(token) && !job.cancelled) this.touch(job);
    }
    if (failure) {
      await this.cancel(token);
      throw failure;
    }
    return result;
  }
  writeAudioChunk(token, value) {
    return this.use(token, 'writing', async job => {
      if (!job.config.audio) throw messageError(new Error(''), 'desktop.videoExportService.errors.enableAudioWhenBeginningTheVideoExport', {});
      const bytes = binary(value), expected = Math.round(job.config.totalFrames / job.config.fps * 48000) * 8;
      if (!bytes?.length || bytes.length > MAX_CHUNK_BYTES || bytes.length % 8 || (job.audioBytes ?? 0) + bytes.length > expected) throw messageError(new Error(''), 'desktop.videoExportService.errors.invalidStereoAudioChunk', {});
      for (let at = 0; at < bytes.length; at += 4) { const sample = bytes.readFloatLE(at); if (!Number.isFinite(sample) || Math.abs(sample) > 1) throw messageError(new Error(''), 'desktop.videoExportService.errors.audioSamplesMustBeFiniteAndNormalized', {}); }
      if (!job.audioHandle) { job.audioPath = path.join(job.directory, 'mix.f32'); job.audioHandle = await fs.open(job.audioPath, 'wx'); }
      let written = 0; while (written < bytes.length) { const result = await job.audioHandle.write(bytes, written, bytes.length - written); if (!result.bytesWritten) throw messageError(new Error(''), 'desktop.videoExportService.errors.audioWritingStopped', {}); written += result.bytesWritten; }
      job.audioBytes = (job.audioBytes ?? 0) + bytes.length; return {written: job.audioBytes, total: expected};
    });
  }
  async muxAudio(job) {
    const expected = Math.round(job.config.totalFrames / job.config.fps * 48000) * 8;
    if (job.audioBytes !== expected) throw messageError(new Error(''), 'desktop.videoExportService.errors.sendTheEntireAudioMixBeforeFinishingVideoExport', {});
    await job.audioHandle.close(); job.audioHandle = null;
    const output = path.join(job.directory, `mixed.${FORMATS[job.config.format].extension}`), codec = {mp4:'aac',webm:'libopus',avi:'pcm_s16le',wmv:'wmav2'}[job.config.format];
    const args = ['-hide_banner','-loglevel','error','-nostdin','-y','-i',job.output,'-f','f32le','-ar','48000','-ac','2','-i',job.audioPath,
      '-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a',codec,...(codec === 'pcm_s16le' ? [] : ['-b:a','192k']),'-t',String(job.config.totalFrames / job.config.fps),...(job.config.format === 'mp4' ? ['-movflags','+faststart'] : []),output];
    let stderr = '', timer; const child = job.muxChild = spawn(this.encoderPath, args, {windowsHide:true,stdio:['ignore','ignore','pipe']});
    job.muxOutput = output; child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4096); });
    job.muxClosed = new Promise(resolve => child.once('close',resolve));
    try {
      await new Promise((resolve,reject) => {
        timer = setTimeout(() => { child.kill(); reject(messageError(new Error(''), 'desktop.videoExportService.errors.addingAudioToTheVideoTimedOut', {})); },this.operationTimeoutMs);
        child.once('error',reject); child.once('close',code => code === 0 ? resolve() : reject(messageError(new Error(''), 'desktop.videoExportService.errors.audioEncodingFailedStderr', {stderr: stderr})));
      });
    } finally { clearTimeout(timer); }
    if (job.cancelled) throw aborted();
    job.silentOutput = job.output; job.output = output;
  }
  beginFrame(token, { index, size } = {}) {
    return this.use(token, "writing", async (job) => {
      if (job.frame) throw messageError(new Error(''), 'desktop.videoExportService.errors.finishThePreviousPNGFrameFirst', {});
      if (index !== job.frames || index >= job.config.totalFrames)
        throw messageError(new Error(''), 'desktop.videoExportService.errors.videoFramesMustArriveInSequence', {});
      integer(size, 45, MAX_FRAME_BYTES, "PNG frame size");
      job.frame = {
        index,
        size,
        written: 0,
        validator: new PNGFrameValidator({ ...job.config, size }),
      };
      return { index, maxChunkBytes: MAX_CHUNK_BYTES };
    });
  }
  writeFrameChunk(token, value) {
    return this.use(token, "writing", async (job) => {
      const bytes = binary(value);
      if (!bytes?.length || bytes.length > MAX_CHUNK_BYTES)
        throw messageError(new Error(''), 'desktop.videoExportService.errors.videoChunksMustContain1ByteTo256KiB', {});
      if (!job.frame)
        throw messageError(new Error(''), 'desktop.videoExportService.errors.beginAPNGFrameBeforeSendingPixels', {});
      job.frame.validator.push(bytes);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(messageError(new Error(''), 'desktop.videoExportService.errors.nativeVideoEncoderStoppedAcceptingPixels', {})),
          this.operationTimeoutMs,
        );
        const closed = () =>
          done(
            job.cancelled
              ? aborted()
              : messageError(new Error(''), 'desktop.videoExportService.errors.nativeVideoEncoderStoppedStderr', {stderr: job.stderr}),
          );
        const done = (error) => {
          clearTimeout(timer);
          job.child.removeListener("close", closed);
          error ? reject(error) : resolve();
        };
        job.child.once("close", closed);
        job.child.stdin.write(bytes, done);
      });
      job.frame.written += bytes.length;
      return {
        written: job.frame.written,
        total: job.frame.size,
        frame: job.frame.index,
      };
    });
  }
  endFrame(token) {
    return this.use(token, "writing", async (job) => {
      if (!job.frame) throw messageError(new Error(''), 'desktop.videoExportService.errors.thereIsNoPNGFrameToFinish', {});
      job.frame.validator.finish();
      job.frames++;
      job.frame = null;
      return { completed: job.frames, total: job.config.totalFrames };
    });
  }
  finish(token) {
    return this.use(token, "writing", async (job) => {
      if (job.frame || job.frames !== job.config.totalFrames)
        throw messageError(new Error(''), 'desktop.videoExportService.errors.sendEveryVideoFrameBeforeFinishingTheExport', {});
      job.child.stdin.end();
      let timer;
      try {
        await Promise.race([
          job.closed,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(messageError(new Error(''), 'desktop.videoExportService.errors.nativeVideoEncoderDidNotFinish', {})),
              this.operationTimeoutMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (job.cancelled) throw aborted();
      if (job.failure || job.exit.code !== 0) {
        const failure = messageError(new Error(''), 'desktop.videoExportService.errors.encodingFailed', {detail:job.stderr || job.failure?.message || ''});
        failure.message = failure.message.trim();
        throw failure;
      }
      if (job.encodedFrames !== job.config.totalFrames)
        throw messageError(new Error(''), 'desktop.videoExportService.errors.nativeVideoEncodedEncodedFramesOfTotalFramesFramesTheVideoMayExceedItsSizeLimit', {encodedFrames: job.encodedFrames, totalFrames: job.config.totalFrames});
      if (job.config.audio) await this.muxAudio(job);
      const stat = await fs.stat(job.output);
      if (!stat.isFile() || !stat.size || stat.size > job.config.maxBytes)
        throw messageError(new Error(''), 'desktop.videoExportService.errors.encodedVideoExceedsItsSizeLimit', {});
      job.handle = await fs.open(job.output, "r");
      job.size = stat.size;
      job.position = 0;
      job.phase = "reading";
      const format = FORMATS[job.config.format];
      return {
        token: job.token,
        size: job.size,
        maxChunkBytes: MAX_CHUNK_BYTES,
        mimeType: format.mimeType,
        extension: format.extension,
        frames: job.frames,
        width: job.config.encodedWidth,
        height: job.config.encodedHeight,
        codec: job.config.codec,
      };
    });
  }
  /** Move the encoded file to a native-approved destination without piping
   * its bytes through the renderer. */
  save(token, destination) {
    return this.use(token, "reading", async (job) => {
      if (typeof destination !== "string" || !path.isAbsolute(destination))
        throw messageError(new Error(''), 'desktop.fileStreams.errors.aNativeApprovedDestinationIsRequired', {});
      if (job.handle) {
        await job.handle.close();
        job.handle = null;
      }
      try {
        await moveFile(job.output, destination);
      } catch (error) {
        // Keep the reading session alive so chunked readback remains possible.
        job.handle = await fs.open(job.output, "r").catch(() => null);
        throw error;
      }
      const size = job.size;
      // release() tolerates the already-moved output (ENOENT) and cleans the directory.
      await this.release(job);
      return { saved: true, path: destination, size };
    });
  }
  read(token) {
    return this.use(token, "reading", async (job) => {
      const count = Math.min(MAX_CHUNK_BYTES, job.size - job.position),
        bytes = Buffer.alloc(count);
      let filled = 0;
      while (filled < count) {
        const { bytesRead } = await job.handle.read(
          bytes,
          filled,
          count - filled,
          job.position + filled,
        );
        if (!bytesRead) throw messageError(new Error(''), 'desktop.videoExportService.errors.encodedVideoChangedWhileReading', {});
        filled += bytesRead;
      }
      job.position += count;
      const done = job.position === job.size,
        result = {
          bytes: bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
          done,
          read: job.position,
          total: job.size,
        };
      if (done) await this.release(job);
      return result;
    });
  }
  async release(job) {
    this.jobs.delete(job.token);
    clearTimeout(job.timer);
    if (job.handle) {
      await job.handle.close();
      job.handle = null;
    }
    await removeFile(job.output);
    if (job.audioHandle) { await job.audioHandle.close(); job.audioHandle = null; }
    for (const file of new Set([job.audioPath,job.silentOutput,job.muxOutput].filter(file => file && file !== job.output))) await removeFile(file);
    await fs.rmdir(job.directory).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  async cancel(token) {
    const job = this.jobs.get(token);
    if (!job) return { cancelled: false };
    if (job.cancellation) return job.cancellation;
    job.cancelled = true;
    clearTimeout(job.timer);
    job.cancellation = (async () => {
      job.child.stdin.destroy();
      if (!job.exit) job.child.kill("SIGKILL");
      job.muxChild?.kill();
      if (job.muxClosed) await job.muxClosed;
      await job.closed;
      if (job.busy) await job.idle;
      await this.release(job);
      return { cancelled: true };
    })();
    return job.cancellation;
  }
  async dispose() {
    for (const token of this.jobs.keys())
      await this.cancel(token).catch(() => {});
  }
}

module.exports = {
  VideoExportService,
  PNGFrameValidator,
  validateConfig,
  encoderArguments,
  MAX_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  MAX_OUTPUT_BYTES,
};
