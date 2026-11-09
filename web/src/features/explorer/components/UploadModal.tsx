import { RefObject, useRef } from 'react';
import { Button, Modal, Progress, Space } from 'antd';
import {
  CheckCircleFilled,
  CloseCircleFilled,
  FolderOpenOutlined,
  InboxOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { formatBytes } from '../../../lib/utils';
import { UploadTaskItem } from '../hooks/useUploadQueue';

interface UploadModalProps {
  open: boolean;
  bucketName: string;
  prefix: string;
  uploadQueue: UploadTaskItem[];
  fileInputRef: RefObject<HTMLInputElement>;
  onClose: () => void;
  onClearQueue: () => void;
  onCancelTask: (id: string) => void;
  onRetryTask: (id: string) => void;
  onCancelAll: () => void;
  onFilesSelect: (files: FileList | null) => void;
  onDropDataTransfer?: (dt: DataTransfer) => void;
}

export function UploadModal({
  open,
  bucketName,
  prefix,
  uploadQueue,
  fileInputRef,
  onClose,
  onClearQueue,
  onCancelTask,
  onRetryTask,
  onCancelAll,
  onFilesSelect,
  onDropDataTransfer,
}: UploadModalProps) {
  const folderInputRef = useRef<HTMLInputElement>(null);
  const hasActive = uploadQueue.some((t) => t.status === 'uploading' || t.status === 'hashing');

  return (
    <Modal
      title={
        <Space>
          <ThunderboltOutlined className="text-blue-600" />
          <span>上传文件至 {bucketName}/{prefix}</span>
        </Space>
      }
      open={open}
      onCancel={onClose}
      footer={[
        hasActive ? (
          <Button key="cancelAll" danger onClick={onCancelAll}>
            终止全部上传
          </Button>
        ) : (
          <Button
            key="clear"
            onClick={onClearQueue}
            disabled={uploadQueue.length === 0}
          >
            清空已完成记录
          </Button>
        ),
        <Button key="close" type="primary" onClick={onClose}>
          {hasActive ? '后台传输中 (点击最小化)' : '完成'}
        </Button>,
      ]}
      width={640}
    >
      <input
        ref={folderInputRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory is supported in mainstream browsers
        webkitdirectory=""
        className="hidden"
        onChange={(e) => {
          onFilesSelect(e.target.files);
          e.target.value = '';
        }}
      />

      <div
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (onDropDataTransfer) {
            onDropDataTransfer(e.dataTransfer);
          } else {
            onFilesSelect(e.dataTransfer.files);
          }
        }}
        className="mt-3 cursor-pointer rounded-xl border-2 border-dashed border-blue-300 bg-blue-50/40 hover:bg-blue-50/80 p-7 text-center transition-colors"
      >
        <InboxOutlined className="text-4xl text-blue-600 mb-2" />
        <div className="text-sm font-medium text-slate-800">
          点击选择文件，或直接将多个文件 / 整个文件夹拖拽到此区域上传
        </div>
        <div className="text-xs text-slate-500 mt-1">
          小文件极速直传，≥1MB 自动启用 <strong>Worker 分片流式计算 SHA-256 零字节秒传</strong>，≥5MB 自动启用<strong>并发分片上传与真断点续传</strong>
        </div>
        <div className="mt-3" onClick={(e) => e.stopPropagation()}>
          <Space size={8}>
            <Button size="small" type="primary" ghost onClick={() => fileInputRef.current?.click()}>
              选择多个文件
            </Button>
            <Button
              size="small"
              icon={<FolderOpenOutlined />}
              onClick={() => folderInputRef.current?.click()}
            >
              选择整个文件夹
            </Button>
          </Space>
        </div>
      </div>

      {uploadQueue.length > 0 && (
        <div className="mt-4 space-y-2.5 max-h-64 overflow-y-auto pr-1">
          {uploadQueue.map((task) => (
            <div
              key={task.id}
              className="p-3 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1.5"
            >
              <div className="flex items-center justify-between text-xs gap-2">
                <span className="font-medium text-slate-800 truncate max-w-[48%]" title={task.name}>
                  {task.name}{' '}
                  <span className="text-slate-400 font-mono">({formatBytes(task.size)})</span>
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span
                    className={`flex items-center gap-1 font-medium ${
                      task.status === 'fast' || task.status === 'done'
                        ? 'text-emerald-600'
                        : task.status === 'error'
                        ? 'text-rose-600'
                        : task.status === 'aborted'
                        ? 'text-amber-600'
                        : 'text-blue-600'
                    }`}
                  >
                    {(task.status === 'fast' || task.status === 'done') && <CheckCircleFilled />}
                    {(task.status === 'error' || task.status === 'aborted') && <CloseCircleFilled />}
                    {task.detail}
                  </span>
                  {(task.status === 'error' || task.status === 'aborted') && (
                    <Button
                      size="small"
                      type="link"
                      icon={<ReloadOutlined />}
                      className="h-5 px-1.5 text-xs cursor-pointer"
                      onClick={() => onRetryTask(task.id)}
                    >
                      继续/重试
                    </Button>
                  )}
                  {(task.status === 'hashing' || task.status === 'uploading') && (
                    <Button
                      size="small"
                      type="text"
                      danger
                      className="h-5 px-1.5 text-xs text-rose-500 hover:bg-rose-50 cursor-pointer"
                      onClick={() => onCancelTask(task.id)}
                    >
                      终止
                    </Button>
                  )}
                </div>
              </div>
              <Progress
                percent={task.progress}
                size="small"
                showInfo={false}
                status={
                  task.status === 'error' || task.status === 'aborted'
                    ? 'exception'
                    : task.status === 'done' || task.status === 'fast'
                    ? 'success'
                    : 'active'
                }
              />
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
