import { describe, expect, it } from 'vitest';
import {
  buildRawUrl,
  folderNameFromCrumb,
  getFileKind,
  parentPrefix,
  withDownloadParam,
} from '../utils/objects';
import { buildQuickStartSnippets } from '../utils/quickStart';

describe('explorer utils/objects', () => {
  it('getFileKind 根据对象属性准确判定种类', () => {
    expect(getFileKind({ isFolder: true, contentType: 'application/octet-stream' })).toBe('folder');
    expect(getFileKind({ isFolder: false, contentType: 'image/png' })).toBe('image');
    expect(getFileKind({ isFolder: false, contentType: 'video/mp4' })).toBe('video');
    expect(getFileKind({ isFolder: false, contentType: 'audio/mpeg' })).toBe('audio');
    expect(getFileKind({ isFolder: false, contentType: 'application/pdf' })).toBe('pdf');
    expect(getFileKind({ isFolder: false, contentType: 'application/zip' })).toBe('archive');
    expect(getFileKind({ isFolder: false, contentType: 'application/json' })).toBe('code');
    expect(getFileKind({ isFolder: false, contentType: 'application/octet-stream' })).toBe('file');
  });

  it('buildRawUrl 构造正确的直链与下载链接', () => {
    expect(buildRawUrl('http://localhost:9000', 'my-bucket', 'docs/readme.txt')).toBe(
      'http://localhost:9000/raw/my-bucket/docs/readme.txt'
    );
    expect(
      buildRawUrl('http://localhost:9000', 'my-bucket', 'docs/中文 name.txt', { download: true })
    ).toBe('http://localhost:9000/raw/my-bucket/docs/%E4%B8%AD%E6%96%87%20name.txt?download=1');
  });

  it('withDownloadParam 追加 download=1', () => {
    expect(withDownloadParam('http://localhost/raw/b/k')).toBe('http://localhost/raw/b/k?download=1');
    expect(withDownloadParam('http://localhost/raw/b/k?sig=123')).toBe(
      'http://localhost/raw/b/k?sig=123&download=1'
    );
  });

  it('parentPrefix 和 folderNameFromCrumb 准确处理前缀层级', () => {
    expect(parentPrefix('')).toBe('');
    expect(parentPrefix('folder/')).toBe('');
    expect(parentPrefix('a/b/c/')).toBe('a/b/');
    expect(folderNameFromCrumb('a/b/c/')).toBe('c');
    expect(folderNameFromCrumb('photos/')).toBe('photos');
  });
});

describe('explorer utils/quickStart', () => {
  it('buildQuickStartSnippets 嵌入关键参数', () => {
    const snippets = buildQuickStartSnippets({
      bucketName: 'test-bucket',
      baseUrl: 'http://127.0.0.1:9000',
      s3Endpoint: 'http://127.0.0.1:9000/s3',
      s3Region: 'cn-north-1',
    });
    expect(snippets.curl).toContain('test-bucket');
    expect(snippets.curl).toContain('http://127.0.0.1:9000/api/v1/buckets/test-bucket');
    expect(snippets.s3Params).toContain('Endpoint (自定义节点) : http://127.0.0.1:9000/s3');
    expect(snippets.s3Params).toContain('Bucket (存储桶名)     : test-bucket');
    expect(snippets.s3Params).toContain('Region (存储区域)     : cn-north-1');
  });
});
