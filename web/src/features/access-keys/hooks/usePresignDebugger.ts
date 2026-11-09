import { useCallback, useState } from 'react';
import { message } from 'antd';
import { Bucket, cosApi } from '../../../lib/api';
import { getErrorMessage } from '../../../lib/errors';
import { copyToClipboard } from '../../../lib/utils';
import type { PresignMethod } from '../types';

/** 在线预签名 URL 签发器：表单状态与生成逻辑 */
export function usePresignDebugger(buckets: Bucket[]) {
  const [selectedBucket, setSelectedBucket] = useState('');
  const [objectKey, setObjectKey] = useState('uploads/demo.png');
  const [method, setMethod] = useState<PresignMethod>('PUT');
  const [ttl, setTtl] = useState(3600);
  const [generatedUrl, setGeneratedUrl] = useState('');

  // 未手动选择时默认使用第一个存储桶
  const bucket = selectedBucket || buckets[0]?.name || '';
  const currentBucketObj = buckets.find((b) => b.name === bucket);
  const isPublicBucket = currentBucketObj?.visibility === 'public-read';

  // 公开只读桶天然支持永久 GET 直链，无需签发 GET 预签名，强制使用 PUT
  const effectiveMethod: PresignMethod = isPublicBucket ? 'PUT' : method;

  const handleSelectBucket = useCallback(
    (nextBucketName: string) => {
      setSelectedBucket(nextBucketName);
      setGeneratedUrl('');
      const target = buckets.find((b) => b.name === nextBucketName);
      if (target?.visibility === 'public-read') {
        setMethod('PUT');
      }
    },
    [buckets]
  );

  const handleSelectMethod = useCallback(
    (nextMethod: PresignMethod) => {
      if (isPublicBucket && nextMethod === 'GET') {
        message.info('公开只读桶的文件天然支持永久直链访问，无需签发 GET 限时链接');
        return;
      }
      setMethod(nextMethod);
      setGeneratedUrl('');
    },
    [isPublicBucket]
  );

  const generate = useCallback(async () => {
    if (!bucket || !objectKey.trim()) {
      message.warning('请选择存储桶并输入对象路径 Key');
      return;
    }
    try {
      const res = await cosApi.presignUrl(bucket, {
        key: objectKey.trim(),
        method: effectiveMethod,
        expiresInSec: ttl,
      });
      setGeneratedUrl(res.url);
      await copyToClipboard(res.url);
      message.success(`${effectiveMethod} 预签名 URL 已生成并复制到剪贴板`);
    } catch (err: unknown) {
      message.error(getErrorMessage(err, '生成预签名 URL 失败'));
    }
  }, [bucket, objectKey, effectiveMethod, ttl]);

  return {
    bucket,
    isPublicBucket,
    setBucket: handleSelectBucket,
    objectKey,
    setObjectKey,
    method: effectiveMethod,
    setMethod: handleSelectMethod,
    ttl,
    setTtl,
    generatedUrl,
    generate,
  };
}
