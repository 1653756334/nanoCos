import { Key, useCallback, useState } from 'react';
import { DEFAULT_PAGE_SIZE, ViewMode } from '../constants';
import { parentPrefix } from '../utils/objects';

/**
 * 对象浏览器的本地交互状态：当前目录前缀、搜索词、分页、多选与视图模式。
 * 切换存储桶时自动回到根目录并清空搜索 / 分页 / 多选。
 */
export function useObjectBrowser(bucket: string) {
  const [prefix, setPrefix] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [selectedKeys, setSelectedKeys] = useState<Key[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>('list');

  // 渲染期同步重置：比 effect 少一次携带旧 prefix 的无效请求
  const [prevBucket, setPrevBucket] = useState(bucket);
  if (prevBucket !== bucket) {
    setPrevBucket(bucket);
    setPrefix('');
    setSearch('');
    setPage(1);
    setSelectedKeys([]);
  }

  /** 进入目录（key 为空串表示回到根目录），同时清空搜索并回到第一页 */
  const enterFolder = useCallback((key: string) => {
    setPrefix(key);
    setSearch('');
    setPage(1);
  }, []);

  const navigateUp = useCallback(() => {
    setPrefix((current) => parentPrefix(current));
    setPage(1);
  }, []);

  const changeSearch = useCallback((value: string) => {
    setSearch(value);
    setPage(1);
  }, []);

  /** antd 分页回调：每页条数变化时回到第一页 */
  const changePage = useCallback(
    (nextPage: number, nextPageSize: number) => {
      if (nextPageSize !== pageSize) {
        setPageSize(nextPageSize);
        setPage(1);
      } else {
        setPage(nextPage);
      }
    },
    [pageSize]
  );

  const clearSelection = useCallback(() => setSelectedKeys([]), []);

  return {
    prefix,
    search,
    page,
    pageSize,
    selectedKeys,
    viewMode,
    setSelectedKeys,
    setViewMode,
    enterFolder,
    navigateUp,
    changeSearch,
    changePage,
    clearSelection,
  };
}

export type ObjectBrowserState = ReturnType<typeof useObjectBrowser>;
