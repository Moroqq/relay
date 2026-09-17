/** An error the console answers with, as a status, a stable code and a message. */
export class ConsoleError extends Error {
  override readonly name = 'ConsoleError';
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
