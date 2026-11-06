import { useState } from 'react';
import { Breadcrumb, Button, Layout, Space, Tooltip, message } from 'antd';
import {
  CopyOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SettingOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useMatch } from 'react-router-dom';
import { cosApi } from '../../lib/api';
import { clearSession } from '../../features/auth/session';
import { routes } from '../../lib/routes';
import { copyToClipboard } from '../../lib/utils';
import { AccountModal } from './AccountModal';

interface AppHeaderProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  username: string;
  s3Endpoint: string;
}

/** 面包屑最后一级标题：随路由变化 */
function useSectionTitle(): string {
  const { pathname } = useLocation();
  const bucketMatch = useMatch('/buckets/:bucket');
  if (pathname.startsWith(routes.keys)) return '访问密钥 & S3';
  if (pathname.startsWith(routes.buckets)) {
    const name = bucketMatch?.params.bucket ? decodeURIComponent(bucketMatch.params.bucket) : '';
    return `存储桶 (${name || '未选择'})`;
  }
  return '存储概览';
}

export function AppHeader({
  collapsed,
  onToggleCollapsed,
  username,
  s3Endpoint,
}: AppHeaderProps) {
  const queryClient = useQueryClient();
  const [accountOpen, setAccountOpen] = useState(false);
  const sectionTitle = useSectionTitle();

  const handleLogout = async () => {
    await cosApi.logout().catch(() => {});
    clearSession(queryClient);
    message.info('已退出登录');
  };

  return (
    <>
      <Layout.Header
        style={{ background: '#ffffff', padding: '0 24px', height: 56, lineHeight: '56px' }}
        className="border-b border-slate-200 flex items-center justify-between sticky top-0 z-20"
      >
        <div className="flex items-center gap-3">
          <Button
            type="text"
            size="small"
            aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={onToggleCollapsed}
          />
          <Breadcrumb items={[{ title: 'NanoCOS' }, { title: sectionTitle }]} />
        </div>

        <Space size={8}>
          <Tooltip title="点击复制 S3 兼容 Endpoint">
            <button
              onClick={async () => {
                await copyToClipboard(s3Endpoint);
                message.success('S3 Endpoint 已复制');
              }}
              className="hidden sm:inline-flex items-center gap-1.5 h-8 px-2.5 rounded bg-slate-50 hover:bg-slate-100 text-xs text-slate-600 border border-slate-200 transition-colors cursor-pointer"
            >
              <span className="text-slate-400">S3:</span>
              <span className="font-mono text-slate-700">{s3Endpoint}</span>
              <CopyOutlined className="text-[11px] text-slate-400" />
            </button>
          </Tooltip>

          <Tooltip title="点击修改管理员用户名或密码">
            <button
              onClick={() => setAccountOpen(true)}
              className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded bg-slate-50 hover:bg-slate-100 text-xs text-slate-700 border border-slate-200 transition-colors cursor-pointer"
            >
              <UserOutlined className="text-slate-500" />
              <span className="font-medium">{username}</span>
              <SettingOutlined className="text-[11px] text-slate-400" />
            </button>
          </Tooltip>

          <Button size="middle" icon={<LogoutOutlined />} onClick={handleLogout}>
            退出
          </Button>
        </Space>
      </Layout.Header>

      <AccountModal
        open={accountOpen}
        username={username}
        onClose={() => setAccountOpen(false)}
      />
    </>
  );
}
