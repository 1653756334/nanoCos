import { Form, Input, Modal, message } from 'antd';
import { getErrorMessage, isFormValidationError } from '../../../lib/errors';
import { useCreateFolder } from '../queries';

interface CreateFolderModalProps {
  open: boolean;
  bucketName: string;
  prefix: string;
  onClose: () => void;
  onSuccess: () => void;
}

export function CreateFolderModal({
  open,
  bucketName,
  prefix,
  onClose,
  onSuccess,
}: CreateFolderModalProps) {
  const [form] = Form.useForm<{ folderName: string }>();
  const createFolderMutation = useCreateFolder(bucketName);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      const clean = values.folderName.trim().replace(/^\/+/, '');
      await createFolderMutation.mutateAsync(`${prefix}${clean}`);
      message.success(`目录 "${clean}" 创建成功`);
      form.resetFields();
      onClose();
      onSuccess();
    } catch (err: unknown) {
      if (isFormValidationError(err)) return;
      message.error(getErrorMessage(err, '创建目录失败'));
    }
  };

  return (
    <Modal
      title="新建目录 (Create Folder)"
      open={open}
      onCancel={onClose}
      onOk={handleOk}
      confirmLoading={createFolderMutation.isPending}
      okText="创建"
      cancelText="取消"
      destroyOnClose
    >
      <Form form={form} layout="vertical" className="mt-4" requiredMark={false}>
        <Form.Item
          label={`将在 ${bucketName}/${prefix} 下创建子目录`}
          name="folderName"
          extra="支持多级目录结构，如 2026/11/banners"
          rules={[{ required: true, message: '请输入目录名称' }]}
        >
          <Input placeholder="例如: assets" autoFocus />
        </Form.Item>
      </Form>
    </Modal>
  );
}
