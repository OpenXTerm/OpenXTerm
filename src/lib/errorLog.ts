type ErrorContext = Record<string, unknown>

function normalizeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }

  return {
    message: String(error),
  }
}

export function logOpenXTermError(scope: string, error: unknown, context: ErrorContext = {}) {
  console.error('[OpenXTerm:error]', scope, {
    ...context,
    error: normalizeError(error),
  })
}
