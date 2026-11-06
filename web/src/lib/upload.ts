import { cosApi } from './api';
import { computeFileSHA256Progressive } from './hasher';
import {
  computeAdaptiveChunkSize,
  deleteMultipartResumeRecord,
  encodeObjectKey,
  formatBytes,
  getMultipartResumeRecord,
  saveMultipartResumeRecord,
} from './utils';

/** 小于该阈值的文件走单流 PUT，否则走分片上传 */
export const MULTIPART_THRESHOLD = 5 * 1024 * 1024;

const MULTIPART_CONCURRENCY = 3;
const MULTIPART_MAX_RETRIES = 3;
const MULTIPART_PART_TIMEOUT_MS = 60_000;

export type UploadStatus = 'hashing' | 'uploading' | 'fast' | 'done' | 'error';

/** 上传过程中向 UI 汇报的状态增量 */
export interface UploadTaskPatch {
  status?: UploadStatus;
  progress?: number;
  detail?: string;
}

/**
 * 上传单个文件的完整策略：
 * 1. 使用 Web Worker + 4MB 分片流式计算 SHA-256 (内存恒定仅 4MB，主线程 0 阻塞)，优先探测 CAS 秒传池；
 * 2. 秒传命中时 0 字节瞬间完成；
 * 3. 未命中时 <5MB 走单流 PUT，≥5MB 自动走并发分片上传 + IndexedDB 断点续传。
 * 失败时抛出异常，由调用方决定如何展示。
 */
export async function uploadFile(
  bucket: string,
  key: string,
  file: File,
  report: (patch: UploadTaskPatch) => void,
  signal?: AbortSignal
): Promise<void> {
  // 1. Web Worker 分片流式哈希计算与 CAS 秒传探测
  report({ status: 'hashing', progress: 0, detail: '计算文件指纹 0% (Worker 分片流)...' });
  try {
    const sha256 = await computeFileSHA256Progressive(
      file,
      (pct) => {
        report({
          status: 'hashing',
          progress: pct,
          detail: `计算文件指纹 ${pct}% (Worker 分片流)...`,
        });
      },
      signal
    );

    if (sha256) {
      report({ status: 'hashing', progress: 100, detail: '探测 CAS 秒传池...' });
      const fastRes = await cosApi.tryFastUpload(bucket, {
        key,
        sha256,
        contentType: file.type || 'application/octet-stream',
      });
      if (fastRes.fastUploaded) {
        report({
          status: 'fast',
          progress: 100,
          detail: 'SHA-256 极速秒传命中 (CAS 全局去重)',
        });
        return;
      }
    }
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    // 其他非中断异常则继续降级执行常规上传
  }

  report({ status: 'uploading', detail: '正在上传...' });
  if (file.size < MULTIPART_THRESHOLD) {
    await uploadSingleStream(bucket, key, file, (pct) => {
      report({ progress: pct, detail: `流式上传中 ${pct}%` });
    });
    report({ status: 'done', progress: 100, detail: '上传成功' });
  } else {
    await uploadMultipart(bucket, key, file, (pct, detail) => {
      report({ progress: pct, detail });
    });
    report({ status: 'done', progress: 100, detail: '分片流式合并完成' });
  }
}

/** 单流上传（XHR 以便获取上传进度） */
export function uploadSingleStream(
  bucket: string,
  key: string,
  file: File,
  onProgress: (pct: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/v1/buckets/${encodeURIComponent(bucket)}/objects/${encodeObjectKey(key)}`);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded * 100) / e.total));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('网络传输中断'));
    xhr.send(file);
  });
}

/** 分片上传：支持 IndexedDB 断点续传、并发、单片重试与超时，失败时清理服务端暂存分片 */
export async function uploadMultipart(
  bucket: string,
  key: string,
  file: File,
  onProgress: (pct: number, detail: string) => void
): Promise<void> {
  const chunkSize = computeAdaptiveChunkSize(file.size);
  const totalParts = Math.ceil(file.size / chunkSize);
  const resumeKey = `${bucket}:${key}:${file.size}:${file.lastModified}:${chunkSize}`;

  let uploadId = '';
  const uploadedPartSet = new Set<number>();

  // 1. 尝试从 IndexedDB 读取断点续传会话，并向服务端查询已落盘的分片
  const cached = await getMultipartResumeRecord(resumeKey);
  if (cached && cached.uploadId && cached.chunkSize === chunkSize) {
    try {
      onProgress(2, '探测未完成的分片会话 (断点续传)...');
      const statusRes = await cosApi.getMultipartStatus(bucket, cached.uploadId);
      if (statusRes && statusRes.uploadId) {
        uploadId = statusRes.uploadId;
        for (const pt of statusRes.parts || []) {
          const pStart = (pt.partNumber - 1) * chunkSize;
          const pExpectedSize = Math.min(chunkSize, file.size - pStart);
          if (pt.sizeBytes === pExpectedSize) {
            uploadedPartSet.add(pt.partNumber);
          }
        }
      }
    } catch {
      await deleteMultipartResumeRecord(resumeKey);
    }
  }

  // 2. 若无可用续传会话，则初始化新分片上传并写入 IndexedDB
  if (!uploadId) {
    onProgress(2, `初始化分片 (${totalParts} 片, 单片 ${formatBytes(chunkSize)})...`);
    const initRes = await cosApi.initMultipart(
      bucket,
      key,
      file.type || 'application/octet-stream'
    );
    uploadId = initRes.uploadId;
    await saveMultipartResumeRecord({
      id: resumeKey,
      uploadId,
      bucket,
      key,
      size: file.size,
      lastModified: file.lastModified,
      chunkSize,
      updatedAt: Date.now(),
    });
  }

  let completed = uploadedPartSet.size;
  let nextPart = 1;

  const uploadPartWithRetry = async (partNumber: number, chunk: Blob) => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MULTIPART_MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MULTIPART_PART_TIMEOUT_MS);
      try {
        await cosApi.uploadMultipartPart(
          bucket,
          uploadId,
          partNumber,
          chunk,
          controller.signal
        );
        clearTimeout(timer);
        return;
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        if (attempt < MULTIPART_MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 400 * attempt));
        }
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`分片 #${partNumber} 重试 ${MULTIPART_MAX_RETRIES} 次后仍失败`);
  };

  try {
    const worker = async () => {
      while (nextPart <= totalParts) {
        const partNumber = nextPart++;
        if (uploadedPartSet.has(partNumber)) {
          continue;
        }
        const start = (partNumber - 1) * chunkSize;
        const end = Math.min(start + chunkSize, file.size);
        const chunk = file.slice(start, end);

        await uploadPartWithRetry(partNumber, chunk);
        completed++;
        const pct = Math.round((completed * 95) / totalParts);
        onProgress(pct, `分片并发传输 ${completed}/${totalParts} (${pct}%)`);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(MULTIPART_CONCURRENCY, totalParts) }, () => worker())
    );

    onProgress(98, '流式合并分片 & 校验 SHA-256...');
    await cosApi.completeMultipart(bucket, uploadId);
    await deleteMultipartResumeRecord(resumeKey);
  } catch (err) {
    // 分片重试耗尽后主动清理服务端暂存分片与本地续传记录，防止残留孤儿分片占满配额
    await cosApi.abortMultipart(bucket, uploadId).catch(() => {});
    await deleteMultipartResumeRecord(resumeKey);
    throw err;
  }
}
