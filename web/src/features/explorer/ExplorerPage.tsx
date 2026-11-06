import { useEffect, useMemo, useRef, useState } from 'react';
import { Card, message } from 'antd';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { StorageObject } from '../../lib/api';
import { getErrorMessage } from '../../lib/errors';
import { ExplorerTab, parseExplorerTab, routes } from '../../lib/routes';
import { useBuckets, useRefreshOverview, useSystemInfo } from '../system/queries';
import { BreadcrumbBar } from './components/BreadcrumbBar';
import { BucketSettingsTab } from './components/BucketSettingsTab';
import { CreateFolderModal } from './components/CreateFolderModal';
import { ExplorerHeader } from './components/ExplorerHeader';
import { ObjectGrid } from './components/ObjectGrid';
import { ObjectInspectorDrawer } from './components/ObjectInspectorDrawer';
import { ObjectTable } from './components/ObjectTable';
import { QuickStartTab } from './components/QuickStartTab';
import { RenameModal } from './components/RenameModal';
import { UploadModal } from './components/UploadModal';
import { useObjectBrowser } from './hooks/useObjectBrowser';
import { useObjectInspector } from './hooks/useObjectInspector';
import { useObjectLinks } from './hooks/useObjectLinks';
import { useUploadQueue } from './hooks/useUploadQueue';
import { useDeleteObjects, useObjectList } from './queries';

/** 存储桶与对象浏览器（路由页面入口） */
export function ExplorerPage() {
  const navigate = useNavigate();
  const { bucket: bucketParam } = useParams<{ bucket?: string }>();
  const [searchParams] = useSearchParams();
  const activeTab: ExplorerTab = parseExplorerTab(searchParams.get('tab'));

  const { data: buckets = [] } = useBuckets();
  const { baseUrl, s3Endpoint, s3Region } = useSystemInfo();
  const refreshOverview = useRefreshOverview();

  // 若路由中未带 bucket，或者指定的 bucket 不存在，尝试重定向至第一个可用桶
  const selectedBucketName = useMemo(() => {
    if (bucketParam && buckets.some((b) => b.name === bucketParam)) {
      return bucketParam;
    }
    return buckets[0]?.name || '';
  }, [bucketParam, buckets]);

  useEffect(() => {
    if (!bucketParam && buckets.length > 0 && selectedBucketName) {
      navigate(routes.bucket(selectedBucketName, activeTab), { replace: true });
    }
  }, [bucketParam, buckets.length, selectedBucketName, activeTab, navigate]);

  const currentBucket = useMemo(
    () => buckets.find((b) => b.name === selectedBucketName),
    [buckets, selectedBucketName]
  );

  const browser = useObjectBrowser(selectedBucketName);
  const objectList = useObjectList(selectedBucketName, {
    prefix: browser.prefix,
    search: browser.search,
    page: browser.page,
    pageSize: browser.pageSize,
  });

  // 当服务端数据刷新（dataUpdatedAt 改变）时，清空多选
  useEffect(() => {
    browser.clearSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectList.dataUpdatedAt]);

  const inspector = useObjectInspector({
    bucket: selectedBucketName,
    baseUrl,
  });

  const { copyLink, download } = useObjectLinks({
    bucket: selectedBucketName,
    baseUrl,
    visibility: currentBucket?.visibility,
  });

  const deleteObjectsMutation = useDeleteObjects(selectedBucketName);

  // 弹窗与拖拽状态
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<StorageObject | null>(null);
  const [pageDragOver, setPageDragOver] = useState(false);

  const { queue: uploadQueue, activeCount: uploadingCount, uploadFiles, clear: clearUploadQueue } =
    useUploadQueue({
      bucket: selectedBucketName,
      prefix: browser.prefix,
      onFinished: async () => {
        objectList.refetch();
        await refreshOverview();
      },
    });

  // 操作处理
  const handleSelectBucket = (name: string) => {
    navigate(routes.bucket(name, activeTab));
  };

  const handleTabChange = (tab: ExplorerTab) => {
    navigate(routes.bucket(selectedBucketName, tab));
  };

  const handleDeleteSingle = async (obj: StorageObject) => {
    try {
      await deleteObjectsMutation.mutateAsync([obj.key]);
      message.success(`已删除 "${obj.name}"`);
      if (inspector.object?.key === obj.key) {
        inspector.close();
      }
    } catch (err: unknown) {
      message.error(getErrorMessage(err, '删除失败'));
    }
  };

  const handleBatchDelete = async () => {
    if (browser.selectedKeys.length === 0) return;
    try {
      const keys = browser.selectedKeys.map(String);
      await deleteObjectsMutation.mutateAsync(keys);
      message.success(`已批量删除 ${keys.length} 项`);
      browser.clearSelection();
    } catch (err: unknown) {
      message.error(getErrorMessage(err, '批量删除部分失败'));
    }
  };

  const isPublicBucket = currentBucket?.visibility === 'public-read';

  return (
    <div
      className="space-y-4 relative"
      onDragOver={(e) => {
        e.preventDefault();
        if (!pageDragOver) setPageDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setPageDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setPageDragOver(false);
        if (e.dataTransfer.files?.length) {
          setUploadModalOpen(true);
          void uploadFiles(e.dataTransfer.files);
        }
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          void uploadFiles(e.target.files);
          e.target.value = '';
        }}
      />

      {/* 存储桶工作台顶部信息卡片 */}
      <ExplorerHeader
        buckets={buckets}
        currentBucket={currentBucket}
        selectedBucketName={selectedBucketName}
        activeTab={activeTab}
        uploadingCount={uploadingCount}
        onSelectBucket={handleSelectBucket}
        onTabChange={handleTabChange}
        onOpenUpload={() => setUploadModalOpen(true)}
        onOpenCreateFolder={() => setFolderModalOpen(true)}
      />

      {/* Tab 1: 文件对象管理 */}
      {activeTab === 'objects' && (
        <Card className="border-slate-200 shadow-none" styles={{ body: { padding: '16px 20px' } }}>
          <BreadcrumbBar
            bucketName={selectedBucketName}
            prefix={browser.prefix}
            breadcrumbs={objectList.breadcrumbs}
            search={browser.search}
            selectedKeys={browser.selectedKeys}
            loading={objectList.loading}
            viewMode={browser.viewMode}
            onNavigateUp={browser.navigateUp}
            onEnterFolder={browser.enterFolder}
            onSearchChange={browser.changeSearch}
            onRefresh={objectList.refetch}
            onViewModeChange={browser.setViewMode}
            onBatchDelete={handleBatchDelete}
          />

          {browser.viewMode === 'list' ? (
            <ObjectTable
              items={objectList.items}
              loading={objectList.loading}
              search={browser.search}
              isPublicBucket={isPublicBucket}
              selectedKeys={browser.selectedKeys}
              page={browser.page}
              pageSize={browser.pageSize}
              totalCount={objectList.totalCount}
              onSelectKeysChange={browser.setSelectedKeys}
              onPageChange={browser.changePage}
              onEnterFolder={browser.enterFolder}
              onOpenInspector={inspector.open}
              onCopyLink={copyLink}
              onDownload={download}
              onOpenRename={(obj) => {
                setRenameTarget(obj);
                setRenameModalOpen(true);
              }}
              onDeleteSingle={handleDeleteSingle}
              onOpenUpload={() => setUploadModalOpen(true)}
            />
          ) : (
            <ObjectGrid
              items={objectList.items}
              bucketName={selectedBucketName}
              baseUrl={baseUrl}
              isPublicBucket={isPublicBucket}
              page={browser.page}
              pageSize={browser.pageSize}
              totalCount={objectList.totalCount}
              onPageChange={browser.changePage}
              onEnterFolder={browser.enterFolder}
              onOpenInspector={inspector.open}
            />
          )}
        </Card>
      )}

      {/* Tab 2: 存储桶权限与配额设置 */}
      {activeTab === 'settings' && currentBucket && (
        <BucketSettingsTab bucket={currentBucket} />
      )}

      {/* Tab 3: 当前存储桶快速接入指南 */}
      {activeTab === 'guide' && currentBucket && (
        <QuickStartTab
          bucket={currentBucket}
          baseUrl={baseUrl}
          s3Endpoint={s3Endpoint}
          s3Region={s3Region}
        />
      )}

      {/* 右侧抽屉：对象详情与在线预览 */}
      <ObjectInspectorDrawer
        inspectObj={inspector.object}
        rawUrl={inspector.rawUrl}
        presignedUrl={inspector.presignedUrl}
        presignTtl={inspector.presignTtl}
        textPreview={inspector.textPreview}
        isPublicBucket={isPublicBucket}
        onClose={inspector.close}
        onUpdatePresignTtl={inspector.refreshPresigned}
        onDeleteSingle={handleDeleteSingle}
      />

      {/* 模态框：上传中心 */}
      <UploadModal
        open={uploadModalOpen}
        bucketName={selectedBucketName}
        prefix={browser.prefix}
        uploadQueue={uploadQueue}
        fileInputRef={fileInputRef}
        onClose={() => setUploadModalOpen(false)}
        onClearQueue={clearUploadQueue}
        onFilesSelect={(files) => {
          void uploadFiles(files);
        }}
      />

      {/* 模态框：新建目录 */}
      <CreateFolderModal
        open={folderModalOpen}
        bucketName={selectedBucketName}
        prefix={browser.prefix}
        onClose={() => setFolderModalOpen(false)}
        onSuccess={() => {
          objectList.refetch();
        }}
      />

      {/* 模态框：零拷贝重命名 / 移动 */}
      <RenameModal
        open={renameModalOpen}
        bucketName={selectedBucketName}
        target={renameTarget}
        onClose={() => {
          setRenameModalOpen(false);
          setRenameTarget(null);
        }}
        onSuccess={() => {
          if (inspector.object?.key === renameTarget?.key) {
            inspector.close();
          }
          objectList.refetch();
        }}
      />
    </div>
  );
}
