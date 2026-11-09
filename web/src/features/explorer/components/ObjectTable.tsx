import { Key } from 'react';
import { Button, Dropdown, Empty, Modal, Popconfirm, Space, Table, Tag, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  EyeOutlined,
  LinkOutlined,
  MoreOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { StorageObject } from '../../../lib/api';
import { formatBytes, formatDate } from '../../../lib/utils';
import { PAGE_SIZE_OPTIONS, showTotalText } from '../constants';
import type { SortDirection, SortField } from '../hooks/useObjectBrowser';
import { FileTypeIcon } from './FileTypeIcon';

interface ObjectTableProps {
  items: StorageObject[];
  loading: boolean;
  search: string;
  isPublicBucket: boolean;
  selectedKeys: Key[];
  page: number;
  pageSize: number;
  totalCount: number;
  sortBy?: SortField;
  sortOrder?: SortDirection;
  onSelectKeysChange: (keys: Key[]) => void;
  onPageChange: (page: number, pageSize: number) => void;
  onSortChange?: (field: SortField, order: SortDirection) => void;
  onEnterFolder: (key: string) => void;
  onOpenInspector: (obj: StorageObject) => void;
  onCopyLink: (obj: StorageObject) => void;
  onDownload: (obj: StorageObject) => void;
  onOpenRename: (obj: StorageObject) => void;
  onDeleteSingle: (obj: StorageObject) => void;
  onOpenUpload: () => void;
}

export function ObjectTable({
  items,
  loading,
  search,
  isPublicBucket,
  selectedKeys,
  page,
  pageSize,
  totalCount,
  sortBy = 'key',
  sortOrder = 'asc',
  onSelectKeysChange,
  onPageChange,
  onSortChange,
  onEnterFolder,
  onOpenInspector,
  onCopyLink,
  onDownload,
  onOpenRename,
  onDeleteSingle,
  onOpenUpload,
}: ObjectTableProps) {
  const columns: ColumnsType<StorageObject> = [
    {
      title: '文件名 (Key)',
      dataIndex: 'name',
      key: 'key',
      sorter: true,
      sortOrder: sortBy === 'key' ? (sortOrder === 'desc' ? 'descend' : 'ascend') : null,
      render: (_: unknown, record: StorageObject) => (
        <button
          onClick={() => {
            if (record.isFolder) {
              onEnterFolder(record.key);
            } else {
              onOpenInspector(record);
            }
          }}
          className="flex items-center gap-2.5 text-left font-medium text-slate-800 hover:text-blue-600 transition-colors bg-transparent border-0 p-0 cursor-pointer outline-none shadow-none"
        >
          <FileTypeIcon object={record} />
          <span className="break-all">{search ? record.key : record.name}</span>
        </button>
      ),
    },
    {
      title: '大小',
      dataIndex: 'sizeBytes',
      key: 'size',
      width: 120,
      sorter: true,
      sortOrder: sortBy === 'size' ? (sortOrder === 'desc' ? 'descend' : 'ascend') : null,
      render: (size: number, record: StorageObject) => (
        <span className="font-mono text-xs text-slate-600">
          {record.isFolder ? '-' : formatBytes(size)}
        </span>
      ),
    },
    {
      title: '类型 / ETag',
      key: 'type',
      width: 230,
      render: (_: unknown, record: StorageObject) =>
        record.isFolder ? (
          <Tag className="m-0">目录 (Prefix)</Tag>
        ) : (
          <Space size={6}>
            <span className="text-xs text-slate-500">
              {record.contentType.split(';')[0]}
            </span>
            {record.etag && (
              <Tag color="blue" className="m-0 font-mono text-[11px]">
                {record.etag.slice(0, 8)}
              </Tag>
            )}
          </Space>
        ),
    },
    {
      title: '最后修改时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 170,
      sorter: true,
      sortOrder: sortBy === 'updatedAt' ? (sortOrder === 'desc' ? 'descend' : 'ascend') : null,
      render: (iso: string) => (
        <span className="font-mono text-xs text-slate-500">{formatDate(iso)}</span>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 210,
      align: 'right',
      render: (_: unknown, record: StorageObject) => {
        if (record.isFolder) {
          return (
            <Space size={2}>
              <Button
                type="link"
                size="small"
                onClick={() => onEnterFolder(record.key)}
              >
                进入目录
              </Button>
              <Tooltip title="重命名 / 移动目录">
                <Button
                  type="text"
                  size="small"
                  aria-label={`重命名目录 ${record.name}`}
                  icon={<EditOutlined />}
                  onClick={() => onOpenRename(record)}
                />
              </Tooltip>
              <Popconfirm
                title={`确定删除目录 "${record.name}" 及其所有子文件？`}
                okText="确认删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => onDeleteSingle(record)}
              >
                <Button
                  type="text"
                  size="small"
                  danger
                  aria-label={`删除目录 ${record.name}`}
                  icon={<DeleteOutlined />}
                />
              </Popconfirm>
            </Space>
          );
        }

        return (
          <Space size={2}>
            <Button
              type="link"
              size="small"
              icon={<EyeOutlined />}
              onClick={() => onOpenInspector(record)}
            >
              详情/预览
            </Button>
            <Tooltip
              title={
                isPublicBucket
                  ? '复制公开直链'
                  : '生成并复制 1 小时预签名链接'
              }
            >
              <Button
                type="text"
                size="small"
                aria-label={`复制 ${record.name} 链接`}
                icon={<LinkOutlined />}
                onClick={() => onCopyLink(record)}
              />
            </Tooltip>
            <Dropdown
              menu={{
                items: [
                  {
                    key: 'rename',
                    icon: <EditOutlined />,
                    label: '重命名 / 移动路径',
                    onClick: () => onOpenRename(record),
                  },
                  {
                    key: 'download',
                    icon: <DownloadOutlined />,
                    label: '下载原文件',
                    onClick: () => onDownload(record),
                  },
                  { type: 'divider' },
                  {
                    key: 'delete',
                    icon: <DeleteOutlined />,
                    danger: true,
                    label: '永久删除对象',
                    onClick: () => {
                      Modal.confirm({
                        title: `确认删除 "${record.name}"？`,
                        content: `对象路径: ${record.key}`,
                        okText: '确认删除',
                        okButtonProps: { danger: true },
                        cancelText: '取消',
                        onOk: () => onDeleteSingle(record),
                      });
                    },
                  },
                ],
              }}
            >
              <Button
                type="text"
                size="small"
                aria-label={`更多操作 ${record.name}`}
                icon={<MoreOutlined />}
              />
            </Dropdown>
          </Space>
        );
      },
    },
  ];

  return (
    <Table
      className="mt-2"
      dataSource={items}
      columns={columns}
      rowKey="key"
      loading={loading}
      size="middle"
      rowSelection={{
        selectedRowKeys: selectedKeys,
        onChange: (keys) => onSelectKeysChange(keys),
      }}
      onChange={(_pagination, _filters, sorter) => {
        if (!onSortChange || Array.isArray(sorter)) return;
        const field = (sorter.columnKey as SortField) || 'key';
        if (!sorter.order) {
          onSortChange('key', 'asc');
        } else {
          onSortChange(field, sorter.order === 'descend' ? 'desc' : 'asc');
        }
      }}
      pagination={{
        current: page,
        pageSize,
        total: totalCount,
        showSizeChanger: true,
        pageSizeOptions: PAGE_SIZE_OPTIONS,
        onChange: onPageChange,
        showTotal: showTotalText,
      }}
      locale={{
        emptyText: (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="当前目录暂无文件，支持拖拽文件到页面或点击上传"
          >
            <Button
              type="primary"
              icon={<UploadOutlined />}
              onClick={onOpenUpload}
            >
              上传文件
            </Button>
          </Empty>
        ),
      }}
    />
  );
}
