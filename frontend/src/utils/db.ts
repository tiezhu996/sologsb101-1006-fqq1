/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与 upgrade 迁移逻辑
 * - 表级增删改查、级联删除、整库导入导出
 * - 纯前端应用：不依赖任何后端服务或数据库
 */
import Dexie, { type Table } from 'dexie'
import type { Section } from '@/types/section'
import { isArchivedRing, type Ring, type RingLifecycle } from '@/types/ring'
import type { Crack } from '@/types/crack'
import type { Survey } from '@/types/survey'
import type { Advice } from '@/types/advice'
import type { Replacement, ReplacementDraft, ReplacementPreview } from '@/types/replacement'
import { validateReplacementDraft } from '@/types/replacement'
import { buildSurveyPoints, levelFromRate } from '@/utils/rate'

/** IndexedDB 数据库名 */
export const DB_NAME = 'gbtunnelcrack'

/**
 * 当前数据结构版本号：调整表结构必须递增并补 upgrade 迁移
 * v3：新增 replacements 换环单表；rings 增加生命周期与换环溯源字段
 */
export const DB_VERSION = 3

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbtunnelcrack:db-version',
  lastBackupAt: 'gbtunnelcrack:last-backup-at',
  uiPrefs: 'gbtunnelcrack:ui-prefs'
} as const

export interface UiPrefs {
  lastSectionId: string | null
  trendOnlyWarning: boolean
}

export const DEFAULT_UI_PREFS: UiPrefs = {
  lastSectionId: null,
  trendOnlyWarning: false
}

/** 整库备份文件结构 */
export interface BackupPayload {
  app: 'gbtunnelcrack'
  dbVersion: number
  exportedAt: string
  sections: Section[]
  rings: Ring[]
  cracks: Crack[]
  surveys: Survey[]
  advices: Advice[]
  /** v3 新增：旧版备份没有该字段，导入时按空数组兼容 */
  replacements?: Replacement[]
}

/** 带行修订号的持久化实体，便于逐行迁移 */
export interface Revisioned {
  /** 数据行结构修订号，便于后续按行迁移 */
  revision?: number
}

export const ROW_REVISION = 3

export type SectionRow = Section & Revisioned
export type RingRow = Ring & Revisioned
export type CrackRow = Crack & Revisioned
export type SurveyRow = Survey & Revisioned
export type AdviceRow = Advice & Revisioned
export type ReplacementRow = Replacement & Revisioned

class TunnelCrackDatabase extends Dexie {
  sections!: Table<SectionRow, string>
  rings!: Table<RingRow, string>
  cracks!: Table<CrackRow, string>
  surveys!: Table<SurveyRow, string>
  advices!: Table<AdviceRow, string>
  replacements!: Table<ReplacementRow, string>

  constructor() {
    super(DB_NAME)

    // v1：初版结构
    this.version(1).stores({
      sections: 'id, line, structureType, startMileage',
      rings: 'id, sectionId, ringNo, mileage',
      cracks: 'id, ringId, code, position, direction, state',
      surveys: 'id, crackId, seq, date',
      advices: 'id, crackId, level, measure, state'
    })

    // v2：裂缝补充 sectionId 冗余列（按区间筛选/统计免联表）；复测补充 surveyor 索引；建议补充 note 字段
    this.version(2)
      .stores({
        sections: 'id, line, structureType, startMileage, updatedAt',
        rings: 'id, sectionId, ringNo, mileage, segmentType, updatedAt',
        cracks: 'id, ringId, sectionId, code, position, direction, state, updatedAt',
        surveys: 'id, crackId, seq, date, surveyor, updatedAt',
        advices: 'id, crackId, level, measure, state, updatedAt'
      })
      .upgrade(async (tx) => {
        // 迁移 1：为全部业务行补齐 revision
        const tables: Array<Table<Record<string, unknown>, string>> = [
          tx.table('sections'),
          tx.table('rings'),
          tx.table('cracks'),
          tx.table('surveys'),
          tx.table('advices')
        ]
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION
          })
        }

        // 迁移 2：历史裂缝缺少 sectionId，用所属环片回填
        const ringRows = (await tx.table('rings').toArray()) as Array<{ id: string; sectionId: string }>
        const sectionOfRing = new Map(ringRows.map((ring) => [ring.id, ring.sectionId]))
        await tx
          .table('cracks')
          .toCollection()
          .modify((crack: Record<string, unknown>) => {
            if (typeof crack.sectionId !== 'string' || crack.sectionId.length === 0) {
              crack.sectionId = sectionOfRing.get(String(crack.ringId)) ?? ''
            }
            if (typeof crack.state !== 'string') crack.state = '观察'
          })

        // 迁移 3：复测缺失变化量时按前一次测次补算（仅补 0，避免误判速率）
        await tx
          .table('surveys')
          .toCollection()
          .modify((survey: Record<string, unknown>) => {
            if (typeof survey.deltaWidthMm !== 'number' || !Number.isFinite(survey.deltaWidthMm)) {
              survey.deltaWidthMm = 0
            }
          })
      })

    // v3：换环版本。新增换环单表；环片增加生命周期与溯源索引（Dexie 只需声明有索引变化的表 + 新表）
    this.version(DB_VERSION)
      .stores({
        rings: 'id, sectionId, ringNo, mileage, segmentType, lifecycle, successorRingId, updatedAt',
        replacements:
          'id, oldRingId, newRingId, sectionId, status, replaceDate, confirmedAt, createdAt, updatedAt'
      })
      .upgrade(async (tx) => {
        // 迁移 1：历史环片全部为在役环，补齐生命周期字段；行修订号升到 v3
        await tx
          .table('rings')
          .toCollection()
          .modify((ring: Record<string, unknown>) => {
            if (ring.lifecycle !== 'archived') ring.lifecycle = 'current'
            ring.revision = ROW_REVISION
          })

        // 迁移 2：其余业务表只升行修订号，结构无变化
        const tables: Array<Table<Record<string, unknown>, string>> = [
          tx.table('sections'),
          tx.table('cracks'),
          tx.table('surveys'),
          tx.table('advices')
        ]
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION
          })
        }
      })
  }
}

export const db = new TunnelCrackDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/* ============================ 演示数据播种 ============================ */

const SEED_STAMP = Date.parse('2024-06-20T09:00:00+08:00')

function stamp(offsetDays = 0): number {
  return SEED_STAMP + offsetDays * 86400000
}

const SEED_SECTIONS: SectionRow[] = [
  {
    id: 'sec-1',
    line: '1号线',
    startMileage: 12300,
    endMileage: 13150,
    structureType: '盾构',
    ringCount: 42,
    createdAt: stamp(-120),
    updatedAt: stamp(-6),
    revision: ROW_REVISION
  },
  {
    id: 'sec-2',
    line: '2号线',
    startMileage: 5000,
    endMileage: 5720,
    structureType: '明挖',
    ringCount: 36,
    createdAt: stamp(-96),
    updatedAt: stamp(-4),
    revision: ROW_REVISION
  }
]

const SEED_RINGS: RingRow[] = [
  // ring-1：已整环更换的原 118 环，整体留档（裂缝/复测/建议仍挂在它下面，不迁到新环）
  {
    id: 'ring-1', sectionId: 'sec-1', ringNo: 118, mileage: 12300, segmentType: '钢筋混凝土', installDate: '2016-04-18',
    lifecycle: 'archived', replacedById: 'rep-1', replacedDate: '2024-01-15', successorRingId: 'ring-6', archivedAt: stamp(-157),
    createdAt: stamp(-118), updatedAt: stamp(-157), revision: ROW_REVISION
  },
  { id: 'ring-2', sectionId: 'sec-1', ringNo: 132, mileage: 12468, segmentType: '钢筋混凝土', installDate: '2016-05-02', lifecycle: 'current', createdAt: stamp(-117), updatedAt: stamp(-6), revision: ROW_REVISION },
  { id: 'ring-3', sectionId: 'sec-1', ringNo: 145, mileage: 12625, segmentType: '铸铁', installDate: '2016-06-11', lifecycle: 'current', createdAt: stamp(-116), updatedAt: stamp(-5), revision: ROW_REVISION },
  { id: 'ring-4', sectionId: 'sec-2', ringNo: 27, mileage: 5080, segmentType: '钢筋混凝土', installDate: '2019-09-23', lifecycle: 'current', createdAt: stamp(-95), updatedAt: stamp(-4), revision: ROW_REVISION },
  { id: 'ring-5', sectionId: 'sec-2', ringNo: 41, mileage: 5220, segmentType: '钢管片', installDate: '2019-10-30', lifecycle: 'current', createdAt: stamp(-94), updatedAt: stamp(-4), revision: ROW_REVISION },
  // ring-6：2024-01-15 换环后接管 118 环号的新环，从零建档，仅挂换环后新登记的裂缝
  {
    id: 'ring-6', sectionId: 'sec-1', ringNo: 118, mileage: 12300, segmentType: '钢筋混凝土', installDate: '2024-01-15',
    lifecycle: 'current', replacementId: 'rep-1', predecessorRingId: 'ring-1',
    createdAt: stamp(-157), updatedAt: stamp(-6), revision: ROW_REVISION
  }
]

const SEED_CRACKS: CrackRow[] = [
  // 下列两条属于已留档原 118 环（ring-1）：换环前裂缝，仅在「已换环历史」中可查
  { id: 'crack-1', ringId: 'ring-1', sectionId: 'sec-1', code: 'SL-118-01', position: '拱顶', direction: '纵向', widthMm: 1.02, lengthMm: 745, state: '待整治', createdAt: stamp(-275), updatedAt: stamp(-160), revision: ROW_REVISION },
  { id: 'crack-2', ringId: 'ring-1', sectionId: 'sec-1', code: 'SL-118-02', position: '侧墙', direction: '环向', widthMm: 0.25, lengthMm: 452, state: '观察', createdAt: stamp(-275), updatedAt: stamp(-160), revision: ROW_REVISION },
  { id: 'crack-3', ringId: 'ring-2', sectionId: 'sec-1', code: 'SL-132-01', position: '道床', direction: '斜向', widthMm: 0.98, lengthMm: 962, state: '待整治', createdAt: stamp(-104), updatedAt: stamp(-3), revision: ROW_REVISION },
  { id: 'crack-4', ringId: 'ring-3', sectionId: 'sec-1', code: 'SL-145-01', position: '拱顶', direction: '环向', widthMm: 0.3, lengthMm: 366, state: '观察', createdAt: stamp(-99), updatedAt: stamp(-9), revision: ROW_REVISION },
  { id: 'crack-5', ringId: 'ring-4', sectionId: 'sec-2', code: 'NL-027-01', position: '侧墙', direction: '纵向', widthMm: 0.46, lengthMm: 548, state: '已整治', createdAt: stamp(-88), updatedAt: stamp(-20), revision: ROW_REVISION },
  { id: 'crack-6', ringId: 'ring-5', sectionId: 'sec-2', code: 'NL-041-01', position: '拱顶', direction: '斜向', widthMm: 0.12, lengthMm: 260, state: '观察', createdAt: stamp(-60), updatedAt: stamp(-6), revision: ROW_REVISION },
  // 换环后新 118 环（ring-6）从零建档的裂缝，编号可与原环同名但物理上挂在新环
  { id: 'crack-7', ringId: 'ring-6', sectionId: 'sec-1', code: 'SL-118-01', position: '侧墙', direction: '纵向', widthMm: 0.2, lengthMm: 300, state: '观察', createdAt: stamp(-30), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'crack-8', ringId: 'ring-6', sectionId: 'sec-1', code: 'SL-118-02', position: '道床', direction: '斜向', widthMm: 0.08, lengthMm: 150, state: '观察', createdAt: stamp(-12), updatedAt: stamp(-12), revision: ROW_REVISION }
]

const SEED_SURVEYS: SurveyRow[] = [
  // crack-1（已换环原 118 环）：换环前测次，末次 2024-01-10 月均 0.31 mm/月（严重），换环后停止复测
  { id: 'sv-1-1', crackId: 'crack-1', seq: 1, date: '2023-11-11', widthMm: 0.42, lengthMm: 620, deltaWidthMm: 0, surveyor: '周维', createdAt: stamp(-222), updatedAt: stamp(-222), revision: ROW_REVISION },
  { id: 'sv-1-2', crackId: 'crack-1', seq: 2, date: '2023-12-11', widthMm: 0.71, lengthMm: 690, deltaWidthMm: 0.29, surveyor: '周维', createdAt: stamp(-192), updatedAt: stamp(-192), revision: ROW_REVISION },
  { id: 'sv-1-3', crackId: 'crack-1', seq: 3, date: '2024-01-10', widthMm: 1.02, lengthMm: 745, deltaWidthMm: 0.31, surveyor: '李文博', createdAt: stamp(-162), updatedAt: stamp(-162), revision: ROW_REVISION },
  // crack-2（已换环原 118 环）：换环前仅两次复测
  { id: 'sv-2-1', crackId: 'crack-2', seq: 1, date: '2023-12-14', widthMm: 0.18, lengthMm: 410, deltaWidthMm: 0, surveyor: '李文博', createdAt: stamp(-189), updatedAt: stamp(-189), revision: ROW_REVISION },
  { id: 'sv-2-2', crackId: 'crack-2', seq: 2, date: '2024-01-09', widthMm: 0.25, lengthMm: 452, deltaWidthMm: 0.07, surveyor: '李文博', createdAt: stamp(-163), updatedAt: stamp(-163), revision: ROW_REVISION },
  // crack-3：0.55 → 0.72 → 0.98，末次月均 0.26 mm/月（较重）
  { id: 'sv-3-1', crackId: 'crack-3', seq: 1, date: '2024-04-12', widthMm: 0.55, lengthMm: 880, deltaWidthMm: 0, surveyor: '陈立', createdAt: stamp(-69), updatedAt: stamp(-69), revision: ROW_REVISION },
  { id: 'sv-3-2', crackId: 'crack-3', seq: 2, date: '2024-05-12', widthMm: 0.72, lengthMm: 905, deltaWidthMm: 0.17, surveyor: '陈立', createdAt: stamp(-39), updatedAt: stamp(-39), revision: ROW_REVISION },
  { id: 'sv-3-3', crackId: 'crack-3', seq: 3, date: '2024-06-11', widthMm: 0.98, lengthMm: 962, deltaWidthMm: 0.26, surveyor: '陈立', createdAt: stamp(-9), updatedAt: stamp(-9), revision: ROW_REVISION },
  // crack-4：0.24 → 0.30，末次月均 0.06 mm/月（一般）
  { id: 'sv-4-1', crackId: 'crack-4', seq: 1, date: '2024-04-15', widthMm: 0.24, lengthMm: 350, deltaWidthMm: 0, surveyor: '周维', createdAt: stamp(-66), updatedAt: stamp(-66), revision: ROW_REVISION },
  { id: 'sv-4-2', crackId: 'crack-4', seq: 2, date: '2024-05-15', widthMm: 0.3, lengthMm: 366, deltaWidthMm: 0.06, surveyor: '周维', createdAt: stamp(-36), updatedAt: stamp(-36), revision: ROW_REVISION },
  // crack-5（已整治）：0.38 → 0.46 后停止复测
  { id: 'sv-5-1', crackId: 'crack-5', seq: 1, date: '2024-02-20', widthMm: 0.38, lengthMm: 540, deltaWidthMm: 0, surveyor: '陈立', createdAt: stamp(-121), updatedAt: stamp(-121), revision: ROW_REVISION },
  { id: 'sv-5-2', crackId: 'crack-5', seq: 2, date: '2024-03-21', widthMm: 0.46, lengthMm: 548, deltaWidthMm: 0.08, surveyor: '陈立', createdAt: stamp(-91), updatedAt: stamp(-91), revision: ROW_REVISION },
  // crack-6：仅初测一次
  { id: 'sv-6-1', crackId: 'crack-6', seq: 1, date: '2024-05-06', widthMm: 0.12, lengthMm: 260, deltaWidthMm: 0, surveyor: '李文博', createdAt: stamp(-45), updatedAt: stamp(-45), revision: ROW_REVISION },
  // crack-7（换环后新 118 环）：0.16 → 0.20，速率极低，与原环历史完全独立
  { id: 'sv-7-1', crackId: 'crack-7', seq: 1, date: '2024-05-21', widthMm: 0.16, lengthMm: 260, deltaWidthMm: 0, surveyor: '周维', createdAt: stamp(-30), updatedAt: stamp(-30), revision: ROW_REVISION },
  { id: 'sv-7-2', crackId: 'crack-7', seq: 2, date: '2024-06-18', widthMm: 0.2, lengthMm: 300, deltaWidthMm: 0.04, surveyor: '周维', createdAt: stamp(-2), updatedAt: stamp(-2), revision: ROW_REVISION }
]

const SEED_ADVICES: AdviceRow[] = [
  // 下列两条随原 118 环留档，只在历史范围出现
  { id: 'ad-1', crackId: 'crack-1', level: '严重', measure: '钢板带', basis: '月均发展速率 0.310 mm/月，超过严重阈值 0.25 mm/月；经评估后整环更换', state: '已下发', createdAt: stamp(-165), updatedAt: stamp(-158), revision: ROW_REVISION },
  { id: 'ad-2', crackId: 'crack-3', level: '较重', measure: '嵌缝', basis: '月均发展速率 0.260 mm/月，超过预警阈值 0.10 mm/月', state: '待下发', createdAt: stamp(-8), updatedAt: stamp(-8), revision: ROW_REVISION },
  { id: 'ad-3', crackId: 'crack-5', level: '一般', measure: '观测', basis: '月均发展速率 0.080 mm/月，处于观察范围，整治后继续观测', state: '已完成', createdAt: stamp(-85), updatedAt: stamp(-30), revision: ROW_REVISION },
  { id: 'ad-4', crackId: 'crack-2', level: '一般', measure: '注浆', basis: '宽度缓慢增长，侧墙环向裂缝建议预防性注浆封堵', state: '待下发', createdAt: stamp(-166), updatedAt: stamp(-166), revision: ROW_REVISION },
  // 换环后新 118 环裂缝的建议，挂新裂缝
  { id: 'ad-5', crackId: 'crack-7', level: '一般', measure: '观测', basis: '换环后新环首次复测，月均速率 0.041 mm/月，处于观察范围，继续例行复测', state: '待下发', createdAt: stamp(-2), updatedAt: stamp(-2), revision: ROW_REVISION }
]

const SEED_REPLACEMENTS: ReplacementRow[] = [
  // rep-1：已完成换环 —— 原 118 环（ring-1）整体留档，新环 ring-6 沿用 118 环号从零建档
  {
    id: 'rep-1',
    oldRingId: 'ring-1',
    oldRingNo: 118,
    oldMileage: 12300,
    sectionId: 'sec-1',
    replaceDate: '2024-01-15',
    reason: '裂缝超限',
    reasonDetail: '拱顶纵向裂缝末次月均发展 0.310 mm/月，宽度 1.02 mm 超过严重阈值，评估后整环更换。',
    newRingId: 'ring-6',
    newRingNo: 118,
    newMileage: 12300,
    newSegmentType: '钢筋混凝土',
    newInstallDate: '2024-01-15',
    manufacturer: '中铁宏源管片厂',
    batchNo: 'RC-2024-011',
    constructionUnit: '维保三部一班',
    status: '已完成',
    confirmedCrackIds: ['crack-1', 'crack-2'],
    confirmedAt: stamp(-157),
    confirmedBy: '张维山',
    lastError: '',
    lastAttemptAt: stamp(-157),
    createdAt: stamp(-170),
    updatedAt: stamp(-157),
    revision: ROW_REVISION
  },
  // rep-2：待确认换环单 —— 已登记换环日期/原因/新环安装信息，尚未确认；确认前 ring-3 仍为在役环
  {
    id: 'rep-2',
    oldRingId: 'ring-3',
    oldRingNo: 145,
    oldMileage: 12625,
    sectionId: 'sec-1',
    replaceDate: '2024-06-25',
    reason: '管片破损',
    reasonDetail: '铸铁管片拱顶螺栓孔周边出现缺角与锈蚀扩展，计划停运天窗内整环更换。',
    newRingId: 'ring-new-145',
    newRingNo: 145,
    newMileage: 12625,
    newSegmentType: '钢筋混凝土',
    newInstallDate: '2024-06-25',
    manufacturer: '中铁宏源管片厂',
    batchNo: 'RC-2024-062',
    constructionUnit: '维保三部二班',
    status: '待确认',
    confirmedCrackIds: [],
    confirmedAt: null,
    confirmedBy: '李文博',
    lastError: '',
    lastAttemptAt: null,
    createdAt: stamp(-1),
    updatedAt: stamp(-1),
    revision: ROW_REVISION
  }
]

/** 幂等播种：仅当主表为空时写入演示数据 */
export async function seedDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.sections, db.rings, db.cracks, db.surveys, db.advices, db.replacements],
    async () => {
      await db.sections.bulkPut(SEED_SECTIONS)
      await db.rings.bulkPut(SEED_RINGS)
      await db.cracks.bulkPut(SEED_CRACKS)
      await db.surveys.bulkPut(SEED_SURVEYS)
      await db.advices.bulkPut(SEED_ADVICES)
      await db.replacements.bulkPut(SEED_REPLACEMENTS)
    }
  )
}

/** 应用启动时调用：打开数据库并在首屏为空时播种 */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.sections.count()) === 0) {
    await seedDatabase()
  }
}

/* ============================== 级联删除 ============================== */

/** 删除区间：级联删除环片 → 裂缝 → 复测 → 建议 → 换环单 */
export async function deleteSectionCascade(sectionId: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.sections, db.rings, db.cracks, db.surveys, db.advices, db.replacements],
    async () => {
      const rings = await db.rings.where('sectionId').equals(sectionId).toArray()
      const ringIds = rings.map((ring) => ring.id)
      await deleteCracksOfRings(ringIds)
      if (ringIds.length > 0) {
        await db.replacements.where('sectionId').equals(sectionId).delete()
        await db.rings.bulkDelete(ringIds)
      }
      await db.sections.delete(sectionId)
    }
  )
}

/**
 * 删除环片：级联删除裂缝及其下游。
 * 已参与换环（留档原环 / 换环后的新环 / 有待确认换环单）的环片禁止物理删除，
 * 避免历史溯源断裂；需要作废时走专门的留档流程。
 */
export async function deleteRingCascade(ringId: string): Promise<void> {
  await db.transaction('rw', [db.rings, db.cracks, db.surveys, db.advices, db.replacements], async () => {
    const ring = await db.rings.get(ringId)
    if (!ring) return
    const linked = await findReplacementForRing(ringId)
    if (linked) {
      throw new Error(`该环已参与换环（换环单 ${linked.id}），不能删除，仅可在「已换环历史」中留档查看`)
    }
    await deleteCracksOfRings([ringId])
    await db.rings.delete(ringId)
  })
}

/** 查找与某环片有关的换环单（待确认/已完成/失败均算），无则 null */
export async function findReplacementForRing(ringId: string): Promise<ReplacementRow | null> {
  const asOld = await db.replacements.where('oldRingId').equals(ringId).first()
  if (asOld) return asOld
  const asNew = await db.replacements.where('newRingId').equals(ringId).first()
  return asNew ?? null
}

/** 删除裂缝：级联删除复测与建议 */
export async function deleteCrackCascade(crackId: string): Promise<void> {
  await db.transaction('rw', db.cracks, db.surveys, db.advices, async () => {
    await db.surveys.where('crackId').equals(crackId).delete()
    await db.advices.where('crackId').equals(crackId).delete()
    await db.cracks.delete(crackId)
  })
}

async function deleteCracksOfRings(ringIds: string[]): Promise<void> {
  if (ringIds.length === 0) return
  const cracks = await db.cracks.where('ringId').anyOf(ringIds).toArray()
  const crackIds = cracks.map((crack) => crack.id)
  if (crackIds.length > 0) {
    await db.surveys.where('crackId').anyOf(crackIds).delete()
    await db.advices.where('crackId').anyOf(crackIds).delete()
    await db.cracks.bulkDelete(crackIds)
  }
}

/* ============================== 换环版本流程 ============================== */

/**
 * 写入门禁：裂缝/复测必须挂在「在役环」的裂缝上。
 * 已留档原环上的历史裂缝禁止再追加复测、改裂缝，防止旧记录混入新环片。
 */
export async function assertRingWritableByCrack(crackId: string, action: string): Promise<CrackRow> {
  const crack = await db.cracks.get(crackId)
  if (!crack) throw new Error('裂缝不存在或已删除')
  const ring = await db.rings.get(crack.ringId)
  if (!ring) throw new Error('裂缝所属环片不存在，不能' + action)
  if (isArchivedRing(ring)) {
    throw new Error(`该裂缝属于换环前留档的第 ${ring.ringNo} 环，历史记录只读，不能${action}`)
  }
  return crack
}

/** 写入门禁：直接按环片 id 判定（新增裂缝用） */
export async function assertRingWritable(ringId: string): Promise<RingRow> {
  const ring = await db.rings.get(ringId)
  if (!ring) throw new Error('环片不存在或已删除')
  if (isArchivedRing(ring)) {
    throw new Error(`第 ${ring.ringNo} 环为换环前留档环，历史数据只读，不能新增裂缝`)
  }
  return ring
}

/**
 * 登记前的跨环/缺安装信息校验（除表单必填外的落库规则）。
 * 返回中文错误信息数组，空数组表示通过。未通过时不写入任何数据。
 */
export async function validateReplacementContext(draft: ReplacementDraft): Promise<string[]> {
  const errors: string[] = []
  const fieldErrors = validateReplacementDraft(draft)
  if (Object.keys(fieldErrors).length > 0) {
    errors.push(...Object.values(fieldErrors))
  }

  const oldRing = draft.oldRingId ? await db.rings.get(draft.oldRingId) : undefined
  if (draft.oldRingId && !oldRing) {
    errors.push('被更换的原环不存在，可能已被删除')
    return errors
  }
  if (oldRing) {
    if (isArchivedRing(oldRing)) {
      errors.push(`第 ${oldRing.ringNo} 环已是换环留档环，不能再次发起换环`)
    }
    // 同一原环只允许一张进行中（待确认/失败）的换环单
    const inProgress = await db.replacements
      .where('oldRingId')
      .equals(oldRing.id)
      .filter((item) => item.status !== '已完成')
      .first()
    if (inProgress) {
      errors.push(`第 ${oldRing.ringNo} 环已有${inProgress.status === '失败' ? '失败待重试的' : '待确认的'}换环单（${inProgress.id}），请在原单上确认或作废`)
    }
    // 同区间在役环环号唯一：新环沿用原环号时，不能与另一在役环撞号（留档环同号是允许的）
    const conflict = await db.rings
      .where('sectionId')
      .equals(oldRing.sectionId)
      .filter((ring) => ring.id !== oldRing.id && !isArchivedRing(ring) && ring.ringNo === oldRing.ringNo)
      .first()
    if (conflict) {
      errors.push(`同区间已存在环号为 ${oldRing.ringNo} 的在役环，跨环冲突，不能换环`)
    }
  }
  return errors
}

/**
 * 第一步：登记换环单（状态=待确认）。
 * 仅登记日期、原因、新环安装信息，不动原环及其裂缝/复测/建议。
 */
export async function registerReplacement(draft: ReplacementDraft): Promise<ReplacementRow> {
  const errors = await validateReplacementContext(draft)
  if (errors.length > 0) throw new Error(errors[0])

  const oldRing = (await db.rings.get(draft.oldRingId)) as RingRow
  const now = Date.now()
  const row: ReplacementRow = {
    id: createId('rep'),
    oldRingId: oldRing.id,
    oldRingNo: oldRing.ringNo,
    oldMileage: oldRing.mileage,
    sectionId: oldRing.sectionId,
    replaceDate: draft.replaceDate,
    reason: draft.reason,
    reasonDetail: draft.reasonDetail.trim(),
    newRingId: createId('ring'),
    newRingNo: oldRing.ringNo,
    newMileage: Math.max(0, Math.round(draft.newMileage)),
    newSegmentType: draft.newSegmentType,
    newInstallDate: draft.newInstallDate,
    manufacturer: draft.manufacturer.trim(),
    batchNo: draft.batchNo.trim(),
    constructionUnit: draft.constructionUnit.trim(),
    status: '待确认',
    confirmedCrackIds: [],
    confirmedAt: null,
    confirmedBy: draft.confirmedBy.trim(),
    lastError: '',
    lastAttemptAt: null,
    createdAt: now,
    updatedAt: now,
    revision: ROW_REVISION
  }
  await db.replacements.put(row)
  return row
}

/** 更新待确认/失败换环单的安装信息（已确认的不允许改） */
export async function updateReplacementDraft(
  replacementId: string,
  patch: Partial<ReplacementDraft>
): Promise<ReplacementRow> {
  const row = await db.replacements.get(replacementId)
  if (!row) throw new Error('换环单不存在')
  if (row.status === '已完成') throw new Error('换环单已确认执行，不能再修改安装信息')
  const merged: ReplacementDraft = {
    oldRingId: row.oldRingId,
    replaceDate: patch.replaceDate ?? row.replaceDate,
    reason: patch.reason ?? row.reason,
    reasonDetail: patch.reasonDetail ?? row.reasonDetail,
    newMileage: patch.newMileage ?? row.newMileage,
    newSegmentType: patch.newSegmentType ?? row.newSegmentType,
    newInstallDate: patch.newInstallDate ?? row.newInstallDate,
    manufacturer: patch.manufacturer ?? row.manufacturer,
    batchNo: patch.batchNo ?? row.batchNo,
    constructionUnit: patch.constructionUnit ?? row.constructionUnit,
    confirmedBy: patch.confirmedBy ?? row.confirmedBy
  }
  const fieldErrors = validateReplacementDraft(merged)
  if (Object.keys(fieldErrors).length > 0) throw new Error(Object.values(fieldErrors)[0])
  await db.replacements.update(replacementId, {
    replaceDate: merged.replaceDate,
    reason: merged.reason,
    reasonDetail: merged.reasonDetail.trim(),
    newMileage: Math.max(0, Math.round(merged.newMileage)),
    newSegmentType: merged.newSegmentType,
    newInstallDate: merged.newInstallDate,
    manufacturer: merged.manufacturer.trim(),
    batchNo: merged.batchNo.trim(),
    constructionUnit: merged.constructionUnit.trim(),
    confirmedBy: merged.confirmedBy.trim(),
    lastError: '',
    updatedAt: Date.now()
  })
  return (await db.replacements.get(replacementId)) as ReplacementRow
}

/**
 * 第二步：预览受影响的裂缝、复测与整治建议（只读，不写库）。
 */
export async function previewReplacement(replacementId: string): Promise<ReplacementPreview> {
  const rep = await db.replacements.get(replacementId)
  if (!rep) throw new Error('换环单不存在')
  const oldRing = await db.rings.get(rep.oldRingId)
  if (!oldRing) throw new Error('被更换的原环不存在，可能已被删除')

  const crackRows = await db.cracks.where('ringId').equals(oldRing.id).toArray()
  const crackIds = crackRows.map((crack) => crack.id)
  const allSurveys = crackIds.length > 0 ? await db.surveys.where('crackId').anyOf(crackIds).toArray() : []
  const allAdvices = crackIds.length > 0 ? await db.advices.where('crackId').anyOf(crackIds).toArray() : []

  const affected = crackRows.map((crack) => {
    const surveysOf = allSurveys.filter((survey) => survey.crackId === crack.id)
    const advicesOf = allAdvices.filter((advice) => advice.crackId === crack.id)
    const points = buildSurveyPoints(surveysOf)
    const latest = points[points.length - 1]
    const rate = latest ? latest.rate : 0
    return {
      crackId: crack.id,
      code: crack.code,
      position: crack.position,
      direction: crack.direction,
      state: crack.state,
      widthMm: crack.widthMm,
      surveyCount: surveysOf.length,
      adviceCount: advicesOf.length,
      latestRate: rate,
      latestLevel: levelFromRate(rate)
    }
  })

  const pending = await db.replacements
    .where('oldRingId')
    .equals(oldRing.id)
    .filter((item) => item.id !== rep.id && item.status !== '已完成')
    .first()

  return {
    oldRingId: oldRing.id,
    oldRingNo: oldRing.ringNo,
    oldMileage: oldRing.mileage,
    oldInstallDate: oldRing.installDate,
    oldSegmentType: oldRing.segmentType,
    newRingNo: rep.newRingNo,
    cracks: affected,
    surveyCount: allSurveys.length,
    adviceCount: allAdvices.length,
    pendingReplacementId: pending ? pending.id : null
  }
}

export interface ConfirmReplacementResult {
  replacement: ReplacementRow
  newRingId: string
  /** 本次调用是否实际执行（false 表示已是完成态，按幂等直接返回） */
  executed: boolean
}

/**
 * 第三步：确认执行换环（整体事务，幂等可重试）。
 * - 原环整体留档（lifecycle=archived + 溯源字段），其裂缝/复测/建议一行不动；
 * - 新环按预生成的 newRingId 从零建档（无裂缝、无复测、无建议）；
 * - 未确认（无确认人）、跨环冲突、缺少安装信息时一律拒绝写入；
 * - 若上次执行在「落确认范围」之后、事务之中失败，单据保留为失败态且范围不丢，重试不再重复建环。
 */
export async function confirmReplacement(
  replacementId: string,
  options: { confirmedBy?: string; allowScopeDrift?: boolean } = {}
): Promise<ConfirmReplacementResult> {
  const rep0 = await db.replacements.get(replacementId)
  if (!rep0) throw new Error('换环单不存在')
  if (rep0.status === '已完成') {
    // 幂等：已完成（例如上一轮请求在成功返回后中断）直接返回，不重复建环
    const existingNew = await db.rings.get(rep0.newRingId)
    if (!existingNew) throw new Error('换环单标记已完成但新环缺失，数据异常，请联系管理员核对')
    return { replacement: rep0, newRingId: rep0.newRingId, executed: false }
  }

  const confirmedBy = (options.confirmedBy ?? rep0.confirmedBy ?? '').trim()
  if (!confirmedBy) throw new Error('未确认（缺少确认人），不能执行换环')
  if (!rep0.replaceDate || !rep0.newInstallDate || !rep0.newSegmentType) {
    throw new Error('新环安装信息不完整，不能执行换环')
  }

  const oldRing = await db.rings.get(rep0.oldRingId)
  if (!oldRing) throw new Error('被更换的原环不存在，不能执行换环')
  if (isArchivedRing(oldRing) && !oldRing.successorRingId) {
    throw new Error('原环已是留档状态但缺少新环溯源，跨环异常，已中止')
  }
  const cross = await db.rings
    .where('sectionId')
    .equals(rep0.sectionId)
    .filter((ring) => !isArchivedRing(ring) && ring.id !== rep0.oldRingId && ring.ringNo === rep0.newRingNo)
    .first()
  if (cross) throw new Error(`同区间已存在环号 ${rep0.newRingNo} 的在役环，跨环冲突，已中止`)

  // 阶段 A：把已确认范围（当前原环裂缝全集）单独落库。
  // 即使阶段 B 事务中途失败，换环单与确认范围仍保留，供重试核对。
  const scopeCracks = await db.cracks.where('ringId').equals(rep0.oldRingId).toArray()
  const scopeIds = scopeCracks.map((crack) => crack.id)
  if (rep0.confirmedCrackIds.length > 0 && !options.allowScopeDrift) {
    const before = new Set(rep0.confirmedCrackIds)
    const drifted = scopeIds.length !== before.size || scopeIds.some((id) => !before.has(id))
    if (drifted) throw new Error('确认范围已变化（登记后原环裂缝有增删），请重新预览并勾选确认后再执行')
  }
  const attemptAt = Date.now()
  await db.replacements.update(replacementId, {
    confirmedBy,
    confirmedCrackIds: scopeIds,
    lastAttemptAt: attemptAt,
    updatedAt: attemptAt
  })

  try {
    // 阶段 B：留档 + 建环原子提交
    await db.transaction(
      'rw',
      db.rings,
      db.replacements,
      async () => {
        const rep = await db.replacements.get(replacementId)
        const old = await db.rings.get(rep0.oldRingId)
        if (!rep || !old) throw new Error('原环或换环单在执行中被删除')

        // 幂等核心：新环 id 已存在说明上次事务已建环，跳过建环，仅补齐单据与留档标记
        const existing = await db.rings.get(rep.newRingId)
        const now = Date.now()
        if (!existing) {
          await db.rings.add({
            id: rep.newRingId,
            sectionId: rep.sectionId,
            ringNo: rep.newRingNo,
            mileage: rep.newMileage,
            segmentType: rep.newSegmentType,
            installDate: rep.newInstallDate,
            lifecycle: 'current',
            replacementId: rep.id,
            predecessorRingId: rep.oldRingId,
            createdAt: now,
            updatedAt: now,
            revision: ROW_REVISION
          })
        }

        await db.rings.update(rep.oldRingId, {
          lifecycle: 'archived' as RingLifecycle,
          replacedById: rep.id,
          replacedDate: rep.replaceDate,
          successorRingId: rep.newRingId,
          archivedAt: now,
          updatedAt: now
        })

        await db.replacements.update(rep.id, {
          status: '已完成',
          confirmedBy,
          confirmedCrackIds: scopeIds,
          confirmedAt: now,
          lastError: '',
          lastAttemptAt: now,
          updatedAt: now
        })
      }
    )
  } catch (error) {
    // 失败后保留换环单与已确认范围：单据置失败态（阶段 A 已落的 scope 不回滚）
    const message = error instanceof Error ? error.message : '换环执行失败'
    await db.replacements.update(replacementId, {
      status: '失败',
      confirmedBy,
      confirmedCrackIds: scopeIds,
      lastError: message,
      lastAttemptAt: Date.now(),
      updatedAt: Date.now()
    })
    throw error
  }

  const done = (await db.replacements.get(replacementId)) as ReplacementRow
  return { replacement: done, newRingId: done.newRingId, executed: true }
}

/** 作废待确认换环单（已完成的不能作废；失败单不允许删除，只能修正后重试） */
export async function cancelReplacement(replacementId: string): Promise<void> {
  const rep = await db.replacements.get(replacementId)
  if (!rep) return
  if (rep.status === '已完成') throw new Error('换环单已确认执行，不能作废')
  const strayNew = await db.rings.get(rep.newRingId)
  if (strayNew) throw new Error('新环已建档，不能作废换环单，请改走再次换环流程')
  await db.replacements.delete(replacementId)
}

/* ============================ 整库导入导出 ============================ */

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [sections, rings, cracks, surveys, advices, replacements] = await Promise.all([
    db.sections.count(),
    db.rings.count(),
    db.cracks.count(),
    db.surveys.count(),
    db.advices.count(),
    db.replacements.count()
  ])
  return { sections, rings, cracks, surveys, advices, replacements }
}

/** 导出整库快照（剥离内部 revision 字段） */
export async function exportSnapshot(): Promise<BackupPayload> {
  const [sections, rings, cracks, surveys, advices, replacements] = await Promise.all([
    db.sections.toArray(),
    db.rings.toArray(),
    db.cracks.toArray(),
    db.surveys.toArray(),
    db.advices.toArray(),
    db.replacements.toArray()
  ])
  const strip = <T extends Revisioned>(row: T): Omit<T, 'revision'> => {
    const { revision: _revision, ...rest } = row
    return rest
  }
  return {
    app: 'gbtunnelcrack',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    sections: sections.map(strip),
    rings: rings.map(strip),
    cracks: cracks.map(strip),
    surveys: surveys.map(strip),
    advices: advices.map(strip),
    replacements: replacements.map(strip)
  }
}

/**
 * 用快照覆盖整库。
 * 兼容旧版（v1/v2）备份：
 * - 无 replacements 字段按空数组处理；
 * - 环片缺生命周期字段一律归一为在役（lifecycle=current），历史留档环必须随换环单显式标记；
 * - 裂缝/复测/建议先做引用完整性校验，父环不存在直接拒绝导入，防止旧记录错挂到新环片。
 */
export async function importSnapshot(payload: BackupPayload): Promise<void> {
  const sections = payload.sections ?? []
  const rawRings = payload.rings ?? []
  const cracks = payload.cracks ?? []
  const surveys = payload.surveys ?? []
  const advices = payload.advices ?? []
  const replacements = payload.replacements ?? []

  const rings: RingRow[] = rawRings.map((ring) => {
    const lifecycle: RingLifecycle = ring.lifecycle === 'archived' ? 'archived' : 'current'
    return { ...ring, lifecycle, revision: ROW_REVISION }
  })

  const ringIds = new Set(rings.map((ring) => ring.id))
  const sectionIds = new Set(sections.map((section) => section.id))
  const orphanCrack = cracks.find((crack) => !ringIds.has(crack.ringId))
  if (orphanCrack) {
    throw new Error(`备份中裂缝 ${orphanCrack.code}（${orphanCrack.id}）引用的环片不存在，已取消导入以防错挂`)
  }
  const orphanSurvey = surveys.find((survey) => !cracks.some((crack) => crack.id === survey.crackId))
  if (orphanSurvey) {
    throw new Error(`备份中复测记录 ${orphanSurvey.id} 引用的裂缝不存在，已取消导入`)
  }
  const orphanAdvice = advices.find((advice) => !cracks.some((crack) => crack.id === advice.crackId))
  if (orphanAdvice) {
    throw new Error(`备份中整治建议 ${orphanAdvice.id} 引用的裂缝不存在，已取消导入`)
  }
  const badReplacement = replacements.find(
    (item) =>
      !ringIds.has(item.oldRingId) ||
      (item.status === '已完成' && !ringIds.has(item.newRingId)) ||
      (item.sectionId && !sectionIds.has(item.sectionId))
  )
  if (badReplacement) {
    throw new Error(`备份中换环单 ${badReplacement.id} 的原环/新环/区间引用不完整，已取消导入`)
  }

  await db.transaction(
    'rw',
    [db.sections, db.rings, db.cracks, db.surveys, db.advices, db.replacements],
    async () => {
      await Promise.all([
        db.sections.clear(),
        db.rings.clear(),
        db.cracks.clear(),
        db.surveys.clear(),
        db.advices.clear(),
        db.replacements.clear()
      ])
      const rev = <T>(row: T): T & Revisioned => ({ ...row, revision: ROW_REVISION })
      await db.sections.bulkPut(sections.map(rev))
      await db.rings.bulkPut(rings)
      await db.cracks.bulkPut(cracks.map(rev))
      await db.surveys.bulkPut(surveys.map(rev))
      await db.advices.bulkPut(advices.map(rev))
      await db.replacements.bulkPut(replacements.map(rev))
    }
  )
}

/** 清空全部业务表 */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.sections, db.rings, db.cracks, db.surveys, db.advices, db.replacements],
    async () => {
      await Promise.all([
        db.sections.clear(),
        db.rings.clear(),
        db.cracks.clear(),
        db.surveys.clear(),
        db.advices.clear(),
        db.replacements.clear()
      ])
    }
  )
}

/** 清空后重新播种（演示数据重置） */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

/* ============================ 本地 UI 偏好 ============================ */

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastSectionId: typeof parsed.lastSectionId === 'string' ? parsed.lastSectionId : null,
      trendOnlyWarning: parsed.trendOnlyWarning === true
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
}

/** 记录结构版本号，便于备份页比对 */
export function stampDbVersion(): void {
  localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
}

export function readStampedDbVersion(): number {
  const parsed = Number(localStorage.getItem(LS_KEYS.dbVersion))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
}

export function stampBackupTime(iso: string): void {
  localStorage.setItem(LS_KEYS.lastBackupAt, iso)
}

export function readLastBackupAt(): string | null {
  return localStorage.getItem(LS_KEYS.lastBackupAt)
}
