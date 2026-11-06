import { useCallback, useState } from 'react';
import { message } from 'antd';
import { UploadStatus, UploadTaskPatch, uploadFile } from '../../../lib/upload';
import { getErrorMessage } from '../../../lib/errors';

export interface UploadTaskItem {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: UploadStatus;
  detail: string;
}

interface UseUploadQueueOptions {
  bucket: string;
  /** 当前所在目录前缀，上传文件的 key = prefix + 文件名 */
  prefix: string;
  /** 一批文件全部处理完成（无论成败）后调用，用于刷新列表与桶统计 */
  onFinished: () => void | Promise<void>;
}

/** 上传任务队列：文件依次上传（秒传 / 单流 / 并发分片），并汇报每个任务的进度 */
export function useUploadQueue({ bucket, prefix, onFinished }: UseUploadQueueOptions) {
  const [queue, setQueue] = useState<UploadTaskItem[]>([]);

  const updateTask = useCallback((id: string, patch: UploadTaskPatch) => {
    setQueue((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const uploadFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      if (!bucket) {
        message.warning('请先选择或创建一个存储桶');
        return;
      }

      const files = Array.from(fileList);
      const newTasks: UploadTaskItem[] = files.map((f) => ({
        id: `${Date.now()}-${Math.random()}`,
        name: f.name,
        size: f.size,
        progress: 5,
        status: 'hashing',
        detail: '计算 SHA-256 指纹...',
      }));
      setQueue((prev) => [...newTasks, ...prev]);

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const task = newTasks[i];
        try {
          await uploadFile(bucket, `${prefix}${file.name}`, file, (patch) =>
            updateTask(task.id, patch)
          );
        } catch (err: unknown) {
          updateTask(task.id, { status: 'error', detail: getErrorMessage(err, '上传失败') });
        }
      }

      await onFinished();
    },
    [bucket, prefix, onFinished, updateTask]
  );

  const clear = useCallback(() => setQueue([]), []);
  const activeCount = queue.filter((t) => t.status === 'uploading').length;

  return { queue, activeCount, uploadFiles, clear };
}
