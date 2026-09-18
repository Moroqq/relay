/** An error the portal answers with, as a status, a stable code and a message. */
export class PortalError extends Error {
  override readonly name = 'PortalError';
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
