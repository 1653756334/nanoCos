import { Button } from 'antd';
import { PlusOutlined } from '@ant-design/icons';

interface AccessKeysHeaderProps {
  onCreate: () => void;
}

/** 页面顶部标题栏与「签发新密钥」入口 */
export function AccessKeysHeader({ onCreate }: AccessKeysHeaderProps) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-white border border-slate-200 rounded-md px-5 py-4">
      <div>
        <h1 className="text-base font-bold text-slate-900 m-0">
          访问密钥 (AK/SK) &amp; S3 生态工具箱
        </h1>
        <p className="text-xs text-slate-500 mt-0.5 mb-0">
          管理多租户 API 访问凭证、在线签发预签名直传/下载 URL，一键对接 S3 客户端生态
        </p>
      </div>
      <Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>
        签发新密钥 (AK/SK)
      </Button>
    </div>
  );
}
