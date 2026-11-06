import { useState } from 'react';
import { Form, message } from 'antd';
import type { Bucket } from '../../../lib/api';
import { getErrorMessage, isFormValidationError } from '../../../lib/errors';
import { bytesToQuotaForm, quotaFormToBytes } from '../../../lib/utils';
import { useCreateBucket, useUpdateBucket } from '../../buckets/mutations';
import type { BucketFormValues } from '../types';

/**
 * 创建 / 编辑存储桶弹窗的状态与提交流程。
 * editBucket 为 null 表示「新建」，否则为「编辑」该桶的配置。
 */
export function useBucketForm() {
  const [form] = Form.useForm<BucketFormValues>();
  const [modalOpen, setModalOpen] = useState(false);
  const [editBucket, setEditBucket] = useState<Bucket | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const createBucket = useCreateBucket();
  const updateBucket = useUpdateBucket();

  const openCreateModal = () => {
    setEditBucket(null);
    form.setFieldsValue({
      name: '',
      visibility: 'public-read',
      quotaValue: 0,
      quotaUnit: 'MB',
      corsOrigins: '*',
    });
    setModalOpen(true);
  };

  const openEditModal = (b: Bucket) => {
    setEditBucket(b);
    const { quotaValue, quotaUnit } = bytesToQuotaForm(b.quotaBytes);
    form.setFieldsValue({
      name: b.name,
      visibility: b.visibility,
      quotaValue,
      quotaUnit,
      corsOrigins: b.corsOrigins || '*',
    });
    setModalOpen(true);
  };

  const closeModal = () => setModalOpen(false);

  const submit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const quotaBytes = quotaFormToBytes(values.quotaValue, values.quotaUnit);
      const corsOrigins = (values.corsOrigins || '*').trim();
      if (editBucket) {
        await updateBucket.mutateAsync({
          name: editBucket.name,
          payload: { visibility: values.visibility, quotaBytes, corsOrigins },
        });
        message.success(`存储桶 "${editBucket.name}" 配置已更新`);
      } else {
        const name = values.name.trim().toLowerCase();
        await createBucket.mutateAsync({
          name,
          visibility: values.visibility,
          quotaBytes,
          corsOrigins,
        });
        message.success(`存储桶 "${name}" 创建成功`);
      }
      setModalOpen(false);
    } catch (err: unknown) {
      if (isFormValidationError(err)) return;
      message.error(getErrorMessage(err, '保存存储桶失败'));
    } finally {
      setSubmitting(false);
    }
  };

  return { form, modalOpen, editBucket, submitting, openCreateModal, openEditModal, closeModal, submit };
}
