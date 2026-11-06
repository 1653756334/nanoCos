import { useMemo } from 'react';
import { Card, Col, Row, Typography } from 'antd';
import { Bucket } from '../../../lib/api';
import { buildQuickStartSnippets } from '../utils/quickStart';

const { Title } = Typography;

interface QuickStartTabProps {
  bucket: Bucket;
  baseUrl: string;
  s3Endpoint: string;
  s3Region: string;
}

export function QuickStartTab({
  bucket,
  baseUrl,
  s3Endpoint,
  s3Region,
}: QuickStartTabProps) {
  const snippets = useMemo(
    () =>
      buildQuickStartSnippets({
        bucketName: bucket.name,
        baseUrl,
        s3Endpoint,
        s3Region,
      }),
    [bucket.name, baseUrl, s3Endpoint, s3Region]
  );

  return (
    <Card className="border-slate-200 shadow-none">
      <Title level={5}>
        存储桶 <code className="text-blue-600">{bucket.name}</code> 快速调用示例
      </Title>
      <Row gutter={[16, 16]} className="mt-4">
        <Col xs={24} lg={12}>
          <Card size="small" title="1. cURL 流式直传与直链读取">
            <pre className="text-xs font-mono bg-slate-900 text-slate-100 p-3.5 rounded overflow-x-auto leading-relaxed">
              {snippets.curl}
            </pre>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="2. PicGo / Rclone S3 兼容接入参数">
            <pre className="text-xs font-mono bg-slate-900 text-slate-100 p-3.5 rounded overflow-x-auto leading-relaxed">
              {snippets.s3Params}
            </pre>
          </Card>
        </Col>
      </Row>
    </Card>
  );
}
