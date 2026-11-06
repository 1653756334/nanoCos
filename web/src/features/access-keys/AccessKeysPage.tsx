import { Col, Row } from 'antd';
import { useBuckets, useSystemInfo } from '../system/queries';
import { AccessKeysHeader } from './components/AccessKeysHeader';
import { AccessKeysTable } from './components/AccessKeysTable';
import { CreateKeyModal } from './components/CreateKeyModal';
import { PresignDebugger } from './components/PresignDebugger';
import { S3SnippetTabs } from './components/S3SnippetTabs';
import { useAccessKeyList } from './hooks/useAccessKeyList';
import { useCreateKeyModal } from './hooks/useCreateKeyModal';
import { resolveSample } from './snippets';

/** 访问密钥管理页：只负责组合各区块 */
export function AccessKeysPage() {
  const { data: bucketsData } = useBuckets();
  const buckets = bucketsData ?? [];
  const { baseUrl, s3Endpoint, s3Region } = useSystemInfo();

  const { keys, loading, revealedSK, toggleReveal, deleteKey } = useAccessKeyList();
  const createModal = useCreateKeyModal();

  // 接入示例默认取第一把密钥与第一个存储桶
  const sample = resolveSample(keys[0], buckets[0]?.name);

  return (
    <div className="space-y-4">
      <AccessKeysHeader onCreate={createModal.openModal} />

      <AccessKeysTable
        keys={keys}
        loading={loading}
        revealedSK={revealedSK}
        onToggleReveal={toggleReveal}
        onDelete={deleteKey}
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={10}>
          <PresignDebugger buckets={buckets} />
        </Col>
        <Col xs={24} xl={14}>
          <S3SnippetTabs context={{ ...sample, baseUrl, s3Endpoint, s3Region }} />
        </Col>
      </Row>

      <CreateKeyModal
        open={createModal.open}
        submitting={createModal.submitting}
        form={createModal.form}
        onCancel={createModal.closeModal}
        onSubmit={createModal.submit}
      />
    </div>
  );
}
