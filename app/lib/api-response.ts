import { NextResponse } from "next/server"
import type { ApiErrorCode } from "./api-codes"

const API_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/u

export interface ApiIssueInput {
  path: string
}

/**
 * API responses deliberately carry machine-readable codes, never localized
 * prose. Browser clients translate those codes (or use contextual i18n copy).
 */
export function apiErrorBody(
  code: ApiErrorCode,
  details: Record<string, unknown> = {},
) {
  if (!API_CODE_PATTERN.test(code)) {
    throw new Error(`API_ERROR_CODE_INVALID:${code}`)
  }
  return { ...details, error: code, code }
}

export function apiError(
  code: ApiErrorCode,
  status: number,
  options: {
    headers?: HeadersInit
    details?: Record<string, unknown>
  } = {},
) {
  return NextResponse.json(apiErrorBody(code, options.details), {
    status,
    headers: options.headers,
  })
}

/** Preserve safe field paths while preventing validator prose from leaking
 * into a language-neutral API response. */
export function apiIssues(
  issues: readonly ApiIssueInput[],
  code: ApiErrorCode = "INVALID_REQUEST",
) {
  if (!API_CODE_PATTERN.test(code)) {
    throw new Error(`API_ISSUE_CODE_INVALID:${code}`)
  }
  return issues.map(issue => ({ path: issue.path, code }))
}
