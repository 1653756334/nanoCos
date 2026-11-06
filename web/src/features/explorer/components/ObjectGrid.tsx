import { Empty, Pagination } from 'antd';
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
  page: number;
  pageSize: number;
  totalCount: number;
  onPageChange: (page: number, pageSize: number) => void;
  onEnterFolder: (key: string) => void;
  onOpenInspector: (obj: StorageObject) => void;
}

export function ObjectGrid({
  items,
  bucketName,
  baseUrl,
  isPublicBucket,
  page,
  pageSize,
  totalCount,
  onPageChange,
  onEnterFolder,
  onOpenInspector,
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

  return (
    <div className="mt-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3.5">
        {items.map((obj) => {
          const isImg = obj.contentType.toLowerCase().startsWith('image/');
          const thumbUrl = buildRawUrl(baseUrl, bucketName, obj.key);
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
              className="group cursor-pointer rounded border border-slate-200 bg-white hover:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all overflow-hidden flex flex-col justify-between"
            >
              <div className="h-28 bg-slate-50 flex items-center justify-center overflow-hidden border-b border-slate-100">
                {isImg && isPublicBucket ? (
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
