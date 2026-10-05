/**
 * 换环单状态（Pinia）
 * 维护换环单列表、登记/编辑/作废与确认执行；确认逻辑全部走 utils/replacement 领域服务。
 */
import { computed } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, type ReplacementRow, type RingRow } from '@/utils/db'
import {
  confirmReplacement,
  findActiveReplacementOfRing,
  refreshOrderScope,
  snapshotRingScope,
  validateReplacementDraft
} from '@/utils/replacement'
import {
  ReplacementError,
  type ReplacementDraft,
  type ReplacementStatus
} from '@/types/replacement'
import { isArchivedRing } from '@/types/ring'

export const useReplacementStore = defineStore('replacement', () => {
  const replacementTable = useIdbTable<ReplacementRow>((database) => database.replacements, {
    sortByUpdatedAt: false
  })

  const orders = computed<ReplacementRow[]>(() =>
    [...replacementTable.rows.value].sort((a, b) => b.createdAt - a.createdAt)
  )

  const draftOrders = computed(() => orders.value.filter((order) => order.status === 'draft'))
  const failedOrders = computed(() => orders.value.filter((order) => order.status === 'failed'))
  const doneOrders = computed(() => orders.value.filter((order) => order.status === 'done'))

  const orderById = computed(() => new Map(orders.value.map((order) => [order.id, order])))

  /** 环 id → 挂着的待确认/失败换环单（已确认的不算占用） */
  const activeOrderMap = computed(() => {
    const map = new Map<string, ReplacementRow>()
    orders.value.forEach((order) => {
      if (order.status === 'draft' || order.status === 'failed') map.set(order.oldRingId, order)
    })
    return map
  })

  /** 某环号血缘链上的换环历史（含已留档各代） */
  function ordersOfRing(ringId: string): ReplacementRow[] {
    return orders.value
      .filter((order) => order.oldRingId === ringId || order.newRingId === ringId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  function ordersOfSection(ringIds: string[]): ReplacementRow[] {
    const set = new Set(ringIds)
    return orders.value.filter((order) => set.has(order.oldRingId))
  }

  function statusCount(status: ReplacementStatus): number {
    return orders.value.filter((order) => order.status === status).length
  }

  /**
   * 登记换环单：校验换环日期/原因/新环安装信息，固化受影响范围快照。
   * 只落换环单本身（draft），不动任何环片/裂缝数据。
   */
  async function registerReplacement(draft: ReplacementDraft, existingId?: string): Promise<ReplacementRow> {
    const oldRing = await db.rings.get(draft.oldRingId)
    if (!oldRing) throw new ReplacementError('NOT_FOUND', '被更换的原环不存在')
    if (isArchivedRing(oldRing)) {
      throw new ReplacementError('OLD_RING_NOT_CURRENT', '原环已留档，请对当前环登记换环')
    }
    const code = validateReplacementDraft(draft, oldRing)
    if (code) throw new ReplacementError(code, '换环登记信息不完整或不合法')

    // 同一环只允许一张活动换环单（编辑自身除外）
    const active = await findActiveReplacementOfRing(draft.oldRingId)
    if (active && active.id !== existingId) {
      throw new ReplacementError('RING_BUSY', '该环已有待确认的换环单')
    }

    const scope = await snapshotRingScope(draft.oldRingId)
    const now = Date.now()
    const payload = {
      oldRingId: draft.oldRingId,
      status: 'draft' as const,
      replaceDate: draft.replaceDate,
      reason: draft.reason.trim(),
      newSegmentType: draft.newSegmentType,
      newInstallDate: draft.newInstallDate,
      newMileage: draft.newMileage,
      installer: draft.installer?.trim() || undefined,
      remark: draft.remark?.trim() || undefined,
      scope
    }

    if (existingId) {
      const existing = await replacementTable.getById(existingId)
      if (!existing) throw new ReplacementError('NOT_FOUND', '换环单不存在')
      if (existing.status === 'done') throw new ReplacementError('NOT_DRAFT', '换环单已确认，不能修改')
      await db.replacements.put({
        ...existing,
        ...payload,
        // 失败单据重新保存：清掉失败标记，但保留累计尝试次数与 newRingId（重试幂等）
        status: 'draft',
        lastErrorCode: undefined,
        updatedAt: now
      })
      const row = await db.replacements.get(existingId)
      if (!row) throw new ReplacementError('NOT_FOUND', '换环单不存在')
      return row
    }

    return await replacementTable.create(payload, 'rep')
  }

  /** 确认：原环留档、新环建档；失败时单据与范围保留，可原样重试 */
  async function confirm(orderId: string): Promise<ReplacementRow> {
    return await confirmReplacement(orderId)
  }

  /** 重新预览：把范围快照刷新为现场（预览后数据有变化时用） */
  async function resnapshot(orderId: string): Promise<ReplacementRow> {
    return await refreshOrderScope(orderId)
  }

  /** 作废未确认的换环单（不动业务数据）；已确认不可作废 */
  async function discard(orderId: string): Promise<void> {
    const order = await replacementTable.getById(orderId)
    if (!order) return
    if (order.status === 'done') {
      throw new ReplacementError('NOT_DRAFT', '换环单已确认，不能作废；历史留档请在台账中查看')
    }
    await replacementTable.remove(orderId)
  }

  /** 新环安装信息预填（从原环带出里程/管片类型） */
  function draftFromRing(ring: RingRow): ReplacementDraft {
    return {
      oldRingId: ring.id,
      replaceDate: new Date().toISOString().slice(0, 10),
      reason: '',
      newSegmentType: ring.segmentType,
      newInstallDate: new Date().toISOString().slice(0, 10),
      newMileage: ring.mileage,
      installer: '',
      remark: ''
    }
  }

  return {
    replacementTable,
    orders,
    draftOrders,
    failedOrders,
    doneOrders,
    orderById,
    activeOrderMap,
    ordersOfRing,
    ordersOfSection,
    statusCount,
    registerReplacement,
    confirm,
    resnapshot,
    discard,
    draftFromRing
  }
})
