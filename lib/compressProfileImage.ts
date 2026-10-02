import { MAX_PROFILE_DOCUMENT_BYTES, profileDocumentError, type DocumentSlot } from "./profileDocuments";

type BitmapLike = Pick<ImageBitmap, "width" | "height" | "close">;
type CanvasLike = {
  width: number;
  height: number;
  getContext: (type: "2d") => Pick<CanvasRenderingContext2D, "drawImage"> | null;
  toBlob: (callback: BlobCallback, type?: string, quality?: number) => void;
};
export type ProfileImageCompressionEnvironment = {
  decode: (file: File, options: ImageBitmapOptions) => Promise<BitmapLike>;
  createCanvas: () => CanvasLike;
};

const MAX_EDGE: Record<DocumentSlot, number> = {
  photo: 1200,
  resident_front: 1800,
  resident_back: 1800,
  guardian_front: 1800,
  guardian_back: 1800,
};

const browserEnvironment: ProfileImageCompressionEnvironment = {
  decode: (file, options) => {
    if (typeof createImageBitmap !== "function") throw new Error("Image decoding is unavailable.");
    return createImageBitmap(file, options);
  },
  createCanvas: () => document.createElement("canvas"),
};

export async function compressProfileImage(
  file: File,
  slot: DocumentSlot,
  environment: ProfileImageCompressionEnvironment = browserEnvironment,
): Promise<File> {
  const invalid = profileDocumentError(slot, file.type, file.size);
  if (invalid) throw new Error(invalid);
  if (file.type === "application/pdf") return file;
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("Choose a supported JPEG, PNG, WebP, or PDF file.");
  }

  let bitmap: BitmapLike | null = null;
  try {
    bitmap = await environment.decode(file, { imageOrientation: "from-image" });
    if (!(bitmap.width > 0) || !(bitmap.height > 0)) throw new Error("The image has invalid dimensions.");
    const scale = Math.min(1, MAX_EDGE[slot] / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = environment.createCanvas();
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image processing is unavailable.");
    context.drawImage(bitmap as ImageBitmap, 0, 0, width, height);

    const qualityType = file.type === "image/png" ? undefined : 0.82;
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(result => result ? resolve(result) : reject(new Error("Image encoding failed.")), file.type, qualityType);
    });
    if (blob.type !== file.type || blob.size <= 0 || blob.size > MAX_PROFILE_DOCUMENT_BYTES) {
      throw new Error("The compressed image exceeds the 4 MB limit or has an unsupported output format.");
    }
    const compressed = new File([blob], file.name, { type: blob.type, lastModified: file.lastModified });
    const outputError = profileDocumentError(slot, compressed.type, compressed.size);
    if (outputError) throw new Error(outputError);
    return compressed;
  } catch (error) {
    if (error instanceof Error && /4 MB|supported|no larger/i.test(error.message)) throw error;
    throw new Error("Unable to compress this image safely. Choose a smaller or clearer supported image.");
  } finally {
    bitmap?.close();
  }
}
