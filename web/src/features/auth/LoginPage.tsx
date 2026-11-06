import { useState } from 'react';
import { Button, Form, Input, Typography, message } from 'antd';
import {
  ArrowRightOutlined,
  CloudServerOutlined,
  CodeOutlined,
  LockOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { cosApi } from '../../lib/api';
import { getErrorMessage } from '../../lib/errors';

const { Text } = Typography;

interface LoginPageProps {
  /** 登录成功后调用，父级负责刷新登录态；返回 Promise 时会等待其完成 */
  onSuccess: (username: string) => void | Promise<void>;
}

export function LoginPage({ onSuccess }: LoginPageProps) {
  const [loading, setLoading] = useState(false);

  const handleFinish = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const res = await cosApi.login(values.username.trim(), values.password);
      message.success('登录成功，欢迎进入 NanoCOS 控制台');
      await onSuccess(res.username);
    } catch (err: unknown) {
      message.error(getErrorMessage(err, '账号或密码错误'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f8fafc] flex flex-col justify-center items-center p-4 relative select-none">
      {/* 极简网格纹理底色装饰 */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.45]"
        style={{
          backgroundImage:
            'radial-gradient(#cbd5e1 1px, transparent 1px), radial-gradient(#cbd5e1 1px, #f8fafc 1px)',
          backgroundSize: '24px 24px',
          backgroundPosition: '0 0, 12px 12px',
        }}
      />

      {/* 核心登录卡片：与系统主题严格对齐的 6px 规整小圆角与轻微描边 */}
      <div className="w-full max-w-[400px] relative z-10">
        <div className="bg-white border border-slate-200 rounded-[6px] shadow-sm p-7 sm:p-8">
          {/* 品牌与标题区 */}
          <div className="flex flex-col items-center text-center mb-6">
            <div className="w-10 h-10 rounded bg-blue-600 text-white flex items-center justify-center text-lg mb-3 shadow-sm">
              <CloudServerOutlined />
            </div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-xl text-slate-900 tracking-tight">
                NanoCOS
              </span>
              <span className="text-[11px] font-mono font-medium px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-200/80">
                CAS + S3
              </span>
            </div>
            <Text type="secondary" className="text-xs text-slate-500 mt-1.5">
              轻量级内容寻址与 S3 兼容对象存储
            </Text>
          </div>

          {/* 表单输入区 */}
          <Form
            layout="vertical"
            initialValues={{ username: '', password: '' }}
            onFinish={handleFinish}
            size="large"
            requiredMark={false}
          >
            <Form.Item
              label={<span className="text-xs font-medium text-slate-700">管理员账号</span>}
              name="username"
              rules={[{ required: true, message: '请输入管理员账号' }]}
              className="mb-4"
            >
              <Input
                prefix={<UserOutlined className="text-slate-400 text-sm" />}
                placeholder="默认管理员 admin"
                autoComplete="username"
                className="text-sm"
              />
            </Form.Item>

            <Form.Item
              label={<span className="text-xs font-medium text-slate-700">登录密码</span>}
              name="password"
              rules={[{ required: true, message: '请输入管理员密码' }]}
              className="mb-6"
            >
              <Input.Password
                prefix={<LockOutlined className="text-slate-400 text-sm" />}
                placeholder="请输入密码"
                autoComplete="current-password"
                className="text-sm"
              />
            </Form.Item>

            <Form.Item className="mb-0">
              <Button
                type="primary"
                htmlType="submit"
                loading={loading}
                block
                icon={<ArrowRightOutlined />}
                iconPosition="end"
                className="font-medium h-10"
              >
                进入控制台
              </Button>
            </Form.Item>
          </Form>

          {/* 运维说明轻量提示条 */}
          <div className="mt-6 pt-5 border-t border-slate-100 flex items-start gap-2 text-slate-500 text-[11px] leading-relaxed">
            <CodeOutlined className="text-slate-400 mt-0.5 shrink-0" />
            <div>
              初始随机密码在服务器首次启动终端输出；重置请执行{' '}
              <code className="text-blue-600 font-mono font-medium">cosd passwd</code>
            </div>
          </div>
        </div>

        {/* 底部微型状态栏 */}
        <div className="text-center text-[11px] text-slate-400 mt-6 tracking-wide">
          NanoCOS Engine · SQLite WAL · Immutable CAS Storage
        </div>
      </div>
    </div>
  );
}
