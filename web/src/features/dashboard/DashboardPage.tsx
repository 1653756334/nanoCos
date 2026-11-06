import { useMemo } from 'react';
import { useSystemOverview } from '../system/queries';
import { BucketFormModal } from './components/BucketFormModal';
import { BucketTable } from './components/BucketTable';
import { BucketUsagePanel } from './components/BucketUsagePanel';
import { CategoryBreakdownPanel } from './components/CategoryBreakdownPanel';
import { DashboardHeader } from './components/DashboardHeader';
import { ObjectFeedPanel } from './components/ObjectFeedPanel';
import { StatCards } from './components/StatCards';
import { SystemTopologyPanel } from './components/SystemTopologyPanel';
import { useBucketFilters } from './hooks/useBucketFilters';
import { useBucketForm } from './hooks/useBucketForm';
import { useDashboardNavigation } from './hooks/useDashboardNavigation';
import { useDeleteBucketAction } from './hooks/useDeleteBucketAction';
import { sortBucketsBySize, summarizeDashboard } from './metrics';

/** 存储监控与分析大盘（路由页面入口，仅负责数据获取与区块组合） */
export function DashboardPage() {
  const { stats, buckets, baseUrl, s3Endpoint, loading, refresh } = useSystemOverview();
  const { openBucket, openKeys } = useDashboardNavigation();
  const bucketForm = useBucketForm();
  const deleteBucket = useDeleteBucketAction();
  const { bucketSearch, setBucketSearch, visFilter, setVisFilter, filteredBuckets } =
    useBucketFilters(buckets);

  const sortedBucketsBySize = useMemo(() => sortBucketsBySize(buckets), [buckets]);
  const summary = useMemo(() => summarizeDashboard(stats, buckets), [stats, buckets]);

  return (
    <div className="space-y-4">
      <DashboardHeader
        uptimeSeconds={stats?.uptimeSeconds}
        diskFreeBytes={stats?.diskFreeBytes}
        diskTotalBytes={stats?.diskTotalBytes}
        loading={loading}
        onRefresh={refresh}
        onCreate={bucketForm.openCreateModal}
      />

      <StatCards stats={stats} buckets={buckets} summary={summary} onNavigateKeys={openKeys} />

      {/* 第二排：三大可视化图表分析面板 (严格等高 3 列网格) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <CategoryBreakdownPanel stats={stats} categories={summary.categories} />
        <BucketUsagePanel
          stats={stats}
          sortedBuckets={sortedBucketsBySize}
          totalBucketCount={buckets.length}
          onOpenBucket={openBucket}
        />
        <SystemTopologyPanel
          stats={stats}
          avgRef={summary.avgRef}
          baseUrl={baseUrl}
          s3Endpoint={s3Endpoint}
        />
      </div>

      {/* 第三排：左 7 列存储桶管理表 + 右 5 列大文件排行/实时上传动态 */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <BucketTable
          buckets={filteredBuckets}
          logicalBytes={stats?.logicalBytes}
          search={bucketSearch}
          onSearchChange={setBucketSearch}
          visFilter={visFilter}
          onVisFilterChange={setVisFilter}
          onOpenBucket={openBucket}
          onCreate={bucketForm.openCreateModal}
          onEdit={bucketForm.openEditModal}
          onDelete={deleteBucket}
        />
        <ObjectFeedPanel stats={stats} onOpenBucket={openBucket} />
      </div>

      <BucketFormModal
        open={bucketForm.modalOpen}
        editBucket={bucketForm.editBucket}
        form={bucketForm.form}
        submitting={bucketForm.submitting}
        onCancel={bucketForm.closeModal}
        onOk={bucketForm.submit}
      />
    </div>
  );
}
