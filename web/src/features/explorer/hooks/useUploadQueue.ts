import { useCallback, useEffect, useRef, useState } from 'react';
import { message } from 'antd';
import { UploadStatus, UploadTaskPatch, uploadFile } from '../../../lib/upload';
import { getErrorMessage } from '../../../lib/errors';

const FILE_UPLOAD_CONCURRENCY = 3;

export interface UploadTaskItem {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: UploadStatus;
  detail: string;
}

interface TaskMeta {
  bucket: string;
  key: string;
  file: File;
}

interface UseUploadQueueOptions {
  bucket: string;
  /** 当前所在目录前缀，上传文件的 key = prefix + 相对路径或文件名 */
  prefix: string;
  /** 单个或一批文件处理完成后调用，用于实时刷新列表与桶统计 */
  onFinished: () => void | Promise<void>;
}

/** 递归解析拖拽的 DataTransfer（支持直接拖拽单/多级文件夹或普通文件） */
export async function extractDroppedFiles(
  dataTransfer: DataTransfer
): Promise<Array<{ file: File; relativePath: string }>> {
  const items = dataTransfer.items;
  if (items && items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
    const entries: FileSystemEntry[] = [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry();
      if (entry) entries.push(entry);
    }
    if (entries.some((e) => e.isDirectory)) {
      const results: Array<{ file: File; relativePath: string }> = [];
      const readEntry = async (entry: FileSystemEntry, parentPath: string): Promise<void> => {
        if (entry.isFile) {
          const fileEntry = entry as FileSystemFileEntry;
          const file = await new Promise<File>((resolve, reject) => {
            fileEntry.file(resolve, reject);
          });
          results.push({
            file,
            relativePath: parentPath ? `${parentPath}/${file.name}` : file.name,
          });
        } else if (entry.isDirectory) {
          const dirEntry = entry as FileSystemDirectoryEntry;
          const reader = dirEntry.createReader();
          const dirPath = parentPath ? `${parentPath}/${dirEntry.name}` : dirEntry.name;
          const readAllSubEntries = async (): Promise<FileSystemEntry[]> => {
            const all: FileSystemEntry[] = [];
            while (true) {
              const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
                reader.readEntries(resolve, reject);
              });
              if (batch.length === 0) break;
              all.push(...batch);
            }
            return all;
          };
          const children = await readAllSubEntries();
          for (const child of children) {
            await readEntry(child, dirPath);
          }
        }
      };
      for (const entry of entries) {
        await readEntry(entry, '');
      }
      if (results.length > 0) {
        return results;
      }
    }
  }

  return Array.from(dataTransfer.files || []).map((file) => ({
    file,
    relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
  }));
}

/** 上传任务队列：支持多文件并发（秒传 / 单流 / 并发分片）、单任务重试断点续传与单/全任务终止 */
export function useUploadQueue({ bucket, prefix, onFinished }: UseUploadQueueOptions) {
  const [queue, setQueue] = useState<UploadTaskItem[]>([]);
  const controllersRef = useRef<Map<string, AbortController>>(new Map());
  const taskMetaRef = useRef<Map<string, TaskMeta>>(new Map());
  const cancelAllFlagRef = useRef(false);

  const updateTask = useCallback((id: string, patch: UploadTaskPatch) => {
    setQueue((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const executeSingleTask = useCallback(
    async (taskId: string) => {
      const meta = taskMetaRef.current.get(taskId);
      if (!meta) return;

      const controller = new AbortController();
      controllersRef.current.set(taskId, controller);
      try {
        await uploadFile(
          meta.bucket,
          meta.key,
          meta.file,
          (patch) => updateTask(taskId, patch),
          controller.signal
        );
        void onFinished();
      } catch (err: unknown) {
        if (
          controller.signal.aborted ||
          (err instanceof DOMException && err.name === 'AbortError')
        ) {
          updateTask(taskId, { status: 'aborted', detail: '已手动终止' });
        } else {
          updateTask(taskId, {
            status: 'error',
            detail: `${getErrorMessage(err, '上传中断')} (可点击继续续传)`,
          });
        }
      } finally {
        controllersRef.current.delete(taskId);
      }
    },
    [onFinished, updateTask]
  );

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

  const retryTask = useCallback(
    async (id: string) => {
      if (!taskMetaRef.current.has(id)) return;
      updateTask(id, { status: 'uploading', detail: '正在恢复上传...' });
      await executeSingleTask(id);
    },
    [executeSingleTask, updateTask]
  );

  const cancelAll = useCallback(() => {
    cancelAllFlagRef.current = true;
    controllersRef.current.forEach((ctrl, id) => {
      ctrl.abort();
      updateTask(id, { status: 'aborted', detail: '已手动终止' });
    });
    controllersRef.current.clear();
  }, [updateTask]);

  const enqueueItems = useCallback(
    async (items: Array<{ file: File; relativePath: string }>) => {
      if (items.length === 0) return;
      if (!bucket) {
        message.warning('请先选择或创建一个存储桶');
        return;
      }

      cancelAllFlagRef.current = false;
      const newTasks: UploadTaskItem[] = items.map(({ file, relativePath }) => {
        const id = `${Date.now()}-${Math.random()}`;
        const cleanRel = relativePath.replace(/^\/+/, '');
        taskMetaRef.current.set(id, {
          bucket,
          key: `${prefix}${cleanRel}`,
          file,
        });
        return {
          id,
          name: cleanRel,
          size: file.size,
          progress: 0,
          status: 'hashing',
          detail: '等待中...',
        };
      });
      setQueue((prev) => [...newTasks, ...prev]);

      let nextIndex = 0;
      const worker = async () => {
        while (nextIndex < newTasks.length) {
          const idx = nextIndex++;
          const task = newTasks[idx];
          if (cancelAllFlagRef.current) {
            updateTask(task.id, { status: 'aborted', detail: '已取消排队' });
            continue;
          }
          await executeSingleTask(task.id);
        }
      };

      await Promise.all(
        Array.from(
          { length: Math.min(FILE_UPLOAD_CONCURRENCY, newTasks.length) },
          () => worker()
        )
      );
      await onFinished();
    },
    [bucket, prefix, executeSingleTask, onFinished, updateTask]
  );

  const uploadFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      const items = Array.from(fileList).map((file) => ({
        file,
        relativePath:
          (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      }));
      await enqueueItems(items);
    },
    [enqueueItems]
  );

  const uploadDataTransfer = useCallback(
    async (dataTransfer: DataTransfer | null) => {
      if (!dataTransfer) return;
      const items = await extractDroppedFiles(dataTransfer);
      await enqueueItems(items);
    },
    [enqueueItems]
  );

  const clear = useCallback(() => {
    setQueue((prev) => {
      const remaining = prev.filter((t) => t.status === 'uploading' || t.status === 'hashing');
      const keepIds = new Set(remaining.map((t) => t.id));
      Array.from(taskMetaRef.current.keys()).forEach((k) => {
        if (!keepIds.has(k)) taskMetaRef.current.delete(k);
      });
      return remaining;
    });
  }, []);

  const activeCount = queue.filter(
    (t) => t.status === 'uploading' || t.status === 'hashing'
  ).length;

  // 页面离开防误触提示（不再在 unload 时主动调用 abort 销毁服务端分片，保留已传分片供刷新后断点续传）
  useEffect(() => {
    if (activeCount === 0) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [activeCount]);

  return {
    queue,
    activeCount,
    uploadFiles,
    uploadDataTransfer,
    clear,
    cancelTask,
    retryTask,
    cancelAll,
  };
}
