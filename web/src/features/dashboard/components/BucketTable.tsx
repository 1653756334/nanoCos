import { Button, Empty, Input, Segmented, Table } from 'antd';
import { FolderOpenOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import type { Bucket } from '../../../lib/api';
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
  onDelete: (name: string) => void;
}

/** 左侧：存储桶空间管理表 (7 列)，含可见性筛选与桶名搜索 */
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
  const columns = createBucketColumns({ logicalBytes, onOpenBucket, onEdit, onDelete });

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
    </div>
  );
}
