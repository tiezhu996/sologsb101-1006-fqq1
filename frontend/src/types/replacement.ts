/**
 * 换环单：隧道大修换掉整环管片时的版本登记单据。
 * 流程：先登记换环日期、原因与新环安装信息（待确认）→ 预览受影响裂缝/复测/建议 →
 * 确认后把原环整体留档（status=current → archived），新环从零建档（沿用原环号）。
 * 换环单在失败后保留单据与已确认范围，重试按 newRingId 幂等，不重复建环。
 */
import type { SegmentType } from '@/types/ring'
import type { AdviceLevel } from '@/types/advice'

/** 换环单状态 */
export type ReplacementStatus = '待确认' | '已完成' | '失败'

/** 换环原因 */
export type ReplacementReason = '裂缝超限' | '管片破损' | '渗漏' | '错台变形' | '其他'

export interface Replacement {
  id: string
  /** 被换下的原环 id */
  oldRingId: string
  /** 登记时冗余的原环信息（原环可能在留档后不再展示在当前台账） */
  oldRingNo: number
  oldMileage: number
  sectionId: string
  /** 换环施工日期 YYYY-MM-DD */
  replaceDate: string
  reason: ReplacementReason
  /** 原因说明（必填，避免只有一个分类标签） */
  reasonDetail: string
  /* ---------------------------- 新环安装信息 ---------------------------- */
  /** 预生成的新环 id：确认执行前先落单，确认时按它幂等建环 */
  newRingId: string
  /** 新环沿用原环号 */
  newRingNo: number
  newMileage: number
  newSegmentType: SegmentType
  /** 新环安装日期 YYYY-MM-DD */
  newInstallDate: string
  /** 管片厂家（选填） */
  manufacturer: string
  /** 批次编号（选填） */
  batchNo: string
  /** 施工单位（选填） */
  constructionUnit: string
  /** 状态 */
  status: ReplacementStatus
  /** 确认执行后留档的影响范围快照：原环裂缝 id 全量 */
  confirmedCrackIds: string[]
  /** 确认时间（ISO 数字时间戳） */
  confirmedAt: number | null
  /** 确认人 */
  confirmedBy: string
  /** 失败原因（status=失败 时回写，保留单据供重试） */
  lastError: string
  /** 最近一次尝试执行时间 */
  lastAttemptAt: number | null
  createdAt: number
  updatedAt: number
}

/** 登记换环单入参 */
export interface ReplacementDraft {
  oldRingId: string
  replaceDate: string
  reason: ReplacementReason
  reasonDetail: string
  newMileage: number
  newSegmentType: SegmentType
  newInstallDate: string
  manufacturer: string
  batchNo: string
  constructionUnit: string
  confirmedBy: string
}

export const REPLACEMENT_REASONS: ReplacementReason[] = ['裂缝超限', '管片破损', '渗漏', '错台变形', '其他']
export const REPLACEMENT_STATUSES: ReplacementStatus[] = ['待确认', '已完成', '失败']

export const EMPTY_REPLACEMENT_DRAFT: ReplacementDraft = {
  oldRingId: '',
  replaceDate: '',
  reason: '裂缝超限',
  reasonDetail: '',
  newMileage: 0,
  newSegmentType: '钢筋混凝土',
  newInstallDate: '',
  manufacturer: '',
  batchNo: '',
  constructionUnit: '',
  confirmedBy: ''
}

/** 预览中的受影响条目 */
export interface ReplacementAffectedCrack {
  crackId: string
  code: string
  position: string
  direction: string
  state: string
  widthMm: number
  surveyCount: number
  adviceCount: number
  latestRate: number
  latestLevel: AdviceLevel
}

/** 换环预览结果：确认前必须先看到的影响范围 */
export interface ReplacementPreview {
  oldRingId: string
  oldRingNo: number
  oldMileage: number
  oldInstallDate: string
  oldSegmentType: SegmentType
  newRingNo: number
  cracks: ReplacementAffectedCrack[]
  surveyCount: number
  adviceCount: number
  /** 原环已有的待确认换环单（预览时给出提示，不允许重复登记） */
  pendingReplacementId: string | null
}

/** 校验错误：键为字段名，值为中文错误信息 */
export type ReplacementErrors = Partial<Record<keyof ReplacementDraft, string>>

/**
 * 纯函数校验换环登记表单（不依赖数据库的部分）。
 * 跨环重复等需要查表的规则由 db 层 validateReplacementContext 补充。
 */
export function validateReplacementDraft(draft: ReplacementDraft): ReplacementErrors {
  const errors: ReplacementErrors = {}
  if (!draft.oldRingId) errors.oldRingId = '请选择被更换的原环'
  if (!draft.replaceDate) errors.replaceDate = '请选择换环施工日期'
  if (!draft.reason) errors.reason = '请选择换环原因'
  if (draft.reasonDetail.trim().length === 0) errors.reasonDetail = '请填写换环原因说明'
  if (!Number.isFinite(draft.newMileage) || draft.newMileage < 0) errors.newMileage = '请填写新环里程（m）'
  if (!draft.newSegmentType) errors.newSegmentType = '请选择管片类型'
  if (!draft.newInstallDate) errors.newInstallDate = '请选择新环安装日期'
  if (draft.newInstallDate && draft.replaceDate && draft.newInstallDate > draft.replaceDate) {
    errors.newInstallDate = '新环安装日期不能晚于换环施工日期'
  }
  return errors
}

/** 换环单状态对应的 Element Plus 标签色 */
export function replacementStatusType(status: ReplacementStatus): 'warning' | 'success' | 'danger' {
  if (status === '已完成') return 'success'
  if (status === '失败') return 'danger'
  return 'warning'
}
