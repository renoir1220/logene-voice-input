import { describe, expect, it } from 'vitest'
import {
  buildPasteExecutionPlan,
  classifyPasteTargetProbe,
  type FocusRestoreResult,
  type PasteTargetAssessment,
} from '../../electron/main/paste-plan'

function makeRestoreResult(overrides?: Partial<FocusRestoreResult>): FocusRestoreResult {
  return {
    success: true,
    targetAppId: 'target-app',
    finalFrontmostAppId: 'target-app',
    attempts: 1,
    reason: 'ok',
    ...overrides,
  }
}

function makeAssessment(overrides?: Partial<PasteTargetAssessment>): PasteTargetAssessment {
  return {
    status: 'ready',
    reason: 'ok',
    attempts: 1,
    ...overrides,
  }
}

describe('classifyPasteTargetProbe', () => {
  it('可写焦点判定为 ready', () => {
    expect(classifyPasteTargetProbe({ ok: true, reason: 'ok' })).toBe('ready')
  })

  it('前台窗口缺失判定为 blocked', () => {
    expect(classifyPasteTargetProbe({ ok: false, reason: 'no-foreground-window' })).toBe('blocked')
  })

  it('UIA 明确不可写时将 no-focused-control 判定为 blocked', () => {
    expect(
      classifyPasteTargetProbe({
        ok: false,
        reason: 'no-focused-control',
        refineOutcome: 'non-writable',
      }),
    ).toBe('blocked')
  })

  it('未复核的 no-focused-control 保持 uncertain，避免误伤真实可粘贴控件', () => {
    expect(classifyPasteTargetProbe({ ok: false, reason: 'no-focused-control' })).toBe('uncertain')
  })
})

describe('buildPasteExecutionPlan', () => {
  it('恢复焦点失败时直接 fallback', () => {
    const plan = buildPasteExecutionPlan(
      makeRestoreResult({ success: false, reason: 'frontmost-mismatch', finalFrontmostAppId: 'other-app' }),
      makeAssessment(),
    )

    expect(plan).toEqual({ action: 'fallback', fallbackReason: 'restore-failed' })
  })

  it('目标明确不可写时直接 fallback', () => {
    const plan = buildPasteExecutionPlan(
      makeRestoreResult(),
      makeAssessment({ status: 'blocked', reason: 'no-focused-control' }),
    )

    expect(plan).toEqual({ action: 'fallback', fallbackReason: 'no-focused-control' })
  })

  it('目标状态不确定时仍只执行一次粘贴，不再自动转 fallback', () => {
    const plan = buildPasteExecutionPlan(
      makeRestoreResult(),
      makeAssessment({ status: 'uncertain', reason: 'focused-control-without-caret' }),
    )

    expect(plan).toEqual({ action: 'paste' })
  })
})
