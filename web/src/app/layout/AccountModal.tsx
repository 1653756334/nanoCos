import { useState } from 'react';
import { Form, Input, Modal, message } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { AuthMeResponse, cosApi } from '../../lib/api';
import { getErrorMessage } from '../../lib/errors';
import { queryKeys } from '../../lib/queryKeys';

interface AccountModalProps {
  open: boolean;
  username: string;
  onClose: () => void;
}

interface AccountFormValues {
  currentPassword: string;
  newUsername: string;
  newPassword?: string;
}

/** 修改管理员用户名 / 密码 */
export function AccountModal({ open, username, onClose }: AccountModalProps) {
  const queryClient = useQueryClient();
  const [form] = Form.useForm<AccountFormValues>();
  const [submitting, setSubmitting] = useState(false);

  const handleFinish = async (values: AccountFormValues) => {
    setSubmitting(true);
    try {
      const res = await cosApi.updateAccount({
        currentPassword: values.currentPassword,
        newUsername: values.newUsername.trim(),
        newPassword: values.newPassword || '',
      });
      queryClient.setQueryData<AuthMeResponse | null>(queryKeys.me, (prev) =>
        prev ? { ...prev, username: res.username } : prev
      );
      onClose();
      message.success('管理员凭证已更新');
    } catch (err: unknown) {
      message.error(getErrorMessage(err, '修改失败'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="修改管理员账号与密码"
      open={open}
      onCancel={onClose}
      confirmLoading={submitting}
      onOk={() => form.submit()}
      okText="保存修改"
      cancelText="取消"
      width={420}
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        className="mt-4"
        // preserve=false：弹窗关闭销毁后清空字段，下次打开重新套用 initialValues（避免残留上次输入的密码）
        preserve={false}
        initialValues={{ currentPassword: '', newUsername: username, newPassword: '' }}
        onFinish={handleFinish}
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
  );
}
