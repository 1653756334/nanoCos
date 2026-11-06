import { message } from 'antd';
import { getErrorMessage } from '../../../lib/errors';
import { useDeleteBucket } from '../../buckets/mutations';

/** 删除存储桶（强制清空桶内文件），成功 / 失败均给出全局提示 */
export function useDeleteBucketAction() {
  const deleteBucket = useDeleteBucket();

  return async (name: string) => {
    try {
      await deleteBucket.mutateAsync({ name, force: true });
      message.success(`存储桶 "${name}" 已删除`);
    } catch (err: unknown) {
      message.error(getErrorMessage(err, '删除存储桶失败'));
    }
  };
}
