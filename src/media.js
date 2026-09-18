import { api } from './state.js';

const MAX_EDGE = 2048;

/** Downscale big pastes and re-encode as WebP (GIFs keep their animation). */
export async function prepareImage(file) {
  if (file.type === 'image/gif') return { blob: file, ext: 'gif' };
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/webp', 0.88));
  if (blob && blob.type === 'image/webp') return { blob, ext: 'webp' };
  const png = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  return { blob: png, ext: 'png' };
}

/** Upload an image file. Returns {path, url}. */
export async function uploadImage(file) {
  if (file.size > 40 * 1024 * 1024) throw new Error('Image is larger than 40 MB');
  const { blob, ext } = await prepareImage(file);
  if (blob.size > 10 * 1024 * 1024) throw new Error('Image is still larger than 10 MB after compression');
  const path = await api().media.upload(blob, ext);
  const urls = await api().media.urls([path]);
  return { path, url: urls[path] };
}

export const imageFiles = (dataTransfer) =>
  [...(dataTransfer?.files || [])].filter((f) => /^image\/(png|jpe?g|webp|gif)$/.test(f.type));

/** Give every <img data-path> inside `root` a fresh signed URL. */
export async function resolveImages(root) {
  const imgs = [...root.querySelectorAll('img[data-path]')];
  if (!imgs.length) return;
  const urls = await api().media.urls(imgs.map((i) => i.dataset.path));
  for (const img of imgs) img.src = urls[img.dataset.path] || '';
}

/** Same as resolveImages, but on an HTML string (used before loading editors). */
export async function resolveHtml(html) {
  if (!html || !html.includes('data-path')) return html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  await resolveImages(tpl.content);
  return tpl.innerHTML;
}

/** Drop the expiring signed URLs before saving; data-path is the source of truth. */
export function stripImageUrls(html) {
  if (!html || !html.includes('data-path')) return html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  tpl.content.querySelectorAll('img[data-path]').forEach((i) => i.setAttribute('src', ''));
  return tpl.innerHTML;
}
