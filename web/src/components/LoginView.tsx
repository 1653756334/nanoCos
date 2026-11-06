import React, { useState } from 'react';
import { Form, Input, Button, Card, Typography, Tag, Space, message } from 'antd';
import {
  UserOutlined,
  LockOutlined,
  CloudServerOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  DatabaseOutlined,
  ArrowRightOutlined,
} from '@ant-design/icons';
import { cosApi } from '../lib/api';

const { Title, Text, Paragraph } = Typography;

interface LoginViewProps {
  onSuccess: (username: string) => void;
}

export function LoginView({ onSuccess }: LoginViewProps) {
  const [loading, setLoading] = useState(false);

  const handleFinish = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const res = await cosApi.login(values.username.trim(), values.password);
      message.success('登录成功，欢迎进入 NanoCOS 对象存储控制台');
      onSuccess(res.username);
    } catch (err: any) {
      message.error(err.message || '账号或密码错误');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f5f7fa] flex items-center justify-center p-4 sm:p-8">
      <div className="w-full max-w-4xl grid grid-cols-1 lg:grid-cols-12 bg-white rounded-md shadow-sm border border-slate-200 overflow-hidden">
        {/* 左侧产品能力展示区 */}
        <div className="lg:col-span-6 bg-slate-900 text-white p-8 sm:p-10 flex flex-col justify-between relative overflow-hidden">
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-8">
              <div className="w-9 h-9 rounded bg-blue-600 flex items-center justify-center text-white text-lg">
                <CloudServerOutlined />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold tracking-tight text-white">NanoCOS</span>
                  <Tag color="blue" className="m-0 font-mono text-[11px]">
                    CAS + S3
                  </Tag>
                </div>
                <div className="text-xs text-slate-400">
                  Enterprise Object Storage Service
                </div>
              </div>
            </div>

            <Title level={3} style={{ color: '#fff', marginBottom: 12 }}>
              轻量级内容寻址与 S3 兼容对象存储
            </Title>
            <Paragraph style={{ color: '#94a3b8', fontSize: 13, lineHeight: 1.7 }}>
              专为服务器私有化部署打造，单静态二进制包含现代管理工作台、CAS 全局物理去重引擎与双协议网关。
            </Paragraph>

            <div className="space-y-3 mt-7">
              <div className="flex items-start gap-3 p-3 rounded bg-slate-800/70 border border-slate-700/70">
                <DatabaseOutlined className="text-blue-400 text-base mt-0.5" />
                <div>
                  <div className="text-sm font-medium text-slate-100">
                    CAS 内容寻址物理去重 (SHA-256)
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    相同内容全局只存一份物理块，天然支持零字节极速秒传与毫秒级零拷贝复制。
                  </div>
                </div>
              </div>

              <div className="flex items-start gap-3 p-3 rounded bg-slate-800/70 border border-slate-700/70">
                <ThunderboltOutlined className="text-emerald-400 text-base mt-0.5" />
                <div>
                  <div className="text-sm font-medium text-slate-100">
                    大文件并发分片 &amp; HTTP Range 206 流媒体
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    内置并发分片上传与流式合并，直链原生支持音视频在线拖拽播放与 ETag 缓存。
                  </div>
                </div>
              </div>

              <div className="flex items-start gap-3 p-3 rounded bg-slate-800/70 border border-slate-700/70">
                <SafetyCertificateOutlined className="text-amber-400 text-base mt-0.5" />
                <div>
                  <div className="text-sm font-medium text-slate-100">
                    REST API + AWS S3 双协议无缝接入
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    开箱即用对接 PicGo、Rclone、Obsidian、AWS SDK 及预签名临时授权外链。
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="relative z-10 mt-8 pt-5 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
            <span>Engine: SQLite (WAL) + Immutable CAS</span>
            <span className="font-mono">v1.0.0</span>
          </div>
        </div>

        {/* 右侧登录表单区 */}
        <div className="lg:col-span-6 p-8 sm:p-12 flex flex-col justify-center bg-white">
          <div className="mb-8">
            <Title level={4} style={{ margin: 0 }}>
              身份认证登录
            </Title>
            <Text type="secondary" className="text-xs">
              请输入管理员账号与密码以访问对象存储控制台
            </Text>
          </div>

          <Form
            layout="vertical"
            initialValues={{ username: '', password: '' }}
            onFinish={handleFinish}
            size="large"
            requiredMark={false}
          >
            <Form.Item
              label={<span className="text-xs font-medium text-slate-600">管理员账号</span>}
              name="username"
              rules={[{ required: true, message: '请输入管理员账号' }]}
            >
              <Input
                prefix={<UserOutlined className="text-slate-400" />}
                placeholder="请输入管理员账号"
                autoComplete="username"
              />
            </Form.Item>

            <Form.Item
              label={<span className="text-xs font-medium text-slate-600">登录密码</span>}
              name="password"
              rules={[{ required: true, message: '请输入管理员密码' }]}
            >
              <Input.Password
                prefix={<LockOutlined className="text-slate-400" />}
                placeholder="请输入管理员密码"
                autoComplete="current-password"
              />
            </Form.Item>

            <Form.Item className="mb-2 mt-6">
              <Button
                type="primary"
                htmlType="submit"
                loading={loading}
                block
                icon={<ArrowRightOutlined />}
                iconPosition="end"
              >
                安全登录
              </Button>
            </Form.Item>
          </Form>

          <Card
            size="small"
            className="mt-6 bg-slate-50 border-slate-200/80"
            styles={{ body: { padding: '10px 14px' } }}
          >
            <Space direction="vertical" size={2}>
              <Text className="text-xs font-medium text-slate-600">
                凭证初始化与密码重置说明
              </Text>
              <Text type="secondary" className="text-xs leading-relaxed">
                首次启动时初始随机凭证仅在服务器终端打印一次；若需修改或找回，可在服务器执行{' '}
                <code className="text-blue-600">cosd passwd</code> 命令重置。
              </Text>
            </Space>
          </Card>
        </div>
      </div>
    </div>
  );
}
