import { useCallback, useEffect, useRef, useState } from 'react';
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

/** 上传任务队列：文件依次上传（秒传 / 单流 / 并发分片），并汇报每个任务的进度，支持单任务/全任务终止 */
export function useUploadQueue({ bucket, prefix, onFinished }: UseUploadQueueOptions) {
  const [queue, setQueue] = useState<UploadTaskItem[]>([]);
  const controllersRef = useRef<Map<string, AbortController>>(new Map());
  const cancelAllFlagRef = useRef(false);

  const updateTask = useCallback((id: string, patch: UploadTaskPatch) => {
    setQueue((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const cancelTask = useCallback(
    (id: string) => {
      const ctrl = controllersRef.current.get(id);
      if (ctrl) {
        ctrl.abort();
        controllersRef.current.delete(id);
      }
      updateTask(id, { status: 'aborted', detail: '已手动终止' });
    },
    [updateTask]
  );

  const cancelAll = useCallback(() => {
    cancelAllFlagRef.current = true;
    controllersRef.current.forEach((ctrl, id) => {
      ctrl.abort();
      updateTask(id, { status: 'aborted', detail: '已手动终止' });
    });
    controllersRef.current.clear();
  }, [updateTask]);

  const uploadFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      if (!bucket) {
        message.warning('请先选择或创建一个存储桶');
        return;
      }

      cancelAllFlagRef.current = false;
      const files = Array.from(fileList);
      const newTasks: UploadTaskItem[] = files.map((f) => ({
        id: `${Date.now()}-${Math.random()}`,
        name: f.name,
        size: f.size,
        progress: 0,
        status: 'hashing',
        detail: '等待中...',
      }));
      setQueue((prev) => [...newTasks, ...prev]);

      for (let i = 0; i < files.length; i++) {
        if (cancelAllFlagRef.current) {
          // 若触发了全部取消，将后续排队的文件统一置为已终止
          for (let j = i; j < files.length; j++) {
            updateTask(newTasks[j].id, { status: 'aborted', detail: '已取消排队' });
          }
          break;
        }

        const file = files[i];
        const task = newTasks[i];
        const controller = new AbortController();
        controllersRef.current.set(task.id, controller);

        try {
          await uploadFile(
            bucket,
            `${prefix}${file.name}`,
            file,
            (patch) => updateTask(task.id, patch),
            controller.signal
          );
        } catch (err: unknown) {
          if (
            controller.signal.aborted ||
            (err instanceof DOMException && err.name === 'AbortError')
          ) {
            updateTask(task.id, { status: 'aborted', detail: '已手动终止' });
          } else {
            updateTask(task.id, { status: 'error', detail: getErrorMessage(err, '上传失败') });
          }
        } finally {
          controllersRef.current.delete(task.id);
        }
      }

      await onFinished();
    },
    [bucket, prefix, onFinished, updateTask]
  );

  const clear = useCallback(() => setQueue([]), []);
  const activeCount = queue.filter(
    (t) => t.status === 'uploading' || t.status === 'hashing'
  ).length;

  // 页面离开防误触与即时清理：若有上传正在进行，离开/刷新时提示并在卸载时中止传输通知后端释放碎片
  useEffect(() => {
    if (activeCount === 0) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    const handleUnload = () => {
      controllersRef.current.forEach((ctrl) => ctrl.abort());
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('unload', handleUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('unload', handleUnload);
    };
  }, [activeCount]);

  return { queue, activeCount, uploadFiles, clear, cancelTask, cancelAll };
}
