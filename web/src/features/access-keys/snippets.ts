/**
 * S3 生态接入示例代码生成器（纯函数，无任何 React / 网络依赖，便于单元测试）。
 */

export interface SnippetContext {
  /** 示例使用的 AccessKey ID */
  accessKey: string;
  /** 示例使用的 SecretKey */
  secretKey: string;
  /** 示例使用的存储桶名称 */
  bucket: string;
  /** 对外访问基础地址（用于 REST API 与自定义域名） */
  baseUrl: string;
  /** S3 兼容 Endpoint */
  s3Endpoint: string;
  /** S3 Region */
  s3Region: string;
}

/** 没有任何真实密钥 / 存储桶时使用的占位值 */
export const PLACEHOLDER_ACCESS_KEY = 'COSAK_YOUR_ACCESS_KEY';
export const PLACEHOLDER_SECRET_KEY = 'YOUR_SECRET_KEY';
export const PLACEHOLDER_BUCKET = 'assets';

/** 根据（可能为空的）首个密钥与首个存储桶，解析示例中要展示的凭证与桶名 */
export function resolveSample(
  firstKey: { accessKey: string; secretKey: string } | undefined,
  firstBucketName: string | undefined
): { accessKey: string; secretKey: string; bucket: string } {
  return {
    accessKey: firstKey?.accessKey || PLACEHOLDER_ACCESS_KEY,
    secretKey: firstKey?.secretKey || PLACEHOLDER_SECRET_KEY,
    bucket: firstBucketName || PLACEHOLDER_BUCKET,
  };
}

/** PicGo (picgo-plugin-s3) / Obsidian Remotely Save 配置参数 */
export function buildPicgoConfig(ctx: SnippetContext): string {
  return `# 适用于 PicGo (picgo-plugin-s3) 或 Obsidian Remotely Save
应用密钥 ID (AccessKeyID)     : ${ctx.accessKey}
应用密钥 (SecretAccessKey)    : ${ctx.secretKey}
桶名 (Bucket)                 : ${ctx.bucket}
区域 (Region)                 : ${ctx.s3Region}
自定义节点 (Endpoint)         : ${ctx.s3Endpoint}
强制路径样式 (ForcePathStyle) : true (开启)
上传路径模板 (UploadPath)     : {year}/{month}/{md5}.{extName}
自定义域名 (Custom URL)       : ${ctx.baseUrl}/raw/${ctx.bucket}`;
}

/** rclone.conf 配置段与验证命令示例 */
export function buildRcloneConfig(ctx: SnippetContext): string {
  return `[nanocos]
type = s3
provider = Other
env_auth = false
access_key_id = ${ctx.accessKey}
secret_access_key = ${ctx.secretKey}
endpoint = ${ctx.s3Endpoint}
region = ${ctx.s3Region}
force_path_style = true

# 验证与同步示例:
# rclone ls nanocos:${ctx.bucket}
# rclone sync ./my-folder nanocos:${ctx.bucket}/backup`;
}

/** AWS S3 SDK (Node.js, v3) 示例代码 */
export function buildSdkSnippet(ctx: SnippetContext): string {
  return `import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  region: "${ctx.s3Region}",
  endpoint: "${ctx.s3Endpoint}",
  forcePathStyle: true,
  credentials: {
    accessKeyId: "${ctx.accessKey}",
    secretAccessKey: "${ctx.secretKey}",
  },
});

// 上传对象
await s3.send(new PutObjectCommand({
  Bucket: "${ctx.bucket}",
  Key: "app/config.json",
  Body: JSON.stringify({ env: "production" }),
  ContentType: "application/json",
}));`;
}

/** cURL 流式直传与 SHA-256 秒传探测示例 */
export function buildCurlSnippet(ctx: SnippetContext): string {
  return `# 1. 现代 REST API 流式上传 (自动 SHA-256 去重)
curl -X PUT "${ctx.baseUrl}/api/v1/buckets/${ctx.bucket}/objects/docs/manual.pdf" \\
  -H "X-Cos-Access-Key: ${ctx.accessKey}" \\
  -H "X-Cos-Secret-Key: ${ctx.secretKey}" \\
  --data-binary "@./manual.pdf"

# 2. SHA-256 零字节秒传探测
curl -X POST "${ctx.baseUrl}/api/v1/buckets/${ctx.bucket}/fast-upload" \\
  -H "X-Cos-Access-Key: ${ctx.accessKey}" \\
  -H "X-Cos-Secret-Key: ${ctx.secretKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"key":"docs/copy.pdf","sha256":"<64位SHA256>","contentType":"application/pdf"}'`;
}

/** 使用 PUT 预签名链接免密钥直传文件的 cURL 命令 */
export function buildPresignPutCurl(presignedUrl: string): string {
  return `# 使用生成的 PUT 预签名链接免密钥直传文件:
curl -X PUT "${presignedUrl}" --data-binary "@./localfile.png"`;
}
