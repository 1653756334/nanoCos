import { Form, Input, Modal, Select } from 'antd';
import type { FormInstance } from 'antd';
import type { CreateKeyFormValues } from '../types';

interface CreateKeyModalProps {
  open: boolean;
  submitting: boolean;
  form: FormInstance<CreateKeyFormValues>;
  onCancel: () => void;
  onSubmit: () => void;
}

/** 签发新密钥弹窗 */
export function CreateKeyModal({
  open,
  submitting,
  form,
  onCancel,
  onSubmit,
}: CreateKeyModalProps) {
  return (
    <Modal
      title="签发新 API 访问密钥 (Create AccessKey)"
      open={open}
      onCancel={onCancel}
      onOk={onSubmit}
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
  );
}
