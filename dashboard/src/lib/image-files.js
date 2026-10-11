const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** Convert pasted or uploaded raster art to a small, safe JPEG data URL. */
export async function prepareImage(file, { maxDimension = 1600, maxBytes = 300_000 } = {}) {
  if (!file || !ALLOWED.has(file.type)) throw new Error('Choose a JPEG, PNG, WebP, or GIF image');
  if (file.size > 20 * 1024 * 1024) throw new Error('Image must be smaller than 20 MB');
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let blob;
    for (const quality of [0.86, 0.78, 0.68, 0.58]) {
      blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob && blob.size <= maxBytes) break;
    }
    if (!blob || blob.size > maxBytes) throw new Error('Image could not be reduced below the size limit');
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read this image'));
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
    return { dataUrl, name: (file.name || 'reference').replace(/[\r\n]/g, '').slice(0, 120), width: canvas.width, height: canvas.height, mimeType: 'image/jpeg' };
  } finally { bitmap.close(); }
}

export async function readImageFiles(files, options) {
  const images = [...files].filter((file) => file?.type?.startsWith('image/'));
  if (!images.length) throw new Error('No image found. Choose or paste a photo.');
  return Promise.all(images.map((file) => prepareImage(file, options)));
}
