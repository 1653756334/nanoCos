import { useState } from 'react';
import { Layout } from 'antd';
import { Outlet } from 'react-router-dom';
import { useMe, useSystemOverview } from '../../features/system/queries';
import { AppHeader } from './AppHeader';
import { SidebarContent } from './Sidebar';

const { Sider, Content } = Layout;

/** 登录后的整体布局：侧边栏 + 顶栏 + 路由出口 */
export function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const { data: me } = useMe();
  const { stats, buckets, s3Endpoint } = useSystemOverview();

  return (
    <Layout className="min-h-screen">
      <Sider
        theme="light"
        width={232}
        collapsedWidth={64}
        collapsible
        collapsed={collapsed}
        trigger={null}
        className="border-r border-slate-200 select-none"
      >
        <SidebarContent collapsed={collapsed} buckets={buckets} stats={stats} />
      </Sider>

      <Layout>
        <AppHeader
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed((v) => !v)}
          username={me?.username || 'admin'}
          s3Endpoint={s3Endpoint}
        />
        <Content className="p-6 overflow-y-auto">
          <div className="w-full">
            <Outlet />
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}
