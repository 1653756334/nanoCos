import { useState } from 'react';
import { Alert, Badge, Button, Dropdown, Input, Modal, Space, Tag, message } from 'antd';
import type { MenuProps } from 'antd';
import {
  CheckCircleFilled,
  ClearOutlined,
  CloudDownloadOutlined,
  DownOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ToolOutlined,
  WarningFilled,
} from '@ant-design/icons';
import { cosApi } from '../../../lib/api';
import { getErrorMessage } from '../../../lib/errors';
import { formatBytes } from '../../../lib/utils';
import { formatUptime } from '../format';

interface DashboardHeaderProps {
  uptimeSeconds?: number;
  diskFreeBytes?: number;
  diskTotalBytes?: number;
  loading: boolean;
  onRefresh: () => Promise<void>;
  onCreate: () => void;
}

/** 顶部监控大盘工具栏：标题、引擎运行状态、磁盘可用容量、系统维护菜单、刷新与新建按钮 */
export function DashboardHeader({
  uptimeSeconds,
  diskFreeBytes,
  diskTotalBytes,
  loading,
  onRefresh,
  onCreate,
}: DashboardHeaderProps) {
  const [maintLoading, setMaintLoading] = useState(false);
  const [scrubResult, setScrubResult] = useState<{
    checked: number;
    corrupted: string[];
    healthy: boolean;
  } | null>(null);
  const [backupModalOpen, setBackupModalOpen] = useState(false);
  const [backupTargetDir, setBackupTargetDir] = useState('');
  const [backupResult, setBackupResult] = useState<{
    backupDir: string;
    dbSnapshot: string;
    copiedBlobs: number;
  } | null>(null);

  const diskText =
    diskFreeBytes != null && diskTotalBytes
      ? ` · 磁盘余 ${formatBytes(diskFreeBytes)} / 共 ${formatBytes(diskTotalBytes)}`
      : '';

  const handleRunGC = async () => {
    setMaintLoading(true);
    try {
      await cosApi.adminGC();
      await onRefresh();
      message.success('存储对账与孤儿物理块回收 (GC) 已完成');
    } catch (err: unknown) {
      message.error(getErrorMessage(err, '执行 GC 失败'));
    } finally {
      setMaintLoading(false);
    }
  };

  const handleRunScrub = async () => {
    setMaintLoading(true);
    try {
      const res = await cosApi.adminScrub();
      setScrubResult(res);
    } catch (err: unknown) {
      message.error(getErrorMessage(err, '执行物理块完整性巡检失败'));
    } finally {
      setMaintLoading(false);
    }
  };

  const handleRunBackup = async () => {
    setMaintLoading(true);
    try {
      const res = await cosApi.adminBackup(backupTargetDir.trim() || undefined);
      setBackupResult({
        backupDir: res.backupDir,
        dbSnapshot: res.dbSnapshot,
        copiedBlobs: res.copiedBlobs,
      });
      message.success('在线一致性热备份已完成');
    } catch (err: unknown) {
      message.error(getErrorMessage(err, '执行在线热备份失败'));
    } finally {
      setMaintLoading(false);
    }
  };

  const maintenanceItems: MenuProps['items'] = [
    {
      key: 'gc',
      icon: <ClearOutlined />,
      label: '存储对账与垃圾回收 (GC)',
      onClick: () => void handleRunGC(),
    },
    {
      key: 'scrub',
      icon: <SafetyCertificateOutlined />,
      label: 'CAS 物理块完整性巡检 (Scrub)',
      onClick: () => void handleRunScrub(),
    },
    {
      type: 'divider',
    },
    {
      key: 'backup',
      icon: <CloudDownloadOutlined />,
      label: '一致性在线热备份 (Backup)',
      onClick: () => {
        setBackupTargetDir('');
        setBackupResult(null);
        setBackupModalOpen(true);
      },
    },
  ];

  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-white border border-slate-200 rounded-md px-5 py-3.5">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-base font-bold text-slate-900 m-0">
          存储监控与分析大盘 (Storage Telemetry &amp; Analytics)
        </h1>
        <Badge
          status="processing"
          text={
            <span className="text-xs text-slate-500 font-mono">
              Engine: SQLite WAL + CAS SHA-256 · 已运行 {formatUptime(uptimeSeconds)}
              {diskText}
            </span>
          }
        />
      </div>
      <Space size={8} wrap>
        <Dropdown menu={{ items: maintenanceItems }} trigger={['click']} disabled={maintLoading}>
          <Button icon={<ToolOutlined />} loading={maintLoading}>
            系统维护 <DownOutlined className="text-[10px]" />
          </Button>
        </Dropdown>
        <Button icon={<ReloadOutlined spin={loading} />} onClick={onRefresh}>
          刷新监控
        </Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>
          新建存储桶
        </Button>
      </Space>

      {/* CAS 物理块完整性巡检结果弹窗 */}
      <Modal
        title="CAS 物理块完整性巡检报告 (Scrub Report)"
        open={!!scrubResult}
        onCancel={() => setScrubResult(null)}
        footer={[
          <Button key="close" type="primary" onClick={() => setScrubResult(null)}>
            知道了
          </Button>,
        ]}
      >
        {scrubResult && (
          <div className="space-y-3 pt-2">
            {scrubResult.healthy ? (
              <Alert
                type="success"
                showIcon
                icon={<CheckCircleFilled />}
                message="所有物理块 SHA-256 校验通过，底层 CAS 存储健康完好"
                description={`本次共校验活跃物理块 ${scrubResult.checked.toLocaleString()} 个，发现损坏块 0 个。`}
              />
            ) : (
              <Alert
                type="error"
                showIcon
                icon={<WarningFilled />}
                message={`发现 ${scrubResult.corrupted.length} 个损坏或缺失的物理块`}
                description={
                  <div className="mt-2 space-y-1">
                    <div>已扫描物理块：{scrubResult.checked.toLocaleString()} 个</div>
                    <div className="font-mono text-xs break-all bg-white p-2 rounded border border-red-200 max-h-40 overflow-y-auto">
                      {scrubResult.corrupted.map((sha) => (
                        <div key={sha}>{sha}</div>
                      ))}
                    </div>
                  </div>
                }
              />
            )}
          </div>
        )}
      </Modal>

      {/* 一致性在线热备份弹窗 */}
      <Modal
        title="一致性在线热备份 (SQLite VACUUM INTO + CAS Blobs)"
        open={backupModalOpen}
        onCancel={() => setBackupModalOpen(false)}
        onOk={() => void handleRunBackup()}
        okText={backupResult ? '重新执行备份' : '开始备份'}
        cancelText="关闭"
        confirmLoading={maintLoading}
      >
        <div className="space-y-3 pt-2">
          <div className="text-xs text-slate-600">
            在不中断线上读写的情况下，通过 <code className="font-mono">VACUUM INTO</code> 生成一致性元数据快照并归档全部活跃 CAS 物理块。
          </div>
          <div>
            <div className="text-xs font-medium text-slate-700 mb-1">
              备份输出目录（选填，留空则自动生成在 <code className="font-mono">data/backups/&lt;时间戳&gt;</code>）：
            </div>
            <Input
              placeholder="例如: /var/backups/nanocos-20261109"
              value={backupTargetDir}
              onChange={(e) => setBackupTargetDir(e.target.value)}
              className="font-mono text-xs"
            />
          </div>
          {backupResult && (
            <Alert
              type="success"
              showIcon
              message="热备份已成功生成"
              description={
                <div className="text-xs space-y-1 mt-1 font-mono break-all">
                  <div>备份目录: {backupResult.backupDir}</div>
                  <div>数据库快照: {backupResult.dbSnapshot}</div>
                  <div>
                    已归档物理块: <Tag color="green">{backupResult.copiedBlobs}</Tag> 个
                  </div>
                </div>
              }
            />
          )}
        </div>
      </Modal>
    </div>
  );
}
