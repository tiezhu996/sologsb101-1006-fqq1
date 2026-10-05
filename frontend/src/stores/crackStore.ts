/**
 * 裂缝状态（Pinia）
 * 维护裂缝列表、部位/走向/状态筛选条件与统计派生值。
 * v3：裂缝按所属环片生命周期分为当前裂缝（在役环）与历史裂缝（已换环留档环），
 * 默认台账/统计/预警只计当前裂缝；历史裂缝只读可查。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import { assertRingWritable, db, deleteCrackCascade, readUiPrefs, writeUiPrefs, type CrackRow } from '@/utils/db'
import type { Crack, CrackDraft, CrackFilterState, CrackPosition, CrackDirection, CrackState } from '@/types/crack'
import { createEmptyCrackFilter, CRACK_DIRECTIONS, CRACK_POSITIONS, CRACK_STATES } from '@/types/crack'
import type { AdviceLevel } from '@/types/advice'
import { isArchivedRing, ringDisplayLabel, type Ring } from '@/types/ring'
import { useSectionStore } from '@/stores/sectionStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { formatMileage } from '@/types/section'
import type { Section } from '@/types/section'
import { round } from '@/utils/rate'

/** 裂缝台账查看范围：当前在役环 / 已换环留档环 */
export type CrackScope = 'current' | 'archived'

/** 裂缝行（附所属环片/区间与最新发展态势） */
export interface CrackEnriched {
  crack: Crack
  ring: Ring | null
  section: Section | null
  ringLabel: string
  sectionLabel: string
  /** 所属环是否已换环留档（历史裂缝只读） */
  archived: boolean
  rate: number
  level: AdviceLevel
  surveyCount: number
}

export const useCrackStore = defineStore('crack', () => {
  const crackTable = useIdbTable<CrackRow>((database) => database.cracks, { sortByUpdatedAt: false })
  const sectionStore = useSectionStore()
  const surveyStore = useSurveyStore()

  const filter = ref<CrackFilterState>(createEmptyCrackFilter())
  const selectedIds = ref<string[]>([])
  /** 速率分级页的「仅看预警」开关，跨页持久化到 localStorage */
  const onlyWarning = ref(readUiPrefs().trendOnlyWarning)
  /** 当前裂缝 / 历史裂缝范围开关，默认当前 */
  const scope = ref<CrackScope>('current')

  const cracks = computed<CrackRow[]>(() =>
    [...crackTable.rows.value].sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
  )

  /** 挂在在役环上的裂缝（当前台账口径） */
  const currentCracks = computed<CrackRow[]>(() =>
    cracks.value.filter((crack) => !sectionStore.isRingArchived(crack.ringId))
  )

  /** 挂在已换环留档环上的裂缝（换环前历史） */
  const archivedCracks = computed<CrackRow[]>(() =>
    cracks.value.filter((crack) => sectionStore.isRingArchived(crack.ringId))
  )

  const scopedCracks = computed<CrackRow[]>(() =>
    scope.value === 'archived' ? archivedCracks.value : currentCracks.value
  )

  const enriched = computed<CrackEnriched[]>(() =>
    scopedCracks.value.map((crack) => {
      const ring = sectionStore.ringById.get(crack.ringId) ?? null
      const section = sectionStore.sectionById.get(crack.sectionId) ?? null
      const summary = surveyStore.summaryOf(crack.id)
      return {
        crack,
        ring,
        section,
        ringLabel: ring ? ringDisplayLabel(ring) : '环片已删除',
        sectionLabel: section ? `${section.line} ${formatMileage(ring ? ring.mileage : section.startMileage)}` : '区间已删除',
        archived: ring ? isArchivedRing(ring) : false,
        rate: summary ? summary.rate : 0,
        level: (summary ? summary.level : '一般') as AdviceLevel,
        surveyCount: summary ? summary.count : 0
      }
    })
  )

  const filtered = computed<CrackEnriched[]>(() => {
    const text = filter.value.keyword.trim().toLowerCase()
    return enriched.value.filter((item) => {
      const { crack, ring } = item
      if (filter.value.sectionId && crack.sectionId !== filter.value.sectionId) return false
      if (filter.value.positions.length > 0 && !filter.value.positions.includes(crack.position)) return false
      if (filter.value.directions.length > 0 && !filter.value.directions.includes(crack.direction)) return false
      if (filter.value.states.length > 0 && !filter.value.states.includes(crack.state)) return false
      if (filter.value.lines.length > 0) {
        const line = item.section ? item.section.line : ''
        if (!filter.value.lines.includes(line)) return false
      }
      if (text.length === 0) return true
      return (
        crack.code.toLowerCase().includes(text) ||
        item.ringLabel.toLowerCase().includes(text) ||
        item.sectionLabel.toLowerCase().includes(text) ||
        (ring ? String(ring.ringNo).includes(text) : false)
      )
    })
  })

  /** 台账统计始终只统计当前在役环裂缝（历史裂缝不计入工单口径） */
  const stateCounts = computed<Record<CrackState, number>>(() => {
    const counts: Record<CrackState, number> = { 观察: 0, 待整治: 0, 已整治: 0 }
    currentCracks.value.forEach((crack) => {
      counts[crack.state] += 1
    })
    return counts
  })

  const positionCounts = computed<Record<CrackPosition, number>>(() => {
    const counts: Record<CrackPosition, number> = { 拱顶: 0, 侧墙: 0, 道床: 0 }
    currentCracks.value.forEach((crack) => {
      counts[crack.position] += 1
    })
    return counts
  })

  const directionCounts = computed<Record<CrackDirection, number>>(() => {
    const counts: Record<CrackDirection, number> = { 纵向: 0, 环向: 0, 斜向: 0 }
    currentCracks.value.forEach((crack) => {
      counts[crack.direction] += 1
    })
    return counts
  })

  /** 每个区间的当前裂缝数与预警数 */
  const sectionStats = computed<Record<string, { crackCount: number; warningCount: number }>>(() => {
    const stats: Record<string, { crackCount: number; warningCount: number }> = {}
    const warningSet = new Set(surveyStore.warningCrackIds)
    currentCracks.value.forEach((crack) => {
      const entry = stats[crack.sectionId] ?? { crackCount: 0, warningCount: 0 }
      entry.crackCount += 1
      if (warningSet.has(crack.id)) entry.warningCount += 1
      stats[crack.sectionId] = entry
    })
    return stats
  })

  const warningCount = computed(() => surveyStore.warningCrackIds.length)

  const warningPercent = computed(() =>
    currentCracks.value.length === 0 ? 0 : Math.round((warningCount.value / currentCracks.value.length) * 100)
  )

  const waitingCount = computed(() => stateCounts.value['待整治'])

  const averageWidth = computed(() => {
    if (currentCracks.value.length === 0) return 0
    const total = currentCracks.value.reduce((sum, crack) => sum + crack.widthMm, 0)
    return round(total / currentCracks.value.length, 2)
  })

  /** 历史裂缝数量（页头徽标用） */
  const archivedCount = computed(() => archivedCracks.value.length)

  function patchFilter(patch: Partial<CrackFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyCrackFilter()
  }

  function setScope(value: CrackScope): void {
    scope.value = value
    selectedIds.value = []
  }

  const hasFilter = computed(() => {
    const current = filter.value
    return (
      current.keyword.trim().length > 0 ||
      current.lines.length > 0 ||
      current.positions.length > 0 ||
      current.directions.length > 0 ||
      current.states.length > 0 ||
      current.sectionId.length > 0
    )
  })

  async function createCrack(draft: CrackDraft): Promise<CrackRow> {
    // 门禁：新裂缝只能挂在在役环上，防止错挂到留档环
    const ring = await assertRingWritable(draft.ringId)
    const row = (await crackTable.create(
      {
        ringId: draft.ringId,
        sectionId: ring.sectionId,
        code: draft.code.trim() || `SL-${Date.now().toString().slice(-5)}`,
        position: draft.position,
        direction: draft.direction,
        widthMm: round(draft.widthMm, 2),
        lengthMm: Math.round(draft.lengthMm),
        state: draft.state
      },
      'crack'
    )) as CrackRow
    return row
  }

  async function updateCrack(id: string, patch: Partial<CrackDraft>): Promise<void> {
    const existing = crackTable.rows.value.find((crack) => crack.id === id)
    if (existing && sectionStore.isRingArchived(existing.ringId)) {
      throw new Error('该裂缝属于换环前留档环，历史记录只读')
    }
    if (patch.ringId && sectionStore.isRingArchived(patch.ringId)) {
      throw new Error('不能把裂缝挂到换环前留档环上')
    }
    const next: Partial<CrackRow> = { ...patch }
    if (patch.code !== undefined) next.code = patch.code.trim()
    if (patch.widthMm !== undefined) next.widthMm = round(patch.widthMm, 2)
    if (patch.lengthMm !== undefined) next.lengthMm = Math.round(patch.lengthMm)
    if (patch.ringId !== undefined) {
      const ring = sectionStore.ringById.get(patch.ringId)
      if (ring) next.sectionId = ring.sectionId
    }
    await crackTable.update(id, next)
  }

  async function removeCrack(id: string): Promise<void> {
    const existing = crackTable.rows.value.find((crack) => crack.id === id)
    if (existing && sectionStore.isRingArchived(existing.ringId)) {
      throw new Error('该裂缝属于换环前留档环，历史记录不能删除')
    }
    await deleteCrackCascade(id)
    selectedIds.value = selectedIds.value.filter((item) => item !== id)
  }

  /** 批量改状态（勾选后一次生效）；历史裂缝一律排除 */
  async function bulkSetState(ids: string[], state: CrackState): Promise<void> {
    if (ids.length === 0) return
    const writable = cracks.value.filter(
      (crack) => ids.includes(crack.id) && !sectionStore.isRingArchived(crack.ringId)
    )
    if (writable.length === 0) throw new Error('所选裂缝均为换环前历史记录，不能修改状态')
    const patch = { state, updatedAt: Date.now() }
    await db.cracks.bulkPut(writable.map((crack) => ({ ...crack, ...patch })))
    selectedIds.value = []
  }

  async function setState(id: string, state: CrackState): Promise<void> {
    const existing = crackTable.rows.value.find((crack) => crack.id === id)
    if (existing && sectionStore.isRingArchived(existing.ringId)) {
      throw new Error('该裂缝属于换环前留档环，历史记录只读')
    }
    await crackTable.update(id, { state })
  }

  function toggleSelect(id: string, checked: boolean): void {
    selectedIds.value = checked
      ? Array.from(new Set([...selectedIds.value, id]))
      : selectedIds.value.filter((item) => item !== id)
  }

  function setSelectedIds(ids: string[]): void {
    selectedIds.value = [...ids]
  }

  function clearSelection(): void {
    selectedIds.value = []
  }

  function setOnlyWarning(value: boolean): void {
    onlyWarning.value = value
    writeUiPrefs({ ...readUiPrefs(), trendOnlyWarning: value })
  }

  return {
    crackTable,
    cracks,
    currentCracks,
    archivedCracks,
    enriched,
    filtered,
    filter,
    selectedIds,
    onlyWarning,
    scope,
    stateCounts,
    positionCounts,
    directionCounts,
    sectionStats,
    warningCount,
    warningPercent,
    waitingCount,
    averageWidth,
    archivedCount,
    hasFilter,
    positionOptions: CRACK_POSITIONS,
    directionOptions: CRACK_DIRECTIONS,
    stateOptions: CRACK_STATES,
    patchFilter,
    resetFilter,
    setScope,
    createCrack,
    updateCrack,
    removeCrack,
    bulkSetState,
    setState,
    toggleSelect,
    setSelectedIds,
    clearSelection,
    setOnlyWarning
  }
})
