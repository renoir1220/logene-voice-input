import type { PasteTargetProbeReason } from './input-sim'

export type FloatPasteFallbackReason = PasteTargetProbeReason | 'type-failed' | 'restore-failed'

export interface FocusRestoreResult {
  success: boolean
  targetAppId: string | null
  finalFrontmostAppId: string | null
  attempts: number
  reason: 'ok' | 'no-target' | 'frontmost-mismatch'
}

export interface PasteTargetAssessment {
  status: 'ready' | 'blocked' | 'uncertain'
  reason: PasteTargetProbeReason
  attempts: number
  source?: 'win32-gui' | 'win32-uia'
  detail?: string
  refineOutcome?: 'writable' | 'non-writable' | 'error'
}

export interface PasteTargetProbeSnapshot {
  ok: boolean
  reason: PasteTargetProbeReason
  refineOutcome?: 'writable' | 'non-writable' | 'error'
}

export interface PasteExecutionPlan {
  action: 'paste' | 'fallback'
  fallbackReason?: FloatPasteFallbackReason
}

export function buildPasteExecutionPlan(
  restoreResult: FocusRestoreResult,
  assessment: PasteTargetAssessment,
): PasteExecutionPlan {
  if (!restoreResult.success) {
    return { action: 'fallback', fallbackReason: 'restore-failed' }
  }

  if (assessment.status === 'blocked') {
    return { action: 'fallback', fallbackReason: assessment.reason }
  }

  return { action: 'paste' }
}

export function classifyPasteTargetProbe(
  probe: PasteTargetProbeSnapshot,
): PasteTargetAssessment['status'] {
  if (probe.ok) return 'ready'
  if (probe.reason === 'no-foreground-window') return 'blocked'
  if (probe.reason === 'no-focused-control' && probe.refineOutcome === 'non-writable') return 'blocked'
  return 'uncertain'
}
