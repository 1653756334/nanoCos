import test from 'node:test';
import assert from 'node:assert/strict';

const UNIT_MULTIPLIERS = {
  B: 1,
  KB: 1024,
  MB: 1024 * 1024,
  GB: 1024 * 1024 * 1024,
};

function bytesToQuotaForm(quotaBytes) {
  if (!quotaBytes || quotaBytes <= 0) {
    return { quotaValue: 0, quotaUnit: 'MB' };
  }
  if (quotaBytes % UNIT_MULTIPLIERS.GB === 0) {
    return { quotaValue: quotaBytes / UNIT_MULTIPLIERS.GB, quotaUnit: 'GB' };
  }
  if (quotaBytes % UNIT_MULTIPLIERS.MB === 0) {
    return { quotaValue: quotaBytes / UNIT_MULTIPLIERS.MB, quotaUnit: 'MB' };
  }
  if (quotaBytes % UNIT_MULTIPLIERS.KB === 0) {
    return { quotaValue: quotaBytes / UNIT_MULTIPLIERS.KB, quotaUnit: 'KB' };
  }
  return { quotaValue: quotaBytes, quotaUnit: 'B' };
}

function quotaFormToBytes(quotaValue, quotaUnit = 'MB') {
  if (!quotaValue || quotaValue <= 0) return 0;
  const mult = UNIT_MULTIPLIERS[quotaUnit] || UNIT_MULTIPLIERS.MB;
  return Math.max(0, Math.round(Number(quotaValue) * mult));
}

function computeAdaptiveChunkSize(fileSize) {
  const MIN_CHUNK = 2 * 1024 * 1024;
  if (!fileSize || fileSize <= 0) return MIN_CHUNK;
  return Math.max(MIN_CHUNK, Math.ceil(fileSize / 9000));
}

test('bytesToQuotaForm and quotaFormToBytes preserve sub-1MB and exact byte quotas', () => {
  // < 1MB (e.g., 512 KB) must NOT round down to 0
  const subMB = bytesToQuotaForm(512 * 1024);
  assert.deepEqual(subMB, { quotaValue: 512, quotaUnit: 'KB' });
  assert.equal(quotaFormToBytes(subMB.quotaValue, subMB.quotaUnit), 512 * 1024);

  // Arbitrary byte quota (e.g., 12345 Bytes) must round-trip losslessly
  const exactB = bytesToQuotaForm(12345);
  assert.deepEqual(exactB, { quotaValue: 12345, quotaUnit: 'B' });
  assert.equal(quotaFormToBytes(exactB.quotaValue, exactB.quotaUnit), 12345);

  // 10 GB quota
  const tenGB = bytesToQuotaForm(10 * 1024 * 1024 * 1024);
  assert.deepEqual(tenGB, { quotaValue: 10, quotaUnit: 'GB' });
  assert.equal(quotaFormToBytes(tenGB.quotaValue, tenGB.quotaUnit), 10 * 1024 * 1024 * 1024);
});

test('computeAdaptiveChunkSize keeps total parts <= 9000 for 50GB files', () => {
  assert.equal(computeAdaptiveChunkSize(10 * 1024 * 1024), 2 * 1024 * 1024);
  const fiftyGB = 50 * 1024 * 1024 * 1024;
  const chunkSize = computeAdaptiveChunkSize(fiftyGB);
  const totalParts = Math.ceil(fiftyGB / chunkSize);
  assert.ok(totalParts <= 9000, `Expected <= 9000 parts, got ${totalParts}`);
});
