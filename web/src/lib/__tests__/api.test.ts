import { afterEach, describe, expect, it, vi } from 'vitest';
import { cosApi } from '../api';

function mockFetchOnce(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('cosApi.request', () => {
  it('成功时返回 JSON 数据', async () => {
    mockFetchOnce(200, { buckets: [] });
    await expect(cosApi.listBuckets()).resolves.toEqual({ buckets: [] });
  });

  it('POST 请求序列化 JSON body 并透传 method', async () => {
    const fetchMock = mockFetchOnce(200, { token: 't', username: 'u' });
    await cosApi.login('u', 'p');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ username: 'u', password: 'p' });
  });

  it('非 2xx 时抛出后端返回的 error 文案', async () => {
    mockFetchOnce(400, { error: '桶名不合法' });
    await expect(cosApi.deleteBucket('x')).rejects.toThrow('桶名不合法');
  });

  it('无 error 字段时回退到状态码提示', async () => {
    mockFetchOnce(500, {});
    await expect(cosApi.listBuckets()).rejects.toThrow('请求失败 (500)');
  });

  it('401 抛 UNAUTHORIZED 并广播 cos:unauthorized 事件', async () => {
    mockFetchOnce(401, {});
    const handler = vi.fn();
    window.addEventListener('cos:unauthorized', handler);
    try {
      await expect(cosApi.listBuckets()).rejects.toThrow('UNAUTHORIZED');
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('cos:unauthorized', handler);
    }
  });

  it('登录接口 401 不触发全局登出事件，且透传错误文案', async () => {
    mockFetchOnce(401, { error: '用户名或密码错误' });
    const handler = vi.fn();
    window.addEventListener('cos:unauthorized', handler);
    try {
      await expect(cosApi.login('u', 'bad')).rejects.toThrow('用户名或密码错误');
      expect(handler).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('cos:unauthorized', handler);
    }
  });
});

describe('cosApi URL 构造', () => {
  it('browseObjects 编码桶名并携带分页参数', async () => {
    const fetchMock = mockFetchOnce(200, { items: [] });
    await cosApi.browseObjects('my bucket', 'dir/', 'q', 20, 40);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/buckets/my%20bucket/objects?');
    const q = new URLSearchParams(url.split('?')[1]);
    expect(q.get('prefix')).toBe('dir/');
    expect(q.get('search')).toBe('q');
    expect(q.get('limit')).toBe('20');
    expect(q.get('offset')).toBe('40');
  });

  it('deleteObject 对 key 做完整编码', async () => {
    const fetchMock = mockFetchOnce(200, { deletedCount: 1 });
    await cosApi.deleteObject('b', 'a/b c.txt');
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/v1/buckets/b/objects?key=a%2Fb%20c.txt'
    );
  });
});
