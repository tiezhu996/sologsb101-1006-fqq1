/**
 * 区间与环片状态（Pinia）
 * 维护区间/环片列表、当前选中区间与里程筛选条件。
 * v3：区分「当前环（在役）」与「已换环历史（留档）」，换环后的新环沿用原环号从零建档。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  db,
  deleteRingCascade,
  deleteSectionCascade,
  readUiPrefs,
  writeUiPrefs,
  type RingRow,
  type SectionRow
} from '@/utils/db'
import {
  STRUCTURE_TYPES,
  formatMileage,
  sectionSpan,
  type Section,
  type SectionDraft,
  type StructureType
} from '@/types/section'
import { isArchivedRing, ringDisplayLabel, SEGMENT_TYPES, type Ring, type RingDraft } from '@/types/ring'
import { useReplacementStore } from '@/stores/replacementStore'

export interface RingEnriched {
  ring: Ring
  section: Section | null
  /** 环号展示文案（留档环带「已换环」后缀） */
  label: string
  mileageText: string
  /** 是否为换环留档环 */
  archived: boolean
  /** 关联的进行中换环单（待确认/失败），用于在台账上提示「待换环」 */
  pendingReplacementId: string | null
}

/** 台账环片范围：当前在役环 / 已换环留档环 */
export type RingScope = 'current' | 'archived'

export const useSectionStore = defineStore('section', () => {
  const sectionTable = useIdbTable<SectionRow>((database) => database.sections, { sortByUpdatedAt: false })
  const ringTable = useIdbTable<RingRow>((database) => database.rings, { sortByUpdatedAt: false })
  const replacementStore = useReplacementStore()

  const prefs = readUiPrefs()
  const currentSectionId = ref<string | null>(prefs.lastSectionId)
  const keyword = ref('')
  const structureTypes = ref<StructureType[]>([])
  const mileageFrom = ref<number | null>(null)
  const mileageTo = ref<number | null>(null)
  /** 环片明细范围，默认只看当前在役环；切到 archived 查看已换环历史 */
  const ringScope = ref<RingScope>('current')

  /* ------------------------------ 区间 ------------------------------ */

  const sections = computed<SectionRow[]>(() =>
    [...sectionTable.rows.value].sort((a, b) => {
      const lineDiff = a.line.localeCompare(b.line, 'zh-Hans-CN')
      if (lineDiff !== 0) return lineDiff
      return a.startMileage - b.startMileage
    })
  )

  const filteredSections = computed<SectionRow[]>(() => {
    const text = keyword.value.trim().toLowerCase()
    return sections.value.filter((section) => {
      if (structureTypes.value.length > 0 && !structureTypes.value.includes(section.structureType)) return false
      if (text.length === 0) return true
      return (
        section.line.toLowerCase().includes(text) ||
        formatMileage(section.startMileage).toLowerCase().includes(text) ||
        formatMileage(section.endMileage).toLowerCase().includes(text)
      )
    })
  })

  const currentSection = computed<SectionRow | null>(
    () => sections.value.find((section) => section.id === currentSectionId.value) ?? null
  )

  const lineOptions = computed(() =>
    Array.from(new Set(sections.value.map((section) => section.line))).map((line) => ({ label: line, value: line }))
  )

  async function selectSection(id: string | null): Promise<void> {
    currentSectionId.value = id
    writeUiPrefs({ ...readUiPrefs(), lastSectionId: id })
    await Promise.resolve()
  }

  async function createSection(draft: SectionDraft): Promise<SectionRow> {
    const row = (await sectionTable.create(
      {
        line: draft.line.trim(),
        startMileage: Math.max(0, Math.round(draft.startMileage)),
        endMileage: Math.max(0, Math.round(draft.endMileage)),
        structureType: draft.structureType,
        ringCount: Math.max(0, Math.round(draft.ringCount))
      },
      'sec'
    )) as SectionRow
    await selectSection(row.id)
    return row
  }

  async function updateSection(id: string, patch: Partial<SectionDraft>): Promise<void> {
    const next: Partial<SectionRow> = { ...patch }
    if (patch.line !== undefined) next.line = patch.line.trim()
    if (patch.startMileage !== undefined) next.startMileage = Math.max(0, Math.round(patch.startMileage))
    if (patch.endMileage !== undefined) next.endMileage = Math.max(0, Math.round(patch.endMileage))
    if (patch.ringCount !== undefined) next.ringCount = Math.max(0, Math.round(patch.ringCount))
    await sectionTable.update(id, next)
  }

  async function removeSection(id: string): Promise<void> {
    await deleteSectionCascade(id)
    if (currentSectionId.value === id) {
      const fallback = sections.value.find((section) => section.id !== id) ?? null
      await selectSection(fallback ? fallback.id : null)
    }
  }

  /* ------------------------------ 环片 ------------------------------ */

  const rings = computed<RingRow[]>(() =>
    [...ringTable.rows.value].sort((a, b) => a.mileage - b.mileage || a.ringNo - b.ringNo)
  )

  /** 当前在役环（裂缝台账、复测、预警的默认口径） */
  const currentRings = computed<RingRow[]>(() => rings.value.filter((ring) => !isArchivedRing(ring)))

  /** 已换环留档环（换环前裂缝/复测/建议仍按这些环可查） */
  const archivedRings = computed<RingRow[]>(() => rings.value.filter((ring) => isArchivedRing(ring)))

  const ringsOfSection = computed<RingRow[]>(() =>
    currentSectionId.value === null ? rings.value : rings.value.filter((ring) => ring.sectionId === currentSectionId.value)
  )

  const enrichedRings = computed<RingEnriched[]>(() =>
    ringsOfSection.value
      .filter((ring) => (ringScope.value === 'archived' ? isArchivedRing(ring) : !isArchivedRing(ring)))
      .map((ring) => ({
        ring,
        section: sections.value.find((section) => section.id === ring.sectionId) ?? null,
        label: ringDisplayLabel(ring),
        mileageText: formatMileage(ring.mileage),
        archived: isArchivedRing(ring),
        pendingReplacementId: replacementStore.pendingOfRing(ring.id)?.id ?? null
      }))
  )

  const filteredRings = computed<RingEnriched[]>(() => {
    const text = keyword.value.trim().toLowerCase()
    return enrichedRings.value.filter((item) => {
      const { ring } = item
      if (mileageFrom.value !== null && ring.mileage < mileageFrom.value) return false
      if (mileageTo.value !== null && ring.mileage > mileageTo.value) return false
      if (text.length === 0) return true
      return (
        String(ring.ringNo).includes(text) ||
        ring.segmentType.toLowerCase().includes(text) ||
        item.mileageText.toLowerCase().includes(text)
      )
    })
  })

  function setMileageRange(from: number | null, to: number | null): void {
    mileageFrom.value = from
    mileageTo.value = to
  }

  function setStructureTypes(values: StructureType[]): void {
    structureTypes.value = values
  }

  function setRingScope(scope: RingScope): void {
    ringScope.value = scope
  }

  function resetFilter(): void {
    keyword.value = ''
    structureTypes.value = []
    mileageFrom.value = null
    mileageTo.value = null
  }

  async function createRing(draft: RingDraft): Promise<RingRow> {
    const row = (await ringTable.create(
      {
        sectionId: draft.sectionId || currentSectionId.value || '',
        ringNo: Math.max(0, Math.round(draft.ringNo)),
        mileage: Math.max(0, Math.round(draft.mileage)),
        segmentType: draft.segmentType,
        installDate: draft.installDate,
        lifecycle: 'current'
      },
      'ring'
    )) as RingRow
    return row
  }

  async function updateRing(id: string, patch: Partial<RingDraft>): Promise<void> {
    const existing = await db.rings.get(id)
    if (existing && isArchivedRing(existing)) {
      throw new Error('该环为换环前留档环，环片里程信息只读')
    }
    const next: Partial<RingRow> = { ...patch }
    if (patch.ringNo !== undefined) next.ringNo = Math.max(0, Math.round(patch.ringNo))
    if (patch.mileage !== undefined) next.mileage = Math.max(0, Math.round(patch.mileage))
    await ringTable.update(id, next)
  }

  async function removeRing(id: string): Promise<void> {
    await deleteRingCascade(id)
  }

  /** 区间跨度合计（页头展示） */
  const totalSpan = computed(() => sections.value.reduce((sum, section) => sum + sectionSpan(section), 0))

  /** 供其它 store 复用的索引（全部环，含留档） */
  const sectionById = computed(() => new Map(sections.value.map((section) => [section.id, section])))
  const ringById = computed(() => new Map(rings.value.map((ring) => [ring.id, ring])))

  /** 环片是否已留档（找不到环按非留档处理，由具体写入门禁再拦截） */
  function isRingArchived(ringId: string): boolean {
    const ring = ringById.value.get(ringId)
    return ring ? isArchivedRing(ring) : false
  }

  /** 裂缝 id → 所属环是否留档（供复测/建议页判断历史只读） */
  function crackRingArchived(crack: { ringId: string } | undefined | null): boolean {
    if (!crack) return false
    return isRingArchived(crack.ringId)
  }

  return {
    sectionTable,
    ringTable,
    sections,
    filteredSections,
    rings,
    currentRings,
    archivedRings,
    ringsOfSection,
    enrichedRings,
    filteredRings,
    currentSectionId,
    currentSection,
    lineOptions,
    keyword,
    structureTypes,
    mileageFrom,
    mileageTo,
    ringScope,
    structureTypeOptions: STRUCTURE_TYPES,
    segmentTypeOptions: SEGMENT_TYPES,
    totalSpan,
    sectionById,
    ringById,
    selectSection,
    createSection,
    updateSection,
    removeSection,
    createRing,
    updateRing,
    removeRing,
    setMileageRange,
    setStructureTypes,
    setRingScope,
    resetFilter,
    isRingArchived,
    crackRingArchived,
    /** 直连 Dexie 供页面做单条查询 */
    getRing: (id: string) => db.rings.get(id)
  }
})
