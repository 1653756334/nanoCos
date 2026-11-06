import { describe, expect, it } from 'vitest';
import type { Bucket, SystemStats } from '../../../lib/api';
import {
  DEFAULT_CATEGORIES,
  calcBucketUsagePercent,
  calcPolicySplit,
  calcSharePercent,
  filterBuckets,
  getRankBadgeClass,
  sortBucketsBySize,
  summarizeDashboard,
} from '../metrics';

function makeBucket(overrides: Partial<Bucket> = {}): Bucket {
  return {
    name: 'bucket',
    visibility: 'public-read',
    quotaBytes: 0,
    corsOrigins: '*',
    createdAt: '2024-01-01T00:00:00Z',
    objectCount: 0,
    usedBytes: 0,
    ...overrides,
  };
}

function makeStats(overrides: Partial<SystemStats> = {}): SystemStats {
  return {
    bucketCount: 0,
    publicBucketCount: 0,
    privateBucketCount: 0,
    objectCount: 0,
    folderCount: 0,
    blobCount: 0,
    logicalBytes: 0,
    physicalBytes: 0,
    savedBytes: 0,
    dedupRatioPercent: 0,
    avgRefCount: 1,
    accessKeyCount: 0,
    multipartActiveCount: 0,
    categories: [],
    recentObjects: [],
    topObjects: [],
    uptimeSeconds: 0,
    ...overrides,
  };
}

describe('summarizeDashboard', () => {
  it('stats 为空时使用默认值与占位分类', () => {
    const s = summarizeDashboard(null, []);
    expect(s.categories).toBe(DEFAULT_CATEGORIES);
    expect(s.publicBucketCount).toBe(0);
    expect(s.privateBucketCount).toBe(0);
    expect(s.dedupPct).toBe(0);
    expect(s.avgRef).toBe('1.00');
    expect(s.physicalRatio).toBe(100);
  });

  it('分类为空数组时同样回退到占位分类', () => {
    expect(summarizeDashboard(makeStats({ categories: [] }), []).categories).toBe(DEFAULT_CATEGORIES);
  });

  it('有分类统计时直接使用后端数据', () => {
    const categories = [
      { category: 'image', label: 'img', color: '#000', objectCount: 1, sizeBytes: 10, percent: 100 },
    ];
    expect(summarizeDashboard(makeStats({ categories }), []).categories).toBe(categories);
  });

  it('统计公开 / 私有桶数量', () => {
    const buckets = [
      makeBucket({ name: 'a', visibility: 'public-read' }),
      makeBucket({ name: 'b', visibility: 'private' }),
      makeBucket({ name: 'c', visibility: 'private' }),
    ];
    const s = summarizeDashboard(null, buckets);
    expect(s.publicBucketCount).toBe(1);
    expect(s.privateBucketCount).toBe(2);
  });

  it('去重率保留 1 位小数，引用比保留 2 位小数', () => {
    const s = summarizeDashboard(makeStats({ dedupRatioPercent: 33.3333, avgRefCount: 2.5 }), []);
    expect(s.dedupPct).toBe(33.3);
    expect(s.avgRef).toBe('2.50');
  });

  it('物理 / 逻辑落盘比四舍五入且不超过 100', () => {
    expect(summarizeDashboard(makeStats({ logicalBytes: 300, physicalBytes: 100 }), []).physicalRatio).toBe(33);
    expect(summarizeDashboard(makeStats({ logicalBytes: 100, physicalBytes: 500 }), []).physicalRatio).toBe(100);
    expect(summarizeDashboard(makeStats({ logicalBytes: 0, physicalBytes: 0 }), []).physicalRatio).toBe(100);
  });
});

describe('calcPolicySplit', () => {
  it('没有存储桶时各占 50%', () => {
    expect(calcPolicySplit(0, 0, 0)).toEqual({ publicWidth: 50, privateWidth: 50 });
  });

  it('按公开 / 私有桶数量计算宽度', () => {
    expect(calcPolicySplit(4, 1, 3)).toEqual({ publicWidth: 25, privateWidth: 75 });
  });
});

describe('filterBuckets', () => {
  const buckets = [
    makeBucket({ name: 'Photos', visibility: 'public-read' }),
    makeBucket({ name: 'backup-vault', visibility: 'private' }),
    makeBucket({ name: 'public-assets', visibility: 'public-read' }),
  ];

  it('all 且无关键字时返回全部', () => {
    expect(filterBuckets(buckets, 'all', '')).toHaveLength(3);
  });

  it('按可见性筛选', () => {
    expect(filterBuckets(buckets, 'private', '').map((b) => b.name)).toEqual(['backup-vault']);
    expect(filterBuckets(buckets, 'public-read', '')).toHaveLength(2);
  });

  it('关键字忽略大小写与首尾空白', () => {
    expect(filterBuckets(buckets, 'all', '  PHOTO ').map((b) => b.name)).toEqual(['Photos']);
  });

  it('可见性与关键字同时生效', () => {
    expect(filterBuckets(buckets, 'private', 'public')).toEqual([]);
    expect(filterBuckets(buckets, 'public-read', 'assets').map((b) => b.name)).toEqual(['public-assets']);
  });

  it('纯空白关键字视为无关键字', () => {
    expect(filterBuckets(buckets, 'all', '   ')).toHaveLength(3);
  });
});

describe('sortBucketsBySize', () => {
  it('按已用容量降序，且不修改入参', () => {
    const buckets = [
      makeBucket({ name: 'small', usedBytes: 1 }),
      makeBucket({ name: 'big', usedBytes: 100 }),
      makeBucket({ name: 'mid', usedBytes: 50 }),
    ];
    const sorted = sortBucketsBySize(buckets);
    expect(sorted.map((b) => b.name)).toEqual(['big', 'mid', 'small']);
    expect(buckets.map((b) => b.name)).toEqual(['small', 'big', 'mid']);
  });
});

describe('calcSharePercent', () => {
  it('总量为空或 0 时返回 0', () => {
    expect(calcSharePercent(10, undefined)).toBe(0);
    expect(calcSharePercent(10, 0)).toBe(0);
  });

  it('按占比计算，capAt100 时截断到 100', () => {
    expect(calcSharePercent(25, 100)).toBe(25);
    expect(calcSharePercent(200, 100)).toBe(200);
    expect(calcSharePercent(200, 100, true)).toBe(100);
  });
});

describe('calcBucketUsagePercent', () => {
  it('有配额时按配额计算并限制在 100 以内', () => {
    expect(calcBucketUsagePercent(makeBucket({ quotaBytes: 200, usedBytes: 50 }), 1000)).toBe(25);
    expect(calcBucketUsagePercent(makeBucket({ quotaBytes: 100, usedBytes: 500 }), 1000)).toBe(100);
  });

  it('无配额时按总逻辑容量计算', () => {
    expect(calcBucketUsagePercent(makeBucket({ quotaBytes: 0, usedBytes: 250 }), 1000)).toBe(25);
  });

  it('无配额且总容量缺失时返回 0', () => {
    expect(calcBucketUsagePercent(makeBucket({ usedBytes: 250 }), undefined)).toBe(0);
    expect(calcBucketUsagePercent(makeBucket({ usedBytes: 250 }), 0)).toBe(0);
  });
});

describe('getRankBadgeClass', () => {
  it('前三名使用金银铜配色，其余为默认', () => {
    expect(getRankBadgeClass(0)).toContain('amber');
    expect(getRankBadgeClass(1)).toContain('slate-200');
    expect(getRankBadgeClass(2)).toContain('orange');
    expect(getRankBadgeClass(3)).toBe('bg-slate-100 text-slate-500');
    expect(getRankBadgeClass(10)).toBe('bg-slate-100 text-slate-500');
  });
});
