/** 环片：区间内一环管片，裂缝的最小归属单元 */
export type SegmentType = '钢筋混凝土' | '铸铁' | '钢管片'

/**
 * 环片档案状态
 * - current 当前环：大修后的在用环（或从未换过的环），裂缝/复测/预警默认只统计当前环
 * - archived 已换环：大修换掉的原环整体留档，换环前的裂缝与全部复测仍挂在原环片可查
 */
export type RingStatus = 'current' | 'archived'

export const RING_STATUS_LABEL: Record<RingStatus, string> = {
  current: '当前环',
  archived: '已换环（历史留档）'
}

export interface Ring {
  id: string
  sectionId: string
  /** 环号：换环后新环沿用原环号，靠世代号区分 */
  ringNo: number
  /** 里程（m） */
  mileage: number
  segmentType: SegmentType
  /** 安装日期 YYYY-MM-DD */
  installDate: string
  /** 档案状态，历史数据缺省按当前环处理 */
  status?: RingStatus
  /** 环片世代号：首环为 1，每换一环加 1 */
  generation?: number
  /**
   * 同一环号血缘链 id：首环即自身 id，换环后新老环共用。
   * 原环留档、新环建档后，裂缝与复测始终按各自所在环片 id 归属，绝不错挂。
   */
  lineageId?: string
  /** 已换环：换它的换环单 id */
  replacedById?: string
  /** 已换环：换环日期 YYYY-MM-DD（冗余自动环单，便于台账直接展示） */
  replacedDate?: string
  /** 当前环：上一环（已留档原环）的 id */
  previousRingId?: string
  /** 当前环（非首环）：建档所用换环单 id */
  replacementId?: string
  createdAt: number
  updatedAt: number
}

export const SEGMENT_TYPES: SegmentType[] = ['钢筋混凝土', '铸铁', '钢管片']

export interface RingDraft {
  sectionId: string
  ringNo: number
  mileage: number
  segmentType: SegmentType
  installDate: string
}

export const EMPTY_RING_DRAFT: RingDraft = {
  sectionId: '',
  ringNo: 0,
  mileage: 0,
  segmentType: '钢筋混凝土',
  installDate: ''
}

/** 里程区间筛选条件（环片二维筛选的第二维） */
export interface MileageRange {
  from: number | null
  to: number | null
}

export function inMileageRange(mileage: number, range: MileageRange): boolean {
  if (range.from !== null && mileage < range.from) return false
  if (range.to !== null && mileage > range.to) return false
  return true
}

/** 是否已留档（已换环），兼容 v2 及更早备份（无 status 字段即当前环） */
export function isArchivedRing(ring: Pick<Ring, 'status'> | undefined | null): boolean {
  return ring?.status === 'archived'
}

/** 环号 + 世代展示文案，如「第 118 环（第 2 代·当前环）」 */
export function ringGenerationLabel(ring: Ring): string {
  const generation = ring.generation && ring.generation > 1 ? `（第 ${ring.generation} 代）` : ''
  return `第 ${ring.ringNo} 环${generation}`
}
