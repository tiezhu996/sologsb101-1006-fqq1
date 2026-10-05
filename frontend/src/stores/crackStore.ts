/**
 * 裂缝状态（Pinia）
 * 维护裂缝列表、部位/走向/状态筛选条件与统计派生值。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, deleteCrackCascade, readUiPrefs, writeUiPrefs, type CrackRow } from '@/utils/db'
import type { Crack, CrackDraft, CrackFilterState, CrackPosition, CrackDirection, CrackState } from '@/types/crack'
import { createEmptyCrackFilter, CRACK_DIRECTIONS, CRACK_POSITIONS, CRACK_STATES } from '@/types/crack'
import type { AdviceLevel } from '@/types/advice'
import { isArchivedRing, ringGenerationLabel, type Ring } from '@/types/ring'
import { useSectionStore } from '@/stores/sectionStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { formatMileage } from '@/types/section'
import type { Section } from '@/types/section'
import { round } from '@/utils/rate'
import { ReplacementError } from '@/types/replacement'

/** 裂缝行（附所属环片/区间与最新发展态势） */
export interface CrackEnriched {
  crack: Crack
  ring: Ring | null
  section: Section | null
  ringLabel: string
  sectionLabel: string
  rate: number
  level: AdviceLevel
  surveyCount: number
  /** 所属环是否已换环留档（只读历史） */
  archived: boolean
}

export const useCrackStore = defineStore('crack', () => {
  const crackTable = useIdbTable<CrackRow>((database) => database.cracks, { sortByUpdatedAt: false })
  const sectionStore = useSectionStore()
  const surveyStore = useSurveyStore()

  const filter = ref<CrackFilterState>(createEmptyCrackFilter())
  const selectedIds = ref<string[]>([])
  /** 速率分级页的「仅看预警」开关，跨页持久化到 localStorage */
  const onlyWarning = ref(readUiPrefs().trendOnlyWarning)

  /** 是否在列表中包含已换环历史裂缝（默认只看当前环，历史裂缝绝不与当前环混排统计） */
  const includeArchived = ref(false)

  const cracks = computed<CrackRow[]>(() =>
    [...crackTable.rows.value].sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
  )

  const enriched = computed<CrackEnriched[]>(() =>
    cracks.value.map((crack) => {
      const ring = sectionStore.ringById.get(crack.ringId) ?? null
      const section = sectionStore.sectionById.get(crack.sectionId) ?? null
      const archived = isArchivedRing(ring ?? undefined)
      const summary = surveyStore.summaryOf(crack.id)
      return {
        crack,
        ring,
        section,
        ringLabel: ring
          ? `${ringGenerationLabel(ring)}${archived ? '·已换环' : ''}`
          : '环片已删除',
        sectionLabel: section ? `${section.line} ${formatMileage(ring ? ring.mileage : section.startMileage)}` : '区间已删除',
        rate: summary ? summary.rate : 0,
        level: (summary ? summary.level : '一般') as AdviceLevel,
        surveyCount: summary ? summary.count : 0,
        archived
      }
    })
  )

  const filtered = computed<CrackEnriched[]>(() => {
    const text = filter.value.keyword.trim().toLowerCase()
    return enriched.value.filter((item) => {
      const { crack, ring } = item
      // 已换环历史默认不参与当前环台账；开关打开后以只读形式附带列出
      if (!includeArchived.value && item.archived) return false
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

  /** 当前环裂缝（所有统计、预警、平均口径只统计当前环，不含已换环历史） */
  const currentEnriched = computed(() => enriched.value.filter((item) => !item.archived))
  const currentCracks = computed<CrackRow[]>(() =>
    cracks.value.filter((crack) => !isArchivedRing(sectionStore.ringById.get(crack.ringId)))
  )
  /** 已换环历史裂缝 id 集合 */
  const archivedCrackIds = computed(
    () => new Set(enriched.value.filter((item) => item.archived).map((item) => item.crack.id))
  )

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

  /** 每个区间的裂缝数与预警数（仅当前环） */
  const sectionStats = computed<Record<string, { crackCount: number; warningCount: number }>>(() => {
    const stats: Record<string, { crackCount: number; warningCount: number }> = {}
    const warningSet = new Set(surveyStore.warningCrackIds)
    currentCracks.value.forEach((crack) => {
      if (archivedCrackIds.value.has(crack.id)) return
      const entry = stats[crack.sectionId] ?? { crackCount: 0, warningCount: 0 }
      entry.crackCount += 1
      if (warningSet.has(crack.id)) entry.warningCount += 1
      stats[crack.sectionId] = entry
    })
    return stats
  })

  /** 预警只计当前环裂缝；已换环历史裂缝的速率不混入当前预警 */
  const warningCrackIds = computed(() =>
    surveyStore.warningCrackIds.filter((crackId) => !archivedCrackIds.value.has(crackId))
  )

  const warningCount = computed(() => warningCrackIds.value.length)

  const warningPercent = computed(() =>
    currentCracks.value.length === 0 ? 0 : Math.round((warningCount.value / currentCracks.value.length) * 100)
  )

  const waitingCount = computed(() => stateCounts.value['待整治'])

  const averageWidth = computed(() => {
    if (currentCracks.value.length === 0) return 0
    const total = currentCracks.value.reduce((sum, crack) => sum + crack.widthMm, 0)
    return round(total / currentCracks.value.length, 2)
  })

  function patchFilter(patch: Partial<CrackFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyCrackFilter()
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
    const ring = sectionStore.ringById.get(draft.ringId)
    // 写入守卫：裂缝只能挂当前环；已换环只读、不能在历史环上续登裂缝
    if (!ring) throw new ReplacementError('NOT_FOUND', '所选环片不存在')
    if (isArchivedRing(ring)) {
      throw new ReplacementError('ARCHIVED_RING_READONLY', '该环已换环留档，新裂缝必须登记在当前环上')
    }
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
    if (existing) {
      const ring = sectionStore.ringById.get(existing.ringId)
      if (isArchivedRing(ring)) {
        throw new ReplacementError('ARCHIVED_RING_READONLY', '已换环历史裂缝为只读留档，不能修改')
      }
    }
    const next: Partial<CrackRow> = { ...patch }
    if (patch.code !== undefined) next.code = patch.code.trim()
    if (patch.widthMm !== undefined) next.widthMm = round(patch.widthMm, 2)
    if (patch.lengthMm !== undefined) next.lengthMm = Math.round(patch.lengthMm)
    if (patch.ringId !== undefined) {
      const target = sectionStore.ringById.get(patch.ringId)
      if (!target) throw new ReplacementError('NOT_FOUND', '目标环片不存在')
      if (isArchivedRing(target)) {
        throw new ReplacementError('ARCHIVED_RING_READONLY', '不能把裂缝改挂到已换环历史环片')
      }
      next.sectionId = target.sectionId
    }
    await crackTable.update(id, next)
  }

  async function removeCrack(id: string): Promise<void> {
    const existing = crackTable.rows.value.find((crack) => crack.id === id)
    if (existing) {
      const ring = sectionStore.ringById.get(existing.ringId)
      if (isArchivedRing(ring)) {
        throw new ReplacementError('ARCHIVED_RING_READONLY', '已换环历史裂缝必须随原环整体留档，不能删除')
      }
    }
    await deleteCrackCascade(id)
    selectedIds.value = selectedIds.value.filter((item) => item !== id)
  }

  /** 批量改状态（勾选后一次生效）；已换环历史裂缝跳过，不允许推进 */
  async function bulkSetState(ids: string[], state: CrackState): Promise<number> {
    if (ids.length === 0) return 0
    const writable = cracks.value.filter(
      (crack) => ids.includes(crack.id) && !isArchivedRing(sectionStore.ringById.get(crack.ringId))
    )
    if (writable.length === 0) return 0
    const patch = { state, updatedAt: Date.now() }
    await db.cracks.bulkPut(writable.map((crack) => ({ ...crack, ...patch })))
    selectedIds.value = []
    return writable.length
  }

  async function setState(id: string, state: CrackState): Promise<void> {
    const existing = crackTable.rows.value.find((crack) => crack.id === id)
    if (existing && isArchivedRing(sectionStore.ringById.get(existing.ringId))) {
      throw new ReplacementError('ARCHIVED_RING_READONLY', '已换环历史裂缝状态随原环留档，不能推进')
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
    enriched,
    currentEnriched,
    archivedCrackIds,
    filtered,
    includeArchived,
    filter,
    selectedIds,
    onlyWarning,
    stateCounts,
    positionCounts,
    directionCounts,
    sectionStats,
    warningCrackIds,
    warningCount,
    warningPercent,
    waitingCount,
    averageWidth,
    hasFilter,
    positionOptions: CRACK_POSITIONS,
    directionOptions: CRACK_DIRECTIONS,
    stateOptions: CRACK_STATES,
    patchFilter,
    resetFilter,
    setIncludeArchived: (value: boolean) => {
      includeArchived.value = value
    },
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
