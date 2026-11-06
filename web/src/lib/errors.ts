/** 后端 401 时 api.ts 抛出的错误文案，用于区分「会话过期」与其他业务错误 */
export const UNAUTHORIZED_MESSAGE = 'UNAUTHORIZED';

/** 安全地从 unknown 错误中提取可展示文案，避免在 catch 中使用 `err: any` */
export function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return fallback;
}

export function isUnauthorizedError(err: unknown): boolean {
  return err instanceof Error && err.message === UNAUTHORIZED_MESSAGE;
}

/** antd Form.validateFields 校验失败时抛出的对象带有 errorFields */
export function isFormValidationError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'errorFields' in err;
}
