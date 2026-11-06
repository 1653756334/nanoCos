import { PaginationProps } from 'antd';

export type ViewMode = 'list' | 'grid';

export const DEFAULT_PAGE_SIZE = 50;
export const PAGE_SIZE_OPTIONS = ['20', '50', '100', '200'];

export const showTotalText: PaginationProps['showTotal'] = (total) => `共 ${total} 项`;

/** 超过该大小的文本对象不做内联预览 */
export const TEXT_PREVIEW_MAX_BYTES = 512 * 1024;

/** 预签名链接可选有效期（秒） */
export const PRESIGN_TTL_OPTIONS = [
  { label: '15分钟', value: 900 },
  { label: '1小时', value: 3600 },
  { label: '24小时', value: 86400 },
  { label: '7天', value: 604800 },
];

/** 快捷复制 / 下载私有桶对象时使用的预签名有效期（秒） */
export const QUICK_PRESIGN_TTL = 3600;
