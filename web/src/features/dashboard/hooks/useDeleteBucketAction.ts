import { message } from 'antd';
import { getErrorMessage } from '../../../lib/errors';
import { useDeleteBucket } from '../../buckets/mutations';

/** 删除存储桶（支持空桶删除或非空桶二次校验后强制清空删除），成功 / 失败均给出全局提示 */
export function useDeleteBucketAction() {
  const deleteBucket = useDeleteBucket();

  return async (name: string, force = false) => {
    try {
      await deleteBucket.mutateAsync({ name, force });
      message.success(`存储桶 "${name}" 已删除`);
    } catch (err: unknown) {
      message.error(getErrorMessage(err, '删除存储桶失败'));
    }
  };
}
