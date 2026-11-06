import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Card,
  Button,
  Table,
  Tag,
  Space,
  Select,
  Input,
  Tabs,
  Drawer,
  Descriptions,
  Modal,
  Form,
  Radio,
  InputNumber,
  Segmented,
  Popconfirm,
  Dropdown,
  Progress,
  Empty,
  Typography,
  Image,
  Alert,
  Badge,
  Tooltip,
  Pagination,
  Row,
  Col,
  message,
} from 'antd';
import {
  UploadOutlined,
  FolderAddOutlined,
  ReloadOutlined,
  DeleteOutlined,
  SearchOutlined,
  FolderFilled,
  FileImageOutlined,
  VideoCameraOutlined,
  AudioOutlined,
  CodeOutlined,
  FilePdfOutlined,
  FileZipOutlined,
  FileTextOutlined,
  EyeOutlined,
  LinkOutlined,
  CopyOutlined,
  DownloadOutlined,
  EditOutlined,
  MoreOutlined,
  HomeOutlined,
  RollbackOutlined,
  AppstoreOutlined,
  BarsOutlined,
  GlobalOutlined,
  LockOutlined,
  ThunderboltOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  SettingOutlined,
  CodeSandboxOutlined,
  InboxOutlined,
} from '@ant-design/icons';
import { Bucket, StorageObject, cosApi } from '../lib/api';
import {
  formatBytes,
  formatDate,
  computeSHA256Hex,
  copyToClipboard,
  bytesToQuotaForm,
  quotaFormToBytes,
  computeAdaptiveChunkSize,
  getMultipartResumeRecord,
  saveMultipartResumeRecord,
  deleteMultipartResumeRecord,
} from '../lib/utils';

const { Title, Text } = Typography;

export interface UploadTaskItem {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: 'hashing' | 'uploading' | 'fast' | 'done' | 'error';
  detail: string;
}

interface ExplorerViewProps {
  buckets: Bucket[];
  selectedBucket: string;
  initialTab?: 'objects' | 'settings' | 'guide';
  onSelectBucket: (name: string) => void;
  baseUrl: string;
  s3Endpoint: string;
  s3Region: string;
  onBucketsChanged: () => Promise<void>;
}

export function ExplorerView({
  buckets,
  selectedBucket,
  initialTab = 'objects',
  onSelectBucket,
  baseUrl,
  s3Endpoint,
  s3Region,
  onBucketsChanged,
}: ExplorerViewProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [activeTab, setActiveTab] = useState<'objects' | 'settings' | 'guide'>(initialTab);
  const [prefix, setPrefix] = useState('');
  const [search, setSearch] = useState('');
  const [breadcrumbs, setBreadcrumbs] = useState<string[]>([]);
  const [items, setItems] = useState<StorageObject[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);

  // 上传弹窗与任务队列
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<UploadTaskItem[]>([]);
  const [pageDragOver, setPageDragOver] = useState(false);

  // 新建目录弹窗
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [folderForm] = Form.useForm();

  // 重命名 / 移动弹窗
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<StorageObject | null>(null);
  const [renameForm] = Form.useForm();

  // 右侧文件详情与预览抽屉 (Object Inspector Drawer)
  const [inspectObj, setInspectObj] = useState<StorageObject | null>(null);
  const [rawUrl, setRawUrl] = useState('');
  const [presignedUrl, setPresignedUrl] = useState('');
  const [presignTtl, setPresignTtl] = useState<number>(3600);
  const [textPreview, setTextPreview] = useState<string | null>(null);

  // 存储桶配置表单
  const [settingsForm] = Form.useForm();
  const [savingSettings, setSavingSettings] = useState(false);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  const currentBucket = buckets.find((b) => b.name === selectedBucket);

  useEffect(() => {
    if (currentBucket) {
      const { quotaValue, quotaUnit } = bytesToQuotaForm(currentBucket.quotaBytes);
      settingsForm.setFieldsValue({
        visibility: currentBucket.visibility,
        quotaValue,
        quotaUnit,
        corsOrigins: currentBucket.corsOrigins || '*',
      });
    }
  }, [currentBucket, settingsForm]);

  const fetchObjects = useCallback(async () => {
    if (!selectedBucket) {
      setItems([]);
      setTotalCount(0);
      return;
    }
    setLoading(true);
    try {
      const offset = (page - 1) * pageSize;
      const res = await cosApi.browseObjects(
        selectedBucket,
        prefix,
        search,
        pageSize,
        offset
      );
      setBreadcrumbs(res.breadcrumbs || []);
      setItems(res.items || []);
      setTotalCount(res.totalCount ?? (res.items?.length || 0));
      setSelectedRowKeys([]);
    } catch (err: any) {
      if (err?.message === 'UNAUTHORIZED') return;
      message.error(err.message || '加载对象列表失败');
    } finally {
      setLoading(false);
    }
  }, [selectedBucket, prefix, search, page, pageSize]);

  useEffect(() => {
    fetchObjects();
  }, [fetchObjects]);

  const handleBucketSwitch = (name: string) => {
    setPrefix('');
    setSearch('');
    setPage(1);
    setSelectedRowKeys([]);
    onSelectBucket(name);
  };

  // --- 上传引擎 (SHA-256 极速秒传 + 大文件并发分片上传) ---
  const updateTask = (id: string, patch: Partial<UploadTaskItem>) => {
    setUploadQueue((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
  };

  const uploadSingleStream = (
    bucket: string,
    key: string,
    file: File,
    onProgress: (pct: number) => void
  ): Promise<void> => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const encodedKey = key.split('/').map(encodeURIComponent).join('/');
      xhr.open('PUT', `/api/v1/buckets/${encodeURIComponent(bucket)}/objects/${encodedKey}`);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded * 100) / e.total));
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`HTTP ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('网络传输中断'));
      xhr.send(file);
    });
  };

  const uploadMultipart = async (
    bucket: string,
    key: string,
    file: File,
    onProgress: (pct: number, detail: string) => void
  ) => {
    const chunkSize = computeAdaptiveChunkSize(file.size);
    const totalParts = Math.ceil(file.size / chunkSize);
    const resumeKey = `${bucket}:${key}:${file.size}:${file.lastModified}:${chunkSize}`;

    let uploadId = '';
    const uploadedPartSet = new Set<number>();

    // 1. 尝试从 IndexedDB 读取断点续传会话，并向服务端查询已落盘的分片
    const cached = await getMultipartResumeRecord(resumeKey);
    if (cached && cached.uploadId && cached.chunkSize === chunkSize) {
      try {
        onProgress(2, '探测未完成的分片会话 (断点续传)...');
        const statusRes = await cosApi.getMultipartStatus(bucket, cached.uploadId);
        if (statusRes && statusRes.uploadId) {
          uploadId = statusRes.uploadId;
          for (const pt of statusRes.parts || []) {
            const pStart = (pt.partNumber - 1) * chunkSize;
            const pExpectedSize = Math.min(chunkSize, file.size - pStart);
            if (pt.sizeBytes === pExpectedSize) {
              uploadedPartSet.add(pt.partNumber);
            }
          }
        }
      } catch {
        await deleteMultipartResumeRecord(resumeKey);
      }
    }

    // 2. 若无可用续传会话，则初始化新分片上传并写入 IndexedDB
    if (!uploadId) {
      onProgress(2, `初始化分片 (${totalParts} 片, 单片 ${formatBytes(chunkSize)})...`);
      const initRes = await cosApi.initMultipart(
        bucket,
        key,
        file.type || 'application/octet-stream'
      );
      uploadId = initRes.uploadId;
      await saveMultipartResumeRecord({
        id: resumeKey,
        uploadId,
        bucket,
        key,
        size: file.size,
        lastModified: file.lastModified,
        chunkSize,
        updatedAt: Date.now(),
      });
    }

    let completed = uploadedPartSet.size;
    let nextPart = 1;
    const concurrency = 3;
    const maxRetries = 3;
    const partTimeoutMs = 60_000;

    const uploadPartWithRetry = async (partNumber: number, chunk: Blob) => {
      let lastErr: unknown;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), partTimeoutMs);
        try {
          await cosApi.uploadMultipartPart(
            bucket,
            uploadId,
            partNumber,
            chunk,
            controller.signal
          );
          clearTimeout(timer);
          return;
        } catch (err) {
          clearTimeout(timer);
          lastErr = err;
          if (attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, 400 * attempt));
          }
        }
      }
      throw lastErr instanceof Error
        ? lastErr
        : new Error(`分片 #${partNumber} 重试 ${maxRetries} 次后仍失败`);
    };

    try {
      const worker = async () => {
        while (nextPart <= totalParts) {
          const partNumber = nextPart++;
          if (uploadedPartSet.has(partNumber)) {
            continue;
          }
          const start = (partNumber - 1) * chunkSize;
          const end = Math.min(start + chunkSize, file.size);
          const chunk = file.slice(start, end);

          await uploadPartWithRetry(partNumber, chunk);
          completed++;
          const pct = Math.round((completed * 95) / totalParts);
          onProgress(pct, `分片并发传输 ${completed}/${totalParts} (${pct}%)`);
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(concurrency, totalParts) }, () => worker())
      );

      onProgress(98, '流式合并分片 & 校验 SHA-256...');
      await cosApi.completeMultipart(bucket, uploadId);
      await deleteMultipartResumeRecord(resumeKey);
    } catch (err) {
      // 分片重试耗尽后主动清理服务端暂存分片与本地续传记录，防止残留孤儿分片占满配额
      await cosApi.abortMultipart(bucket, uploadId).catch(() => {});
      await deleteMultipartResumeRecord(resumeKey);
      throw err;
    }
  };

  const processFilesUpload = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    if (!selectedBucket) {
      message.warning('请先选择或创建一个存储桶');
      return;
    }

    const files = Array.from(fileList);
    const newTasks: UploadTaskItem[] = files.map((f) => ({
      id: `${Date.now()}-${Math.random()}`,
      name: f.name,
      size: f.size,
      progress: 5,
      status: 'hashing',
      detail: '计算 SHA-256 指纹...',
    }));

    setUploadQueue((prev) => [...newTasks, ...prev]);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const task = newTasks[i];
      const targetKey = `${prefix}${file.name}`;

      try {
        if (file.size <= 20 * 1024 * 1024) {
          const sha256 = await computeSHA256Hex(file);
          if (sha256) {
            updateTask(task.id, { detail: '探测 CAS 秒传池...', progress: 15 });
            const fastRes = await cosApi.tryFastUpload(selectedBucket, {
              key: targetKey,
              sha256,
              contentType: file.type || 'application/octet-stream',
            });
            if (fastRes.fastUploaded) {
              updateTask(task.id, {
                status: 'fast',
                progress: 100,
                detail: 'SHA-256 极速秒传命中 (CAS 全局去重)',
              });
              continue;
            }
          }
        }

        updateTask(task.id, { status: 'uploading', detail: '正在上传...' });
        const MULTIPART_THRESHOLD = 5 * 1024 * 1024;
        if (file.size < MULTIPART_THRESHOLD) {
          await uploadSingleStream(selectedBucket, targetKey, file, (pct) => {
            updateTask(task.id, { progress: pct, detail: `流式上传中 ${pct}%` });
          });
          updateTask(task.id, {
            status: 'done',
            progress: 100,
            detail: '上传成功',
          });
        } else {
          await uploadMultipart(selectedBucket, targetKey, file, (pct, detail) => {
            updateTask(task.id, { progress: pct, detail });
          });
          updateTask(task.id, {
            status: 'done',
            progress: 100,
            detail: '分片流式合并完成',
          });
        }
      } catch (err: any) {
        updateTask(task.id, {
          status: 'error',
          detail: err.message || '上传失败',
        });
      }
    }

    await fetchObjects();
    await onBucketsChanged();
  };

  // --- 目录、重命名、删除操作 ---
  const handleCreateFolder = async () => {
    try {
      const values = await folderForm.validateFields();
      const clean = values.folderName.trim().replace(/^\/+/, '');
      await cosApi.createFolder(selectedBucket, `${prefix}${clean}`);
      message.success(`目录 "${clean}" 创建成功`);
      folderForm.resetFields();
      setFolderModalOpen(false);
      await fetchObjects();
    } catch (err: any) {
      if (err?.errorFields) return;
      message.error(err.message || '创建目录失败');
    }
  };

  const handleRenameSubmit = async () => {
    if (!renameTarget) return;
    try {
      const values = await renameForm.validateFields();
      const dstKey = values.newKey.trim();
      if (!dstKey || dstKey === renameTarget.key) {
        setRenameModalOpen(false);
        return;
      }
      await cosApi.copyObject(selectedBucket, {
        srcKey: renameTarget.key,
        dstBucket: selectedBucket,
        dstKey,
        deleteSource: true,
      });
      message.success('重命名 / 移动成功 (基于 CAS 零拷贝)');
      setRenameModalOpen(false);
      if (inspectObj?.key === renameTarget.key) {
        setInspectObj(null);
      }
      await fetchObjects();
    } catch (err: any) {
      if (err?.errorFields) return;
      message.error(err.message || '重命名失败');
    }
  };

  const handleDeleteSingle = async (obj: StorageObject) => {
    try {
      await cosApi.deleteObject(selectedBucket, obj.key);
      message.success(`已删除 "${obj.name}"`);
      if (inspectObj?.key === obj.key) {
        setInspectObj(null);
      }
      await fetchObjects();
      await onBucketsChanged();
    } catch (err: any) {
      message.error(err.message || '删除失败');
    }
  };

  const handleBatchDelete = async () => {
    if (selectedRowKeys.length === 0) return;
    try {
      for (const k of selectedRowKeys) {
        await cosApi.deleteObject(selectedBucket, String(k));
      }
      message.success(`已批量删除 ${selectedRowKeys.length} 项`);
      setSelectedRowKeys([]);
      await fetchObjects();
      await onBucketsChanged();
    } catch (err: any) {
      message.error(err.message || '批量删除部分失败');
    }
  };

  // --- 打开右侧对象详情与预览抽屉 ---
  const openInspector = async (obj: StorageObject) => {
    setInspectObj(obj);
    setTextPreview(null);
    const encodedKey = obj.key.split('/').map(encodeURIComponent).join('/');
    const directUrl = `${baseUrl}/raw/${encodeURIComponent(selectedBucket)}/${encodedKey}`;
    setRawUrl(directUrl);
    setPresignedUrl('');

    let activeUrl = directUrl;
    try {
      const res = await cosApi.presignUrl(selectedBucket, {
        key: obj.key,
        method: 'GET',
        expiresInSec: presignTtl,
      });
      activeUrl = res.url;
      setPresignedUrl(res.url);
    } catch {
      // ignore
    }

    const ct = (obj.contentType || '').toLowerCase();
    const isText =
      ct.startsWith('text/') ||
      ct.includes('json') ||
      ct.includes('javascript') ||
      ct.includes('xml') ||
      ct.includes('yaml');

    if (isText && obj.sizeBytes <= 512 * 1024) {
      try {
        const resp = await fetch(activeUrl);
        setTextPreview(await resp.text());
      } catch {
        setTextPreview('无法加载文本预览');
      }
    }
  };

  const handleUpdatePresignTtl = async (ttl: number) => {
    setPresignTtl(ttl);
    if (!inspectObj) return;
    try {
      const res = await cosApi.presignUrl(selectedBucket, {
        key: inspectObj.key,
        method: 'GET',
        expiresInSec: ttl,
      });
      setPresignedUrl(res.url);
    } catch (err: any) {
      message.error(err.message || '生成预签名链接失败');
    }
  };

  const handleQuickCopyLink = async (obj: StorageObject) => {
    const encodedKey = obj.key.split('/').map(encodeURIComponent).join('/');
    const directUrl = `${baseUrl}/raw/${encodeURIComponent(selectedBucket)}/${encodedKey}`;
    if (currentBucket?.visibility === 'public-read') {
      await copyToClipboard(directUrl);
      message.success('公开直链已复制到剪贴板');
    } else {
      try {
        const res = await cosApi.presignUrl(selectedBucket, {
          key: obj.key,
          method: 'GET',
          expiresInSec: 3600,
        });
        await copyToClipboard(res.url);
        message.success('私有桶 1 小时预签名临时链接已生成并复制');
      } catch (err: any) {
        message.error(err.message || '生成链接失败');
      }
    }
  };

  const handleDownloadObject = async (obj: StorageObject) => {
    const encodedKey = obj.key.split('/').map(encodeURIComponent).join('/');
    const directDownloadUrl = `${baseUrl}/raw/${encodeURIComponent(selectedBucket)}/${encodedKey}?download=1`;
    if (currentBucket?.visibility === 'public-read') {
      window.open(directDownloadUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    try {
      const res = await cosApi.presignUrl(selectedBucket, {
        key: obj.key,
        method: 'GET',
        expiresInSec: 3600,
        download: true,
      });
      window.open(res.url, '_blank', 'noopener,noreferrer');
    } catch (err: any) {
      message.error(err.message || '生成下载链接失败');
    }
  };

  // 保存存储桶设置
  const handleSaveBucketSettings = async (values: any) => {
    if (!currentBucket) return;
    setSavingSettings(true);
    try {
      const quotaBytes = quotaFormToBytes(values.quotaValue, values.quotaUnit);
      await cosApi.updateBucket(currentBucket.name, {
        visibility: values.visibility,
        quotaBytes,
        corsOrigins: (values.corsOrigins || '*').trim(),
      });
      message.success('存储桶配置已保存');
      await onBucketsChanged();
    } catch (err: any) {
      message.error(err.message || '保存配置失败');
    } finally {
      setSavingSettings(false);
    }
  };

  const renderFileIcon = (obj: StorageObject, sizeClass = 'text-lg') => {
    if (obj.isFolder) {
      return <FolderFilled className={`${sizeClass} text-amber-500`} />;
    }
    const ct = (obj.contentType || '').toLowerCase();
    if (ct.startsWith('image/')) return <FileImageOutlined className={`${sizeClass} text-pink-500`} />;
    if (ct.startsWith('video/')) return <VideoCameraOutlined className={`${sizeClass} text-purple-500`} />;
    if (ct.startsWith('audio/')) return <AudioOutlined className={`${sizeClass} text-cyan-600`} />;
    if (ct.includes('pdf')) return <FilePdfOutlined className={`${sizeClass} text-rose-500`} />;
    if (ct.includes('zip') || ct.includes('tar') || ct.includes('gzip')) {
      return <FileZipOutlined className={`${sizeClass} text-orange-500`} />;
    }
    if (
      ct.startsWith('text/') ||
      ct.includes('json') ||
      ct.includes('javascript') ||
      ct.includes('xml') ||
      ct.includes('yaml')
    ) {
      return <CodeOutlined className={`${sizeClass} text-blue-600`} />;
    }
    return <FileTextOutlined className={`${sizeClass} text-slate-400`} />;
  };

  const navigateUp = () => {
    if (!prefix) return;
    const trimmed = prefix.replace(/\/$/, '');
    const idx = trimmed.lastIndexOf('/');
    setPrefix(idx >= 0 ? trimmed.slice(0, idx + 1) : '');
    setPage(1);
  };

  const columns = [
    {
      title: '文件名 (Key)',
      dataIndex: 'name',
      key: 'name',
      render: (_: unknown, record: StorageObject) => (
        <button
          onClick={() => {
            if (record.isFolder) {
              setPrefix(record.key);
              setSearch('');
              setPage(1);
            } else {
              openInspector(record);
            }
          }}
          className="flex items-center gap-2.5 text-left font-medium text-slate-800 hover:text-blue-600 transition-colors"
        >
          {renderFileIcon(record)}
          <span className="break-all">{search ? record.key : record.name}</span>
        </button>
      ),
    },
    {
      title: '大小',
      dataIndex: 'sizeBytes',
      key: 'sizeBytes',
      width: 120,
      sorter: (a: StorageObject, b: StorageObject) => a.sizeBytes - b.sizeBytes,
      render: (size: number, record: StorageObject) => (
        <span className="font-mono text-xs text-slate-600">
          {record.isFolder ? '-' : formatBytes(size)}
        </span>
      ),
    },
    {
      title: '类型 / ETag',
      key: 'type',
      width: 230,
      render: (_: unknown, record: StorageObject) =>
        record.isFolder ? (
          <Tag className="m-0">目录 (Prefix)</Tag>
        ) : (
          <Space size={6}>
            <span className="text-xs text-slate-500">
              {record.contentType.split(';')[0]}
            </span>
            {record.etag && (
              <Tag color="blue" className="m-0 font-mono text-[11px]">
                {record.etag.slice(0, 8)}
              </Tag>
            )}
          </Space>
        ),
    },
    {
      title: '最后修改时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 170,
      sorter: (a: StorageObject, b: StorageObject) =>
        new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(),
      render: (iso: string) => (
        <span className="font-mono text-xs text-slate-500">{formatDate(iso)}</span>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 210,
      align: 'right' as const,
      render: (_: unknown, record: StorageObject) => {
        if (record.isFolder) {
          return (
            <Space size={4}>
              <Button
                type="link"
                size="small"
                onClick={() => {
                  setPrefix(record.key);
                  setSearch('');
                  setPage(1);
                }}
              >
                进入目录
              </Button>
              <Popconfirm
                title={`确定删除目录 "${record.name}" 及其所有子文件？`}
                okText="确认删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => handleDeleteSingle(record)}
              >
                <Button
                  type="text"
                  size="small"
                  danger
                  aria-label={`删除目录 ${record.name}`}
                  icon={<DeleteOutlined />}
                />
              </Popconfirm>
            </Space>
          );
        }

        return (
          <Space size={2}>
            <Button
              type="link"
              size="small"
              icon={<EyeOutlined />}
              onClick={() => openInspector(record)}
            >
              详情/预览
            </Button>
            <Tooltip
              title={
                currentBucket?.visibility === 'public-read'
                  ? '复制公开直链'
                  : '生成并复制 1 小时预签名链接'
              }
            >
              <Button
                type="text"
                size="small"
                aria-label={`复制 ${record.name} 链接`}
                icon={<LinkOutlined />}
                onClick={() => handleQuickCopyLink(record)}
              />
            </Tooltip>
            <Dropdown
              menu={{
                items: [
                  {
                    key: 'rename',
                    icon: <EditOutlined />,
                    label: '重命名 / 移动路径',
                    onClick: () => {
                      setRenameTarget(record);
                      renameForm.setFieldsValue({ newKey: record.key });
                      setRenameModalOpen(true);
                    },
                  },
                  {
                    key: 'download',
                    icon: <DownloadOutlined />,
                    label: '下载原文件',
                    onClick: () => handleDownloadObject(record),
                  },
                  { type: 'divider' },
                  {
                    key: 'delete',
                    icon: <DeleteOutlined />,
                    danger: true,
                    label: '永久删除对象',
                    onClick: () => {
                      Modal.confirm({
                        title: `确认删除 "${record.name}"？`,
                        content: `对象路径: ${record.key}`,
                        okText: '确认删除',
                        okButtonProps: { danger: true },
                        cancelText: '取消',
                        onOk: () => handleDeleteSingle(record),
                      });
                    },
                  },
                ],
              }}
            >
              <Button
                type="text"
                size="small"
                aria-label={`更多操作 ${record.name}`}
                icon={<MoreOutlined />}
              />
            </Dropdown>
          </Space>
        );
      },
    },
  ];

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
          processFilesUpload(e.dataTransfer.files);
        }
      }}
    >
      {/* 存储桶工作台顶部信息卡片 */}
      <Card className="border-slate-200 shadow-none" styles={{ body: { padding: '16px 24px 0' } }}>
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 pb-3">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="w-9 h-9 rounded bg-blue-600 text-white flex items-center justify-center text-base">
              <FolderFilled />
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <Select
                  value={selectedBucket || undefined}
                  onChange={handleBucketSwitch}
                  placeholder="选择存储桶"
                  style={{ minWidth: 200 }}
                  className="font-mono font-semibold"
                  options={buckets.map((b) => ({
                    value: b.name,
                    label: `🪣 ${b.name}`,
                  }))}
                />
                {currentBucket &&
                  (currentBucket.visibility === 'public-read' ? (
                    <Tag icon={<GlobalOutlined />} color="success" className="m-0">
                      公开读私有写
                    </Tag>
                  ) : (
                    <Tag icon={<LockOutlined />} color="warning" className="m-0">
                      私有读写
                    </Tag>
                  ))}
              </div>
              {currentBucket && (
                <div className="text-xs text-slate-500 mt-1.5 flex items-center gap-4 flex-wrap">
                  <span>
                    已用空间:{' '}
                    <strong className="font-mono text-slate-700">
                      {formatBytes(currentBucket.usedBytes)}
                    </strong>
                  </span>
                  <span>
                    配额限制:{' '}
                    <strong className="font-mono text-slate-700">
                      {currentBucket.quotaBytes > 0
                        ? formatBytes(currentBucket.quotaBytes)
                        : '无限制'}
                    </strong>
                  </span>
                  <span>
                    对象数量:{' '}
                    <strong className="font-mono text-slate-700">
                      {currentBucket.objectCount.toLocaleString()}
                    </strong>
                  </span>
                  <span>创建时间: {formatDate(currentBucket.createdAt)}</span>
                </div>
              )}
            </div>
          </div>

          <Space wrap>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                processFilesUpload(e.target.files);
                e.target.value = '';
              }}
            />
            <Badge count={uploadQueue.filter((t) => t.status === 'uploading').length}>
              <Button
                type="primary"
                icon={<UploadOutlined />}
                onClick={() => setUploadModalOpen(true)}
                disabled={!selectedBucket}
              >
                上传文件 / 任务中心
              </Button>
            </Badge>
            <Button
              icon={<FolderAddOutlined />}
              onClick={() => setFolderModalOpen(true)}
              disabled={!selectedBucket}
            >
              新建目录
            </Button>
          </Space>
        </div>

        <Tabs
          activeKey={activeTab}
          onChange={(k) => setActiveTab(k as any)}
          items={[
            {
              key: 'objects',
              label: (
                <span className="flex items-center gap-1.5">
                  <FolderFilled />
                  文件管理 (Objects)
                </span>
              ),
            },
            {
              key: 'settings',
              label: (
                <span className="flex items-center gap-1.5">
                  <SettingOutlined />
                  权限与配额配置 (Settings)
                </span>
              ),
            },
            {
              key: 'guide',
              label: (
                <span className="flex items-center gap-1.5">
                  <CodeSandboxOutlined />
                  当前桶快速接入 (Quick Start)
                </span>
              ),
            },
          ]}
        />
      </Card>

      {/* Tab 1: 文件对象管理 */}
      {activeTab === 'objects' && (
        <Card className="border-slate-200 shadow-none" styles={{ body: { padding: '16px 20px' } }}>
          {/* 操作与过滤栏 */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3.5 border-b border-slate-100">
            <div className="flex items-center gap-2 flex-wrap">
              {prefix !== '' && (
                <Button size="small" icon={<RollbackOutlined />} onClick={navigateUp}>
                  上级目录
                </Button>
              )}
              <div className="flex items-center gap-1 bg-slate-50 border border-slate-200 rounded px-2.5 py-1 text-xs">
                <button
                  onClick={() => {
                    setPrefix('');
                    setSearch('');
                    setPage(1);
                  }}
                  className={`flex items-center gap-1 hover:text-blue-600 ${
                    prefix === '' ? 'text-blue-600 font-semibold' : 'text-slate-600'
                  }`}
                >
                  <HomeOutlined />
                  <span className="font-mono">{selectedBucket || '根目录'}</span>
                </button>
                {breadcrumbs.map((crumb, idx) => {
                  const parts = crumb.replace(/\/$/, '').split('/');
                  const folderName = parts[parts.length - 1];
                  const isLast = idx === breadcrumbs.length - 1;
                  return (
                    <React.Fragment key={crumb}>
                      <span className="text-slate-300 mx-0.5">/</span>
                      <button
                        onClick={() => {
                          setPrefix(crumb);
                          setSearch('');
                          setPage(1);
                        }}
                        className={`font-mono hover:text-blue-600 ${
                          isLast ? 'text-blue-600 font-semibold' : 'text-slate-600'
                        }`}
                      >
                        {folderName}
                      </button>
                    </React.Fragment>
                  );
                })}
              </div>

              {selectedRowKeys.length > 0 && (
                <Popconfirm
                  title={`确认批量删除已勾选的 ${selectedRowKeys.length} 个对象？`}
                  okText="确认删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={handleBatchDelete}
                >
                  <Button size="small" danger icon={<DeleteOutlined />}>
                    批量删除 ({selectedRowKeys.length})
                  </Button>
                </Popconfirm>
              )}
            </div>

            <Space wrap>
              <Input
                placeholder="输入文件名或前缀过滤..."
                prefix={<SearchOutlined className="text-slate-400" />}
                allowClear
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                style={{ width: 220 }}
              />
              <Button
                aria-label="刷新对象列表"
                icon={<ReloadOutlined spin={loading} />}
                onClick={fetchObjects}
                title="刷新列表"
              />
              <Segmented
                aria-label="切换列表或宫格视图"
                value={viewMode}
                onChange={(v) => setViewMode(v as 'list' | 'grid')}
                options={[
                  { value: 'list', icon: <BarsOutlined /> },
                  { value: 'grid', icon: <AppstoreOutlined /> },
                ]}
              />
            </Space>
          </div>

          {/* 表格视图 vs 网格画廊视图 */}
          {viewMode === 'list' ? (
            <Table
              className="mt-2"
              dataSource={items}
              columns={columns}
              rowKey="key"
              loading={loading}
              size="middle"
              rowSelection={{
                selectedRowKeys,
                onChange: (keys) => setSelectedRowKeys(keys),
              }}
              pagination={{
                current: page,
                pageSize,
                total: totalCount,
                showSizeChanger: true,
                pageSizeOptions: ['20', '50', '100', '200'],
                onChange: (nextPage, nextPageSize) => {
                  if (nextPageSize !== pageSize) {
                    setPageSize(nextPageSize);
                    setPage(1);
                  } else {
                    setPage(nextPage);
                  }
                },
                showTotal: (total) => `共 ${total} 项`,
              }}
              locale={{
                emptyText: (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="当前目录暂无文件，支持拖拽文件到页面或点击上传"
                  >
                    <Button
                      type="primary"
                      icon={<UploadOutlined />}
                      onClick={() => setUploadModalOpen(true)}
                    >
                      上传文件
                    </Button>
                  </Empty>
                ),
              }}
            />
          ) : (
            <div className="mt-4">
              {items.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="当前目录为空"
                />
              ) : (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3.5">
                    {items.map((obj) => {
                      const isImg = obj.contentType.toLowerCase().startsWith('image/');
                      const encodedKey = obj.key.split('/').map(encodeURIComponent).join('/');
                      const thumbUrl = `${baseUrl}/raw/${encodeURIComponent(selectedBucket)}/${encodedKey}`;
                      const activateCard = () => {
                        if (obj.isFolder) {
                          setPrefix(obj.key);
                          setSearch('');
                          setPage(1);
                        } else {
                          openInspector(obj);
                        }
                      };

                      return (
                        <div
                          key={obj.key}
                          role="button"
                          tabIndex={0}
                          aria-label={obj.isFolder ? `打开目录 ${obj.name}` : `预览对象 ${obj.name}`}
                          onClick={activateCard}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              activateCard();
                            }
                          }}
                          className="group cursor-pointer rounded border border-slate-200 bg-white hover:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all overflow-hidden flex flex-col justify-between"
                        >
                          <div className="h-28 bg-slate-50 flex items-center justify-center overflow-hidden border-b border-slate-100">
                            {isImg && currentBucket?.visibility === 'public-read' ? (
                              <img
                                src={thumbUrl}
                                alt={obj.name}
                                loading="lazy"
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                              />
                            ) : (
                              renderFileIcon(obj, 'text-3xl')
                            )}
                          </div>
                          <div className="p-2.5">
                            <div
                              className="text-xs font-medium text-slate-800 truncate"
                              title={obj.name}
                            >
                              {obj.name}
                            </div>
                            <div className="text-[11px] font-mono text-slate-400 mt-0.5 flex items-center justify-between">
                              <span>{obj.isFolder ? '目录' : formatBytes(obj.sizeBytes)}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {totalCount > pageSize && (
                    <div className="mt-4 flex justify-end">
                      <Pagination
                        size="small"
                        current={page}
                        pageSize={pageSize}
                        total={totalCount}
                        showSizeChanger
                        pageSizeOptions={['20', '50', '100', '200']}
                        showTotal={(total) => `共 ${total} 项`}
                        onChange={(nextPage, nextPageSize) => {
                          if (nextPageSize !== pageSize) {
                            setPageSize(nextPageSize);
                            setPage(1);
                          } else {
                            setPage(nextPage);
                          }
                        }}
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </Card>
      )}

      {/* Tab 2: 存储桶权限与配额设置 */}
      {activeTab === 'settings' && currentBucket && (
        <Card className="border-slate-200 shadow-none">
          <div className="max-w-2xl">
            <Title level={5}>存储桶访问策略与容量控制</Title>
            <Alert
              type="info"
              showIcon
              className="mb-6"
              message="CAS 内容寻址安全保障"
              description="无论存储桶设置为公开读还是私有，所有上传写入与删除操作均强制要求管理员或具备写权限的 AccessKey 签名验证。"
            />

            <Form
              form={settingsForm}
              layout="vertical"
              onFinish={handleSaveBucketSettings}
              requiredMark={false}
            >
              <Form.Item label="访问权限 (ACL)" name="visibility">
                <Radio.Group className="w-full">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="flex items-start gap-2.5 p-3.5 rounded border border-slate-200 hover:border-blue-500 cursor-pointer">
                      <Radio value="public-read" className="mt-0.5" />
                      <div>
                        <div className="font-medium text-sm text-slate-800">
                          公开读，私有写 (Public Read)
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          适合图床、静态前端资源、音视频直链分发。
                        </div>
                      </div>
                    </label>
                    <label className="flex items-start gap-2.5 p-3.5 rounded border border-slate-200 hover:border-blue-500 cursor-pointer">
                      <Radio value="private" className="mt-0.5" />
                      <div>
                        <div className="font-medium text-sm text-slate-800">
                          私有读写 (Private)
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          适合业务备份、内部文档、需预签名限时授权下载的资源。
                        </div>
                      </div>
                    </label>
                  </div>
                </Radio.Group>
              </Form.Item>

              <Row gutter={16}>
                <Col xs={24} sm={12}>
                  <Form.Item label="容量配额上限 (0 表示不限)">
                    <Space.Compact className="w-full">
                      <Form.Item name="quotaValue" noStyle>
                        <InputNumber min={0} className="w-full" />
                      </Form.Item>
                      <Form.Item name="quotaUnit" noStyle initialValue="MB">
                        <Select
                          style={{ width: 92 }}
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
                <Col xs={24} sm={12}>
                  <Form.Item
                    label="CORS 允许跨域 Origin"
                    name="corsOrigins"
                  >
                    <Input className="font-mono" placeholder="*" />
                  </Form.Item>
                </Col>
              </Row>

              <Button type="primary" htmlType="submit" loading={savingSettings}>
                保存桶配置
              </Button>
            </Form>
          </div>
        </Card>
      )}

      {/* Tab 3: 当前存储桶快速接入指南 */}
      {activeTab === 'guide' && currentBucket && (
        <Card className="border-slate-200 shadow-none">
          <Title level={5}>
            存储桶 <code className="text-blue-600">{currentBucket.name}</code> 快速调用示例
          </Title>
          <Row gutter={[16, 16]} className="mt-4">
            <Col xs={24} lg={12}>
              <Card size="small" title="1. cURL 流式直传与直链读取">
                <pre className="text-xs font-mono bg-slate-900 text-slate-100 p-3.5 rounded overflow-x-auto leading-relaxed">
{`# 上传本地文件至 ${currentBucket.name}
curl -X PUT "${baseUrl}/api/v1/buckets/${currentBucket.name}/objects/demo/hello.txt" \\
  -H "X-Cos-Access-Key: <YOUR_AK>" \\
  -H "X-Cos-Secret-Key: <YOUR_SK>" \\
  --data-binary "@./hello.txt"

# 直链下载或 HTTP Range 视频流读取
curl -H "Range: bytes=0-1023" "${baseUrl}/raw/${currentBucket.name}/demo/hello.txt"`}
                </pre>
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card size="small" title="2. PicGo / Rclone S3 兼容接入参数">
                <pre className="text-xs font-mono bg-slate-900 text-slate-100 p-3.5 rounded overflow-x-auto leading-relaxed">
{`Endpoint (自定义节点) : ${s3Endpoint}
Bucket (存储桶名)     : ${currentBucket.name}
Region (存储区域)     : ${s3Region}
ForcePathStyle        : true (必须开启路径样式)
Custom URL (外链前缀) : ${baseUrl}/raw/${currentBucket.name}`}
                </pre>
              </Card>
            </Col>
          </Row>
        </Card>
      )}

      {/* 右侧滑出式：对象详情与在线预览抽屉 (Object Inspector Drawer) */}
      <Drawer
        title={
          <div className="flex items-center gap-2 pr-4">
            {inspectObj && renderFileIcon(inspectObj)}
            <span className="truncate font-mono text-sm">
              {inspectObj?.name || '对象详情'}
            </span>
          </div>
        }
        placement="right"
        width={560}
        open={!!inspectObj}
        onClose={() => setInspectObj(null)}
        extra={
          inspectObj && (
            <Space>
              <a
                href={`${presignedUrl || rawUrl}${
                  (presignedUrl || rawUrl).includes('?') ? '&' : '?'
                }download=1`}
                target="_blank"
                rel="noreferrer"
              >
                <Button size="small" type="primary" icon={<DownloadOutlined />}>
                  下载
                </Button>
              </a>
              <Popconfirm
                title="确定永久删除该对象？"
                onConfirm={() => handleDeleteSingle(inspectObj)}
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
              >
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </Space>
          )
        }
      >
        {inspectObj && (
          <div className="space-y-5">
            {/* 1. 媒体在线预览画布 */}
            <div className="rounded-xl bg-slate-900 border border-slate-200 p-4 flex items-center justify-center min-h-[220px] overflow-hidden">
              {inspectObj.contentType.toLowerCase().startsWith('image/') ? (
                <Image
                  src={presignedUrl || rawUrl}
                  alt={inspectObj.name}
                  style={{ maxHeight: 320, objectFit: 'contain' }}
                />
              ) : inspectObj.contentType.toLowerCase().startsWith('video/') ? (
                <video
                  src={presignedUrl || rawUrl}
                  controls
                  preload="metadata"
                  className="w-full max-h-[320px] rounded-lg"
                />
              ) : inspectObj.contentType.toLowerCase().startsWith('audio/') ? (
                <audio src={presignedUrl || rawUrl} controls className="w-full" />
              ) : textPreview !== null ? (
                <div className="w-full">
                  <div className="flex items-center justify-between text-xs text-slate-400 mb-2 pb-1.5 border-b border-slate-800">
                    <span>文本 / 代码预览</span>
                    <Button
                      size="small"
                      type="text"
                      className="text-slate-300"
                      icon={<CopyOutlined />}
                      onClick={async () => {
                        await copyToClipboard(textPreview);
                        message.success('文件内容已复制');
                      }}
                    >
                      复制内容
                    </Button>
                  </div>
                  <pre className="text-xs font-mono text-slate-100 max-h-[280px] overflow-auto whitespace-pre-wrap break-all">
                    {textPreview}
                  </pre>
                </div>
              ) : (
                <div className="text-center text-slate-400 py-8 space-y-2">
                  <div>{renderFileIcon(inspectObj, 'text-4xl')}</div>
                  <div className="text-xs">
                    当前文件类型不支持内联预览，可点击右上角下载或复制外链
                  </div>
                </div>
              )}
            </div>

            {/* 2. 对象属性表 */}
            <div>
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                对象元数据 (Metadata)
              </div>
              <Descriptions bordered size="small" column={1}>
                <Descriptions.Item label="对象路径 (Key)">
                  <Text copyable className="font-mono text-xs break-all">
                    {inspectObj.key}
                  </Text>
                </Descriptions.Item>
                <Descriptions.Item label="文件大小">
                  <span className="font-mono text-xs">
                    {formatBytes(inspectObj.sizeBytes)} ({inspectObj.sizeBytes.toLocaleString()} Bytes)
                  </span>
                </Descriptions.Item>
                <Descriptions.Item label="Content-Type">
                  <Tag color="blue" className="m-0 font-mono text-xs">
                    {inspectObj.contentType}
                  </Tag>
                </Descriptions.Item>
                <Descriptions.Item label="ETag (MD5)">
                  <Text copyable className="font-mono text-xs">
                    {inspectObj.etag || '-'}
                  </Text>
                </Descriptions.Item>
                <Descriptions.Item label="CAS SHA-256">
                  {inspectObj.blobSha256 ? (
                    <Text copyable className="font-mono text-xs break-all text-slate-600">
                      {inspectObj.blobSha256}
                    </Text>
                  ) : (
                    '-'
                  )}
                </Descriptions.Item>
                <Descriptions.Item label="最后修改时间">
                  <span className="font-mono text-xs">{formatDate(inspectObj.updatedAt)}</span>
                </Descriptions.Item>
              </Descriptions>
            </div>

            {/* 3. 直链与 Markdown 引用 */}
            <Card size="small" title="固定直链与 Markdown 引用">
              <div className="space-y-2.5">
                <Input
                  value={rawUrl}
                  readOnly
                  className="font-mono text-xs"
                  addonAfter={
                    <button
                      onClick={async () => {
                        await copyToClipboard(rawUrl);
                        message.success('直链 URL 已复制');
                      }}
                      className="text-xs font-medium text-blue-600"
                    >
                      复制 URL
                    </button>
                  }
                />
                <div className="flex gap-2">
                  <Button
                    size="small"
                    icon={<CopyOutlined />}
                    onClick={async () => {
                      const targetUrl =
                        currentBucket?.visibility === 'private' && presignedUrl
                          ? presignedUrl
                          : rawUrl;
                      await copyToClipboard(`![${inspectObj.name}](${targetUrl})`);
                      message.success('Markdown 格式已复制');
                    }}
                  >
                    复制 Markdown
                  </Button>
                  <Button
                    size="small"
                    icon={<CopyOutlined />}
                    onClick={async () => {
                      const targetUrl =
                        currentBucket?.visibility === 'private' && presignedUrl
                          ? presignedUrl
                          : rawUrl;
                      await copyToClipboard(`<img src="${targetUrl}" alt="${inspectObj.name}" />`);
                      message.success('HTML 标签已复制');
                    }}
                  >
                    复制 HTML
                  </Button>
                </div>
              </div>
            </Card>

            {/* 4. 预签名临时授权链接 */}
            <Card
              size="small"
              title="预签名临时分享链接 (Presigned URL)"
              extra={<Tag color="purple" className="m-0">支持私有桶安全外发</Tag>}
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-xs text-slate-500">选择授权有效期:</span>
                  <Segmented
                    size="small"
                    value={presignTtl}
                    onChange={(v) => handleUpdatePresignTtl(Number(v))}
                    options={[
                      { label: '15分钟', value: 900 },
                      { label: '1小时', value: 3600 },
                      { label: '24小时', value: 86400 },
                      { label: '7天', value: 604800 },
                    ]}
                  />
                </div>
                <Input
                  value={presignedUrl}
                  readOnly
                  className="font-mono text-xs"
                  placeholder="正在签发临时链接..."
                />
                <Button
                  type="primary"
                  block
                  icon={<LinkOutlined />}
                  onClick={async () => {
                    if (!presignedUrl) {
                      await handleUpdatePresignTtl(presignTtl);
                    }
                    if (presignedUrl) {
                      await copyToClipboard(presignedUrl);
                      message.success('带签名的临时访问链接已复制');
                    }
                  }}
                >
                  复制预签名临时链接
                </Button>
              </div>
            </Card>
          </div>
        )}
      </Drawer>

      {/* 上传中心弹窗 (支持多文件拖拽、秒传提示、分片进度) */}
      <Modal
        title={
          <Space>
            <ThunderboltOutlined className="text-blue-600" />
            <span>上传文件至 {selectedBucket}/{prefix}</span>
          </Space>
        }
        open={uploadModalOpen}
        onCancel={() => setUploadModalOpen(false)}
        footer={[
          <Button
            key="clear"
            onClick={() => setUploadQueue([])}
            disabled={uploadQueue.length === 0}
          >
            清空记录
          </Button>,
          <Button key="close" type="primary" onClick={() => setUploadModalOpen(false)}>
            完成
          </Button>,
        ]}
        width={620}
      >
        <div
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            processFilesUpload(e.dataTransfer.files);
          }}
          className="mt-3 cursor-pointer rounded-xl border-2 border-dashed border-blue-300 bg-blue-50/40 hover:bg-blue-50/80 p-8 text-center transition-colors"
        >
          <InboxOutlined className="text-4xl text-blue-600 mb-2" />
          <div className="text-sm font-medium text-slate-800">
            点击选择文件，或将多个文件拖拽到此区域上传
          </div>
          <div className="text-xs text-slate-500 mt-1">
            小于 20MB 自动计算 <code className="text-blue-600">SHA-256</code> 尝试<strong>零字节极速秒传</strong>；大于 5MB 自动启用 <strong>并发分片流式上传</strong>
          </div>
        </div>

        {uploadQueue.length > 0 && (
          <div className="mt-4 space-y-2.5 max-h-64 overflow-y-auto pr-1">
            {uploadQueue.map((task) => (
              <div
                key={task.id}
                className="p-3 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1.5"
              >
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-slate-800 truncate max-w-[55%]">
                    {task.name}{' '}
                    <span className="text-slate-400 font-mono">({formatBytes(task.size)})</span>
                  </span>
                  <span
                    className={`flex items-center gap-1 font-medium ${
                      task.status === 'fast' || task.status === 'done'
                        ? 'text-emerald-600'
                        : task.status === 'error'
                        ? 'text-rose-600'
                        : 'text-blue-600'
                    }`}
                  >
                    {(task.status === 'fast' || task.status === 'done') && <CheckCircleFilled />}
                    {task.status === 'error' && <CloseCircleFilled />}
                    {task.detail}
                  </span>
                </div>
                <Progress
                  percent={task.progress}
                  size="small"
                  showInfo={false}
                  status={
                    task.status === 'error'
                      ? 'exception'
                      : task.status === 'done' || task.status === 'fast'
                      ? 'success'
                      : 'active'
                  }
                />
              </div>
            ))}
          </div>
        )}
      </Modal>

      {/* 新建目录弹窗 */}
      <Modal
        title="新建目录 (Create Folder)"
        open={folderModalOpen}
        onCancel={() => setFolderModalOpen(false)}
        onOk={handleCreateFolder}
        okText="创建"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={folderForm} layout="vertical" className="mt-4" requiredMark={false}>
          <Form.Item
            label={`将在 ${selectedBucket}/${prefix} 下创建子目录`}
            name="folderName"
            extra="支持多级目录结构，如 2026/11/banners"
            rules={[{ required: true, message: '请输入目录名称' }]}
          >
            <Input placeholder="例如: assets" autoFocus />
          </Form.Item>
        </Form>
      </Modal>

      {/* 零拷贝重命名 / 移动弹窗 */}
      <Modal
        title="重命名 / 移动对象路径 (CAS Zero-Copy)"
        open={renameModalOpen}
        onCancel={() => setRenameModalOpen(false)}
        onOk={handleRenameSubmit}
        okText="确认修改"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={renameForm} layout="vertical" className="mt-4" requiredMark={false}>
          <Form.Item
            label="目标完整路径 Key"
            name="newKey"
            extra="底层通过 CAS 引用计数指针重定向，无需复制物理磁盘数据，毫秒级完成"
            rules={[{ required: true, message: '请输入新的对象路径 Key' }]}
          >
            <Input className="font-mono" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
