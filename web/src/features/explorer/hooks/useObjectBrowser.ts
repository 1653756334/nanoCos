import { Key, useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DEFAULT_PAGE_SIZE, ViewMode } from '../constants';
import { parentPrefix } from '../utils/objects';

export type SortField = 'key' | 'size' | 'updatedAt';
export type SortDirection = 'asc' | 'desc';

/**
 * 对象浏览器的交互状态：当前目录前缀、搜索词、分页、排序、多选与视图模式。
 * 目录前缀、搜索词、分页与视图模式同步至 URL SearchParams，支持刷新保持与浏览器前进/后退导航。
 */
export function useObjectBrowser(bucket: string) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedKeys, setSelectedKeys] = useState<Key[]>([]);

  const prefix = searchParams.get('prefix') || '';
  const search = searchParams.get('q') || '';
  const page = Math.max(1, Number(searchParams.get('page')) || 1);
  const pageSize = Math.max(1, Number(searchParams.get('pageSize')) || DEFAULT_PAGE_SIZE);
  const viewMode: ViewMode = searchParams.get('view') === 'grid' ? 'grid' : 'list';
  const sortBy: SortField =
    (searchParams.get('sortBy') as SortField) === 'size' ||
    (searchParams.get('sortBy') as SortField) === 'updatedAt'
      ? (searchParams.get('sortBy') as SortField)
      : 'key';
  const sortOrder: SortDirection = searchParams.get('sortOrder') === 'desc' ? 'desc' : 'asc';

  const [prevBucket, setPrevBucket] = useState(bucket);
  if (prevBucket !== bucket) {
    setPrevBucket(bucket);
    setSelectedKeys([]);
  }

  const updateParams = useCallback(
    (
      updater: (next: URLSearchParams) => void,
      options: { replace?: boolean } = { replace: true }
    ) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          updater(next);
          return next;
        },
        options
      );
    },
    [setSearchParams]
  );

  /** 进入目录（key 为空串表示回到根目录），推入历史记录以支持浏览器后退键返回上级目录 */
  const enterFolder = useCallback(
    (key: string) => {
      setSelectedKeys([]);
      updateParams(
        (next) => {
          if (key) next.set('prefix', key);
          else next.delete('prefix');
          next.delete('q');
          next.delete('page');
        },
        { replace: false }
      );
    },
    [updateParams]
  );

  const navigateUp = useCallback(() => {
    setSelectedKeys([]);
    updateParams(
      (next) => {
        const up = parentPrefix(next.get('prefix') || '');
        if (up) next.set('prefix', up);
        else next.delete('prefix');
        next.delete('page');
      },
      { replace: false }
    );
  }, [updateParams]);

  const changeSearch = useCallback(
    (value: string) => {
      updateParams((next) => {
        if (value) next.set('q', value);
        else next.delete('q');
        next.delete('page');
      });
    },
    [updateParams]
  );

  /** antd 分页回调：每页条数变化时回到第一页 */
  const changePage = useCallback(
    (nextPage: number, nextPageSize: number) => {
      updateParams((next) => {
        if (nextPageSize !== pageSize) {
          if (nextPageSize !== DEFAULT_PAGE_SIZE) next.set('pageSize', String(nextPageSize));
          else next.delete('pageSize');
          next.delete('page');
        } else {
          if (nextPage > 1) next.set('page', String(nextPage));
          else next.delete('page');
        }
      });
    },
    [pageSize, updateParams]
  );

  const setViewMode = useCallback(
    (mode: ViewMode) => {
      updateParams((next) => {
        if (mode === 'grid') next.set('view', 'grid');
        else next.delete('view');
      });
    },
    [updateParams]
  );

  const changeSort = useCallback(
    (field: SortField, order: SortDirection) => {
      updateParams((next) => {
        if (field === 'key' && order === 'asc') {
          next.delete('sortBy');
          next.delete('sortOrder');
        } else {
          next.set('sortBy', field);
          next.set('sortOrder', order);
        }
        next.delete('page');
      });
    },
    [updateParams]
  );

  const clearSelection = useCallback(() => setSelectedKeys([]), []);

  return {
    prefix,
    search,
    page,
    pageSize,
    sortBy,
    sortOrder,
    selectedKeys,
    viewMode,
    setSelectedKeys,
    setViewMode,
    enterFolder,
    navigateUp,
    changeSearch,
    changePage,
    changeSort,
    clearSelection,
  };
}

export type ObjectBrowserState = ReturnType<typeof useObjectBrowser>;
