/**
 * 换环单：隧道大修更换整环管片的登记—预览—确认凭证。
 * 流程：登记（待确认）→ 预览受影响裂缝/复测/建议 → 确认（原环整体留档、新环从零建档）。
 * 未确认不写入任何业务数据；确认失败保留换环单与已确认范围，重试幂等不重复建环。
 */
import type { SegmentType } from '@/types/ring'

/**
 * 换环单状态
 * - draft   待确认：已登记日期/原因/新环安装信息，尚未执行留档建档
 * - failed  确认失败：业务表未被改动，可按原范围重试
 * - done    已确认：原环已留档、新环已建档
 */
export type ReplacementStatus = 'draft' | 'failed' | 'done'

export const REPLACEMENT_STATUS_LABEL: Record<ReplacementStatus, string> = {
  draft: '待确认',
  failed: '确认失败（可重试）',
  done: '已确认'
}

/** 换环单登记/编辑入参 */
export interface ReplacementDraft {
  /** 被更换的原环（当前环）id */
  oldRingId: string
  /** 换环日期 YYYY-MM-DD（新环就位、原环拆除的日期） */
  replaceDate: string
  /** 换环原因，如结构裂缝超限、错台、收敛超标 */
  reason: string
  /** 新环沿用原环号，单独登记安装信息；环号由原环带出，不允许在这里改挂别的环 */
  newSegmentType: SegmentType
  /** 新环安装日期 YYYY-MM-DD */
  newInstallDate: string
  /** 新环里程（m），缺省沿用原环里程 */
  newMileage?: number
  /** 施工/安装单位 */
  installer?: string
  /** 备注 */
  remark?: string
}

export const EMPTY_REPLACEMENT_DRAFT: ReplacementDraft = {
  oldRingId: '',
  replaceDate: '',
  reason: '',
  newSegmentType: '钢筋混凝土',
  newInstallDate: '',
  newMileage: undefined,
  installer: '',
  remark: ''
}

/**
 * 确认时的范围快照：登记预览后把受影响对象的 id 固化在换环单上。
 * 确认执行时重读现状并与之比对（漂移检测），且只允许操作原环自身的数据，防错挂。
 */
export interface ReplacementScope {
  /** 受影响裂缝 id（原环上的全部裂缝） */
  crackIds: string[]
  /** 受影响复测 id（上述裂缝的全部测次） */
  surveyIds: string[]
  /** 受影响整治建议 id（上述裂缝的建议） */
  adviceIds: string[]
  /** 范围指纹：按 id 排序拼接，确认时重算对比 */
  fingerprint: string
  /** 登记预览时的数量，供确认页直接展示 */
  crackCount: number
  surveyCount: number
  adviceCount: number
  /** 预览生成时间戳 */
  previewedAt: number
}

export interface Replacement {
  id: string
  oldRingId: string
  /** 确认后写入的新环 id（draft/failed 阶段为空，重试时凭它幂等） */
  newRingId?: string
  status: ReplacementStatus
  replaceDate: string
  reason: string
  newSegmentType: SegmentType
  newInstallDate: string
  newMileage?: number
  installer?: string
  remark?: string
  /** 已确认范围（登记预览后固化） */
  scope?: ReplacementScope
  /** 确认重试次数（每次失败 +1） */
  attempts?: number
  /** 最近一次失败原因（错误码） */
  lastErrorCode?: string
  confirmedAt?: number
  createdAt: number
  updatedAt: number
}

/**
 * 换环写入守卫错误码：未确认、跨环、缺安装信息、范围漂移等全部拒绝写入。
 */
export type ReplacementErrorCode =
  | 'NOT_FOUND'
  | 'OLD_RING_NOT_CURRENT'
  | 'CROSS_SECTION_RING'
  | 'RING_NO_CONFLICT'
  | 'SCOPE_DRIFT'
  | 'MISSING_INSTALL_INFO'
  | 'MISSING_REASON'
  | 'MISSING_DATE'
  | 'DATE_ORDER_INVALID'
  | 'NOT_DRAFT'
  | 'RING_BUSY'
  | 'ARCHIVED_RING_READONLY'
  | 'NEW_RING_ORPHAN'

export class ReplacementError extends Error {
  code: ReplacementErrorCode
  constructor(code: ReplacementErrorCode, message: string) {
    super(message)
    this.name = 'ReplacementError'
    this.code = code
  }
}

/** 错误码 → 中文提示（页面与守卫共用） */
export const REPLACEMENT_ERROR_TEXT: Record<ReplacementErrorCode, string> = {
  NOT_FOUND: '换环单或原环不存在，数据可能已被删除，请刷新后重新登记',
  OLD_RING_NOT_CURRENT: '原环已留档，不能再次换环；请对当前环登记换环',
  CROSS_SECTION_RING: '检测到裂缝跨环或归属区间不一致，已阻止写入，请核对裂缝归属后重新预览',
  RING_NO_CONFLICT: '同一区间已存在相同环号的当前环，新环无法沿用原环号建档',
  SCOPE_DRIFT: '登记后裂缝/复测范围发生变化，为免错挂请重新预览确认',
  MISSING_INSTALL_INFO: '缺少新环安装信息（管片类型与安装日期必填），不能写入',
  MISSING_REASON: '请填写换环原因',
  MISSING_DATE: '请填写换环日期与新环安装日期',
  DATE_ORDER_INVALID: '日期顺序不合法：安装日期与换环日期需不早于原环安装日期，且安装日期不晚于换环日期',
  NOT_DRAFT: '换环单不是待确认/可重试状态，不能执行该操作',
  RING_BUSY: '该环已有待确认的换环单，请先确认或作废后再操作',
  ARCHIVED_RING_READONLY: '已换环整体留档为只读历史，裂缝、复测与建议不能新增或修改',
  NEW_RING_ORPHAN: '检测到上次失败遗留的新环，已自动接管原建档结果继续完成换环'
}

export function replacementErrorText(code: string): string {
  return REPLACEMENT_ERROR_TEXT[code as ReplacementErrorCode] ?? `换环写入被拒绝（${code}）`
}
