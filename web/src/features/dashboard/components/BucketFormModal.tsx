import { Col, Form, Input, InputNumber, Modal, Radio, Row, Select, Space, Tag } from 'antd';
import type { FormInstance } from 'antd';
import { GlobalOutlined, LockOutlined } from '@ant-design/icons';
import type { Bucket } from '../../../lib/api';
import type { BucketFormValues } from '../types';

interface BucketFormModalProps {
  open: boolean;
  /** 编辑中的存储桶；为 null 表示新建 */
  editBucket: Bucket | null;
  form: FormInstance<BucketFormValues>;
  submitting: boolean;
  onCancel: () => void;
  onOk: () => void;
}

/** 创建 / 编辑存储桶弹窗 */
export function BucketFormModal({
  open,
  editBucket,
  form,
  submitting,
  onCancel,
  onOk,
}: BucketFormModalProps) {
  return (
    <Modal
      title={editBucket ? `修改存储桶配置: ${editBucket.name}` : '新建存储桶 (Create Bucket)'}
      open={open}
      onCancel={onCancel}
      onOk={onOk}
      confirmLoading={submitting}
      okText={editBucket ? '保存配置' : '立即创建'}
      cancelText="取消"
      destroyOnHidden
      width={520}
    >
      <Form form={form} layout="vertical" className="mt-4" requiredMark={false}>
        <Form.Item
          label="存储桶名称 (Bucket Name)"
          name="name"
          extra="支持 3~63 位小写字母、数字、中划线 (-)，创建后不可更改名称"
          rules={[
            { required: true, message: '请输入存储桶名称' },
            {
              pattern: /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/,
              message: '需为 3~63 位小写字母、数字或中划线，且首尾为字母或数字',
            },
          ]}
        >
          <Input
            placeholder="例如: public-assets 或 backup-vault"
            disabled={!!editBucket}
            className="font-mono"
          />
        </Form.Item>

        <Form.Item label="访问权限 (Access Policy)" name="visibility">
          <Radio.Group className="w-full">
            <div className="grid grid-cols-1 gap-2.5">
              <label className="flex items-start gap-3 p-3 rounded border border-slate-200 hover:border-blue-500 cursor-pointer transition-colors">
                <Radio value="public-read" className="mt-0.5" />
                <div>
                  <div className="text-sm font-medium text-slate-800 flex items-center gap-1.5">
                    <GlobalOutlined className="text-emerald-600" />
                    <span>公开读，私有写 (Public Read)</span>
                    <Tag color="success" className="m-0 text-[10px]">
                      推荐图床/静态资源
                    </Tag>
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    任何人可通过 <code className="text-blue-600">/raw/&#123;bucket&#125;/&#123;key&#125;</code> 直链读取或播放音视频，上传与修改需认证。
                  </div>
                </div>
              </label>

              <label className="flex items-start gap-3 p-3 rounded border border-slate-200 hover:border-blue-500 cursor-pointer transition-colors">
                <Radio value="private" className="mt-0.5" />
                <div>
                  <div className="text-sm font-medium text-slate-800 flex items-center gap-1.5">
                    <LockOutlined className="text-amber-600" />
                    <span>私有读写 (Private)</span>
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    所有读写请求均需携带有效 AK/SK 签名或通过生成的预签名临时链接 (Presigned URL) 访问。
                  </div>
                </div>
              </label>
            </div>
          </Radio.Group>
        </Form.Item>

        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              label="容量配额限制"
              extra="填 0 表示不限制存储桶容量"
            >
              <Space.Compact className="w-full">
                <Form.Item name="quotaValue" noStyle>
                  <InputNumber min={0} className="w-full" placeholder="0" />
                </Form.Item>
                <Form.Item name="quotaUnit" noStyle initialValue="MB">
                  <Select
                    style={{ width: 84 }}
                    options={[
                      { value: 'B', label: 'Byte' },
                      { value: 'KB', label: 'KB' },
                      { value: 'MB', label: 'MB' },
                      { value: 'GB', label: 'GB' },
                    ]}
                  />
                </Form.Item>
              </Space.Compact>
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              label="CORS 允许跨域 Origin"
              name="corsOrigins"
              extra="默认 * 允许所有前端域名跨域读取"
            >
              <Input placeholder="*" className="font-mono" />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}
