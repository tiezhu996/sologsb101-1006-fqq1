/**
 * 换环单状态（Pinia）
 * 维护换环单列表、按环片/区间的换环溯源索引，封装登记 → 预览 → 确认的三步流程。
 * 注意：所有真正的落库与事务规则都在 utils/db.ts，store 只做响应式包装与错误归一。
 */
import { computed } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  cancelReplacement,
  confirmReplacement,
  previewReplacement,
  registerReplacement,
  updateReplacementDraft,
  type ReplacementRow
} from '@/utils/db'
import type { ReplacementDraft, ReplacementPreview, ReplacementStatus } from '@/types/replacement'

export type { ReplacementDraft, ReplacementPreview }

export const useReplacementStore = defineStore('replacement', () => {
  const replacementTable = useIdbTable<ReplacementRow>((database) => database.replacements, {
    sortByUpdatedAt: false
  })

  /** 换环单按登记时间倒序（进行中优先排前） */
  const replacements = computed<ReplacementRow[]>(() =>
    [...replacementTable.rows.value].sort((a, b) => {
      const rank: Record<ReplacementStatus, number> = { 失败: 0, 待确认: 1, 已完成: 2 }
      const statusDiff = rank[a.status] - rank[b.status]
      if (statusDiff !== 0) return statusDiff
      return b.createdAt - a.createdAt
    })
  )

  /** 原环 id → 换环单（含已完成/待确认/失败） */
  const byOldRing = computed(() => {
    const map = new Map<string, ReplacementRow>()
    replacements.value.forEach((row) => map.set(row.oldRingId, row))
    return map
  })

  /** 新环 id → 来源换环单 */
  const byNewRing = computed(() => {
    const map = new Map<string, ReplacementRow>()
    replacements.value.forEach((row) => map.set(row.newRingId, row))
    return map
  })

  /** 某环的进行中换环单（待确认/失败），无则 null */
  function pendingOfRing(ringId: string): ReplacementRow | null {
    return replacements.value.find((row) => row.oldRingId === ringId && row.status !== '已完成') ?? null
  }

  /** 某环的已完成换环单（新环用 predecessorRingId 关联，留档环用 replacedById） */
  function completedOfOldRing(ringId: string): ReplacementRow | null {
    return replacements.value.find((row) => row.oldRingId === ringId && row.status === '已完成') ?? null
  }

  const pendingCount = computed(
    () => replacements.value.filter((row) => row.status === '待确认').length
  )
  const failedCount = computed(() => replacements.value.filter((row) => row.status === '失败').length)
  const completedCount = computed(() => replacements.value.filter((row) => row.status === '已完成').length)

  function ofSection(sectionId: string): ReplacementRow[] {
    return replacements.value.filter((row) => row.sectionId === sectionId)
  }

  async function register(draft: ReplacementDraft): Promise<ReplacementRow> {
    return registerReplacement(draft)
  }

  async function updateDraft(id: string, patch: Partial<ReplacementDraft>): Promise<ReplacementRow> {
    return updateReplacementDraft(id, patch)
  }

  async function preview(id: string): Promise<ReplacementPreview> {
    return previewReplacement(id)
  }

  async function confirm(
    id: string,
    options: { confirmedBy?: string; allowScopeDrift?: boolean } = {}
  ): Promise<{ newRingId: string; executed: boolean }> {
    const result = await confirmReplacement(id, options)
    return { newRingId: result.newRingId, executed: result.executed }
  }

  async function cancel(id: string): Promise<void> {
    await cancelReplacement(id)
  }

  return {
    replacementTable,
    replacements,
    byOldRing,
    byNewRing,
    pendingCount,
    failedCount,
    completedCount,
    pendingOfRing,
    completedOfOldRing,
    ofSection,
    register,
    updateDraft,
    preview,
    confirm,
    cancel
  }
})
