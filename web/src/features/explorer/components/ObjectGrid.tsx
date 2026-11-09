import { Key } from 'react';
import { Button, Checkbox, Empty, Pagination, Popconfirm, Tooltip } from 'antd';
import { DeleteOutlined, EditOutlined, LinkOutlined } from '@ant-design/icons';
import { StorageObject } from '../../../lib/api';
import { formatBytes } from '../../../lib/utils';
import { PAGE_SIZE_OPTIONS, showTotalText } from '../constants';
import { buildRawUrl } from '../utils/objects';
import { FileTypeIcon } from './FileTypeIcon';

interface ObjectGridProps {
  items: StorageObject[];
  bucketName: string;
  baseUrl: string;
  isPublicBucket: boolean;
  selectedKeys?: Key[];
  page: number;
  pageSize: number;
  totalCount: number;
  onSelectKeysChange?: (keys: Key[]) => void;
  onPageChange: (page: number, pageSize: number) => void;
  onEnterFolder: (key: string) => void;
  onOpenInspector: (obj: StorageObject) => void;
  onCopyLink?: (obj: StorageObject) => void;
  onOpenRename?: (obj: StorageObject) => void;
  onDeleteSingle?: (obj: StorageObject) => void;
}

export function ObjectGrid({
  items,
  bucketName,
  baseUrl,
  isPublicBucket,
  selectedKeys = [],
  page,
  pageSize,
  totalCount,
  onSelectKeysChange,
  onPageChange,
  onEnterFolder,
  onOpenInspector,
  onCopyLink,
  onOpenRename,
  onDeleteSingle,
}: ObjectGridProps) {
  if (items.length === 0) {
    return (
      <div className="mt-4">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="当前目录为空"
        />
      </div>
    );
  }

  const selectedSet = new Set(selectedKeys.map(String));

  const toggleSelect = (key: string, checked: boolean) => {
    if (!onSelectKeysChange) return;
    if (checked) {
      onSelectKeysChange([...selectedKeys, key]);
    } else {
      onSelectKeysChange(selectedKeys.filter((k) => String(k) !== key));
    }
  };

  return (
    <div className="mt-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3.5">
        {items.map((obj) => {
          const isImg = obj.contentType.toLowerCase().startsWith('image/');
          const thumbUrl = buildRawUrl(baseUrl, bucketName, obj.key);
          const isChecked = selectedSet.has(obj.key);
          const activateCard = () => {
            if (obj.isFolder) {
              onEnterFolder(obj.key);
            } else {
              onOpenInspector(obj);
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
              className={`group relative cursor-pointer rounded border bg-white hover:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all overflow-hidden flex flex-col justify-between ${
                isChecked ? 'border-blue-500 ring-1 ring-blue-500' : 'border-slate-200'
              }`}
            >
              {/* 左上角多选框 */}
              {onSelectKeysChange && (
                <div
                  className={`absolute top-1.5 left-2 z-10 transition-opacity ${
                    isChecked ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                  }`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Checkbox
                    checked={isChecked}
                    onChange={(e) => toggleSelect(obj.key, e.target.checked)}
                  />
                </div>
              )}

              {/* 右上角快捷操作栏 */}
              <div
                className="absolute top-1.5 right-1.5 z-10 flex items-center gap-0.5 bg-white/90 backdrop-blur-sm rounded px-1 py-0.5 shadow-sm border border-slate-200/70 opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={(e) => e.stopPropagation()}
              >
                {!obj.isFolder && onCopyLink && (
                  <Tooltip title={isPublicBucket ? '复制直链' : '复制预签名链接'}>
                    <Button
                      type="text"
                      size="small"
                      className="h-5 w-5 p-0"
                      icon={<LinkOutlined className="text-xs" />}
                      onClick={() => onCopyLink(obj)}
                    />
                  </Tooltip>
                )}
                {onOpenRename && (
                  <Tooltip title="重命名 / 移动">
                    <Button
                      type="text"
                      size="small"
                      className="h-5 w-5 p-0"
                      icon={<EditOutlined className="text-xs" />}
                      onClick={() => onOpenRename(obj)}
                    />
                  </Tooltip>
                )}
                {onDeleteSingle && (
                  <Popconfirm
                    title={
                      obj.isFolder
                        ? `确定删除目录 "${obj.name}" 及其所有子文件？`
                        : `确定删除 "${obj.name}"？`
                    }
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => onDeleteSingle(obj)}
                  >
                    <Button
                      type="text"
                      size="small"
                      danger
                      className="h-5 w-5 p-0"
                      icon={<DeleteOutlined className="text-xs" />}
                    />
                  </Popconfirm>
                )}
              </div>

              <div className="h-28 bg-slate-50 flex items-center justify-center overflow-hidden border-b border-slate-100">
                {isImg ? (
                  <img
                    src={thumbUrl}
                    alt={obj.name}
                    loading="lazy"
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                  />
                ) : (
                  <FileTypeIcon object={obj} sizeClass="text-3xl" />
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
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            showTotal={showTotalText}
            onChange={onPageChange}
          />
        </div>
      )}
    </div>
  );
}
