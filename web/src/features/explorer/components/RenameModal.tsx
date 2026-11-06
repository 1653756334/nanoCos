import { useEffect } from 'react';
import { Form, Input, Modal, message } from 'antd';
import { StorageObject } from '../../../lib/api';
import { getErrorMessage, isFormValidationError } from '../../../lib/errors';
import { useRenameObject } from '../queries';

interface RenameModalProps {
  open: boolean;
  bucketName: string;
  target: StorageObject | null;
  onClose: () => void;
  onSuccess: () => void;
}

export function RenameModal({
  open,
  bucketName,
  target,
  onClose,
  onSuccess,
}: RenameModalProps) {
  const [form] = Form.useForm<{ newKey: string }>();
  const renameMutation = useRenameObject(bucketName);

  useEffect(() => {
    if (open && target) {
      form.setFieldsValue({ newKey: target.key });
    }
  }, [open, target, form]);

  const handleOk = async () => {
    if (!target) return;
    try {
      const values = await form.validateFields();
      const dstKey = values.newKey.trim();
      if (!dstKey || dstKey === target.key) {
        onClose();
        return;
      }
      await renameMutation.mutateAsync({
        srcKey: target.key,
        dstKey,
      });
      message.success('重命名 / 移动成功 (基于 CAS 零拷贝)');
      onClose();
      onSuccess();
    } catch (err: unknown) {
      if (isFormValidationError(err)) return;
      message.error(getErrorMessage(err, '重命名失败'));
    }
  };

  return (
    <Modal
      title="重命名 / 移动对象路径 (CAS Zero-Copy)"
      open={open}
      onCancel={onClose}
      onOk={handleOk}
      confirmLoading={renameMutation.isPending}
      okText="确认修改"
      cancelText="取消"
      destroyOnClose
    >
      <Form form={form} layout="vertical" className="mt-4" requiredMark={false}>
        <Form.Item
          label="目标完整路径 Key"
          name="newKey"
          extra="底层通过 CAS 引用计数指针重定向，无需复制物理磁盘数据，毫秒级完成"
          rules={[{ required: true, message: '请输入新的对象路径 Key' }]}
        >
          <Input className="font-mono" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
