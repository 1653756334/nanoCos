import { StreamingSHA256 } from './sha256-stream';

export interface WorkerHashRequest {
  file: File;
  chunkSize?: number;
}

export type WorkerHashResponse =
  | { type: 'progress'; percent: number; offset: number; total: number }
  | { type: 'done'; sha256: string }
  | { type: 'error'; message: string };

self.onmessage = async (e: MessageEvent<WorkerHashRequest>) => {
  try {
    const { file, chunkSize = 4 * 1024 * 1024 } = e.data;
    const hasher = new StreamingSHA256();
    const total = file.size;

    if (total === 0) {
      self.postMessage({ type: 'done', sha256: hasher.digest() } satisfies WorkerHashResponse);
      return;
    }

    let offset = 0;
    while (offset < total) {
      const end = Math.min(offset + chunkSize, total);
      const slice = file.slice(offset, end);
      const buffer = await slice.arrayBuffer();
      hasher.update(new Uint8Array(buffer));
      offset = end;

      const percent = Math.min(100, Math.round((offset * 100) / total));
      self.postMessage({
        type: 'progress',
        percent,
        offset,
        total,
      } satisfies WorkerHashResponse);
    }

    const sha256 = hasher.digest();
    self.postMessage({ type: 'done', sha256 } satisfies WorkerHashResponse);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    self.postMessage({ type: 'error', message: msg } satisfies WorkerHashResponse);
  }
};
