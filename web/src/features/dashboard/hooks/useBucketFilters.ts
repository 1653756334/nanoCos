import { useMemo, useState } from 'react';
import type { Bucket } from '../../../lib/api';
import { filterBuckets } from '../metrics';
import type { VisibilityFilter } from '../types';

/** 存储桶列表的搜索与可见性筛选状态 */
export function useBucketFilters(buckets: Bucket[]) {
  const [bucketSearch, setBucketSearch] = useState('');
  const [visFilter, setVisFilter] = useState<VisibilityFilter>('all');

  const filteredBuckets = useMemo(
    () => filterBuckets(buckets, visFilter, bucketSearch),
    [buckets, visFilter, bucketSearch]
  );

  return { bucketSearch, setBucketSearch, visFilter, setVisFilter, filteredBuckets };
}
