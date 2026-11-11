/** A failure to show the user as-is. Messages never include API keys. */
export class AiError extends Error {
  constructor(
    message: string,
    readonly status: 422 | 429 | 502 | 503,
  ) {
    super(message);
  }
}
