import { Button, Card, Popconfirm, Space, Table, Tag, Typography, message } from 'antd';
import type { TableColumnsType } from 'antd';
import {
  CopyOutlined,
  DeleteOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  KeyOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import type { AccessKeyItem } from '../../../lib/api';
import { copyToClipboard, formatDate } from '../../../lib/utils';

const { Text } = Typography;

interface AccessKeysTableProps {
  keys: AccessKeyItem[];
  loading: boolean;
  /** 以 AccessKey 为键，记录 SecretKey 是否已展开 */
  revealedSK: Record<string, boolean>;
  onToggleReveal: (accessKey: string) => void;
  onDelete: (accessKey: string) => Promise<void>;
}

/** 已签发的访问密钥列表卡片 */
export function AccessKeysTable({
  keys,
  loading,
  revealedSK,
  onToggleReveal,
  onDelete,
}: AccessKeysTableProps) {
  const columns: TableColumnsType<AccessKeyItem> = [
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
      render: (sk: string, record) => {
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
              onClick={() => onToggleReveal(record.accessKey)}
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
      align: 'right',
      render: (_: unknown, record) => (
        <Popconfirm
          title={`确定吊销密钥 "${record.accessKey}"？`}
          description="吊销后使用该密钥的客户端或图床将立即无法访问。"
          okText="确认吊销"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => onDelete(record.accessKey)}
        >
          <Button type="text" size="small" danger icon={<DeleteOutlined />}>
            吊销
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
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
  );
}
