/** 环片：区间内一环管片，裂缝的最小归属单元 */
export type SegmentType = '钢筋混凝土' | '铸铁' | '钢管片'

/**
 * 环片生命周期：
 * - current：在役环片（新装环或从未换环的环片），裂缝台账、复测、预警默认只统计它
 * - archived：大修换环后整体留档的原环，其裂缝/复测/建议仍按原环片可查，但不参与当前业务
 */
export type RingLifecycle = 'current' | 'archived'

export interface Ring {
  id: string
  sectionId: string
  /** 环号（换环后新环沿用原环号，因此同环号可能对应一在役环 + 若干留档环） */
  ringNo: number
  /** 里程（m） */
  mileage: number
  segmentType: SegmentType
  /** 安装日期 YYYY-MM-DD */
  installDate: string
  /** 生命周期，历史行无此字段时按在役处理 */
  lifecycle?: RingLifecycle
  /** 已完成换环单 id（仅留档原环有值，指向把它换下来的换环单） */
  replacedById?: string
  /** 换环施工日期 YYYY-MM-DD（仅留档原环有值） */
  replacedDate?: string
  /** 换环后接管同环号的新环 id（仅留档原环有值） */
  successorRingId?: string
  /** 新环专用：来源换环单 id（从零建档的新环有值，普通录入环为空） */
  replacementId?: string
  /** 新环专用：被替换的原环 id */
  predecessorRingId?: string
  /** 留档时间（仅留档原环有值） */
  archivedAt?: number
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

/** 取环片生命周期，缺省视为在役 */
export function ringLifecycleOf(ring: Pick<Ring, 'lifecycle'> | undefined | null): RingLifecycle {
  return ring?.lifecycle === 'archived' ? 'archived' : 'current'
}

export function isArchivedRing(ring: Pick<Ring, 'lifecycle'> | undefined | null): boolean {
  return ringLifecycleOf(ring) === 'archived'
}

/** 环号展示文案：留档环追加「已换环」后缀 */
export function ringDisplayLabel(ring: Pick<Ring, 'ringNo' | 'lifecycle'>): string {
  return isArchivedRing(ring) ? `第 ${ring.ringNo} 环（已换环）` : `第 ${ring.ringNo} 环`
}
