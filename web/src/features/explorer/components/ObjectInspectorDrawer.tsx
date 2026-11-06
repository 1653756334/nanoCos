import { Button, Card, Descriptions, Drawer, Image, Input, Popconfirm, Segmented, Space, Tag, Typography, message } from 'antd';
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
  textPreview: string | null;
  isPublicBucket: boolean;
  onClose: () => void;
  onUpdatePresignTtl: (ttl: number) => Promise<string>;
  onDeleteSingle: (obj: StorageObject) => void;
}

export function ObjectInspectorDrawer({
  inspectObj,
  rawUrl,
  presignedUrl,
  presignTtl,
  textPreview,
  isPublicBucket,
  onClose,
  onUpdatePresignTtl,
  onDeleteSingle,
}: ObjectInspectorDrawerProps) {
  const downloadUrl = isPublicBucket
    ? `${rawUrl}${rawUrl.includes('?') ? '&' : '?'}download=1`
    : `${presignedUrl || rawUrl}${(presignedUrl || rawUrl).includes('?') ? '&' : '?'}download=1`;

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
            <a
              href={downloadUrl}
              target="_blank"
              rel="noreferrer"
            >
              <Button size="small" type="primary" icon={<DownloadOutlined />}>
                下载
              </Button>
            </a>
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
            {inspectObj.contentType.toLowerCase().startsWith('image/') ? (
              <Image
                src={presignedUrl || rawUrl}
                alt={inspectObj.name}
                style={{ maxHeight: 320, objectFit: 'contain' }}
              />
            ) : inspectObj.contentType.toLowerCase().startsWith('video/') ? (
              <video
                src={presignedUrl || rawUrl}
                controls
                preload="metadata"
                className="w-full max-h-[320px] rounded-lg"
              />
            ) : inspectObj.contentType.toLowerCase().startsWith('audio/') ? (
              <audio src={presignedUrl || rawUrl} controls className="w-full" />
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

          {/* 3. 直链与 Markdown 引用 */}
          <Card
            size="small"
            title={isPublicBucket ? '公开永久直链 (免鉴权无签名)' : '固定直链与 Markdown 引用'}
            extra={
              <Tag color={isPublicBucket ? 'green' : 'gold'} className="m-0">
                {isPublicBucket ? '公开直链 · 永久有效' : '需要鉴权'}
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
                      message.success(isPublicBucket ? '公开永久直链已复制' : '直链 URL 已复制');
                    }}
                    className="text-xs font-medium text-blue-600 cursor-pointer"
                  >
                    {isPublicBucket ? '复制公开链接' : '复制 URL'}
                  </button>
                }
              />
              <div className="flex gap-2">
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={async () => {
                    const targetUrl = !isPublicBucket && presignedUrl ? presignedUrl : rawUrl;
                    await copyToClipboard(`![${inspectObj.name}](${targetUrl})`);
                    message.success('Markdown 格式已复制');
                  }}
                >
                  复制 Markdown
                </Button>
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={async () => {
                    const targetUrl = !isPublicBucket && presignedUrl ? presignedUrl : rawUrl;
                    await copyToClipboard(`<img src="${targetUrl}" alt="${inspectObj.name}" />`);
                    message.success('HTML 标签已复制');
                  }}
                >
                  复制 HTML
                </Button>
              </div>
            </div>
          </Card>

          {/* 4. 预签名临时授权链接 (仅私有桶显示；公开桶本身可直接访问，无需附加临时签名后缀) */}
          {!isPublicBucket && (
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
                <Button
                  type="primary"
                  block
                  icon={<LinkOutlined />}
                  onClick={async () => {
                    let activeUrl = presignedUrl;
                    if (!activeUrl) {
                      activeUrl = await onUpdatePresignTtl(presignTtl);
                    }
                    if (activeUrl) {
                      await copyToClipboard(activeUrl);
                      message.success('带签名的临时访问链接已复制');
                    }
                  }}
                >
                  复制预签名临时链接
                </Button>
              </div>
            </Card>
          )}
        </div>
      )}
    </Drawer>
  );
}
