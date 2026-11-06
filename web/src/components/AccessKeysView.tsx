import React, { useState, useEffect, useCallback } from 'react';
import {
  Card,
  Table,
  Button,
  Tag,
  Space,
  Modal,
  Form,
  Input,
  Select,
  Popconfirm,
  Tabs,
  Typography,
  Row,
  Col,
  Alert,
  Segmented,
  message,
} from 'antd';
import {
  PlusOutlined,
  KeyOutlined,
  CopyOutlined,
  DeleteOutlined,
  EyeOutlined,
  EyeInvisibleOutlined,
  SafetyCertificateOutlined,
  CodeOutlined,
  LinkOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { AccessKeyItem, Bucket, cosApi } from '../lib/api';
import { formatDate, copyToClipboard } from '../lib/utils';

const { Title, Text } = Typography;

interface AccessKeysViewProps {
  buckets: Bucket[];
  baseUrl: string;
  s3Endpoint: string;
  s3Region: string;
  onChanged: () => Promise<void>;
}

export function AccessKeysView({
  buckets,
  baseUrl,
  s3Endpoint,
  s3Region,
  onChanged,
}: AccessKeysViewProps) {
  const [keys, setKeys] = useState<AccessKeyItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [revealedSK, setRevealedSK] = useState<Record<string, boolean>>({});
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();

  // 在线预签名 URL 生成调试器状态
  const [debugBucket, setDebugBucket] = useState<string>('');
  const [debugKey, setDebugKey] = useState<string>('uploads/demo.png');
  const [debugMethod, setDebugMethod] = useState<'GET' | 'PUT'>('PUT');
  const [debugTtl, setDebugTtl] = useState<number>(3600);
  const [generatedPresign, setGeneratedPresign] = useState<string>('');

  useEffect(() => {
    if (!debugBucket && buckets.length > 0) {
      setDebugBucket(buckets[0].name);
    }
  }, [buckets, debugBucket]);

  const fetchKeys = useCallback(async () => {
    setLoading(true);
    try {
      const res = await cosApi.listAccessKeys();
      setKeys(res.accessKeys || []);
    } catch (err: any) {
      if (err?.message === 'UNAUTHORIZED') return;
      message.error(err.message || '加载访问密钥失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const handleCreateKey = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      await cosApi.createAccessKey({
        name: values.name.trim(),
        allowedBuckets: (values.allowedBuckets || '*').trim(),
        permission: values.permission,
      });
      message.success('新访问密钥 (AK/SK) 已签发');
      form.resetFields();
      setModalOpen(false);
      await fetchKeys();
      await onChanged();
    } catch (err: any) {
      if (err?.errorFields) return;
      message.error(err.message || '创建密钥失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteKey = async (ak: string) => {
    try {
      await cosApi.deleteAccessKey(ak);
      message.success(`密钥 ${ak} 已吊销`);
      await fetchKeys();
      await onChanged();
    } catch (err: any) {
      message.error(err.message || '吊销密钥失败');
    }
  };

  const handleGenerateDebugPresign = async () => {
    if (!debugBucket || !debugKey.trim()) {
      message.warning('请选择存储桶并输入对象路径 Key');
      return;
    }
    try {
      const res = await cosApi.presignUrl(debugBucket, {
        key: debugKey.trim(),
        method: debugMethod,
        expiresInSec: debugTtl,
      });
      setGeneratedPresign(res.url);
      await copyToClipboard(res.url);
      message.success(`${debugMethod} 预签名 URL 已生成并复制到剪贴板`);
    } catch (err: any) {
      message.error(err.message || '生成预签名 URL 失败');
    }
  };

  const sampleKey = keys[0] || {
    accessKey: 'COSAK_YOUR_ACCESS_KEY',
    secretKey: 'YOUR_SECRET_KEY',
  };
  const sampleBucket = buckets[0]?.name || 'assets';

  const columns = [
    {
      title: '密钥名称 / 用途备注',
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => (
        <Space>
          <SafetyCertificateOutlined className="text-blue-600" />
          <span className="font-medium text-slate-800">{name}</span>
        </Space>
      ),
    },
    {
      title: 'AccessKey ID (AK)',
      dataIndex: 'accessKey',
      key: 'accessKey',
      render: (ak: string) => (
        <Text copyable className="font-mono text-xs text-blue-600 font-medium">
          {ak}
        </Text>
      ),
    },
    {
      title: 'SecretKey (SK)',
      dataIndex: 'secretKey',
      key: 'secretKey',
      render: (sk: string, record: AccessKeyItem) => {
        const revealed = !!revealedSK[record.accessKey];
        return (
          <Space size={6}>
            <code className="text-xs font-mono bg-slate-100 px-2 py-0.5 rounded text-slate-700">
              {revealed ? sk : '••••••••••••••••••••••••'}
            </code>
            <Button
              type="text"
              size="small"
              aria-label={revealed ? '隐藏 SecretKey' : '显示 SecretKey'}
              icon={revealed ? <EyeInvisibleOutlined /> : <EyeOutlined />}
              onClick={() =>
                setRevealedSK((prev) => ({
                  ...prev,
                  [record.accessKey]: !revealed,
                }))
              }
            />
            <Button
              type="text"
              size="small"
              aria-label="复制 SecretKey"
              icon={<CopyOutlined />}
              onClick={async () => {
                await copyToClipboard(sk);
                message.success('SecretKey 已复制');
              }}
            />
          </Space>
        );
      },
    },
    {
      title: '授权存储桶',
      dataIndex: 'allowedBuckets',
      key: 'allowedBuckets',
      render: (b: string) => (
        <Tag color="blue" className="m-0 font-mono">
          {b === '*' ? '* (全部存储桶)' : b}
        </Tag>
      ),
    },
    {
      title: '权限策略',
      dataIndex: 'permission',
      key: 'permission',
      render: (perm: string) => {
        if (perm === 'admin') return <Tag color="gold">管理员 (admin)</Tag>;
        if (perm === 'readwrite') return <Tag color="green">读写 (readwrite)</Tag>;
        return <Tag>只读 (read)</Tag>;
      },
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: (iso: string) => (
        <span className="font-mono text-xs text-slate-500">{formatDate(iso)}</span>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 100,
      align: 'right' as const,
      render: (_: unknown, record: AccessKeyItem) => (
        <Popconfirm
          title={`确定吊销密钥 "${record.accessKey}"？`}
          description="吊销后使用该密钥的客户端或图床将立即无法访问。"
          okText="确认吊销"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => handleDeleteKey(record.accessKey)}
        >
          <Button type="text" size="small" danger icon={<DeleteOutlined />}>
            吊销
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const picgoCode = `# 适用于 PicGo (picgo-plugin-s3) 或 Obsidian Remotely Save
应用密钥 ID (AccessKeyID)     : ${sampleKey.accessKey}
应用密钥 (SecretAccessKey)    : ${sampleKey.secretKey}
桶名 (Bucket)                 : ${sampleBucket}
区域 (Region)                 : ${s3Region}
自定义节点 (Endpoint)         : ${s3Endpoint}
强制路径样式 (ForcePathStyle) : true (开启)
上传路径模板 (UploadPath)     : {year}/{month}/{md5}.{extName}
自定义域名 (Custom URL)       : ${baseUrl}/raw/${sampleBucket}`;

  const rcloneCode = `[nanocos]
type = s3
provider = Other
env_auth = false
access_key_id = ${sampleKey.accessKey}
secret_access_key = ${sampleKey.secretKey}
endpoint = ${s3Endpoint}
region = ${s3Region}
force_path_style = true

# 验证与同步示例:
# rclone ls nanocos:${sampleBucket}
# rclone sync ./my-folder nanocos:${sampleBucket}/backup`;

  const sdkCode = `import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  region: "${s3Region}",
  endpoint: "${s3Endpoint}",
  forcePathStyle: true,
  credentials: {
    accessKeyId: "${sampleKey.accessKey}",
    secretAccessKey: "${sampleKey.secretKey}",
  },
});

// 上传对象
await s3.send(new PutObjectCommand({
  Bucket: "${sampleBucket}",
  Key: "app/config.json",
  Body: JSON.stringify({ env: "production" }),
  ContentType: "application/json",
}));`;

  const curlCode = `# 1. 现代 REST API 流式上传 (自动 SHA-256 去重)
curl -X PUT "${baseUrl}/api/v1/buckets/${sampleBucket}/objects/docs/manual.pdf" \\
  -H "X-Cos-Access-Key: ${sampleKey.accessKey}" \\
  -H "X-Cos-Secret-Key: ${sampleKey.secretKey}" \\
  --data-binary "@./manual.pdf"

# 2. SHA-256 零字节秒传探测
curl -X POST "${baseUrl}/api/v1/buckets/${sampleBucket}/fast-upload" \\
  -H "X-Cos-Access-Key: ${sampleKey.accessKey}" \\
  -H "X-Cos-Secret-Key: ${sampleKey.secretKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"key":"docs/copy.pdf","sha256":"<64位SHA256>","contentType":"application/pdf"}'`;

  return (
    <div className="space-y-4">
      {/* 顶部标题 */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-white border border-slate-200 rounded-md px-5 py-4">
        <div>
          <h1 className="text-base font-bold text-slate-900 m-0">
            访问密钥 (AK/SK) &amp; S3 生态工具箱
          </h1>
          <p className="text-xs text-slate-500 mt-0.5 mb-0">
            管理多租户 API 访问凭证、在线签发预签名直传/下载 URL，一键对接 S3 客户端生态
          </p>
        </div>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            form.setFieldsValue({
              name: '',
              allowedBuckets: '*',
              permission: 'readwrite',
            });
            setModalOpen(true);
          }}
        >
          签发新密钥 (AK/SK)
        </Button>
      </div>

      {/* 密钥列表 */}
      <Card
        className="border-slate-200 shadow-none"
        title={
          <Space>
            <KeyOutlined className="text-blue-600" />
            <span className="font-semibold text-sm">已签发的访问凭证 (Access Keys)</span>
            <Tag className="m-0 font-mono">{keys.length}</Tag>
          </Space>
        }
        styles={{ body: { padding: 0 } }}
      >
        <Table
          dataSource={keys}
          columns={columns}
          rowKey="accessKey"
          loading={loading}
          pagination={false}
          size="middle"
        />
      </Card>

      {/* 在线预签名 URL 签发器 & S3 接入配置 */}
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={10}>
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
                    value={debugBucket || undefined}
                    onChange={setDebugBucket}
                    placeholder="选择存储桶"
                    options={buckets.map((b) => ({ value: b.name, label: b.name }))}
                  />
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-1">授权操作方法 (Method)</div>
                  <Segmented
                    block
                    value={debugMethod}
                    onChange={(v) => setDebugMethod(v as 'GET' | 'PUT')}
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
                  value={debugKey}
                  onChange={(e) => setDebugKey(e.target.value)}
                  placeholder="例如: uploads/2026/avatar.png"
                  className="font-mono"
                />
              </div>

              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">链接有效期:</span>
                <Segmented
                  size="small"
                  value={debugTtl}
                  onChange={(v) => setDebugTtl(Number(v))}
                  options={[
                    { label: '15分钟', value: 900 },
                    { label: '1小时', value: 3600 },
                    { label: '24小时', value: 86400 },
                    { label: '7天', value: 604800 },
                  ]}
                />
              </div>

              <Button
                type="primary"
                block
                icon={<LinkOutlined />}
                onClick={handleGenerateDebugPresign}
              >
                生成并复制 {debugMethod} 预签名 URL
              </Button>

              {generatedPresign && (
                <div className="pt-2 space-y-2">
                  <Input.TextArea
                    value={generatedPresign}
                    readOnly
                    rows={2}
                    className="font-mono text-xs"
                  />
                  {debugMethod === 'PUT' && (
                    <pre className="text-[11px] font-mono bg-slate-900 text-slate-100 p-2.5 rounded-lg overflow-x-auto">
{`# 使用生成的 PUT 预签名链接免密钥直传文件:
curl -X PUT "${generatedPresign}" --data-binary "@./localfile.png"`}
                    </pre>
                  )}
                </div>
              )}
            </div>
          </Card>
        </Col>

        <Col xs={24} xl={14}>
          <Card
            className="border-slate-200 shadow-none h-full"
            title={
              <Space>
                <CodeOutlined className="text-blue-600" />
                <span className="font-semibold text-sm">
                  客户端与 S3 工具接入配置（已自动填入当前密钥）
                </span>
              </Space>
            }
          >
            <Tabs
              items={[
                {
                  key: 'picgo',
                  label: 'PicGo / Obsidian 图床',
                  children: (
                    <div className="space-y-2">
                      <div className="flex justify-end">
                        <Button
                          size="small"
                          icon={<CopyOutlined />}
                          onClick={async () => {
                            await copyToClipboard(picgoCode);
                            message.success('PicGo 配置参数已复制');
                          }}
                        >
                          复制配置
                        </Button>
                      </div>
                      <pre className="text-xs font-mono bg-slate-900 text-slate-100 p-4 rounded-xl overflow-x-auto leading-relaxed">
                        {picgoCode}
                      </pre>
                    </div>
                  ),
                },
                {
                  key: 'rclone',
                  label: 'Rclone 挂载与备份',
                  children: (
                    <div className="space-y-2">
                      <div className="flex justify-end">
                        <Button
                          size="small"
                          icon={<CopyOutlined />}
                          onClick={async () => {
                            await copyToClipboard(rcloneCode);
                            message.success('rclone.conf 配置已复制');
                          }}
                        >
                          复制 rclone.conf
                        </Button>
                      </div>
                      <pre className="text-xs font-mono bg-slate-900 text-slate-100 p-4 rounded-xl overflow-x-auto leading-relaxed">
                        {rcloneCode}
                      </pre>
                    </div>
                  ),
                },
                {
                  key: 'sdk',
                  label: 'AWS S3 SDK (Node.js)',
                  children: (
                    <div className="space-y-2">
                      <div className="flex justify-end">
                        <Button
                          size="small"
                          icon={<CopyOutlined />}
                          onClick={async () => {
                            await copyToClipboard(sdkCode);
                            message.success('S3 SDK 示例代码已复制');
                          }}
                        >
                          复制代码
                        </Button>
                      </div>
                      <pre className="text-xs font-mono bg-slate-900 text-slate-100 p-4 rounded-xl overflow-x-auto leading-relaxed">
                        {sdkCode}
                      </pre>
                    </div>
                  ),
                },
                {
                  key: 'curl',
                  label: 'cURL 流式直传 & 秒传',
                  children: (
                    <div className="space-y-2">
                      <div className="flex justify-end">
                        <Button
                          size="small"
                          icon={<CopyOutlined />}
                          onClick={async () => {
                            await copyToClipboard(curlCode);
                            message.success('cURL 示例命令已复制');
                          }}
                        >
                          复制命令
                        </Button>
                      </div>
                      <pre className="text-xs font-mono bg-slate-900 text-slate-100 p-4 rounded-xl overflow-x-auto leading-relaxed">
                        {curlCode}
                      </pre>
                    </div>
                  ),
                },
              ]}
            />
          </Card>
        </Col>
      </Row>

      {/* 签发新密钥弹窗 */}
      <Modal
        title="签发新 API 访问密钥 (Create AccessKey)"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleCreateKey}
        confirmLoading={submitting}
        okText="立即签发"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={form} layout="vertical" className="mt-4" requiredMark={false}>
          <Form.Item
            label="密钥备注名称"
            name="name"
            rules={[{ required: true, message: '请输入密钥用途备注' }]}
          >
            <Input placeholder="例如: PicGo 个人图床 / 生产库每日备份" autoFocus />
          </Form.Item>

          <Form.Item
            label="允许访问的存储桶范围"
            name="allowedBuckets"
            extra="填 * 表示允许访问所有存储桶；若限制特定桶请用英文逗号分隔，如 assets,images"
            rules={[{ required: true, message: '请输入授权存储桶范围' }]}
          >
            <Input className="font-mono" placeholder="*" />
          </Form.Item>

          <Form.Item label="权限级别" name="permission">
            <Select
              options={[
                {
                  value: 'readwrite',
                  label: '读写权限 (readwrite) — 可上传、下载、预览与删除授权桶内对象',
                },
                {
                  value: 'read',
                  label: '只读权限 (read) — 仅可列举与下载授权桶内对象',
                },
                {
                  value: 'admin',
                  label: '管理员权限 (admin) — 可创建/删除存储桶及管理全站对象',
                },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
