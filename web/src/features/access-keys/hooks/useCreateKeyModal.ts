import { useCallback, useState } from 'react';
import { Form, message } from 'antd';
import { getErrorMessage, isFormValidationError } from '../../../lib/errors';
import { useCreateAccessKey } from '../queries';
import type { CreateKeyFormValues } from '../types';

/** 签发新密钥弹窗：表单、开关与提交逻辑 */
export function useCreateKeyModal() {
  const [form] = Form.useForm<CreateKeyFormValues>();
  const [open, setOpen] = useState(false);
  const createMutation = useCreateAccessKey();

  const openModal = useCallback(() => {
    form.setFieldsValue({
      name: '',
      allowedBuckets: '*',
      permission: 'readwrite',
    });
    setOpen(true);
  }, [form]);

  const closeModal = useCallback(() => setOpen(false), []);

  const submit = useCallback(async () => {
    try {
      const values = await form.validateFields();
      await createMutation.mutateAsync({
        name: values.name.trim(),
        allowedBuckets: (values.allowedBuckets || '*').trim(),
        permission: values.permission,
      });
      message.success('新访问密钥 (AK/SK) 已签发');
      form.resetFields();
      setOpen(false);
    } catch (err: unknown) {
      if (isFormValidationError(err)) return;
      message.error(getErrorMessage(err, '创建密钥失败'));
    }
  }, [form, createMutation]);

  return {
    form,
    open,
    submitting: createMutation.isPending,
    openModal,
    closeModal,
    submit,
  };
}
