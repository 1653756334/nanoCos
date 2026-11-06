import { Button, Card, Space, Tabs, message } from 'antd';
import { CodeOutlined, CopyOutlined } from '@ant-design/icons';
import { copyToClipboard } from '../../../lib/utils';
import {
  SnippetContext,
  buildCurlSnippet,
  buildPicgoConfig,
  buildRcloneConfig,
  buildSdkSnippet,
} from '../snippets';

interface SnippetPaneProps {
  code: string;
  copyLabel: string;
  successText: string;
}

/** 单个代码片段：右上角复制按钮 + 深色代码块 */
function SnippetPane({ code, copyLabel, successText }: SnippetPaneProps) {
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Button
          size="small"
          icon={<CopyOutlined />}
          onClick={async () => {
            await copyToClipboard(code);
            message.success(successText);
          }}
        >
          {copyLabel}
        </Button>
      </div>
      <pre className="text-xs font-mono bg-slate-900 text-slate-100 p-4 rounded-xl overflow-x-auto leading-relaxed">
        {code}
      </pre>
    </div>
  );
}

interface S3SnippetTabsProps {
  context: SnippetContext;
}

/** 客户端与 S3 工具接入配置（PicGo / rclone / SDK / cURL） */
export function S3SnippetTabs({ context }: S3SnippetTabsProps) {
  return (
    <Card
      className="border-slate-200 shadow-none h-full"
      title={
        <Space>
          <CodeOutlined className="text-blue-600" />
          <span className="font-semibold text-sm">
            客户端与 S3 工具接入配置（已自动填入当前密钥）
          </span>
        </Space>
      }
    >
      <Tabs
        items={[
          {
            key: 'picgo',
            label: 'PicGo / Obsidian 图床',
            children: (
              <SnippetPane
                code={buildPicgoConfig(context)}
                copyLabel="复制配置"
                successText="PicGo 配置参数已复制"
              />
            ),
          },
          {
            key: 'rclone',
            label: 'Rclone 挂载与备份',
            children: (
              <SnippetPane
                code={buildRcloneConfig(context)}
                copyLabel="复制 rclone.conf"
                successText="rclone.conf 配置已复制"
              />
            ),
          },
          {
            key: 'sdk',
            label: 'AWS S3 SDK (Node.js)',
            children: (
              <SnippetPane
                code={buildSdkSnippet(context)}
                copyLabel="复制代码"
                successText="S3 SDK 示例代码已复制"
              />
            ),
          },
          {
            key: 'curl',
            label: 'cURL 流式直传 & 秒传',
            children: (
              <SnippetPane
                code={buildCurlSnippet(context)}
                copyLabel="复制命令"
                successText="cURL 示例命令已复制"
              />
            ),
          },
        ]}
      />
    </Card>
  );
}
