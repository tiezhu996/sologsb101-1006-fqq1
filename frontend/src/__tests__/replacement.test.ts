/**
 * 换环流程集成验证（不进业务包，仅本地脚本执行）。
 * 用 fake-indexeddb 模拟浏览器 IndexedDB，走 register → preview → confirm 全链路。
 */
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import 'fake-indexeddb/auto'
import {
  db,
  initDatabase,
  clearAllTables,
  exportSnapshot,
  importSnapshot,
  registerReplacement,
  previewReplacement,
  confirmReplacement,
  cancelReplacement,
  assertRingWritableByCrack,
  updateReplacementDraft,
  validateReplacementContext,
  type BackupPayload
} from '@/utils/db'
import { EMPTY_REPLACEMENT_DRAFT } from '@/types/replacement'
import type { ReplacementDraft } from '@/types/replacement'

let draftSeed = 0
function draft(over: Partial<ReplacementDraft> = {}): ReplacementDraft {
  draftSeed += 1
  return {
    ...EMPTY_REPLACEMENT_DRAFT,
    oldRingId: 'ring-3',
    replaceDate: '2024-06-25',
    reason: '管片破损',
    reasonDetail: `测试换环原因 ${draftSeed}`,
    newMileage: 12625,
    newSegmentType: '钢筋混凝土',
    newInstallDate: '2024-06-25',
    manufacturer: '测试厂家',
    batchNo: `BATCH-${draftSeed}`,
    constructionUnit: '测试班组',
    confirmedBy: '测试确认人',
    ...over
  }
}

beforeAll(async () => {
  await initDatabase()
})

beforeEach(async () => {
  await clearAllTables()
  await initDatabase() // 空库后重新播种
  // 默认作废种子里 ring-3 的待确认换环单，避免与用例自行登记冲突
  const pending = await db.replacements.where('status').equals('待确认').toArray()
  for (const row of pending) await db.replacements.delete(row.id)
})

describe('换环流程', () => {
  test('登记 → 预览 → 确认：原环留档、新环从零建档、老记录不迁移', async () => {
    const rep = await registerReplacement(draft())
    expect(rep.status).toBe('待确认')
    expect(rep.newRingNo).toBe(145)

    const preview = await previewReplacement(rep.id)
    expect(preview.oldRingNo).toBe(145)
    const oldCrackIds = preview.cracks.map((c) => c.crackId).sort()
    expect(oldCrackIds).toEqual(['crack-4'])
    expect(preview.surveyCount).toBe(2)
    expect(preview.adviceCount).toBe(0)

    const result = await confirmReplacement(rep.id, { confirmedBy: '张工' })
    expect(result.executed).toBe(true)

    const oldRing = await db.rings.get('ring-3')
    expect(oldRing?.lifecycle).toBe('archived')
    expect(oldRing?.successorRingId).toBe(result.newRingId)
    expect(oldRing?.replacedById).toBe(rep.id)

    const newRing = await db.rings.get(result.newRingId)
    expect(newRing).toBeTruthy()
    expect(newRing?.ringNo).toBe(145)
    expect(newRing?.lifecycle).toBe('current')
    expect(newRing?.replacementId).toBe(rep.id)
    expect(newRing?.predecessorRingId).toBe('ring-3')

    // 老裂缝/复测仍挂原环
    const oldCracks = await db.cracks.where('ringId').equals('ring-3').toArray()
    expect(oldCracks.map((c) => c.id)).toEqual(['crack-4'])
    const oldSurveys = await db.surveys.where('crackId').equals('crack-4').count()
    expect(oldSurveys).toBe(2)

    // 新环没有裂缝
    const newCracks = await db.cracks.where('ringId').equals(result.newRingId).count()
    expect(newCracks).toBe(0)

    // 留档裂缝禁止追加复测
    await expect(
      assertRingWritableByCrack('crack-4', '追加复测')
    ).rejects.toThrow(/留档|只读/)
  })

  test('重复确认幂等：不重复建环', async () => {
    const rep = await registerReplacement(draft())
    const first = await confirmReplacement(rep.id)
    expect(first.executed).toBe(true)
    const second = await confirmReplacement(rep.id)
    expect(second.executed).toBe(false)
    expect(second.newRingId).toBe(first.newRingId)
    const ringCount = await db.rings.where('ringNo').equals(145).count()
    expect(ringCount).toBe(2) // 原环 + 新环各一
  })

  test('未确认（无确认人）不能执行', async () => {
    const rep = await registerReplacement(draft({ confirmedBy: '' }))
    await expect(confirmReplacement(rep.id)).rejects.toThrow(/未确认|确认人/)
    const fresh = await db.replacements.get(rep.id)
    expect(fresh?.status).toBe('待确认')
    const oldRing = await db.rings.get('ring-3')
    expect(oldRing?.lifecycle ?? 'current').toBe('current')
  })

  test('缺少新环安装信息不能登记', async () => {
    const before = await db.replacements.count()
    const errors = await validateReplacementContext(draft({ newInstallDate: '' }))
    expect(errors.join(' ')).toContain('安装日期')
    expect(await db.replacements.count()).toBe(before)
  })

  test('同环不能重复登记待确认换环单', async () => {
    await registerReplacement(draft())
    const errors = await validateReplacementContext(draft({ oldRingId: 'ring-3', reasonDetail: '重复登记尝试' }))
    expect(errors.join(' ')).toMatch(/已有|待确认|失败/)
  })

  test('留档环不能再次换环', async () => {
    // ring-1 已随 rep-1 留档
    const errors = await validateReplacementContext(draft({ oldRingId: 'ring-1' }))
    expect(errors.join(' ')).toContain('留档')
  })

  test('跨环冲突：同区间在役同环号不能换（人为构造一个在役 145 环）', async () => {
    const now = Date.now()
    await db.rings.add({
      id: 'ring-fake-145',
      sectionId: 'sec-1',
      ringNo: 145,
      mileage: 9999,
      segmentType: '钢筋混凝土',
      installDate: '2024-01-01',
      lifecycle: 'current',
      createdAt: now,
      updatedAt: now
    })
    const errors = await validateReplacementContext(draft({ oldRingId: 'ring-3' }))
    expect(errors.join(' ')).toContain('跨环')
  })

  test('失败后保留换环单与确认范围，重试成功且不重复建环', async () => {
    const rep = await registerReplacement(draft())

    // 模拟阶段 A 成功（范围已确认）、阶段 B 失败：手工置失败态并保留 scope
    const cracks = await db.cracks.where('ringId').equals('ring-3').toArray()
    await db.replacements.update(rep.id, {
      status: '失败',
      confirmedCrackIds: cracks.map((c) => c.id),
      confirmedAt: null,
      lastError: '模拟事务中断',
      lastAttemptAt: Date.now()
    })
    let failed = await db.replacements.get(rep.id)
    expect(failed?.status).toBe('失败')
    expect(failed?.confirmedCrackIds).toEqual(['crack-4'])
    expect(await db.rings.get(rep.newRingId)).toBeUndefined() // 新环尚未建

    // 重试成功
    const result = await confirmReplacement(rep.id, { confirmedBy: '李工' })
    expect(result.executed).toBe(true)
    expect(await db.rings.get(rep.newRingId)).toBeTruthy()
    failed = await db.replacements.get(rep.id)
    expect(failed?.status).toBe('已完成')
    expect(failed?.lastError).toBe('')
  })

  test('作废待确认单不影响原环；已完成单不能作废', async () => {
    const rep = await registerReplacement(draft())
    await cancelReplacement(rep.id)
    expect(await db.replacements.get(rep.id)).toBeUndefined()
    const ring3 = await db.rings.get('ring-3')
    expect(ring3?.lifecycle ?? 'current').toBe('current')
    await expect(cancelReplacement('rep-1')).rejects.toThrow(/已完成|不能作废/)
  })

  test('阶段B中断模拟：单据失败、范围保留、原环仍在役，重试幂等成功', async () => {
    const rep = await registerReplacement(draft())
    // 直接模拟阶段A已落范围、阶段B未完成的失败现场
    const cracks = await db.cracks.where('ringId').equals('ring-3').toArray()
    await db.replacements.update(rep.id, {
      status: '失败',
      confirmedCrackIds: cracks.map((c) => c.id),
      confirmedBy: '王工',
      lastError: '阶段B中断',
      lastAttemptAt: Date.now()
    })
    expect((await db.replacements.get(rep.id))?.status).toBe('失败')
    expect((await db.rings.get('ring-3'))?.lifecycle ?? 'current').toBe('current')
    expect(await db.rings.get(rep.newRingId)).toBeUndefined()

    // 重试成功
    const result = await confirmReplacement(rep.id)
    expect(result.executed).toBe(true)
    expect((await db.replacements.get(rep.id))?.status).toBe('已完成')
    // 再调一次不重复建环
    expect((await confirmReplacement(rep.id)).executed).toBe(false)
    expect(await db.rings.where('ringNo').equals(145).count()).toBe(2)
  })

  test('确认范围在登记后发生变化时拒绝执行，重新确认后放行', async () => {
    const rep = await registerReplacement(draft())
    // 阶段A先落一次范围（模拟首次确认时只有 crack-4）
    await confirmReplacement(rep.id).catch(() => undefined)
    // 若已成功（范围未漂移）则跳过；这里直接构造漂移场景：重新置回待确认并固化旧范围
    await db.transaction('rw', [db.rings, db.replacements], async () => {
      // 回滚到执行前
      const newRing = await db.rings.get(rep.newRingId)
      if (newRing) await db.rings.delete(rep.newRingId)
      await db.rings.update('ring-3', {
        lifecycle: 'current',
        replacedById: undefined,
        replacedDate: undefined,
        successorRingId: undefined,
        archivedAt: undefined
      })
      await db.replacements.update(rep.id, {
        status: '待确认',
        confirmedAt: null,
        confirmedCrackIds: ['crack-4', 'fake-old-crack']
      })
    })
    // 旧范围与现范围不一致 → 拒绝
    await expect(confirmReplacement(rep.id)).rejects.toThrow(/范围已变化/)
    // 允许漂移（重新预览确认）→ 成功
    const result = await confirmReplacement(rep.id, { allowScopeDrift: true })
    expect(result.executed).toBe(true)
  })

  test('修改已完成换环单被拒绝', async () => {
    await expect(updateReplacementDraft('rep-1', { reasonDetail: 'X' })).rejects.toThrow(/已确认|已完成/)
  })

})

describe('备份兼容', () => {
  test('v2 旧备份（无 replacements、无 lifecycle）导入后环全部按在役处理', async () => {
    const snap = (await exportSnapshot()) as BackupPayload
    // 构造 v2 形态：剔除换环单与留档环，只保留在役环及其裂缝/复测/建议，并剥掉 v3 溯源字段
    const currentRingIds = new Set(snap.rings.filter((ring) => ring.lifecycle !== 'archived').map((ring) => ring.id))
    const currentCracks = snap.cracks.filter((crack) => currentRingIds.has(crack.ringId))
    const currentCrackIds = new Set(currentCracks.map((crack) => crack.id))
    const legacy: BackupPayload = {
      app: 'gbtunnelcrack',
      dbVersion: 2,
      exportedAt: snap.exportedAt,
      sections: snap.sections,
      rings: snap.rings
        .filter((ring) => ring.lifecycle !== 'archived')
        .map(
          ({
            lifecycle: _l,
            replacedById: _r1,
            replacedDate: _r2,
            successorRingId: _r3,
            replacementId: _r4,
            predecessorRingId: _r5,
            archivedAt: _r6,
            ...rest
          }) => rest
        ),
      cracks: currentCracks,
      surveys: snap.surveys.filter((survey) => currentCrackIds.has(survey.crackId)),
      advices: snap.advices.filter((advice) => currentCrackIds.has(advice.crackId)),
      replacements: []
    }
    await importSnapshot(legacy)
    const rings = await db.rings.toArray()
    expect(rings.length).toBeGreaterThan(0)
    expect(rings.every((ring) => (ring.lifecycle ?? 'current') === 'current')).toBe(true)
    expect(await db.replacements.count()).toBe(0)
  })

  test('裂缝引用不存在的环片时拒绝导入，防错挂', async () => {
    const snap = await exportSnapshot()
    const tampered: BackupPayload = {
      ...snap,
      cracks: snap.cracks.map((crack, i) => (i === 0 ? { ...crack, ringId: 'ring-not-exist' } : crack))
    }
    await expect(importSnapshot(tampered)).rejects.toThrow(/引用的环片不存在|错挂/)
    // 导入失败不应清掉原库
    expect(await db.rings.count()).toBeGreaterThan(0)
  })

  test('已完成换环单但缺新环的备份拒绝导入', async () => {
    const snap = await exportSnapshot()
    const tampered: BackupPayload = {
      ...snap,
      replacements: snap.replacements!.map((rep) =>
        rep.status === '已完成' ? { ...rep, newRingId: 'missing-ring' } : rep
      )
    }
    await expect(importSnapshot(tampered)).rejects.toThrow(/引用不完整/)
  })
})
