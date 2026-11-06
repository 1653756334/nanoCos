import { Alert, Button, Card, Input, Segmented, Select, Space } from 'antd';
import { LinkOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { Bucket } from '../../../lib/api';
import { buildPresignPutCurl } from '../snippets';
import { usePresignDebugger } from '../hooks/usePresignDebugger';
import type { PresignMethod } from '../types';

interface PresignDebuggerProps {
  buckets: Bucket[];
}

/** 在线预签名 URL 签发器卡片 */
export function PresignDebugger({ buckets }: PresignDebuggerProps) {
  const {
    bucket,
    setBucket,
    objectKey,
    setObjectKey,
    method,
    setMethod,
    ttl,
    setTtl,
    generatedUrl,
    generate,
  } = usePresignDebugger(buckets);

  return (
    <Card
      className="border-slate-200 shadow-none h-full"
      title={
        <Space>
          <ThunderboltOutlined className="text-purple-600" />
          <span className="font-semibold text-sm">
            在线预签名 URL 签发器 (Presigned URL Generator)
          </span>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        className="mb-4"
        message="前端无密钥安全直传 / 私有文件限时分享"
        description="通过服务端签发带有效期的 PUT 或 GET 预签名 URL，客户端无需暴露 AK/SK 即可直接向 NanoCOS 上传或下载文件。"
      />

      <div className="space-y-3.5">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs text-slate-500 mb-1">目标存储桶 (Bucket)</div>
            <Select
              className="w-full font-mono"
              value={bucket || undefined}
              onChange={setBucket}
              placeholder="选择存储桶"
              options={buckets.map((b) => ({ value: b.name, label: b.name }))}
            />
          </div>
          <div>
            <div className="text-xs text-slate-500 mb-1">授权操作方法 (Method)</div>
            <Segmented
              block
              value={method}
              onChange={(v) => setMethod(v as PresignMethod)}
              options={[
                { label: 'PUT (前端直传)', value: 'PUT' },
                { label: 'GET (限时下载)', value: 'GET' },
              ]}
            />
          </div>
        </div>

        <div>
          <div className="text-xs text-slate-500 mb-1">目标对象路径 (Object Key)</div>
          <Input
            value={objectKey}
            onChange={(e) => setObjectKey(e.target.value)}
            placeholder="例如: uploads/2026/avatar.png"
            className="font-mono"
          />
        </div>

        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500">链接有效期:</span>
          <Segmented
            size="small"
            value={ttl}
            onChange={(v) => setTtl(Number(v))}
            options={[
              { label: '15分钟', value: 900 },
              { label: '1小时', value: 3600 },
              { label: '24小时', value: 86400 },
              { label: '7天', value: 604800 },
            ]}
          />
        </div>

        <Button type="primary" block icon={<LinkOutlined />} onClick={generate}>
          生成并复制 {method} 预签名 URL
        </Button>

        {generatedUrl && (
          <div className="pt-2 space-y-2">
            <Input.TextArea
              value={generatedUrl}
              readOnly
              rows={2}
              className="font-mono text-xs"
            />
            {method === 'PUT' && (
              <pre className="text-[11px] font-mono bg-slate-900 text-slate-100 p-2.5 rounded-lg overflow-x-auto">
                {buildPresignPutCurl(generatedUrl)}
              </pre>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
