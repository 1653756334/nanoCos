import { Badge, Button, Card, Select, Space, Tabs, Tag } from 'antd';
import {
  CodeSandboxOutlined,
  FolderAddOutlined,
  FolderFilled,
  GlobalOutlined,
  LockOutlined,
  SettingOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { Bucket } from '../../../lib/api';
import { ExplorerTab } from '../../../lib/routes';
import { formatBytes, formatDate } from '../../../lib/utils';

interface ExplorerHeaderProps {
  buckets: Bucket[];
  currentBucket?: Bucket;
  selectedBucketName: string;
  activeTab: ExplorerTab;
  uploadingCount: number;
  onSelectBucket: (name: string) => void;
  onTabChange: (tab: ExplorerTab) => void;
  onOpenUpload: () => void;
  onOpenCreateFolder: () => void;
}

export function ExplorerHeader({
  buckets,
  currentBucket,
  selectedBucketName,
  activeTab,
  uploadingCount,
  onSelectBucket,
  onTabChange,
  onOpenUpload,
  onOpenCreateFolder,
}: ExplorerHeaderProps) {
  return (
    <Card className="border-slate-200 shadow-none" styles={{ body: { padding: '16px 24px 0' } }}>
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 pb-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="w-9 h-9 rounded bg-blue-600 text-white flex items-center justify-center text-base">
            <FolderFilled />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <Select
                value={selectedBucketName || undefined}
                onChange={onSelectBucket}
                placeholder="选择存储桶"
                style={{ minWidth: 200 }}
                className="font-mono font-semibold"
                options={buckets.map((b) => ({
                  value: b.name,
                  label: `🪣 ${b.name}`,
                }))}
              />
              {currentBucket &&
                (currentBucket.visibility === 'public-read' ? (
                  <Tag icon={<GlobalOutlined />} color="success" className="m-0">
                    公开读私有写
                  </Tag>
                ) : (
                  <Tag icon={<LockOutlined />} color="warning" className="m-0">
                    私有读写
                  </Tag>
                ))}
            </div>
            {currentBucket && (
              <div className="text-xs text-slate-500 mt-1.5 flex items-center gap-4 flex-wrap">
                <span>
                  已用空间:{' '}
                  <strong className="font-mono text-slate-700">
                    {formatBytes(currentBucket.usedBytes)}
                  </strong>
                </span>
                <span>
                  配额限制:{' '}
                  <strong className="font-mono text-slate-700">
                    {currentBucket.quotaBytes > 0
                      ? formatBytes(currentBucket.quotaBytes)
                      : '无限制'}
                  </strong>
                </span>
                <span>
                  对象数量:{' '}
                  <strong className="font-mono text-slate-700">
                    {currentBucket.objectCount.toLocaleString()}
                  </strong>
                </span>
                <span>创建时间: {formatDate(currentBucket.createdAt)}</span>
              </div>
            )}
          </div>
        </div>

        <Space wrap>
          <Badge count={uploadingCount}>
            <Button
              type="primary"
              icon={<UploadOutlined />}
              onClick={onOpenUpload}
              disabled={!selectedBucketName}
            >
              上传文件 / 任务中心
            </Button>
          </Badge>
          <Button
            icon={<FolderAddOutlined />}
            onClick={onOpenCreateFolder}
            disabled={!selectedBucketName}
          >
            新建目录
          </Button>
        </Space>
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={(k) => onTabChange(k as ExplorerTab)}
        items={[
          {
            key: 'objects',
            label: (
              <span className="flex items-center gap-1.5">
                <FolderFilled />
                文件管理 (Objects)
              </span>
            ),
          },
          {
            key: 'settings',
            label: (
              <span className="flex items-center gap-1.5">
                <SettingOutlined />
                权限与配额配置 (Settings)
              </span>
            ),
          },
          {
            key: 'guide',
            label: (
              <span className="flex items-center gap-1.5">
                <CodeSandboxOutlined />
                当前桶快速接入 (Quick Start)
              </span>
            ),
          },
        ]}
      />
    </Card>
  );
}
