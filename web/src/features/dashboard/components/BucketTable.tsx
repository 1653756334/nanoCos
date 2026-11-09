import { useState } from 'react';
import { Alert, Button, Empty, Input, Modal, Segmented, Table } from 'antd';
import {
  ExclamationCircleFilled,
  FolderOpenOutlined,
  PlusOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import type { Bucket } from '../../../lib/api';
import { formatBytes } from '../../../lib/utils';
import type { VisibilityFilter } from '../types';
import { createBucketColumns } from './bucketColumns';

interface BucketTableProps {
  buckets: Bucket[];
  logicalBytes?: number;
  search: string;
  onSearchChange: (value: string) => void;
  visFilter: VisibilityFilter;
  onVisFilterChange: (value: VisibilityFilter) => void;
  onOpenBucket: (bucketName: string) => void;
  onCreate: () => void;
  onEdit: (bucket: Bucket) => void;
  onDelete: (name: string, force?: boolean) => Promise<void> | void;
}

/** 左侧：存储桶空间管理表 (7 列)，含可见性筛选、桶名搜索与非空桶二次输入桶名强制删除保护 */
export function BucketTable({
  buckets,
  logicalBytes,
  search,
  onSearchChange,
  visFilter,
  onVisFilterChange,
  onOpenBucket,
  onCreate,
  onEdit,
  onDelete,
}: BucketTableProps) {
  const [forceDeleteTarget, setForceDeleteTarget] = useState<Bucket | null>(null);
  const [confirmBucketName, setConfirmBucketName] = useState('');
  const [deleting, setDeleting] = useState(false);

  const closeForceDeleteModal = () => {
    setForceDeleteTarget(null);
    setConfirmBucketName('');
    setDeleting(false);
  };

  const handleConfirmForceDelete = async () => {
    if (!forceDeleteTarget || confirmBucketName.trim() !== forceDeleteTarget.name) return;
    setDeleting(true);
    try {
      await onDelete(forceDeleteTarget.name, true);
      closeForceDeleteModal();
    } finally {
      setDeleting(false);
    }
  };

  const columns = createBucketColumns({
    logicalBytes,
    onOpenBucket,
    onEdit,
    onDeleteEmpty: (name) => void onDelete(name, false),
    onRequestForceDelete: (bucket) => {
      setForceDeleteTarget(bucket);
      setConfirmBucketName('');
    },
  });

  return (
    <div className="lg:col-span-7 bg-white border border-slate-200 rounded-md flex flex-col justify-between">
      <div>
        <div className="px-4 py-3 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FolderOpenOutlined className="text-blue-600" />
            <span className="text-sm font-semibold text-slate-800">
              存储桶空间管理 (Buckets)
            </span>
            <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
              {buckets.length}
            </span>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Segmented
              size="small"
              value={visFilter}
              onChange={(v) => onVisFilterChange(v as VisibilityFilter)}
              options={[
                { label: '全部', value: 'all' },
                { label: '公开读', value: 'public-read' },
                { label: '私有', value: 'private' },
              ]}
            />
            <Input
              size="small"
              placeholder="搜索桶名..."
              prefix={<SearchOutlined className="text-slate-400" />}
              allowClear
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              style={{ width: 150, height: 26 }}
            />
          </div>
        </div>

        <Table
          dataSource={buckets}
          columns={columns}
          rowKey="name"
          pagination={false}
          size="small"
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="暂无存储桶"
              >
                <Button type="primary" size="small" icon={<PlusOutlined />} onClick={onCreate}>
                  创建存储桶
                </Button>
              </Empty>
            ),
          }}
        />
      </div>

      <Modal
        title={
          <div className="flex items-center gap-2 text-red-600">
            <ExclamationCircleFilled />
            <span>强制删除非空存储桶</span>
          </div>
        }
        open={!!forceDeleteTarget}
        onCancel={closeForceDeleteModal}
        onOk={handleConfirmForceDelete}
        okText="确认强制删除"
        cancelText="取消"
        confirmLoading={deleting}
        okButtonProps={{
          danger: true,
          disabled: !forceDeleteTarget || confirmBucketName.trim() !== forceDeleteTarget.name,
        }}
        destroyOnClose
      >
        {forceDeleteTarget && (
          <div className="space-y-3 pt-2">
            <Alert
              type="warning"
              showIcon
              message={`存储桶 "${forceDeleteTarget.name}" 当前非空`}
              description={`桶内共包含 ${forceDeleteTarget.objectCount.toLocaleString()} 个对象（占用 ${formatBytes(forceDeleteTarget.usedBytes)}）。强制删除将永久清空该桶下的所有对象并回收无引用物理块，此操作不可恢复！`}
            />
            <div className="text-xs text-slate-600">
              请在下方输入存储桶名称{' '}
              <code className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 font-mono font-semibold text-red-600 select-all">
                {forceDeleteTarget.name}
              </code>{' '}
              以确认强制删除：
            </div>
            <Input
              placeholder={`请输入 ${forceDeleteTarget.name}`}
              value={confirmBucketName}
              onChange={(e) => setConfirmBucketName(e.target.value)}
              onPressEnter={() => {
                if (confirmBucketName.trim() === forceDeleteTarget.name) {
                  void handleConfirmForceDelete();
                }
              }}
              autoFocus
            />
          </div>
        )}
      </Modal>
    </div>
  );
}
