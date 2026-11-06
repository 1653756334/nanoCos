import React, { useState, useEffect, useCallback } from 'react';
import {
  ConfigProvider,
  Layout,
  Menu,
  Button,
  Tag,
  Space,
  Breadcrumb,
  Progress,
  Spin,
  Tooltip,
  Modal,
  Form,
  Input,
  message,
} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import {
  DashboardOutlined,
  FolderOpenOutlined,
  KeyOutlined,
  CloudServerOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  LogoutOutlined,
  UserOutlined,
  GlobalOutlined,
  LockOutlined,
  CopyOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { LoginView } from './components/LoginView';
import { DashboardView } from './components/DashboardView';
import { ExplorerView } from './components/ExplorerView';
import { AccessKeysView } from './components/AccessKeysView';
import { Bucket, SystemStats, cosApi } from './lib/api';
import { formatBytes, copyToClipboard } from './lib/utils';

const { Header, Sider, Content } = Layout;

type NavKey = 'dashboard' | 'explorer' | 'keys';

export default function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState('admin');
  const [collapsed, setCollapsed] = useState(false);
  const [activeNav, setActiveNav] = useState<NavKey>('dashboard');
  const [explorerTab, setExplorerTab] = useState<'objects' | 'settings' | 'guide'>('objects');

  const [stats, setStats] = useState<SystemStats | null>(null);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [selectedBucket, setSelectedBucket] = useState<string>('');
  const [baseUrl, setBaseUrl] = useState<string>(window.location.origin);
  const [s3Endpoint, setS3Endpoint] = useState<string>(`${window.location.origin}/s3`);
  const [s3Region, setS3Region] = useState<string>('us-east-1');
  const [loading, setLoading] = useState(false);
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [accountSubmitting, setAccountSubmitting] = useState(false);
  const [accountForm] = Form.useForm();

  const loadSystemOverview = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, bucketsRes] = await Promise.all([
        cosApi.getStats(),
        cosApi.listBuckets(),
      ]);
      setStats(statsRes.stats);
      setBaseUrl(statsRes.baseUrl || window.location.origin);
      setS3Endpoint(statsRes.s3Endpoint || `${window.location.origin}/s3`);
      setS3Region(statsRes.s3Region || 'us-east-1');

      const list = bucketsRes.buckets || [];
      setBuckets(list);
      setSelectedBucket((prev) => {
        if (prev && list.some((b) => b.name === prev)) return prev;
        return list[0]?.name || '';
      });
    } catch (err: any) {
      if (err.message === 'UNAUTHORIZED') {
        setAuthenticated(false);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const onUnauthorized = () => {
      setAuthenticated((prev) => {
        if (prev) {
          message.warning('登录会话已过期，请重新登录');
        }
        return false;
      });
    };
    window.addEventListener('cos:unauthorized', onUnauthorized);
    return () => window.removeEventListener('cos:unauthorized', onUnauthorized);
  }, []);

  useEffect(() => {
    cosApi
      .me()
      .then((res) => {
        setAuthenticated(true);
        setUsername(res.username || 'admin');
        setBaseUrl(res.baseUrl || window.location.origin);
        setS3Endpoint(res.s3Endpoint || `${window.location.origin}/s3`);
        setS3Region(res.s3Region || 'us-east-1');
        loadSystemOverview();
      })
      .catch(() => {
        setAuthenticated(false);
      })
      .finally(() => {
        setAuthChecked(true);
      });
  }, [loadSystemOverview]);

  const handleLogout = async () => {
    await cosApi.logout().catch(() => {});
    setAuthenticated(false);
    message.info('已退出登录');
  };

  const handleOpenBucket = (
    name: string,
    tab: 'objects' | 'settings' | 'guide' = 'objects'
  ) => {
    setSelectedBucket(name);
    setExplorerTab(tab);
    setActiveNav('explorer');
  };

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#1677ff',
          borderRadius: 4,
          borderRadiusLG: 6,
          borderRadiusSM: 4,
          colorBgLayout: '#f5f7fa',
          colorBorderSecondary: '#e5e7eb',
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", "Microsoft YaHei", sans-serif',
        },
        components: {
          Card: {
            headerFontSize: 14,
            borderRadiusLG: 6,
          },
          Button: {
            borderRadius: 4,
            borderRadiusLG: 4,
            borderRadiusSM: 4,
          },
          Input: {
            borderRadius: 4,
          },
          Select: {
            borderRadius: 4,
          },
          Table: {
            headerBg: '#f8fafc',
            headerColor: '#475569',
            borderRadius: 4,
          },
          Menu: {
            itemBorderRadius: 4,
            itemMarginInline: 8,
          },
        },
      }}
    >
      {!authChecked ? (
        <div className="min-h-screen flex items-center justify-center bg-[#f5f7fa]">
          <Spin size="large" />
        </div>
      ) : !authenticated ? (
        <LoginView
          onSuccess={(user) => {
            setUsername(user);
            setAuthenticated(true);
            loadSystemOverview();
          }}
        />
      ) : (
        <Layout className="min-h-screen">
          {/* 左侧导航栏 */}
          <Sider
            theme="light"
            width={232}
            collapsedWidth={64}
            collapsible
            collapsed={collapsed}
            trigger={null}
            className="border-r border-slate-200 select-none"
          >
            <div className="h-full flex flex-col justify-between">
              <div>
                {/* 顶部品牌栏 - 与右侧 Header 56px 严格对齐 */}
                <div className="h-14 px-4 flex items-center justify-between border-b border-slate-200">
                  <div className="flex items-center gap-2.5 overflow-hidden">
                    <div className="w-7 h-7 rounded bg-blue-600 text-white flex items-center justify-center text-sm shrink-0">
                      <CloudServerOutlined />
                    </div>
                    {!collapsed && (
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-[15px] text-slate-900 tracking-tight">
                          NanoCOS
                        </span>
                        <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">
                          v1.0
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* 主导航菜单 */}
                <div className="pt-3">
                  {!collapsed && (
                    <div className="px-4 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      控制台导航
                    </div>
                  )}
                  <Menu
                    mode="inline"
                    selectedKeys={[activeNav]}
                    style={{ borderInlineEnd: 'none' }}
                    onClick={({ key }) => setActiveNav(key as NavKey)}
                    items={[
                      {
                        key: 'dashboard',
                        icon: <DashboardOutlined />,
                        label: '存储概览',
                      },
                      {
                        key: 'explorer',
                        icon: <FolderOpenOutlined />,
                        label: '存储桶与对象',
                      },
                      {
                        key: 'keys',
                        icon: <KeyOutlined />,
                        label: '访问密钥 & S3',
                      },
                    ]}
                  />
                </div>

                {/* 存储桶快捷列表 */}
                {!collapsed && (
                  <div className="px-3 mt-5 pt-4 border-t border-slate-100">
                    <div className="px-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">
                      <span>存储桶列表</span>
                      <span className="font-mono">{buckets.length}</span>
                    </div>
                    <div className="space-y-0.5 max-h-64 overflow-y-auto">
                      {buckets.length === 0 ? (
                        <div className="px-2 py-2 text-xs text-slate-400">
                          暂无存储桶
                        </div>
                      ) : (
                        buckets.map((b) => {
                          const isSelected =
                            activeNav === 'explorer' && selectedBucket === b.name;
                          return (
                            <button
                              key={b.name}
                              onClick={() => handleOpenBucket(b.name, 'objects')}
                              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded text-xs transition-colors ${
                                isSelected
                                  ? 'bg-blue-50 text-blue-600 font-medium'
                                  : 'text-slate-600 hover:bg-slate-100'
                              }`}
                            >
                              <div className="flex items-center gap-2 truncate">
                                {b.visibility === 'public-read' ? (
                                  <GlobalOutlined className="text-emerald-600 shrink-0 text-xs" />
                                ) : (
                                  <LockOutlined className="text-amber-600 shrink-0 text-xs" />
                                )}
                                <span className="font-mono truncate">{b.name}</span>
                              </div>
                              <span className="font-mono text-[11px] text-slate-400">
                                {b.objectCount}
                              </span>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* 底部 CAS 物理存储水位卡片 */}
              {!collapsed && stats && (
                <div className="p-3 border-t border-slate-200 bg-slate-50/60">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-500">CAS 物理落盘</span>
                      <span className="font-mono font-semibold text-slate-800">
                        {formatBytes(stats.physicalBytes)}
                      </span>
                    </div>
                    <Progress
                      percent={Number(stats.dedupRatioPercent.toFixed(1))}
                      size="small"
                      strokeColor="#10b981"
                      showInfo={false}
                    />
                    <div className="flex items-center justify-between text-[11px] text-slate-400">
                      <span>去重已省 {formatBytes(stats.savedBytes)}</span>
                      <span className="font-mono text-emerald-600 font-medium">
                        {stats.dedupRatioPercent.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </Sider>

          {/* 右侧主区域 */}
          <Layout>
            <Header
              style={{ background: '#ffffff', padding: '0 24px', height: 56, lineHeight: '56px' }}
              className="border-b border-slate-200 flex items-center justify-between sticky top-0 z-20"
            >
              <div className="flex items-center gap-3">
                <Button
                  type="text"
                  size="small"
                  aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
                  icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                  onClick={() => setCollapsed(!collapsed)}
                />
                <Breadcrumb
                  items={[
                    { title: 'NanoCOS' },
                    {
                      title:
                        activeNav === 'dashboard'
                          ? '存储概览'
                          : activeNav === 'explorer'
                          ? `存储桶 (${selectedBucket || '未选择'})`
                          : '访问密钥 & S3',
                    },
                  ]}
                />
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
                    onClick={() => {
                      accountForm.setFieldsValue({
                        currentPassword: '',
                        newUsername: username,
                        newPassword: '',
                      });
                      setAccountModalOpen(true);
                    }}
                    className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded bg-slate-50 hover:bg-slate-100 text-xs text-slate-700 border border-slate-200 transition-colors cursor-pointer"
                  >
                    <UserOutlined className="text-slate-500" />
                    <span className="font-medium">{username}</span>
                    <SettingOutlined className="text-[11px] text-slate-400" />
                  </button>
                </Tooltip>

                <Button
                  size="middle"
                  icon={<LogoutOutlined />}
                  onClick={handleLogout}
                >
                  退出
                </Button>
              </Space>
            </Header>

            <Modal
              title="修改管理员账号与密码"
              open={accountModalOpen}
              onCancel={() => setAccountModalOpen(false)}
              confirmLoading={accountSubmitting}
              onOk={() => accountForm.submit()}
              okText="保存修改"
              cancelText="取消"
              width={420}
              destroyOnClose
            >
              <Form
                form={accountForm}
                layout="vertical"
                className="mt-4"
                onFinish={async (values) => {
                  setAccountSubmitting(true);
                  try {
                    const res = await cosApi.updateAccount({
                      currentPassword: values.currentPassword,
                      newUsername: values.newUsername.trim(),
                      newPassword: values.newPassword || '',
                    });
                    setUsername(res.username);
                    setAccountModalOpen(false);
                    message.success('管理员凭证已更新');
                  } catch (err: any) {
                    message.error(err.message || '修改失败');
                  } finally {
                    setAccountSubmitting(false);
                  }
                }}
              >
                <Form.Item
                  label="当前管理员密码"
                  name="currentPassword"
                  rules={[{ required: true, message: '请输入当前密码以验证身份' }]}
                >
                  <Input.Password placeholder="请输入当前正在使用的密码" />
                </Form.Item>
                <Form.Item
                  label="新管理员用户名"
                  name="newUsername"
                  rules={[{ required: true, message: '用户名不能为空' }]}
                >
                  <Input placeholder="请输入管理员用户名" />
                </Form.Item>
                <Form.Item
                  label="新登录密码 (留空则仅修改用户名)"
                  name="newPassword"
                  rules={[
                    {
                      validator: (_, val) => {
                        if (val && val.length < 6) {
                          return Promise.reject(new Error('新密码长度不能少于 6 位'));
                        }
                        return Promise.resolve();
                      },
                    },
                  ]}
                >
                  <Input.Password placeholder="不少于 6 位，留空则保持原密码不变" />
                </Form.Item>
              </Form>
            </Modal>

            <Content className="p-6 overflow-y-auto">
              <div className="w-full">
                {activeNav === 'dashboard' && (
                  <DashboardView
                    stats={stats}
                    buckets={buckets}
                    baseUrl={baseUrl}
                    s3Endpoint={s3Endpoint}
                    s3Region={s3Region}
                    loading={loading}
                    onRefresh={loadSystemOverview}
                    onOpenBucket={handleOpenBucket}
                    onNavigateKeys={() => setActiveNav('keys')}
                  />
                )}

                {activeNav === 'explorer' && (
                  <ExplorerView
                    buckets={buckets}
                    selectedBucket={selectedBucket}
                    initialTab={explorerTab}
                    onSelectBucket={setSelectedBucket}
                    baseUrl={baseUrl}
                    s3Endpoint={s3Endpoint}
                    s3Region={s3Region}
                    onBucketsChanged={loadSystemOverview}
                  />
                )}

                {activeNav === 'keys' && (
                  <AccessKeysView
                    buckets={buckets}
                    baseUrl={baseUrl}
                    s3Endpoint={s3Endpoint}
                    s3Region={s3Region}
                    onChanged={loadSystemOverview}
                  />
                )}
              </div>
            </Content>
          </Layout>
        </Layout>
      )}
    </ConfigProvider>
  );
}
