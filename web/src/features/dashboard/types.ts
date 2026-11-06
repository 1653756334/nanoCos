import type { QuotaUnit } from '../../lib/utils';

/** 存储桶列表的可见性筛选 */
export type VisibilityFilter = 'all' | 'public-read' | 'private';

/** 右侧动态流模式：大文件排行 / 最近上传 */
export type FeedMode = 'top' | 'recent';

/** 创建 / 编辑存储桶弹窗的表单值 */
export interface BucketFormValues {
  name: string;
  visibility: 'public-read' | 'private';
  quotaValue: number | null;
  quotaUnit: QuotaUnit;
  corsOrigins: string;
}
