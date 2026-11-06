import { describe, expect, it } from 'vitest';
import { StreamingSHA256 } from '../sha256-stream';

describe('StreamingSHA256', () => {
  it('匹配空字符串的标准 SHA-256 哈希', () => {
    const s = new StreamingSHA256();
    expect(s.digest()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('匹配 "abc" 标准测试向量', () => {
    const s = new StreamingSHA256();
    s.update(new TextEncoder().encode('abc'));
    expect(s.digest()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('匹配长字符串标准测试向量', () => {
    const s = new StreamingSHA256();
    s.update(new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'));
    expect(s.digest()).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('支持非对齐的任意分块流式增量注入并保证结果一致', () => {
    const text = 'NanoCOS CAS Object Storage Chunked Hash Streaming Verification 2026!'.repeat(100);
    const fullBytes = new TextEncoder().encode(text);

    // 一次性
    const s1 = new StreamingSHA256();
    s1.update(fullBytes);
    const hash1 = s1.digest();

    // 切成每 13 字节一块注入（非 64 字节对齐）
    const s2 = new StreamingSHA256();
    for (let i = 0; i < fullBytes.length; i += 13) {
      s2.update(fullBytes.subarray(i, Math.min(i + 13, fullBytes.length)));
    }
    const hash2 = s2.digest();

    expect(hash2).toBe(hash1);
  });
});
