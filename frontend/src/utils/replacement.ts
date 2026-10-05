/**
 * 换环领域服务：登记校验、受影响范围预览、范围指纹、确认写入（原环留档 / 新环建档）。
 *
 * 不变量：
 * 1. 未确认（draft/failed）不改动任何业务环片；确认在单事务内完成，失败整体回滚；
 * 2. 确认时只重读并写入原环自身的数据；检测到裂缝跨环/跨区间、环号冲突、范围漂移一律拒绝；
 * 3. 失败保留换环单与已确认范围快照，重试凭 newRingId / 血缘链幂等，不重复建环；
 * 4. 已留档环（archived）只读：裂缝、复测、建议均不可再写。
 */
import {
  db,
  type AdviceRow,
  type CrackRow,
  type ReplacementRow,
  type RingRow,
  type SurveyRow
} from '@/utils/db'
import {
  ReplacementError,
  type Replacement,
  type ReplacementDraft,
  type ReplacementErrorCode,
  type ReplacementScope
} from '@/types/replacement'
import { isArchivedRing, type Ring } from '@/types/ring'
import { daysBetween } from '@/utils/rate'

/* ------------------------------ 基础校验 ------------------------------ */

/** 校验登记内容：换环日期、原因、新环安装信息缺一不可，日期顺序必须合法 */
export function validateReplacementDraft(draft: ReplacementDraft, oldRing: Ring): ReplacementErrorCode | null {
  if (!draft.replaceDate || !draft.newInstallDate) return 'MISSING_DATE'
  if (!draft.reason.trim()) return 'MISSING_REASON'
  if (!draft.newSegmentType) return 'MISSING_INSTALL_INFO'
  // 原环安装日期 → 新环安装日期 → 换环日期，顺序不合法不允许写入
  if (oldRing.installDate) {
    if (draft.newInstallDate < oldRing.installDate || draft.replaceDate < oldRing.installDate) {
      return 'DATE_ORDER_INVALID'
    }
  }
  if (draft.newInstallDate > draft.replaceDate) return 'DATE_ORDER_INVALID'
  if (draft.newMileage !== undefined && (!Number.isFinite(draft.newMileage) || draft.newMileage < 0)) {
    return 'MISSING_INSTALL_INFO'
  }
  return null
}

/* ------------------------------ 范围快照 ------------------------------ */

/** 读取某环当前的全部受影响对象（裂缝 → 复测 → 建议） */
export async function readRingScope(ringId: string): Promise<{
  cracks: CrackRow[]
  surveys: SurveyRow[]
  advices: AdviceRow[]
}> {
  const cracks = await db.cracks.where('ringId').equals(ringId).toArray()
  const crackIds = cracks.map((crack) => crack.id)
  const [surveys, advices] = crackIds.length === 0
    ? [[], []]
    : await Promise.all([
        db.surveys.where('crackId').anyOf(crackIds).toArray(),
        db.advices.where('crackId').anyOf(crackIds).toArray()
      ])
  return { cracks, surveys, advices }
}

/** 按 id 排序后拼接指纹，保证两次计算顺序一致 */
export function scopeFingerprint(crackIds: string[], surveyIds: string[], adviceIds: string[]): string {
  const sorted = (ids: string[]): string[] => [...ids].sort((a, b) => a.localeCompare(b))
  return [sorted(crackIds).join('|'), sorted(surveyIds).join('|'), sorted(adviceIds).join('|')].join('##')
}

/** 现场重读范围并生成快照（登记预览时固化到换环单） */
export async function snapshotRingScope(ringId: string): Promise<ReplacementScope> {
  const { cracks, surveys, advices } = await readRingScope(ringId)
  const crackIds = cracks.map((crack) => crack.id)
  const surveyIds = surveys.map((survey) => survey.id)
  const adviceIds = advices.map((advice) => advice.id)
  return {
    crackIds,
    surveyIds,
    adviceIds,
    fingerprint: scopeFingerprint(crackIds, surveyIds, adviceIds),
    crackCount: crackIds.length,
    surveyCount: surveyIds.length,
    adviceCount: adviceIds.length,
    previewedAt: Date.now()
  }
}

/* ------------------------------ 写入守卫 ------------------------------ */

/** 已换环（留档）只读守卫：裂缝/复测/建议的新增、编辑、删除前调用 */
export function assertCurrentRingWritable(ring: Ring | null | undefined): void {
  if (!ring) throw new ReplacementError('NOT_FOUND', '环片不存在或已被删除')
  if (isArchivedRing(ring)) {
    throw new ReplacementError('ARCHIVED_RING_READONLY', '已换环整体留档为只读历史，不能写入裂缝、复测或建议')
  }
}

/** 该环当前是否挂着待确认/失败待重试的换环单（挂单期间环片本身禁删禁改） */
export async function findActiveReplacementOfRing(ringId: string): Promise<ReplacementRow | undefined> {
  const list = await db.replacements.where('oldRingId').equals(ringId).toArray()
  return list.find((item) => item.status === 'draft' || item.status === 'failed')
}

/* ------------------------------ 确认执行 ------------------------------ */

/**
 * 确认换环单：原环整体留档（archived），新环沿用原环号从零建档。
 * - draft / failed 可执行；已确认直接返回（幂等）
 * - 单事务提交，任何守卫不通过都整体回滚，换环单保留、范围不丢
 * - 重试时复用单据 newRingId 或接管遗留新环，绝不重复建环
 */
export async function confirmReplacement(orderId: string): Promise<ReplacementRow> {
  const order = await db.replacements.get(orderId)
  if (!order) throw new ReplacementError('NOT_FOUND', '换环单不存在')
  if (order.status === 'done') return order
  if (order.status !== 'draft' && order.status !== 'failed') {
    throw new ReplacementError('NOT_DRAFT', '换环单不是待确认状态')
  }

  try {
    const result = await db.transaction(
      'rw',
      [db.replacements, db.rings, db.cracks, db.surveys, db.advices],
      async () => {
        // 事务内重读，避免登记后被并发改动
        const txOrder = await db.replacements.get(orderId)
        if (!txOrder) throw new ReplacementError('NOT_FOUND', '换环单不存在')
        if (txOrder.status === 'done') return txOrder

        const oldRing = await db.rings.get(txOrder.oldRingId)
        if (!oldRing) throw new ReplacementError('NOT_FOUND', '原环不存在')

        // 幂等恢复：上次失败时新环可能已建档。只认本单据创建的新环，不能借用别的换环单结果
        let newRing = txOrder.newRingId ? await db.rings.get(txOrder.newRingId) : undefined
        if (newRing && newRing.replacementId !== txOrder.id) newRing = undefined
        if (!newRing) {
          const lineage = await db.rings.where('lineageId').equals(oldRing.lineageId ?? oldRing.id).toArray()
          newRing = lineage.find(
            (ring) =>
              ring.status === 'current' &&
              ring.ringNo === oldRing.ringNo &&
              ring.id !== oldRing.id &&
              ring.replacementId === txOrder.id
          )
        }

        if (oldRing.status === 'archived' && newRing && newRing.replacementId === txOrder.id) {
          // 原环已留档且新环确为本单据所建：上次仅差单据收尾，幂等完成
          const doneOrder: ReplacementRow = {
            ...txOrder,
            status: 'done',
            newRingId: newRing.id,
            lastErrorCode: undefined,
            confirmedAt: txOrder.confirmedAt ?? Date.now(),
            updatedAt: Date.now()
          }
          await db.replacements.put(doneOrder)
          return doneOrder
        }
        if (isArchivedRing(oldRing)) {
          // 原环已被别的换环单留档，本单据不能接管或再建一环
          throw new ReplacementError('OLD_RING_NOT_CURRENT', '原环已留档，不能再次换环')
        }

        // 守卫 1：环片必须仍是当前环
        if (oldRing.status !== 'current') {
          throw new ReplacementError('OLD_RING_NOT_CURRENT', '原环已留档，不能再次换环')
        }

        // 守卫 2：跨环/跨区间——重读裂缝，每条必须属于原环且与原环同区间
        const liveCracks = await db.cracks.where('ringId').equals(oldRing.id).toArray()
        const crossRing = liveCracks.some((crack) => crack.ringId !== oldRing.id)
        const crossSection = liveCracks.some((crack) => !!crack.sectionId && crack.sectionId !== oldRing.sectionId)
        if (crossRing) throw new ReplacementError('CROSS_SECTION_RING', '存在不归属本原环的裂缝，已阻止换环')
        if (crossSection) throw new ReplacementError('CROSS_SECTION_RING', '裂缝归属区间与原环不一致，已阻止换环')

        // 守卫 3：范围漂移——预览后新增/删除过裂缝、复测或建议则要求重新预览
        const liveScope = await snapshotRingScope(oldRing.id)
        if (txOrder.scope && liveScope.fingerprint !== txOrder.scope.fingerprint) {
          throw new ReplacementError('SCOPE_DRIFT', '受影响范围与预览时不一致，请重新预览')
        }
        if (!txOrder.scope) {
          throw new ReplacementError('SCOPE_DRIFT', '换环单尚未固化预览范围，请重新预览')
        }

        // 守卫 4：安装信息与日期再校验
        const invalid = validateReplacementDraft(txOrder, oldRing)
        if (invalid) throw new ReplacementError(invalid, '换环登记信息不完整或不合法')

        // 守卫 5：同区间当前环环号唯一（排除血缘链自身）
        const sameNoRings = await db.rings
          .where('sectionId')
          .equals(oldRing.sectionId)
          .filter((ring) => ring.ringNo === oldRing.ringNo && ring.status === 'current' && ring.id !== oldRing.id)
          .toArray()
        if (sameNoRings.length > 0 && !newRing) {
          throw new ReplacementError('RING_NO_CONFLICT', '同区间已存在同环号的当前环')
        }

        const now = Date.now()

        // 新环从零建档（沿用原环号，世代 +1，共用血缘链）
        if (!newRing) {
          newRing = {
            id: `ring_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
            sectionId: oldRing.sectionId,
            ringNo: oldRing.ringNo,
            mileage: typeof txOrder.newMileage === 'number' ? txOrder.newMileage : oldRing.mileage,
            segmentType: txOrder.newSegmentType,
            installDate: txOrder.newInstallDate,
            status: 'current',
            generation: (oldRing.generation ?? 1) + 1,
            lineageId: oldRing.lineageId ?? oldRing.id,
            previousRingId: oldRing.id,
            replacementId: txOrder.id,
            createdAt: now,
            updatedAt: now
          }
          await db.rings.put(newRing)
        }

        // 原环整体留档：裂缝、复测、建议一律不动，继续按原环片 id 查询
        const archivedRing: RingRow = {
          ...oldRing,
          status: 'archived',
          replacedById: txOrder.id,
          replacedDate: txOrder.replaceDate,
          updatedAt: now
        }
        await db.rings.put(archivedRing)

        const doneOrder: ReplacementRow = {
          ...txOrder,
          status: 'done',
          newRingId: newRing.id,
          scope: { ...txOrder.scope, ...liveScope },
          lastErrorCode: undefined,
          confirmedAt: now,
          updatedAt: now
        }
        await db.replacements.put(doneOrder)
        return doneOrder
      }
    )
    return result
  } catch (error) {
    // 事务已回滚：业务表未改动；仅把单据置为失败并保留范围，供幂等重试
    await markReplacementFailed(orderId, error)
    throw error
  }
}

/** 记录失败：保留换环单与已确认范围，attempts +1，不重复建环 */
async function markReplacementFailed(orderId: string, error: unknown): Promise<void> {
  const current = await db.replacements.get(orderId)
  if (!current || current.status === 'done') return
  const code = error instanceof ReplacementError ? error.code : 'NOT_FOUND'
  await db.replacements.update(orderId, {
    status: 'failed',
    attempts: (current.attempts ?? 0) + 1,
    lastErrorCode: code,
    updatedAt: Date.now()
  })
}

/** 把范围刷新为当前现场（用户在确认前手动「重新预览」） */
export async function refreshOrderScope(orderId: string): Promise<ReplacementRow> {
  const order = await db.replacements.get(orderId)
  if (!order) throw new ReplacementError('NOT_FOUND', '换环单不存在')
  if (order.status === 'done') throw new ReplacementError('NOT_DRAFT', '换环单已确认')
  const scope = await snapshotRingScope(order.oldRingId)
  await db.replacements.update(order.id, { scope, updatedAt: Date.now() })
  const updated = await db.replacements.get(order.id)
  if (!updated) throw new ReplacementError('NOT_FOUND', '换环单不存在')
  return updated
}

/* ------------------------------ 展示辅助 ------------------------------ */

/** 预览汇总：把范围快照与现场对象拼装成确认页可直接渲染的结构 */
export interface ReplacementPreview {
  order: Replacement
  oldRing: RingRow | null
  newRing: RingRow | null
  cracks: CrackRow[]
  surveys: SurveyRow[]
  advices: AdviceRow[]
  /** 范围是否已与现场漂移（确认前提示重新预览） */
  drifted: boolean
}

export async function buildPreview(order: Replacement): Promise<ReplacementPreview> {
  const [oldRing, live] = await Promise.all([
    db.rings.get(order.oldRingId),
    readRingScope(order.oldRingId)
  ])
  const newRing = order.newRingId ? await db.rings.get(order.newRingId) : undefined
  const liveFingerprint = scopeFingerprint(
    live.cracks.map((crack) => crack.id),
    live.surveys.map((survey) => survey.id),
    live.advices.map((advice) => advice.id)
  )
  return {
    order,
    oldRing: oldRing ?? null,
    newRing: newRing ?? null,
    cracks: live.cracks,
    surveys: live.surveys,
    advices: live.advices,
    drifted: !!order.scope && liveFingerprint !== order.scope.fingerprint
  }
}

/** 换环日期距今天数的文案辅助（台账用） */
export function replacementAgeText(replaceDate: string): string {
  if (!replaceDate) return '—'
  const days = daysBetween(replaceDate, new Date().toISOString().slice(0, 10))
  return days >= 1 ? `${days} 天前` : '今天'
}
