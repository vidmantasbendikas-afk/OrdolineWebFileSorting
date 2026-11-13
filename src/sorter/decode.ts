/** Normalizing inputs and decoding images to RGBA pixels (createImageBitmap + OffscreenCanvas). */
import { OrdolineError } from "./errors.js";
import { readUrl } from "./model-cache.js";
import type { ImageInput, RawImage, SorterInput, TaggedInput } from "./types.js";

export const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";
export const isRawImage = (v: unknown): v is RawImage =>
  isObj(v) && ArrayBuffer.isView(v.data) && Number.isInteger(v.width) && Number.isInteger(v.height);
export const isBlob = (v: unknown): v is Blob => typeof Blob !== "undefined" && v instanceof Blob;
export const isBytes = (v: unknown): v is ArrayBuffer | ArrayBufferView =>
  v instanceof ArrayBuffer || (ArrayBuffer.isView(v) && !isRawImage(v));
export const isTagged = (v: unknown): v is TaggedInput => isObj(v) && "image" in v && !isRawImage(v) && !isBlob(v);

/** Split an ImageInput or {image, id?, name?} into its parts. */
export function unwrap(input: SorterInput): { image: ImageInput; id: string | null; name: string | null } {
  if (isTagged(input)) return { image: input.image, id: input.id != null ? String(input.id) : null, name: input.name ?? null };
  return { image: input, id: null, name: null };
}

export function inferName(image: unknown): string | null {
  if (isBlob(image) && typeof (image as File).name === "string") return (image as File).name; // File
  let url: string | null = null;
  if (typeof image === "string") url = image;
  else if (isObj(image) && typeof image.currentSrc === "string") url = (image.currentSrc || image.src) as string;
  if (!url || url.startsWith("data:") || url.startsWith("blob:")) return null;
  try { return decodeURIComponent(url.split(/[?#]/)[0].split("/").pop() ?? "") || null; } catch { return null; }
}

/** Encoded bytes (file contents) for string/Blob/ArrayBuffer/TypedArray inputs. */
export async function encodedBytes(image: string | Blob | ArrayBuffer | ArrayBufferView): Promise<Uint8Array> {
  if (typeof image === "string") {
    try { return new Uint8Array(await readUrl(image)); } catch (err) {
      throw new OrdolineError("FETCH_FAILED", `Could not fetch ${image}`, err);
    }
  }
  if (isBlob(image)) return new Uint8Array(await image.arrayBuffer());
  if (image instanceof ArrayBuffer) return new Uint8Array(image);
  return new Uint8Array(image.buffer, image.byteOffset, image.byteLength);
}

export const hasBuiltinDecoder = () => typeof createImageBitmap === "function" && typeof OffscreenCanvas === "function";

/** Browser/worker decoding: anything createImageBitmap accepts -> RGBA pixels at native size. */
export async function builtinDecode(source: ImageBitmapSource): Promise<RawImage> {
  let bmp: ImageBitmap;
  try {
    // from-image applies EXIF orientation for encoded images
    bmp = await createImageBitmap(source, { imageOrientation: "from-image" });
  } catch {
    try { bmp = await createImageBitmap(source); } catch (err) {
      if ((err as Error)?.name === "TypeError") throw new OrdolineError("UNSUPPORTED_INPUT", "Unsupported input type", err);
      throw new OrdolineError("DECODE_FAILED", "Image could not be decoded", err);
    }
  }
  try {
    const { width, height } = bmp;
    if (!width || !height) throw new OrdolineError("DECODE_FAILED", "Image has zero size");
    const ctx = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    return { data: ctx.getImageData(0, 0, width, height).data, width, height, channels: 4 };
  } finally {
    if (bmp !== source) bmp.close?.();
  }
}

export async function decode(image: ImageInput): Promise<RawImage> {
  if (isRawImage(image)) return image;
  if (!hasBuiltinDecoder()) {
    throw new OrdolineError("UNSUPPORTED_INPUT", "This browser lacks createImageBitmap/OffscreenCanvas: pass {data, width, height} pixels");
  }
  if (isBlob(image)) return builtinDecode(image);
  if (typeof image === "string" || isBytes(image)) return builtinDecode(new Blob([await encodedBytes(image) as BlobPart]));
  // HTMLImageElement, canvas, ImageBitmap, VideoFrame, ...
  const el = image as { decode?: () => Promise<void>; naturalWidth?: number };
  if (typeof el.decode === "function" && "naturalWidth" in el) {
    try { await el.decode(); } catch (err) { throw new OrdolineError("DECODE_FAILED", "Image element could not be decoded", err); }
  }
  return builtinDecode(image as ImageBitmapSource);
}
