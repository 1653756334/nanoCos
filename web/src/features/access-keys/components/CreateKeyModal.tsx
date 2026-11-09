import { Form, Input, Modal, Select } from 'antd';
import type { FormInstance } from 'antd';
import type { Bucket } from '../../../lib/api';
import type { CreateKeyFormValues } from '../types';

interface CreateKeyModalProps {
  open: boolean;
  submitting: boolean;
  form: FormInstance<CreateKeyFormValues>;
  buckets: Bucket[];
  onCancel: () => void;
  onSubmit: () => void;
}

/** 签发新密钥弹窗 */
export function CreateKeyModal({
  open,
  submitting,
  form,
  buckets,
  onCancel,
  onSubmit,
}: CreateKeyModalProps) {
  const bucketOptions = [
    { value: '*', label: '* (全部存储桶)' },
    ...buckets.map((b) => ({
      value: b.name,
      label: `${b.name} (${b.visibility === 'public-read' ? '公开读' : '私有'})`,
    })),
  ];

  const handleBucketsChange = (vals: string[]) => {
    if (vals.length === 0) {
      form.setFieldValue('allowedBuckets', ['*']);
      return;
    }
    const last = vals[vals.length - 1];
    if (last === '*') {
      form.setFieldValue('allowedBuckets', ['*']);
    } else {
      form.setFieldValue(
        'allowedBuckets',
        vals.filter((v) => v !== '*')
      );
    }
  };

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
          extra="可选择 *（允许访问全部存储桶）或勾选指定的一个或多个存储桶"
          rules={[{ required: true, message: '请选择授权存储桶范围' }]}
        >
          <Select
            mode="tags"
            options={bucketOptions}
            onChange={handleBucketsChange}
            placeholder="选择 * 或指定的存储桶"
          />
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
