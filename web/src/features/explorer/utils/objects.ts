import { StorageObject } from '../../../lib/api';
import { encodeObjectKey, isTextContentType } from '../../../lib/utils';

export type FileKind =
  | 'folder'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'archive'
  | 'code'
  | 'file';

/** 根据对象的目录标记与 Content-Type 推断展示用的文件类型（决定图标与预览方式） */
export function getFileKind(obj: Pick<StorageObject, 'isFolder' | 'contentType'>): FileKind {
  if (obj.isFolder) return 'folder';
  const ct = (obj.contentType || '').toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  if (ct.includes('pdf')) return 'pdf';
  if (ct.includes('zip') || ct.includes('tar') || ct.includes('gzip')) return 'archive';
  if (isTextContentType(obj.contentType)) return 'code';
  return 'file';
}

/** 对象的直链：`{baseUrl}/raw/{bucket}/{key}` */
export function buildRawUrl(
  baseUrl: string,
  bucket: string,
  key: string,
  options: { download?: boolean } = {}
): string {
  const url = `${baseUrl}/raw/${encodeURIComponent(bucket)}/${encodeObjectKey(key)}`;
  return options.download ? `${url}?download=1` : url;
}

/** 给已有 URL（可能已带签名参数）追加 download=1 */
export function withDownloadParam(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}download=1`;
}

/** 上一级目录前缀：`a/b/c/` → `a/b/`，`a/` → `''` */
export function parentPrefix(prefix: string): string {
  if (!prefix) return '';
  const trimmed = prefix.replace(/\/$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(0, idx + 1) : '';
}

/** 面包屑项（形如 `a/b/`）的显示名：取最后一段目录名 */
export function folderNameFromCrumb(crumb: string): string {
  const parts = crumb.replace(/\/$/, '').split('/');
  return parts[parts.length - 1];
}
