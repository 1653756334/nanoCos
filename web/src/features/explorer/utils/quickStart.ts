export interface QuickStartParams {
  bucketName: string;
  baseUrl: string;
  s3Endpoint: string;
  s3Region: string;
}

export interface QuickStartSnippets {
  /** cURL 直传与直链读取示例 */
  curl: string;
  /** PicGo / Rclone 等 S3 兼容客户端的接入参数 */
  s3Params: string;
}

/** 生成「当前桶快速接入」页展示的示例文本 */
export function buildQuickStartSnippets(p: QuickStartParams): QuickStartSnippets {
  const curl = `# 上传本地文件至 ${p.bucketName}
curl -X PUT "${p.baseUrl}/api/v1/buckets/${p.bucketName}/objects/demo/hello.txt" \\
  -H "X-Cos-Access-Key: <YOUR_AK>" \\
  -H "X-Cos-Secret-Key: <YOUR_SK>" \\
  --data-binary "@./hello.txt"

# 直链下载或 HTTP Range 视频流读取
curl -H "Range: bytes=0-1023" "${p.baseUrl}/raw/${p.bucketName}/demo/hello.txt"`;

  const s3Params = `Endpoint (自定义节点) : ${p.s3Endpoint}
Bucket (存储桶名)     : ${p.bucketName}
Region (存储区域)     : ${p.s3Region}
ForcePathStyle        : true (必须开启路径样式)
Custom URL (外链前缀) : ${p.baseUrl}/raw/${p.bucketName}`;

  return { curl, s3Params };
}
