/**
 * Errors a merchant sees.
 *
 * Every failure carries a stable machine-readable `code` alongside the human
 * message, because integrations branch on codes and messages get reworded.
 * Nothing internal — no SQL, no stack, no table name — reaches the client.
 */

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  readonly code: string;
  readonly detail: string | undefined;

  constructor(status: number, code: string, message: string, detail?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  toJSON(): { error: { code: string; message: string; detail?: string } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.detail === undefined ? {} : { detail: this.detail }),
      },
    };
  }
}

export const badRequest = (code: string, message: string, detail?: string): ApiError =>
  new ApiError(400, code, message, detail);

export const unauthorized = (message = 'Missing or invalid API key'): ApiError =>
  new ApiError(401, 'unauthorized', message);

export const notFound = (message = 'Not found'): ApiError =>
  new ApiError(404, 'not_found', message);
