import { describe, expect, it } from 'vitest';
import { formatUptime } from '../format';

describe('formatUptime', () => {
  it('未提供或为 0 时回退为 1 秒', () => {
    expect(formatUptime()).toBe('1 秒');
    expect(formatUptime(0)).toBe('1 秒');
  });

  it('小于 60 秒按秒显示', () => {
    expect(formatUptime(1)).toBe('1 秒');
    expect(formatUptime(59)).toBe('59 秒');
  });

  it('小于 1 小时按分钟显示（向下取整）', () => {
    expect(formatUptime(60)).toBe('1 分钟');
    expect(formatUptime(119)).toBe('1 分钟');
    expect(formatUptime(3599)).toBe('59 分钟');
  });

  it('小于 1 天显示「小时 分」', () => {
    expect(formatUptime(3600)).toBe('1 小时 0 分');
    expect(formatUptime(3600 + 5 * 60 + 30)).toBe('1 小时 5 分');
    expect(formatUptime(86399)).toBe('23 小时 59 分');
  });

  it('大于等于 1 天显示「天 小时」', () => {
    expect(formatUptime(86400)).toBe('1 天 0 小时');
    expect(formatUptime(86400 * 3 + 3600 * 5 + 600)).toBe('3 天 5 小时');
  });
});
