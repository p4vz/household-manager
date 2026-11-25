/**
 * Shrinks a photo in the browser and re-encodes it as JPEG, which also drops
 * its metadata (GPS position, camera details) before it leaves the device.
 * Tries lower quality until it fits `maxBytes`.
 */
export async function shrinkImage(file: File, { maxSide = 1600, maxBytes = 950_000 } = {}): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.85, 0.7, 0.55, 0.4]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) break;
    if (blob.size <= maxBytes) return blob;
  }
  throw new Error("That picture is too large even after shrinking.");
}
