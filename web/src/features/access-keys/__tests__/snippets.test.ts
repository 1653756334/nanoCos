import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_ACCESS_KEY,
  PLACEHOLDER_BUCKET,
  PLACEHOLDER_SECRET_KEY,
  SnippetContext,
  buildCurlSnippet,
  buildPicgoConfig,
  buildPresignPutCurl,
  buildRcloneConfig,
  buildSdkSnippet,
  resolveSample,
} from '../snippets';

const ctx: SnippetContext = {
  accessKey: 'COSAK_TEST123',
  secretKey: 'secret/abc+XYZ',
  bucket: 'my-bucket',
  baseUrl: 'https://cos.example.com',
  s3Endpoint: 'https://cos.example.com/s3',
  s3Region: 'ap-east-1',
};

describe('resolveSample', () => {
  it('有真实密钥和存储桶时直接使用', () => {
    expect(resolveSample({ accessKey: 'AK1', secretKey: 'SK1' }, 'photos')).toEqual({
      accessKey: 'AK1',
      secretKey: 'SK1',
      bucket: 'photos',
    });
  });

  it('缺失时回退到占位值', () => {
    expect(resolveSample(undefined, undefined)).toEqual({
      accessKey: PLACEHOLDER_ACCESS_KEY,
      secretKey: PLACEHOLDER_SECRET_KEY,
      bucket: PLACEHOLDER_BUCKET,
    });
    expect(resolveSample(undefined, '')).toMatchObject({ bucket: 'assets' });
  });
});

describe('buildPicgoConfig', () => {
  it('嵌入 AK/SK、桶名、region、endpoint 与自定义域名', () => {
    const out = buildPicgoConfig(ctx);
    expect(out).toContain(`: ${ctx.accessKey}`);
    expect(out).toContain(`: ${ctx.secretKey}`);
    expect(out).toContain(`: ${ctx.bucket}`);
    expect(out).toContain(`: ${ctx.s3Region}`);
    expect(out).toContain(`: ${ctx.s3Endpoint}`);
    expect(out).toContain('https://cos.example.com/raw/my-bucket');
    expect(out).toContain('{year}/{month}/{md5}.{extName}');
  });
});

describe('buildRcloneConfig', () => {
  it('生成 rclone.conf 配置段', () => {
    const out = buildRcloneConfig(ctx);
    expect(out.startsWith('[nanocos]\ntype = s3')).toBe(true);
    expect(out).toContain('access_key_id = COSAK_TEST123');
    expect(out).toContain('secret_access_key = secret/abc+XYZ');
    expect(out).toContain('endpoint = https://cos.example.com/s3');
    expect(out).toContain('region = ap-east-1');
    expect(out).toContain('force_path_style = true');
    expect(out).toContain('# rclone ls nanocos:my-bucket');
    expect(out).toContain('# rclone sync ./my-folder nanocos:my-bucket/backup');
  });
});

describe('buildSdkSnippet', () => {
  it('生成带 endpoint / region / 凭证 / Bucket 的 S3Client 代码', () => {
    const out = buildSdkSnippet(ctx);
    expect(out).toContain('region: "ap-east-1"');
    expect(out).toContain('endpoint: "https://cos.example.com/s3"');
    expect(out).toContain('forcePathStyle: true');
    expect(out).toContain('accessKeyId: "COSAK_TEST123"');
    expect(out).toContain('secretAccessKey: "secret/abc+XYZ"');
    expect(out).toContain('Bucket: "my-bucket"');
  });
});

describe('buildCurlSnippet', () => {
  it('两条命令都使用 baseUrl、桶名与密钥头', () => {
    const out = buildCurlSnippet(ctx);
    expect(out).toContain(
      'curl -X PUT "https://cos.example.com/api/v1/buckets/my-bucket/objects/docs/manual.pdf"'
    );
    expect(out).toContain(
      'curl -X POST "https://cos.example.com/api/v1/buckets/my-bucket/fast-upload"'
    );
    expect(out.match(/X-Cos-Access-Key: COSAK_TEST123/g)).toHaveLength(2);
    expect(out.match(/X-Cos-Secret-Key: secret\/abc\+XYZ/g)).toHaveLength(2);
  });

  it('行尾续行符为单个反斜杠', () => {
    const out = buildCurlSnippet(ctx);
    expect(out).toContain('manual.pdf" \\\n  -H');
    expect(out).not.toContain('\\\\');
  });
});

describe('buildPresignPutCurl', () => {
  it('嵌入预签名 URL', () => {
    const url = 'https://cos.example.com/s3/my-bucket/a.png?X-Amz-Signature=abc';
    const out = buildPresignPutCurl(url);
    expect(out).toContain(`curl -X PUT "${url}" --data-binary "@./localfile.png"`);
  });
});
