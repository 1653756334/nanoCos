import { Button, Card, Descriptions, Drawer, Image, Input, Popconfirm, Segmented, Space, Spin, Tag, Typography, message } from 'antd';
import {
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  LinkOutlined,
} from '@ant-design/icons';
import { StorageObject } from '../../../lib/api';
import { copyToClipboard, formatBytes, formatDate } from '../../../lib/utils';
import { PRESIGN_TTL_OPTIONS } from '../constants';
import { FileTypeIcon } from './FileTypeIcon';

const { Text } = Typography;

interface ObjectInspectorDrawerProps {
  inspectObj: StorageObject | null;
  rawUrl: string;
  presignedUrl: string;
  presignTtl: number;
  loadingPresign?: boolean;
  textPreview: string | null;
  isPublicBucket: boolean;
  onClose: () => void;
  onUpdatePresignTtl: (ttl: number) => Promise<string>;
  onDownload: (obj: StorageObject) => void;
  onDeleteSingle: (obj: StorageObject) => void;
}

export function ObjectInspectorDrawer({
  inspectObj,
  rawUrl,
  presignedUrl,
  presignTtl,
  loadingPresign = false,
  textPreview,
  isPublicBucket,
  onClose,
  onUpdatePresignTtl,
  onDownload,
  onDeleteSingle,
}: ObjectInspectorDrawerProps) {
  const mediaPreviewSrc = isPublicBucket ? rawUrl : presignedUrl || rawUrl;

  const ensurePresignedUrl = async (): Promise<string> => {
    if (presignedUrl) return presignedUrl;
    return onUpdatePresignTtl(presignTtl);
  };

  return (
    <Drawer
      title={
        <div className="flex items-center gap-2 pr-4">
          {inspectObj && <FileTypeIcon object={inspectObj} />}
          <span className="truncate font-mono text-sm">
            {inspectObj?.name || '对象详情'}
          </span>
        </div>
      }
      placement="right"
      width={560}
      open={!!inspectObj}
      onClose={onClose}
      extra={
        inspectObj && (
          <Space>
            <Button
              size="small"
              type="primary"
              icon={<DownloadOutlined />}
              onClick={() => onDownload(inspectObj)}
            >
              下载
            </Button>
            <Popconfirm
              title="确定永久删除该对象？"
              onConfirm={() => onDeleteSingle(inspectObj)}
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
            >
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          </Space>
        )
      }
    >
      {inspectObj && (
        <div className="space-y-5">
          {/* 1. 媒体在线预览画布 */}
          <div className="rounded-xl bg-slate-900 border border-slate-200 p-4 flex items-center justify-center min-h-[220px] overflow-hidden">
            {!isPublicBucket && loadingPresign && !presignedUrl ? (
              <div className="py-10 text-center space-y-2">
                <Spin />
                <div className="text-xs text-slate-400">正在签发私有预览授权...</div>
              </div>
            ) : inspectObj.contentType.toLowerCase().startsWith('image/') ? (
              <Image
                src={mediaPreviewSrc}
                alt={inspectObj.name}
                style={{ maxHeight: 320, objectFit: 'contain' }}
              />
            ) : inspectObj.contentType.toLowerCase().startsWith('video/') ? (
              <video
                src={mediaPreviewSrc}
                controls
                preload="metadata"
                className="w-full max-h-[320px] rounded-lg"
              />
            ) : inspectObj.contentType.toLowerCase().startsWith('audio/') ? (
              <audio src={mediaPreviewSrc} controls className="w-full" />
            ) : textPreview !== null ? (
              <div className="w-full">
                <div className="flex items-center justify-between text-xs text-slate-400 mb-2 pb-1.5 border-b border-slate-800">
                  <span>文本 / 代码预览</span>
                  <Button
                    size="small"
                    type="text"
                    className="text-slate-300"
                    icon={<CopyOutlined />}
                    onClick={async () => {
                      await copyToClipboard(textPreview);
                      message.success('文件内容已复制');
                    }}
                  >
                    复制内容
                  </Button>
                </div>
                <pre className="text-xs font-mono text-slate-100 max-h-[280px] overflow-auto whitespace-pre-wrap break-all">
                  {textPreview}
                </pre>
              </div>
            ) : (
              <div className="text-center text-slate-400 py-8 space-y-2">
                <div><FileTypeIcon object={inspectObj} sizeClass="text-4xl" /></div>
                <div className="text-xs">
                  当前文件类型不支持内联预览，可点击右上角下载或复制外链
                </div>
              </div>
            )}
          </div>

          {/* 2. 对象属性表 */}
          <div>
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
              对象元数据 (Metadata)
            </div>
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="对象路径 (Key)">
                <Text copyable className="font-mono text-xs break-all">
                  {inspectObj.key}
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label="文件大小">
                <span className="font-mono text-xs">
                  {formatBytes(inspectObj.sizeBytes)} ({inspectObj.sizeBytes.toLocaleString()} Bytes)
                </span>
              </Descriptions.Item>
              <Descriptions.Item label="Content-Type">
                <Tag color="blue" className="m-0 font-mono text-xs">
                  {inspectObj.contentType}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="ETag (MD5)">
                <Text copyable className="font-mono text-xs">
                  {inspectObj.etag || '-'}
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label="CAS SHA-256">
                {inspectObj.blobSha256 ? (
                  <Text copyable className="font-mono text-xs break-all text-slate-600">
                    {inspectObj.blobSha256}
                  </Text>
                ) : (
                  '-'
                )}
              </Descriptions.Item>
              <Descriptions.Item label="最后修改时间">
                <span className="font-mono text-xs">{formatDate(inspectObj.updatedAt)}</span>
              </Descriptions.Item>
            </Descriptions>
          </div>

          {/* 3. 外链分享与引用：公开桶仅展示永久直链；私有桶仅展示预签名临时授权链接（不再展示 403 无签名死链） */}
          {isPublicBucket ? (
            <Card
              size="small"
              title="公开永久直链与引用 (免鉴权无签名)"
              extra={
                <Tag color="green" className="m-0">
                  公开直链 · 永久有效
                </Tag>
              }
            >
              <div className="space-y-2.5">
                <Input
                  value={rawUrl}
                  readOnly
                  className="font-mono text-xs"
                  addonAfter={
                    <button
                      onClick={async () => {
                        await copyToClipboard(rawUrl);
                        message.success('公开永久直链已复制');
                      }}
                      className="text-xs font-medium text-blue-600 cursor-pointer"
                    >
                      复制公开链接
                    </button>
                  }
                />
                <div className="flex gap-2">
                  <Button
                    size="small"
                    icon={<CopyOutlined />}
                    onClick={async () => {
                      await copyToClipboard(`![${inspectObj.name}](${rawUrl})`);
                      message.success('Markdown 格式已复制');
                    }}
                  >
                    复制 Markdown
                  </Button>
                  <Button
                    size="small"
                    icon={<CopyOutlined />}
                    onClick={async () => {
                      await copyToClipboard(`<img src="${rawUrl}" alt="${inspectObj.name}" />`);
                      message.success('HTML 标签已复制');
                    }}
                  >
                    复制 HTML
                  </Button>
                </div>
              </div>
            </Card>
          ) : (
            <Card
              size="small"
              title="预签名临时分享链接 (Presigned URL)"
              extra={<Tag color="purple" className="m-0">私有桶限时授权外发</Tag>}
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-xs text-slate-500">选择授权有效期:</span>
                  <Segmented
                    size="small"
                    value={presignTtl}
                    disabled={loadingPresign}
                    onChange={(v) => {
                      void onUpdatePresignTtl(Number(v));
                    }}
                    options={PRESIGN_TTL_OPTIONS}
                  />
                </div>
                <Input
                  value={presignedUrl}
                  readOnly
                  className="font-mono text-xs"
                  placeholder="正在签发临时链接..."
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="primary"
                    className="flex-1"
                    icon={<LinkOutlined />}
                    loading={loadingPresign}
                    onClick={async () => {
                      const activeUrl = await ensurePresignedUrl();
                      if (activeUrl) {
                        await copyToClipboard(activeUrl);
                        message.success('带签名的临时访问链接已复制');
                      }
                    }}
                  >
                    复制预签名临时链接
                  </Button>
                  <Button
                    icon={<CopyOutlined />}
                    disabled={loadingPresign}
                    onClick={async () => {
                      const activeUrl = await ensurePresignedUrl();
                      if (activeUrl) {
                        await copyToClipboard(`![${inspectObj.name}](${activeUrl})`);
                        message.success('带临时签名的 Markdown 已复制');
                      }
                    }}
                  >
                    复制 Markdown
                  </Button>
                  <Button
                    icon={<CopyOutlined />}
                    disabled={loadingPresign}
                    onClick={async () => {
                      const activeUrl = await ensurePresignedUrl();
                      if (activeUrl) {
                        await copyToClipboard(`<img src="${activeUrl}" alt="${inspectObj.name}" />`);
                        message.success('带临时签名的 HTML 已复制');
                      }
                    }}
                  >
                    复制 HTML
                  </Button>
                </div>
              </div>
            </Card>
          )}
        </div>
      )}
    </Drawer>
  );
}
