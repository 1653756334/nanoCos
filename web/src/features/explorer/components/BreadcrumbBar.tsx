import React, { Key } from 'react';
import { Button, Input, Popconfirm, Segmented, Space } from 'antd';
import {
  AppstoreOutlined,
  BarsOutlined,
  DeleteOutlined,
  HomeOutlined,
  ReloadOutlined,
  RollbackOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { ViewMode } from '../constants';
import { folderNameFromCrumb } from '../utils/objects';

interface BreadcrumbBarProps {
  bucketName: string;
  prefix: string;
  breadcrumbs: string[];
  search: string;
  selectedKeys: Key[];
  loading: boolean;
  viewMode: ViewMode;
  onNavigateUp: () => void;
  onEnterFolder: (crumb: string) => void;
  onSearchChange: (val: string) => void;
  onRefresh: () => void;
  onViewModeChange: (mode: ViewMode) => void;
  onBatchDelete: () => void;
}

export function BreadcrumbBar({
  bucketName,
  prefix,
  breadcrumbs,
  search,
  selectedKeys,
  loading,
  viewMode,
  onNavigateUp,
  onEnterFolder,
  onSearchChange,
  onRefresh,
  onViewModeChange,
  onBatchDelete,
}: BreadcrumbBarProps) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3.5 border-b border-slate-100">
      <div className="flex items-center gap-2 flex-wrap">
        {prefix !== '' && (
          <Button size="small" icon={<RollbackOutlined />} onClick={onNavigateUp}>
            上级目录
          </Button>
        )}
        <div className="flex items-center gap-1 bg-slate-50 border border-slate-200 rounded px-2.5 py-1 text-xs">
          <button
            onClick={() => onEnterFolder('')}
            className={`flex items-center gap-1 hover:text-blue-600 ${
              prefix === '' ? 'text-blue-600 font-semibold' : 'text-slate-600'
            }`}
          >
            <HomeOutlined />
            <span className="font-mono">{bucketName || '根目录'}</span>
          </button>
          {breadcrumbs.map((crumb, idx) => {
            const folderName = folderNameFromCrumb(crumb);
            const isLast = idx === breadcrumbs.length - 1;
            return (
              <React.Fragment key={crumb}>
                <span className="text-slate-300 mx-0.5">/</span>
                <button
                  onClick={() => onEnterFolder(crumb)}
                  className={`font-mono hover:text-blue-600 ${
                    isLast ? 'text-blue-600 font-semibold' : 'text-slate-600'
                  }`}
                >
                  {folderName}
                </button>
              </React.Fragment>
            );
          })}
        </div>

        {selectedKeys.length > 0 && (
          <Popconfirm
            title={`确认批量删除已勾选的 ${selectedKeys.length} 个对象？`}
            okText="确认删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={onBatchDelete}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>
              批量删除 ({selectedKeys.length})
            </Button>
          </Popconfirm>
        )}
      </div>

      <Space wrap>
        <Input
          placeholder="输入文件名或前缀过滤..."
          prefix={<SearchOutlined className="text-slate-400" />}
          allowClear
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          style={{ width: 220 }}
        />
        <Button
          aria-label="刷新对象列表"
          icon={<ReloadOutlined spin={loading} />}
          onClick={onRefresh}
          title="刷新列表"
        />
        <Segmented
          aria-label="切换列表或宫格视图"
          value={viewMode}
          onChange={(v) => onViewModeChange(v as ViewMode)}
          options={[
            { value: 'list', icon: <BarsOutlined /> },
            { value: 'grid', icon: <AppstoreOutlined /> },
          ]}
        />
      </Space>
    </div>
  );
}
