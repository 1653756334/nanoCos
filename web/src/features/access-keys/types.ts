/** 签发新密钥表单的字段 */
export interface CreateKeyFormValues {
  name: string;
  allowedBuckets: string;
  permission: 'read' | 'readwrite' | 'admin';
}

/** 预签名链接支持的 HTTP 方法 */
export type PresignMethod = 'GET' | 'PUT';
