import React, { useState, useMemo } from 'react';
import {
  Button,
  Table,
  Tag,
  Progress,
  Modal,
  Form,
  Input,
  Select,
  Radio,
  InputNumber,
  Popconfirm,
  Space,
  Empty,
  Tooltip,
  Badge,
  Segmented,
  Row,
  Col,
  message,
} from 'antd';
import {
  PlusOutlined,
  ReloadOutlined,
  FolderOpenOutlined,
  SettingOutlined,
  DeleteOutlined,
  GlobalOutlined,
  LockOutlined,
  DatabaseOutlined,
  HddOutlined,
  ApiOutlined,
  KeyOutlined,
  ThunderboltOutlined,
  CopyOutlined,
  SearchOutlined,
  PieChartOutlined,
  BarChartOutlined,
  ClusterOutlined,
  ClockCircleOutlined,
  FireOutlined,
  FileTextOutlined,
  ArrowRightOutlined,
} from '@ant-design/icons';
import { Bucket, SystemStats, CategoryStat, cosApi } from '../lib/api';
import {
  formatBytes,
  formatDate,
  copyToClipboard,
  bytesToQuotaForm,
  quotaFormToBytes,
} from '../lib/utils';

interface DashboardViewProps {
  stats: SystemStats | null;
  buckets: Bucket[];
  baseUrl: string;
  s3Endpoint: string;
  s3Region: string;
  loading: boolean;
  onRefresh: () => Promise<void>;
  onOpenBucket: (bucketName: string, tab?: 'objects' | 'settings' | 'guide') => void;
  onNavigateKeys: () => void;
}

function formatUptime(seconds?: number): string {
  if (!seconds || seconds < 60) return `${seconds || 1} 秒`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins} 分钟`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return `${hours} 小时 ${remMins} 分`;
  const days = Math.floor(hours / 24);
  return `${days} 天 ${hours % 24} 小时`;
}

// SVG 环形饼图组件：展示按文件类型的容量占比
function CategoryDonutChart({
  categories,
  totalBytes,
  totalObjects,
}: {
  categories: CategoryStat[];
  totalBytes: number;
  totalObjects: number;
}) {
  const size = 148;
  const strokeWidth = 20;
  const center = size / 2;
  const radius = center - strokeWidth;
  const circumference = 2 * Math.PI * radius;

  let accumulatedPercent = 0;
  const hasData = totalBytes > 0 && categories.some((c) => c.sizeBytes > 0);

  return (
    <div className="relative flex items-center justify-center shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        {/* 底环 */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="transparent"
          stroke="#f1f5f9"
          strokeWidth={strokeWidth}
        />
        {hasData &&
          categories.map((cat) => {
            if (cat.percent <= 0) return null;
            const strokeDasharray = `${(cat.percent / 100) * circumference} ${circumference}`;
            const strokeDashoffset = -((accumulatedPercent / 100) * circumference);
            accumulatedPercent += cat.percent;
            return (
              <circle
                key={cat.category}
                cx={center}
                cy={center}
                r={radius}
                fill="transparent"
                stroke={cat.color}
                strokeWidth={strokeWidth}
                strokeDasharray={strokeDasharray}
                strokeDashoffset={strokeDashoffset}
                className="transition-all duration-500"
              />
            );
          })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
        <span className="text-[11px] text-slate-400">总逻辑容量</span>
        <span className="text-sm font-bold font-mono text-slate-800 mt-0.5">
          {formatBytes(totalBytes)}
        </span>
        <span className="text-[10px] font-mono text-slate-400">
          {totalObjects} 个文件
        </span>
      </div>
    </div>
  );
}

export function DashboardView({
  stats,
  buckets,
  baseUrl,
  s3Endpoint,
  s3Region,
  loading,
  onRefresh,
  onOpenBucket,
  onNavigateKeys,
}: DashboardViewProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editBucket, setEditBucket] = useState<Bucket | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [bucketSearch, setBucketSearch] = useState('');
  const [visFilter, setVisFilter] = useState<'all' | 'public-read' | 'private'>('all');
  const [feedMode, setFeedMode] = useState<'top' | 'recent'>('top');
  const [form] = Form.useForm();

  const openCreateModal = () => {
    setEditBucket(null);
    form.setFieldsValue({
      name: '',
      visibility: 'public-read',
      quotaValue: 0,
      quotaUnit: 'MB',
      corsOrigins: '*',
    });
    setModalOpen(true);
  };

  const openEditModal = (b: Bucket) => {
    setEditBucket(b);
    const { quotaValue, quotaUnit } = bytesToQuotaForm(b.quotaBytes);
    form.setFieldsValue({
      name: b.name,
      visibility: b.visibility,
      quotaValue,
      quotaUnit,
      corsOrigins: b.corsOrigins || '*',
    });
    setModalOpen(true);
  };

  const handleSaveBucket = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const quotaBytes = quotaFormToBytes(values.quotaValue, values.quotaUnit);
      if (editBucket) {
        await cosApi.updateBucket(editBucket.name, {
          visibility: values.visibility,
          quotaBytes,
          corsOrigins: (values.corsOrigins || '*').trim(),
        });
        message.success(`存储桶 "${editBucket.name}" 配置已更新`);
      } else {
        const name = values.name.trim().toLowerCase();
        await cosApi.createBucket({
          name,
          visibility: values.visibility,
          quotaBytes,
          corsOrigins: (values.corsOrigins || '*').trim(),
        });
        message.success(`存储桶 "${name}" 创建成功`);
      }
      setModalOpen(false);
      await onRefresh();
    } catch (err: any) {
      if (err?.errorFields) return;
      message.error(err.message || '保存存储桶失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteBucket = async (name: string) => {
    try {
      await cosApi.deleteBucket(name, true);
      message.success(`存储桶 "${name}" 已删除`);
      await onRefresh();
    } catch (err: any) {
      message.error(err.message || '删除存储桶失败');
    }
  };

  const filteredBuckets = useMemo(() => {
    return buckets.filter((b) => {
      if (visFilter !== 'all' && b.visibility !== visFilter) return false;
      if (bucketSearch.trim() && !b.name.toLowerCase().includes(bucketSearch.trim().toLowerCase())) {
        return false;
      }
      return true;
    });
  }, [buckets, visFilter, bucketSearch]);

  const sortedBucketsBySize = useMemo(() => {
    return [...buckets].sort((a, b) => b.usedBytes - a.usedBytes);
  }, [buckets]);

  const categories: CategoryStat[] = stats?.categories?.length
    ? stats.categories
    : [
        { category: 'image', label: '图片媒体 (Images)', color: '#3b82f6', objectCount: 0, sizeBytes: 0, percent: 0 },
        { category: 'media', label: '音视频流 (Video/Audio)', color: '#8b5cf6', objectCount: 0, sizeBytes: 0, percent: 0 },
        { category: 'doc', label: '文档与代码 (Docs/Code)', color: '#10b981', objectCount: 0, sizeBytes: 0, percent: 0 },
        { category: 'archive', label: '归档与二进制 (Archives/Bin)', color: '#f59e0b', objectCount: 0, sizeBytes: 0, percent: 0 },
      ];

  const publicBucketCount = buckets.filter((b) => b.visibility === 'public-read').length;
  const privateBucketCount = buckets.length - publicBucketCount;
  const dedupPct = Number((stats?.dedupRatioPercent ?? 0).toFixed(1));
  const avgRef = (stats?.avgRefCount ?? 1.0).toFixed(2);
  const physicalRatio =
    stats && stats.logicalBytes > 0
      ? Math.min(100, Math.round((stats.physicalBytes * 100) / stats.logicalBytes))
      : 100;

  const columns = [
    {
      title: '存储桶名称',
      dataIndex: 'name',
      key: 'name',
      width: 180,
      render: (name: string) => (
        <button
          onClick={() => onOpenBucket(name, 'objects')}
          className="group inline-flex items-center gap-2 text-left font-medium text-slate-800 hover:text-blue-600 transition-colors cursor-pointer"
        >
          <div className="w-6 h-6 rounded bg-blue-50 border border-blue-100 flex items-center justify-center text-blue-600 group-hover:bg-blue-600 group-hover:text-white transition-colors">
            <FolderOpenOutlined className="text-xs" />
          </div>
          <span className="font-mono text-xs font-semibold">{name}</span>
        </button>
      ),
    },
    {
      title: '访问权限',
      dataIndex: 'visibility',
      key: 'visibility',
      width: 130,
      render: (vis: string) =>
        vis === 'public-read' ? (
          <Tag icon={<GlobalOutlined />} color="success" className="m-0 text-xs">
            公开读
          </Tag>
        ) : (
          <Tag icon={<LockOutlined />} color="warning" className="m-0 text-xs">
            私有空间
          </Tag>
        ),
    },
    {
      title: '对象数',
      dataIndex: 'objectCount',
      key: 'objectCount',
      width: 90,
      render: (cnt: number) => (
        <span className="font-mono text-xs text-slate-700">{cnt.toLocaleString()}</span>
      ),
    },
    {
      title: '容量占用 / 配额',
      key: 'usage',
      render: (_: unknown, record: Bucket) => {
        const hasQuota = record.quotaBytes > 0;
        const pct = hasQuota
          ? Math.min(100, Math.round((record.usedBytes * 100) / record.quotaBytes))
          : stats?.logicalBytes
          ? Math.min(100, Math.round((record.usedBytes * 100) / stats.logicalBytes))
          : 0;
        return (
          <div className="max-w-[180px]">
            <div className="flex items-center justify-between text-xs font-mono mb-1">
              <span className="text-slate-700 font-medium">{formatBytes(record.usedBytes)}</span>
              <span className="text-slate-400 text-[11px]">
                {hasQuota ? `/ ${formatBytes(record.quotaBytes)}` : '/ 不限'}
              </span>
            </div>
            <div className="h-1.5 w-full rounded bg-slate-100 overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all"
                style={{ width: `${record.usedBytes > 0 ? Math.max(8, pct) : 0}%` }}
              />
            </div>
          </div>
        );
      },
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 155,
      render: (iso: string) => (
        <span className="text-xs text-slate-400 font-mono">{formatDate(iso)}</span>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 150,
      align: 'right' as const,
      render: (_: unknown, record: Bucket) => (
        <Space size={2}>
          <Button
            type="link"
            size="small"
            onClick={() => onOpenBucket(record.name, 'objects')}
          >
            管理
          </Button>
          <Tooltip title="配置存储桶">
            <Button
              type="text"
              size="small"
              aria-label={`配置存储桶 ${record.name}`}
              icon={<SettingOutlined />}
              onClick={() => openEditModal(record)}
            />
          </Tooltip>
          <Popconfirm
            title={`确定删除存储桶 "${record.name}"？`}
            description="将清空桶内所有文件并回收无引用物理块。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => handleDeleteBucket(record.name)}
          >
            <Button
              type="text"
              size="small"
              danger
              aria-label={`删除存储桶 ${record.name}`}
              icon={<DeleteOutlined />}
            />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const feedItems =
    feedMode === 'top' ? stats?.topObjects || [] : stats?.recentObjects || [];

  return (
    <div className="space-y-4">
      {/* 顶部监控大盘工具栏 */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-white border border-slate-200 rounded-md px-5 py-3.5">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-base font-bold text-slate-900 m-0">
            存储监控与分析大盘 (Storage Telemetry &amp; Analytics)
          </h1>
          <Badge
            status="processing"
            text={
              <span className="text-xs text-slate-500 font-mono">
                Engine: SQLite WAL + CAS SHA-256 · 已运行 {formatUptime(stats?.uptimeSeconds)}
              </span>
            }
          />
        </div>
        <Space size={8}>
          <Button icon={<ReloadOutlined spin={loading} />} onClick={onRefresh}>
            刷新监控
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreateModal}>
            新建存储桶
          </Button>
        </Space>
      </div>

      {/* 第一排：4 张带微图表的高密度数字指标卡 (严格等高 h-[148px]) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {/* KPI 1: 逻辑存储总量 + 多彩分类光谱条 */}
        <div className="h-[148px] bg-white border border-slate-200 rounded-md p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500">
              逻辑存储总容量 (Logical Capacity)
            </span>
            <div className="w-7 h-7 rounded bg-blue-50 border border-blue-100 text-blue-600 flex items-center justify-center text-sm">
              <DatabaseOutlined />
            </div>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-bold font-mono text-slate-900 leading-none">
              {formatBytes(stats?.logicalBytes)}
            </span>
            <span className="text-xs font-mono text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100">
              {(stats?.objectCount ?? 0).toLocaleString()} 文件 / {(stats?.folderCount ?? 0).toLocaleString()} 目录
            </span>
          </div>
          <div>
            {/* 分类占比光谱条 */}
            <div className="h-2 w-full rounded bg-slate-100 overflow-hidden flex mb-2">
              {categories.map((c) =>
                c.percent > 0 ? (
                  <div
                    key={c.category}
                    style={{ width: `${c.percent}%`, backgroundColor: c.color }}
                    title={`${c.label}: ${formatBytes(c.sizeBytes)} (${c.percent.toFixed(1)}%)`}
                  />
                ) : null
              )}
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span>跨存储桶逻辑汇总</span>
              <span className="font-mono text-slate-600">{buckets.length} Active Buckets</span>
            </div>
          </div>
        </div>

        {/* KPI 2: 物理磁盘占用 + 逻辑/物理双层对比条 */}
        <div className="h-[148px] bg-white border border-slate-200 rounded-md p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500">
              CAS 物理磁盘落盘 (Physical Footprint)
            </span>
            <div className="w-7 h-7 rounded bg-cyan-50 border border-cyan-100 text-cyan-600 flex items-center justify-center text-sm">
              <HddOutlined />
            </div>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-bold font-mono text-slate-900 leading-none">
              {formatBytes(stats?.physicalBytes)}
            </span>
            <span className="text-xs font-mono text-cyan-600 bg-cyan-50 px-1.5 py-0.5 rounded border border-cyan-100">
              {(stats?.blobCount ?? 0).toLocaleString()} 独立物理块
            </span>
          </div>
          <div>
            <div className="h-2 w-full rounded bg-slate-100 overflow-hidden mb-2">
              <div
                className="h-full bg-cyan-500 transition-all"
                style={{ width: `${stats?.physicalBytes ? physicalRatio : 0}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span>物理/逻辑落盘比</span>
              <span className="font-mono text-slate-600">{physicalRatio}% 磁盘占空比</span>
            </div>
          </div>
        </div>

        {/* KPI 3: CAS 去重节省与引用复用率 */}
        <div className="h-[148px] bg-white border border-slate-200 rounded-md p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500">
              CAS 去重与秒传收益 (Deduplication)
            </span>
            <div className="w-7 h-7 rounded bg-emerald-50 border border-emerald-100 text-emerald-600 flex items-center justify-center text-sm">
              <ThunderboltOutlined />
            </div>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-bold font-mono text-emerald-600 leading-none">
              {formatBytes(stats?.savedBytes)}
            </span>
            <span className="text-xs font-mono font-semibold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600 border border-emerald-200">
              去重率 {dedupPct}%
            </span>
          </div>
          <div>
            <div className="h-2 w-full rounded bg-slate-100 overflow-hidden mb-2">
              <div
                className="h-full bg-emerald-500 transition-all"
                style={{ width: `${Math.min(100, dedupPct)}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span>块平均引用比 (Ref Ratio)</span>
              <span className="font-mono text-emerald-600 font-semibold">{avgRef}x 复用</span>
            </div>
          </div>
        </div>

        {/* KPI 4: 访问安全与协议网关状态 */}
        <div className="h-[148px] bg-white border border-slate-200 rounded-md p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500">
              安全策略与访问凭证 (Security &amp; Auth)
            </span>
            <div className="w-7 h-7 rounded bg-amber-50 border border-amber-100 text-amber-600 flex items-center justify-center text-sm">
              <KeyOutlined />
            </div>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-bold font-mono text-slate-900 leading-none">
              {stats?.accessKeyCount ?? 0}{' '}
              <span className="text-xs font-sans font-normal text-slate-500">组密钥</span>
            </span>
            <button
              onClick={onNavigateKeys}
              className="text-xs text-blue-600 hover:underline flex items-center gap-1 cursor-pointer"
            >
              <span>管理密钥</span>
              <ArrowRightOutlined className="text-[10px]" />
            </button>
          </div>
          <div>
            <div className="h-2 w-full rounded bg-slate-100 overflow-hidden flex mb-2">
              <div
                className="h-full bg-emerald-500"
                style={{
                  width: `${
                    buckets.length > 0 ? (publicBucketCount * 100) / buckets.length : 50
                  }%`,
                }}
              />
              <div
                className="h-full bg-amber-500"
                style={{
                  width: `${
                    buckets.length > 0 ? (privateBucketCount * 100) / buckets.length : 50
                  }%`,
                }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span>桶策略: {publicBucketCount} 公开 / {privateBucketCount} 私有</span>
              <span className="font-mono text-slate-600">
                {stats?.multipartActiveCount ?? 0} 分片传输中
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 第二排：三大可视化图表分析面板 (严格等高 3 列网格) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* 图表 1: 媒体类型容量分布环形图 (4 列) */}
        <div className="lg:col-span-4 bg-white border border-slate-200 rounded-md flex flex-col justify-between">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <PieChartOutlined className="text-blue-600" />
              <span className="text-sm font-semibold text-slate-800">
                文件类型容量构成 (Media Breakdown)
              </span>
            </div>
            <span className="text-[11px] font-mono text-slate-400">MIME 分布</span>
          </div>

          <div className="p-4 flex flex-col sm:flex-row items-center gap-4 flex-1">
            <CategoryDonutChart
              categories={categories}
              totalBytes={stats?.logicalBytes ?? 0}
              totalObjects={stats?.objectCount ?? 0}
            />
            <div className="flex-1 w-full space-y-2.5">
              {categories.map((cat) => (
                <div key={cat.category} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-slate-700 font-medium truncate">
                      <span
                        className="w-2.5 h-2.5 rounded-sm shrink-0"
                        style={{ backgroundColor: cat.color }}
                      />
                      <span className="truncate">{cat.label.split(' ')[0]}</span>
                    </span>
                    <span className="font-mono text-xs text-slate-800 font-semibold">
                      {formatBytes(cat.sizeBytes)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-slate-400 pl-4">
                    <span>{cat.objectCount} 个对象</span>
                    <span className="font-mono">{cat.percent.toFixed(1)}%</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 图表 2: 存储桶容量与对象占比柱状图 (4 列) */}
        <div className="lg:col-span-4 bg-white border border-slate-200 rounded-md flex flex-col justify-between">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BarChartOutlined className="text-blue-600" />
              <span className="text-sm font-semibold text-slate-800">
                存储桶容量分布对比 (Bucket Usage)
              </span>
            </div>
            <span className="text-[11px] font-mono text-slate-400">Top Buckets</span>
          </div>

          <div className="p-4 flex-1 flex flex-col justify-between">
            {sortedBucketsBySize.length === 0 ? (
              <div className="my-auto text-center text-xs text-slate-400 py-8">
                暂无存储桶数据
              </div>
            ) : (
              <div className="space-y-3">
                {sortedBucketsBySize.slice(0, 4).map((b, idx) => {
                  const sharePct =
                    stats && stats.logicalBytes > 0
                      ? (b.usedBytes * 100) / stats.logicalBytes
                      : 0;
                  const barColors = ['#2563eb', '#0891b2', '#7c3aed', '#10b981'];
                  const barColor = barColors[idx % barColors.length];
                  return (
                    <div
                      key={b.name}
                      onClick={() => onOpenBucket(b.name, 'objects')}
                      className="group cursor-pointer space-y-1"
                    >
                      <div className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono font-semibold text-slate-800 group-hover:text-blue-600">
                            {b.name}
                          </span>
                          <span className="text-[11px] text-slate-400 font-mono">
                            ({b.objectCount} 项)
                          </span>
                        </div>
                        <div className="flex items-center gap-2 font-mono">
                          <span className="text-slate-800 font-medium">
                            {formatBytes(b.usedBytes)}
                          </span>
                          <span className="text-[11px] text-slate-400 w-11 text-right">
                            {sharePct.toFixed(1)}%
                          </span>
                        </div>
                      </div>
                      <div className="h-2.5 w-full rounded bg-slate-100 overflow-hidden">
                        <div
                          className="h-full transition-all duration-500 rounded"
                          style={{
                            width: `${b.usedBytes > 0 ? Math.max(6, sharePct) : 0}%`,
                            backgroundColor: barColor,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="mt-3 pt-2.5 border-t border-slate-100 flex items-center justify-between text-xs text-slate-400">
              <span>点击任意桶柱状条可直达文件管理</span>
              <span className="font-mono text-slate-600">
                共 {buckets.length} 个桶
              </span>
            </div>
          </div>
        </div>

        {/* 图表 3: CAS 寻址引擎流水线拓扑 & 网关节点 (4 列) */}
        <div className="lg:col-span-4 bg-white border border-slate-200 rounded-md flex flex-col justify-between">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ClusterOutlined className="text-blue-600" />
              <span className="text-sm font-semibold text-slate-800">
                CAS 寻址引擎拓扑与网关端点
              </span>
            </div>
            <span className="text-[11px] font-mono text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200">
              PathStyle: true
            </span>
          </div>

          <div className="p-4 flex-1 flex flex-col justify-between gap-3">
            {/* 拓扑流向图 */}
            <div className="grid grid-cols-3 gap-2 text-center bg-slate-50 border border-slate-200/80 rounded p-2.5">
              <div className="bg-white border border-slate-200 rounded p-2">
                <div className="text-[10px] text-slate-400">1. 逻辑对象层</div>
                <div className="text-sm font-bold font-mono text-blue-600 mt-0.5">
                  {stats?.objectCount ?? 0}
                </div>
                <div className="text-[10px] font-mono text-slate-500">
                  {formatBytes(stats?.logicalBytes)}
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded p-2 flex flex-col items-center justify-center">
                <div className="text-[10px] text-slate-400">2. SHA256 映射</div>
                <div className="text-xs font-bold font-mono text-emerald-600 mt-0.5">
                  {avgRef}x 聚合
                </div>
                <div className="text-[10px] text-slate-400">原子 Rename</div>
              </div>

              <div className="bg-white border border-slate-200 rounded p-2">
                <div className="text-[10px] text-slate-400">3. 物理块存储池</div>
                <div className="text-sm font-bold font-mono text-cyan-600 mt-0.5">
                  {stats?.blobCount ?? 0}
                </div>
                <div className="text-[10px] font-mono text-slate-500">
                  {formatBytes(stats?.physicalBytes)}
                </div>
              </div>
            </div>

            {/* 三大协议入口快捷复制列表 */}
            <div className="space-y-1.5">
              {[
                { tag: 'S3 节点', url: s3Endpoint },
                { tag: 'REST API', url: `${baseUrl}/api/v1` },
                { tag: 'Range 直链', url: `${baseUrl}/raw/{bucket}/{key}` },
              ].map((ep) => (
                <div
                  key={ep.tag}
                  className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded bg-slate-50 border border-slate-200/80 text-xs"
                >
                  <div className="flex items-center gap-2 truncate">
                    <span className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-white border border-slate-200 text-slate-600 shrink-0">
                      {ep.tag}
                    </span>
                    <code className="font-mono text-xs text-slate-700 truncate">
                      {ep.url}
                    </code>
                  </div>
                  <button
                    onClick={async () => {
                      await copyToClipboard(ep.url);
                      message.success(`${ep.tag} 地址已复制`);
                    }}
                    className="text-slate-400 hover:text-blue-600 shrink-0 cursor-pointer"
                    title="复制地址"
                  >
                    <CopyOutlined />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 第三排：左 7 列存储桶管理表 + 右 5 列大文件排行/实时上传动态 */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* 左侧：存储桶空间管理表 (7 列) */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-md flex flex-col justify-between">
          <div>
            <div className="px-4 py-3 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <FolderOpenOutlined className="text-blue-600" />
                <span className="text-sm font-semibold text-slate-800">
                  存储桶空间管理 (Buckets)
                </span>
                <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                  {filteredBuckets.length}
                </span>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <Segmented
                  size="small"
                  value={visFilter}
                  onChange={(v) => setVisFilter(v as any)}
                  options={[
                    { label: '全部', value: 'all' },
                    { label: '公开读', value: 'public-read' },
                    { label: '私有', value: 'private' },
                  ]}
                />
                <Input
                  size="small"
                  placeholder="搜索桶名..."
                  prefix={<SearchOutlined className="text-slate-400" />}
                  allowClear
                  value={bucketSearch}
                  onChange={(e) => setBucketSearch(e.target.value)}
                  style={{ width: 150, height: 26 }}
                />
              </div>
            </div>

            <Table
              dataSource={filteredBuckets}
              columns={columns}
              rowKey="name"
              pagination={false}
              size="small"
              locale={{
                emptyText: (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="暂无存储桶"
                  >
                    <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openCreateModal}>
                      创建存储桶
                    </Button>
                  </Empty>
                ),
              }}
            />
          </div>
        </div>

        {/* 右侧：Top 大文件容量排行 & 最近上传动态流 (5 列) */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-md flex flex-col justify-between">
          <div>
            <div className="px-4 py-2.5 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                {feedMode === 'top' ? (
                  <FireOutlined className="text-amber-500" />
                ) : (
                  <ClockCircleOutlined className="text-blue-600" />
                )}
                <span className="text-sm font-semibold text-slate-800">
                  {feedMode === 'top' ? 'Top 大文件容量排行' : '最近写入对象动态'}
                </span>
              </div>
              <Segmented
                size="small"
                value={feedMode}
                onChange={(v) => setFeedMode(v as 'top' | 'recent')}
                options={[
                  { label: 'Top 大文件', value: 'top' },
                  { label: '最新上传', value: 'recent' },
                ]}
              />
            </div>

            <div className="p-3.5">
              {feedItems.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="暂无文件对象记录"
                />
              ) : (
                <div className="space-y-2.5">
                  {feedItems.map((obj, idx) => {
                    const sharePct =
                      stats && stats.logicalBytes > 0
                        ? Math.min(100, (obj.sizeBytes * 100) / stats.logicalBytes)
                        : 0;
                    return (
                      <div
                        key={`${obj.bucket}-${obj.key}`}
                        onClick={() => onOpenBucket(obj.bucket, 'objects')}
                        className="group cursor-pointer p-2.5 rounded bg-slate-50/80 hover:bg-blue-50/50 border border-slate-200/70 hover:border-blue-200 transition-colors"
                      >
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <div className="flex items-center gap-2 truncate">
                            <span
                              className={`w-5 h-5 rounded text-[11px] font-mono font-bold flex items-center justify-center shrink-0 ${
                                idx === 0
                                  ? 'bg-amber-100 text-amber-700'
                                  : idx === 1
                                  ? 'bg-slate-200 text-slate-700'
                                  : idx === 2
                                  ? 'bg-orange-100 text-orange-700'
                                  : 'bg-slate-100 text-slate-500'
                              }`}
                            >
                              {idx + 1}
                            </span>
                            <FileTextOutlined className="text-slate-400 shrink-0" />
                            <span
                              className="font-mono font-medium text-slate-800 group-hover:text-blue-600 truncate"
                              title={obj.key}
                            >
                              {obj.key}
                            </span>
                          </div>
                          <span className="font-mono font-semibold text-slate-800 shrink-0">
                            {formatBytes(obj.sizeBytes)}
                          </span>
                        </div>

                        <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px] text-slate-400 pl-7">
                          <div className="flex items-center gap-2">
                            <span className="font-mono px-1.5 py-0.2 bg-white border border-slate-200 rounded text-slate-600">
                              {obj.bucket}
                            </span>
                            <span>{obj.contentType.split(';')[0]}</span>
                          </div>
                          <span className="font-mono">
                            {feedMode === 'top'
                              ? `占比 ${sharePct.toFixed(1)}%`
                              : formatDate(obj.updatedAt)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 创建 / 编辑存储桶弹窗 */}
      <Modal
        title={editBucket ? `修改存储桶配置: ${editBucket.name}` : '新建存储桶 (Create Bucket)'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSaveBucket}
        confirmLoading={submitting}
        okText={editBucket ? '保存配置' : '立即创建'}
        cancelText="取消"
        destroyOnHidden
        width={520}
      >
        <Form form={form} layout="vertical" className="mt-4" requiredMark={false}>
          <Form.Item
            label="存储桶名称 (Bucket Name)"
            name="name"
            extra="支持 3~63 位小写字母、数字、中划线 (-)，创建后不可更改名称"
            rules={[
              { required: true, message: '请输入存储桶名称' },
              {
                pattern: /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/,
                message: '需为 3~63 位小写字母、数字或中划线，且首尾为字母或数字',
              },
            ]}
          >
            <Input
              placeholder="例如: public-assets 或 backup-vault"
              disabled={!!editBucket}
              className="font-mono"
            />
          </Form.Item>

          <Form.Item label="访问权限 (Access Policy)" name="visibility">
            <Radio.Group className="w-full">
              <div className="grid grid-cols-1 gap-2.5">
                <label className="flex items-start gap-3 p-3 rounded border border-slate-200 hover:border-blue-500 cursor-pointer transition-colors">
                  <Radio value="public-read" className="mt-0.5" />
                  <div>
                    <div className="text-sm font-medium text-slate-800 flex items-center gap-1.5">
                      <GlobalOutlined className="text-emerald-600" />
                      <span>公开读，私有写 (Public Read)</span>
                      <Tag color="success" className="m-0 text-[10px]">
                        推荐图床/静态资源
                      </Tag>
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      任何人可通过 <code className="text-blue-600">/raw/&#123;bucket&#125;/&#123;key&#125;</code> 直链读取或播放音视频，上传与修改需认证。
                    </div>
                  </div>
                </label>

                <label className="flex items-start gap-3 p-3 rounded border border-slate-200 hover:border-blue-500 cursor-pointer transition-colors">
                  <Radio value="private" className="mt-0.5" />
                  <div>
                    <div className="text-sm font-medium text-slate-800 flex items-center gap-1.5">
                      <LockOutlined className="text-amber-600" />
                      <span>私有读写 (Private)</span>
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      所有读写请求均需携带有效 AK/SK 签名或通过生成的预签名临时链接 (Presigned URL) 访问。
                    </div>
                  </div>
                </label>
              </div>
            </Radio.Group>
          </Form.Item>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label="容量配额限制"
                extra="填 0 表示不限制存储桶容量"
              >
                <Space.Compact className="w-full">
                  <Form.Item name="quotaValue" noStyle>
                    <InputNumber min={0} className="w-full" placeholder="0" />
                  </Form.Item>
                  <Form.Item name="quotaUnit" noStyle initialValue="MB">
                    <Select
                      style={{ width: 84 }}
                      options={[
                        { value: 'B', label: 'Byte' },
                        { value: 'KB', label: 'KB' },
                        { value: 'MB', label: 'MB' },
                        { value: 'GB', label: 'GB' },
                      ]}
                    />
                  </Form.Item>
                </Space.Compact>
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="CORS 允许跨域 Origin"
                name="corsOrigins"
                extra="默认 * 允许所有前端域名跨域读取"
              >
                <Input placeholder="*" className="font-mono" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </div>
  );
}
