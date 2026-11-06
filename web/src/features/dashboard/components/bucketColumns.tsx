import { Button, Popconfirm, Space, Tag, Tooltip } from 'antd';
import type { TableColumnsType } from 'antd';
import {
  DeleteOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  LockOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import type { Bucket } from '../../../lib/api';
import { formatBytes, formatDate } from '../../../lib/utils';
import { calcBucketUsagePercent } from '../metrics';

interface BucketColumnsOptions {
  /** 全局逻辑总容量，无配额的桶以此计算进度 */
  logicalBytes?: number;
  onOpenBucket: (bucketName: string) => void;
  onEdit: (bucket: Bucket) => void;
  onDelete: (name: string) => void;
}

/** 存储桶管理表的列定义 */
export function createBucketColumns({
  logicalBytes,
  onOpenBucket,
  onEdit,
  onDelete,
}: BucketColumnsOptions): TableColumnsType<Bucket> {
  return [
    {
      title: '存储桶名称',
      dataIndex: 'name',
      key: 'name',
      width: 180,
      render: (name: string) => (
        <button
          onClick={() => onOpenBucket(name)}
          className="group inline-flex items-center gap-2 text-left font-medium text-slate-800 hover:text-blue-600 transition-colors cursor-pointer"
        >
          <div className="w-6 h-6 rounded bg-blue-50 border border-blue-100 flex items-center justify-center text-blue-600 group-hover:bg-blue-600 group-hover:text-white transition-colors">
            <FolderOpenOutlined className="text-xs" />
          </div>
          <span className="font-mono text-xs font-semibold">{name}</span>
        </button>
      ),
    },
    {
      title: '访问权限',
      dataIndex: 'visibility',
      key: 'visibility',
      width: 130,
      render: (vis: string) =>
        vis === 'public-read' ? (
          <Tag icon={<GlobalOutlined />} color="success" className="m-0 text-xs">
            公开读
          </Tag>
        ) : (
          <Tag icon={<LockOutlined />} color="warning" className="m-0 text-xs">
            私有空间
          </Tag>
        ),
    },
    {
      title: '对象数',
      dataIndex: 'objectCount',
      key: 'objectCount',
      width: 90,
      render: (cnt: number) => (
        <span className="font-mono text-xs text-slate-700">{cnt.toLocaleString()}</span>
      ),
    },
    {
      title: '容量占用 / 配额',
      key: 'usage',
      render: (_: unknown, record: Bucket) => {
        const hasQuota = record.quotaBytes > 0;
        const pct = calcBucketUsagePercent(record, logicalBytes);
        return (
          <div className="max-w-[180px]">
            <div className="flex items-center justify-between text-xs font-mono mb-1">
              <span className="text-slate-700 font-medium">{formatBytes(record.usedBytes)}</span>
              <span className="text-slate-400 text-[11px]">
                {hasQuota ? `/ ${formatBytes(record.quotaBytes)}` : '/ 不限'}
              </span>
            </div>
            <div className="h-1.5 w-full rounded bg-slate-100 overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all"
                style={{ width: `${record.usedBytes > 0 ? Math.max(8, pct) : 0}%` }}
              />
            </div>
          </div>
        );
      },
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 155,
      render: (iso: string) => (
        <span className="text-xs text-slate-400 font-mono">{formatDate(iso)}</span>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 150,
      align: 'right' as const,
      render: (_: unknown, record: Bucket) => (
        <Space size={2}>
          <Button type="link" size="small" onClick={() => onOpenBucket(record.name)}>
            管理
          </Button>
          <Tooltip title="配置存储桶">
            <Button
              type="text"
              size="small"
              aria-label={`配置存储桶 ${record.name}`}
              icon={<SettingOutlined />}
              onClick={() => onEdit(record)}
            />
          </Tooltip>
          <Popconfirm
            title={`确定删除存储桶 "${record.name}"？`}
            description="将清空桶内所有文件并回收无引用物理块。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => onDelete(record.name)}
          >
            <Button
              type="text"
              size="small"
              danger
              aria-label={`删除存储桶 ${record.name}`}
              icon={<DeleteOutlined />}
            />
          </Popconfirm>
        </Space>
      ),
    },
  ];
}
