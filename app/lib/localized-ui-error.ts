/**
 * Marks text that has already been produced by the active locale catalog.
 * Unknown browser/runtime errors must never be rendered through `Error.message`
 * because those messages are supplied by the engine and are usually English.
 */
export class LocalizedUiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LocalizedUiError"
  }
}

export function localizedUiErrorMessage(error: unknown, fallback: string) {
  return error instanceof LocalizedUiError ? error.message : fallback
}
