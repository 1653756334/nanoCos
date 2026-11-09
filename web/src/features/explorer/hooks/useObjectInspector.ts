import { useRef, useState } from 'react';
import { message } from 'antd';
import { Bucket, StorageObject, cosApi } from '../../../lib/api';
import { getErrorMessage } from '../../../lib/errors';
import { isTextContentType } from '../../../lib/utils';
import { QUICK_PRESIGN_TTL, TEXT_PREVIEW_MAX_BYTES } from '../constants';
import { buildRawUrl } from '../utils/objects';

interface UseObjectInspectorOptions {
  bucket: string;
  baseUrl: string;
  visibility?: Bucket['visibility'];
}

/**
 * 右侧「对象详情 / 在线预览」抽屉的状态：直链、预签名链接、文本预览。
 * 通过请求序号忽略过期响应，避免快速切换对象时旧结果覆盖新结果。
 */
export function useObjectInspector({ bucket, baseUrl, visibility }: UseObjectInspectorOptions) {
  const isPublic = visibility === 'public-read';
  const [object, setObject] = useState<StorageObject | null>(null);
  const [rawUrl, setRawUrl] = useState('');
  const [presignedUrl, setPresignedUrl] = useState('');
  const [presignTtl, setPresignTtl] = useState(QUICK_PRESIGN_TTL);
  const [loadingPresign, setLoadingPresign] = useState(false);
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const requestSeq = useRef(0);

  // 切换存储桶时关闭抽屉（渲染期同步重置）
  const [prevBucket, setPrevBucket] = useState(bucket);
  if (prevBucket !== bucket) {
    setPrevBucket(bucket);
    setObject(null);
  }

  const open = async (obj: StorageObject) => {
    const seq = ++requestSeq.current;
    const isStale = () => seq !== requestSeq.current;

    const directUrl = buildRawUrl(baseUrl, bucket, obj.key);
    setObject(obj);
    setTextPreview(null);
    setRawUrl(directUrl);
    setPresignedUrl('');

    let activeUrl = directUrl;
    // 公开桶直接走无签名直链，只有私有桶才需要额外请求预签名
    if (!isPublic) {
      setLoadingPresign(true);
      try {
        const res = await cosApi.presignUrl(bucket, {
          key: obj.key,
          method: 'GET',
          expiresInSec: presignTtl,
        });
        if (isStale()) return;
        activeUrl = res.url;
        setPresignedUrl(res.url);
      } catch {
        // 预签名失败时回退到直链（同源 Cookie 仍可加载预览）
      } finally {
        if (!isStale()) setLoadingPresign(false);
      }
    } else {
      setLoadingPresign(false);
    }

    if (isTextContentType(obj.contentType) && obj.sizeBytes <= TEXT_PREVIEW_MAX_BYTES) {
      try {
        const resp = await fetch(activeUrl);
        const text = await resp.text();
        if (!isStale()) setTextPreview(text);
      } catch {
        if (!isStale()) setTextPreview('无法加载文本预览');
      }
    }
  };

  const close = () => {
    requestSeq.current++;
    setLoadingPresign(false);
    setObject(null);
  };

  /** 以指定有效期重新签发预签名链接，返回新链接（失败返回空串并提示） */
  const refreshPresigned = async (ttl: number): Promise<string> => {
    setPresignTtl(ttl);
    if (!object || isPublic) return '';
    setLoadingPresign(true);
    try {
      const res = await cosApi.presignUrl(bucket, {
        key: object.key,
        method: 'GET',
        expiresInSec: ttl,
      });
      setPresignedUrl(res.url);
      return res.url;
    } catch (err: unknown) {
      message.error(getErrorMessage(err, '生成预签名链接失败'));
      return '';
    } finally {
      setLoadingPresign(false);
    }
  };

  return {
    object,
    rawUrl,
    presignedUrl,
    presignTtl,
    loadingPresign,
    textPreview,
    open,
    close,
    refreshPresigned,
  };
}

export type ObjectInspectorState = ReturnType<typeof useObjectInspector>;
