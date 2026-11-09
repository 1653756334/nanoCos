import { useEffect, useState } from 'react';
import { Form, Input, Modal, Segmented, message } from 'antd';
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

type RenameMode = 'name' | 'path';

export function RenameModal({
  open,
  bucketName,
  target,
  onClose,
  onSuccess,
}: RenameModalProps) {
  const [form] = Form.useForm<{ newName: string; newKey: string }>();
  const [mode, setMode] = useState<RenameMode>('name');
  const renameMutation = useRenameObject(bucketName);

  useEffect(() => {
    if (open && target) {
      setMode('name');
      const cleanName = target.isFolder ? target.name.replace(/\/+$/, '') : target.name;
      form.setFieldsValue({
        newName: cleanName,
        newKey: target.key,
      });
    }
  }, [open, target, form]);

  const handleOk = async () => {
    if (!target) return;
    try {
      const values = await form.validateFields();
      let dstKey = '';
      if (mode === 'name') {
        const cleanName = (values.newName || '').trim().replace(/^\/+|\/+$/g, '');
        if (!cleanName) {
          onClose();
          return;
        }
        const parent = target.parentDir || '';
        dstKey = `${parent}${cleanName}${target.isFolder ? '/' : ''}`;
      } else {
        dstKey = (values.newKey || '').trim().replace(/^\/+/, '');
        if (target.isFolder && dstKey && !dstKey.endsWith('/')) {
          dstKey += '/';
        }
      }

      if (!dstKey || dstKey === target.key) {
        onClose();
        return;
      }
      await renameMutation.mutateAsync({
        srcKey: target.key,
        dstKey,
      });
      message.success(target.isFolder ? '目录重命名 / 移动成功 (CAS 零拷贝)' : '重命名 / 移动成功 (CAS 零拷贝)');
      onClose();
      onSuccess();
    } catch (err: unknown) {
      if (isFormValidationError(err)) return;
      message.error(getErrorMessage(err, '重命名失败'));
    }
  };

  return (
    <Modal
      title={
        target?.isFolder
          ? '重命名 / 移动文件夹 (CAS Zero-Copy)'
          : '重命名 / 移动对象 (CAS Zero-Copy)'
      }
      open={open}
      onCancel={onClose}
      onOk={handleOk}
      confirmLoading={renameMutation.isPending}
      okText="确认修改"
      cancelText="取消"
      destroyOnClose
    >
      <div className="mt-3 mb-3">
        <Segmented
          size="small"
          value={mode}
          onChange={(v) => setMode(v as RenameMode)}
          options={[
            { label: '仅修改当前名称 (保持原目录)', value: 'name' },
            { label: '修改完整路径 / 跨目录移动', value: 'path' },
          ]}
        />
      </div>

      <Form form={form} layout="vertical" requiredMark={false}>
        {mode === 'name' ? (
          <Form.Item
            label={target?.isFolder ? '新文件夹名称' : '新文件名称'}
            name="newName"
            extra="保持当前所在父目录不变，底层通过 CAS 引用计数指针重定向，毫秒级完成"
            rules={[{ required: true, message: '请输入新名称' }]}
          >
            <Input
              className="font-mono"
              addonBefore={target?.parentDir ? <span className="font-mono text-xs text-slate-500">{target.parentDir}</span> : undefined}
              addonAfter={target?.isFolder ? <span className="font-mono text-xs text-slate-500">/</span> : undefined}
              autoFocus
            />
          </Form.Item>
        ) : (
          <Form.Item
            label="目标完整路径 Key"
            name="newKey"
            extra="可直接修改父目录前缀将对象或整个文件夹零拷贝移动至新目录"
            rules={[{ required: true, message: '请输入新的对象路径 Key' }]}
          >
            <Input className="font-mono" autoFocus />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}
