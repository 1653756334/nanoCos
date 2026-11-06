import { StreamingSHA256 } from './sha256-stream';
import type { WorkerHashRequest, WorkerHashResponse } from './sha256.worker';

const CHUNK_SIZE = 4 * 1024 * 1024; // 每次读取 4MB，内存占用恒定

/**
 * 在后台线程 (Web Worker) 中分片流式计算大文件的 SHA-256 哈希值。
 * 1. 内存恒定占用仅 ~4MB，无论文件是 10MB 还是 20GB，绝不爆内存；
 * 2. 独立 Worker 线程，主线程 UI 零卡顿；
 * 3. 实时汇报计算进度 (0% -> 100%)，支持随 AbortSignal 中止；
 * 4. 在不支持 Worker 的测试/受限环境中自动平滑回退至主线程异步微任务分片计算。
 */
export async function computeFileSHA256Progressive(
  file: File,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal
): Promise<string> {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  // 1. 尝试使用 Web Worker
  if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
    try {
      return await computeViaWorker(file, onProgress, signal);
    } catch {
      // 若因同源策略或环境限制 Worker 创建失败，回退到主线程增量计算
    }
  }

  // 2. 回退机制：主线程分片异步流式计算（每次 4MB 并让出事件循环）
  return computeViaMainThread(file, onProgress, signal);
}

function computeViaWorker(
  file: File,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL('./sha256.worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch (err) {
      reject(err);
      return;
    }

    const cleanup = () => {
      if (worker) {
        worker.terminate();
        worker = null;
      }
    };

    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      });
    }

    worker.onmessage = (e: MessageEvent<WorkerHashResponse>) => {
      const data = e.data;
      if (data.type === 'progress') {
        onProgress?.(data.percent);
      } else if (data.type === 'done') {
        cleanup();
        resolve(data.sha256);
      } else if (data.type === 'error') {
        cleanup();
        reject(new Error(data.message));
      }
    };

    worker.onerror = (err) => {
      cleanup();
      reject(err);
    };

    const req: WorkerHashRequest = { file, chunkSize: CHUNK_SIZE };
    worker.postMessage(req);
  });
}

async function computeViaMainThread(
  file: File,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal
): Promise<string> {
  const hasher = new StreamingSHA256();
  const total = file.size;

  if (total === 0) {
    onProgress?.(100);
    return hasher.digest();
  }

  let offset = 0;
  while (offset < total) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const end = Math.min(offset + CHUNK_SIZE, total);
    const slice = file.slice(offset, end);
    const buffer = await slice.arrayBuffer();
    hasher.update(new Uint8Array(buffer));
    offset = end;

    const percent = Math.min(100, Math.round((offset * 100) / total));
    onProgress?.(percent);

    // 每次处理完分片后短暂让出主线程微任务队列，防止极端情况下主线程短暂丢帧
    await new Promise((r) => setTimeout(r, 0));
  }

  return hasher.digest();
}
