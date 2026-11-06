import { useEffect } from 'react';
import { Alert, Button, Card, Col, Form, Input, InputNumber, Radio, Row, Select, Space, Typography, message } from 'antd';
import { Bucket } from '../../../lib/api';
import { bytesToQuotaForm, quotaFormToBytes, QuotaUnit } from '../../../lib/utils';
import { getErrorMessage } from '../../../lib/errors';
import { useUpdateBucket } from '../../buckets/mutations';

const { Title } = Typography;

interface BucketSettingsFormValues {
  visibility: 'private' | 'public-read';
  quotaValue?: number;
  quotaUnit: QuotaUnit;
  corsOrigins?: string;
}

interface BucketSettingsTabProps {
  bucket: Bucket;
}

export function BucketSettingsTab({ bucket }: BucketSettingsTabProps) {
  const [form] = Form.useForm<BucketSettingsFormValues>();
  const updateBucketMutation = useUpdateBucket();

  useEffect(() => {
    const { quotaValue, quotaUnit } = bytesToQuotaForm(bucket.quotaBytes);
    form.setFieldsValue({
      visibility: bucket.visibility,
      quotaValue,
      quotaUnit,
      corsOrigins: bucket.corsOrigins || '*',
    });
  }, [bucket, form]);

  const handleFinish = async (values: BucketSettingsFormValues) => {
    try {
      const quotaBytes = quotaFormToBytes(values.quotaValue, values.quotaUnit);
      await updateBucketMutation.mutateAsync({
        name: bucket.name,
        payload: {
          visibility: values.visibility,
          quotaBytes,
          corsOrigins: (values.corsOrigins || '*').trim(),
        },
      });
      message.success('存储桶配置已保存');
    } catch (err: unknown) {
      message.error(getErrorMessage(err, '保存配置失败'));
    }
  };

  return (
    <Card className="border-slate-200 shadow-none">
      <div className="max-w-2xl">
        <Title level={5}>存储桶访问策略与容量控制</Title>
        <Alert
          type="info"
          showIcon
          className="mb-6"
          message="CAS 内容寻址安全保障"
          description="无论存储桶设置为公开读还是私有，所有上传写入与删除操作均强制要求管理员或具备写权限的 AccessKey 签名验证。"
        />

        <Form
          form={form}
          layout="vertical"
          onFinish={handleFinish}
          requiredMark={false}
        >
          <Form.Item label="访问权限 (ACL)" name="visibility">
            <Radio.Group className="w-full">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="flex items-start gap-2.5 p-3.5 rounded border border-slate-200 hover:border-blue-500 cursor-pointer">
                  <Radio value="public-read" className="mt-0.5" />
                  <div>
                    <div className="font-medium text-sm text-slate-800">
                      公开读，私有写 (Public Read)
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      适合图床、静态前端资源、音视频直链分发。
                    </div>
                  </div>
                </label>
                <label className="flex items-start gap-2.5 p-3.5 rounded border border-slate-200 hover:border-blue-500 cursor-pointer">
                  <Radio value="private" className="mt-0.5" />
                  <div>
                    <div className="font-medium text-sm text-slate-800">
                      私有读写 (Private)
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      适合业务备份、内部文档、需预签名限时授权下载的资源。
                    </div>
                  </div>
                </label>
              </div>
            </Radio.Group>
          </Form.Item>

          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item label="容量配额上限 (0 表示不限)">
                <Space.Compact className="w-full">
                  <Form.Item name="quotaValue" noStyle>
                    <InputNumber min={0} className="w-full" />
                  </Form.Item>
                  <Form.Item name="quotaUnit" noStyle initialValue="MB">
                    <Select
                      style={{ width: 92 }}
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
            <Col xs={24} sm={12}>
              <Form.Item
                label="CORS 允许跨域 Origin"
                name="corsOrigins"
              >
                <Input className="font-mono" placeholder="*" />
              </Form.Item>
            </Col>
          </Row>

          <Button
            type="primary"
            htmlType="submit"
            loading={updateBucketMutation.isPending}
          >
            保存桶配置
          </Button>
        </Form>
      </div>
    </Card>
  );
}
