import { message } from 'antd';
import { Bucket, StorageObject, cosApi } from '../../../lib/api';
import { getErrorMessage } from '../../../lib/errors';
import { copyToClipboard } from '../../../lib/utils';
import { QUICK_PRESIGN_TTL } from '../constants';
import { buildRawUrl } from '../utils/objects';

interface UseObjectLinksOptions {
  bucket: string;
  baseUrl: string;
  visibility?: Bucket['visibility'];
}

/** 对象列表中的「复制链接」「下载」：公开桶走直链，私有桶签发 1 小时预签名链接 */
export function useObjectLinks({ bucket, baseUrl, visibility }: UseObjectLinksOptions) {
  const isPublic = visibility === 'public-read';

  const copyLink = async (obj: StorageObject) => {
    if (isPublic) {
      await copyToClipboard(buildRawUrl(baseUrl, bucket, obj.key));
      message.success('公开直链已复制到剪贴板');
      return;
    }
    try {
      const res = await cosApi.presignUrl(bucket, {
        key: obj.key,
        method: 'GET',
        expiresInSec: QUICK_PRESIGN_TTL,
      });
      await copyToClipboard(res.url);
      message.success('私有桶 1 小时预签名临时链接已生成并复制');
    } catch (err: unknown) {
      message.error(getErrorMessage(err, '生成链接失败'));
    }
  };

  const download = async (obj: StorageObject) => {
    if (isPublic) {
      window.open(
        buildRawUrl(baseUrl, bucket, obj.key, { download: true }),
        '_blank',
        'noopener,noreferrer'
      );
      return;
    }
    try {
      const res = await cosApi.presignUrl(bucket, {
        key: obj.key,
        method: 'GET',
        expiresInSec: QUICK_PRESIGN_TTL,
        download: true,
      });
      window.open(res.url, '_blank', 'noopener,noreferrer');
    } catch (err: unknown) {
      message.error(getErrorMessage(err, '生成下载链接失败'));
    }
  };

  return { copyLink, download };
}
