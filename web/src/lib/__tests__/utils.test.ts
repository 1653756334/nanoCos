import { describe, expect, it } from 'vitest';
import {
  bytesToQuotaForm,
  computeAdaptiveChunkSize,
  encodeObjectKey,
  formatBytes,
  formatDate,
  isTextContentType,
  quotaFormToBytes,
} from '../utils';

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

describe('bytesToQuotaForm / quotaFormToBytes', () => {
  it('小于 1MB 的配额不会被舍入为 0', () => {
    const form = bytesToQuotaForm(512 * KB);
    expect(form).toEqual({ quotaValue: 512, quotaUnit: 'KB' });
    expect(quotaFormToBytes(form.quotaValue, form.quotaUnit)).toBe(512 * KB);
  });

  it('任意字节数可无损往返', () => {
    const form = bytesToQuotaForm(12345);
    expect(form).toEqual({ quotaValue: 12345, quotaUnit: 'B' });
    expect(quotaFormToBytes(form.quotaValue, form.quotaUnit)).toBe(12345);
  });

  it('整 GB 配额使用 GB 单位', () => {
    const form = bytesToQuotaForm(10 * GB);
    expect(form).toEqual({ quotaValue: 10, quotaUnit: 'GB' });
    expect(quotaFormToBytes(form.quotaValue, form.quotaUnit)).toBe(10 * GB);
  });

  it('0 / 空值视为不限制', () => {
    expect(bytesToQuotaForm(0)).toEqual({ quotaValue: 0, quotaUnit: 'MB' });
    expect(bytesToQuotaForm(undefined)).toEqual({ quotaValue: 0, quotaUnit: 'MB' });
    expect(quotaFormToBytes(0, 'GB')).toBe(0);
    expect(quotaFormToBytes(null)).toBe(0);
    expect(quotaFormToBytes(-5, 'MB')).toBe(0);
  });
});

describe('computeAdaptiveChunkSize', () => {
  it('小文件使用最小 2MB 分片', () => {
    expect(computeAdaptiveChunkSize(10 * MB)).toBe(2 * MB);
    expect(computeAdaptiveChunkSize(0)).toBe(2 * MB);
  });

  it('50GB 文件的总分片数不超过 9000', () => {
    const size = 50 * GB;
    const chunk = computeAdaptiveChunkSize(size);
    expect(Math.ceil(size / chunk)).toBeLessThanOrEqual(9000);
  });
});

describe('formatBytes', () => {
  it('格式化各量级', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(undefined)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(5 * MB)).toBe('5.00 MB');
  });

  it('超过 TB 时不越界', () => {
    expect(formatBytes(2048 * 1024 * GB)).toMatch(/TB$/);
  });
});

describe('formatDate', () => {
  it('空值返回占位符', () => {
    expect(formatDate(undefined)).toBe('-');
    expect(formatDate('')).toBe('-');
  });

  it('合法时间返回非空字符串', () => {
    expect(formatDate('2026-01-02T03:04:05Z')).toMatch(/2026/);
  });
});

describe('encodeObjectKey', () => {
  it('保留目录分隔符并编码各段', () => {
    expect(encodeObjectKey('a b/中文/c#d.txt')).toBe('a%20b/%E4%B8%AD%E6%96%87/c%23d.txt');
  });

  it('空字符串与单段 key', () => {
    expect(encodeObjectKey('')).toBe('');
    expect(encodeObjectKey('file.txt')).toBe('file.txt');
  });
});

describe('isTextContentType', () => {
  it.each(['text/plain', 'application/json', 'application/javascript', 'application/xml', 'text/yaml'])(
    '%s 视为文本',
    (ct) => {
      expect(isTextContentType(ct)).toBe(true);
    }
  );

  it.each(['image/png', 'application/pdf', '', undefined])('%s 不视为文本', (ct) => {
    expect(isTextContentType(ct)).toBe(false);
  });

  it('大小写不敏感', () => {
    expect(isTextContentType('Application/JSON')).toBe(true);
  });
});
