export type QuotaUnit = 'B' | 'KB' | 'MB' | 'GB';

const UNIT_MULTIPLIERS: Record<QuotaUnit, number> = {
  B: 1,
  KB: 1024,
  MB: 1024 * 1024,
  GB: 1024 * 1024 * 1024,
};

/** 对象 key 按 `/` 分段做 URL 编码，保留目录分隔符 */
export function encodeObjectKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

/** 判断 Content-Type 是否属于可直接文本预览/展示为代码的类型 */
export function isTextContentType(contentType?: string): boolean {
  const ct = (contentType || '').toLowerCase();
  return (
    ct.startsWith('text/') ||
    ct.includes('json') ||
    ct.includes('javascript') ||
    ct.includes('xml') ||
    ct.includes('yaml')
  );
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

/**
 * 将后端字节配额无损转换为前端表单的「数值 + 单位」，避免 <1MB 或非整数 MB 配额被四舍五入为 0
 */
export function bytesToQuotaForm(quotaBytes?: number): {
  quotaValue: number;
  quotaUnit: QuotaUnit;
} {
  if (!quotaBytes || quotaBytes <= 0) {
    return { quotaValue: 0, quotaUnit: 'MB' };
  }
  if (quotaBytes % UNIT_MULTIPLIERS.GB === 0) {
    return { quotaValue: quotaBytes / UNIT_MULTIPLIERS.GB, quotaUnit: 'GB' };
  }
  if (quotaBytes % UNIT_MULTIPLIERS.MB === 0) {
    return { quotaValue: quotaBytes / UNIT_MULTIPLIERS.MB, quotaUnit: 'MB' };
  }
  if (quotaBytes % UNIT_MULTIPLIERS.KB === 0) {
    return { quotaValue: quotaBytes / UNIT_MULTIPLIERS.KB, quotaUnit: 'KB' };
  }
  return { quotaValue: quotaBytes, quotaUnit: 'B' };
}

/**
 * 将表单的「数值 + 单位」精确还原为字节数
 */
export function quotaFormToBytes(
  quotaValue?: number | null,
  quotaUnit: QuotaUnit = 'MB'
): number {
  if (!quotaValue || quotaValue <= 0) return 0;
  const mult = UNIT_MULTIPLIERS[quotaUnit] || UNIT_MULTIPLIERS.MB;
  return Math.max(0, Math.round(Number(quotaValue) * mult));
}

/**
 * 自适应计算分片大小：保证总分片数 <= 9000（后端上限为 10000），单分片最小 2MB
 */
export function computeAdaptiveChunkSize(fileSize: number): number {
  const MIN_CHUNK = 2 * 1024 * 1024;
  if (!fileSize || fileSize <= 0) return MIN_CHUNK;
  return Math.max(MIN_CHUNK, Math.ceil(fileSize / 9000));
}

export function formatDate(iso?: string): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export async function computeSHA256Hex(file: File): Promise<string | null> {
  if (!window.crypto || !window.crypto.subtle) return null;
  try {
    const buffer = await file.arrayBuffer();
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    return true;
  }
}

// --- IndexedDB 分片上传断点续传存储 ---
export interface MultipartResumeRecord {
  id: string;
  uploadId: string;
  bucket: string;
  key: string;
  size: number;
  lastModified: number;
  chunkSize: number;
  updatedAt: number;
}

const IDB_NAME = 'nanocos_uploader_db';
const IDB_STORE = 'multipart_sessions';

function openMultipartIDB(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function getMultipartResumeRecord(
  id: string
): Promise<MultipartResumeRecord | null> {
  const db = await openMultipartIDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(id);
      req.onsuccess = () => resolve((req.result as MultipartResumeRecord) || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveMultipartResumeRecord(
  record: MultipartResumeRecord
): Promise<void> {
  const db = await openMultipartIDB();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function deleteMultipartResumeRecord(id: string): Promise<void> {
  const db = await openMultipartIDB();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}
