<script setup lang="ts">
/**
 * /replacements 换环管理
 * 登记换环单（日期/原因/新环安装信息）、预览受影响裂缝/复测/建议，确认后原环整体留档、新环从零建档；
 * 未确认不写入业务数据；失败保留单据与已确认范围，重试不重复建环。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Switch } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import ReplacementWizard from '@/components/replacement/ReplacementWizard.vue'
import { useReplacementStore } from '@/stores/replacementStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useCrackStore } from '@/stores/crackStore'
import {
  REPLACEMENT_STATUS_LABEL,
  ReplacementError,
  replacementErrorText,
  type ReplacementStatus
} from '@/types/replacement'
import type { ReplacementRow, RingRow } from '@/utils/db'
import { formatMileage } from '@/types/section'
import { ringGenerationLabel } from '@/types/ring'

type FilterModel = { keyword: string; [key: string]: string | string[] | boolean }

const router = useRouter()
const replacementStore = useReplacementStore()
const sectionStore = useSectionStore()
const crackStore = useCrackStore()

const statusFilter = ref<ReplacementStatus[]>([])
const keyword = ref('')

const filterModel = computed<FilterModel>(() => ({ keyword: keyword.value, status: statusFilter.value }))
const filterSelects = computed(() => [
  {
    key: 'status',
    label: '单据状态',
    options: (['draft', 'failed', 'done'] as ReplacementStatus[]).map((value) => ({
      label: REPLACEMENT_STATUS_LABEL[value],
      value
    }))
  }
])

function onFilterChange(model: FilterModel): void {
  keyword.value = String(model.keyword ?? '')
  statusFilter.value = (Array.isArray(model.status) ? model.status : []) as ReplacementStatus[]
}

const rows = computed(() =>
  replacementStore.orders.filter((order) => {
    if (statusFilter.value.length > 0 && !statusFilter.value.includes(order.status)) return false
    const text = keyword.value.trim().toLowerCase()
    if (text.length === 0) return true
    const oldRing = sectionStore.ringById.get(order.oldRingId)
    const newRing = order.newRingId ? sectionStore.ringById.get(order.newRingId) : undefined
    const section = oldRing ? sectionStore.sectionById.get(oldRing.sectionId) : undefined
    return (
      order.reason.toLowerCase().includes(text) ||
      (oldRing ? String(oldRing.ringNo).includes(text) : false) ||
      (section ? section.line.toLowerCase().includes(text) : false) ||
      (newRing ? newRing.segmentType.toLowerCase().includes(text) : false) ||
      (order.installer ?? '').toLowerCase().includes(text)
    )
  })
)

function oldRingOf(order: ReplacementRow) {
  return sectionStore.ringById.get(order.oldRingId) ?? null
}
function newRingOf(order: ReplacementRow) {
  return order.newRingId ? sectionStore.ringById.get(order.newRingId) ?? null : null
}
function sectionLineOf(order: ReplacementRow): string {
  const ring = oldRingOf(order)
  const section = ring ? sectionStore.sectionById.get(ring.sectionId) : undefined
  return section ? section.line : '—'
}

function statusTagType(status: ReplacementStatus): 'warning' | 'danger' | 'success' {
  if (status === 'draft') return 'warning'
  if (status === 'failed') return 'danger'
  return 'success'
}

function scopeText(order: ReplacementRow): string {
  const scope = order.scope
  if (!scope) return '尚未预览'
  return `裂缝 ${scope.crackCount} · 复测 ${scope.surveyCount} · 建议 ${scope.adviceCount}`
}

/* ------------------------------ 向导 ------------------------------ */

const wizardVisible = ref(false)
const wizardRing = ref<RingRow | null>(null)
const wizardOrder = ref<ReplacementRow | null>(null)

function openCreate(): void {
  wizardRing.value = null
  wizardOrder.value = null
  wizardVisible.value = true
}

function openForRing(): void {
  if (sectionStore.currentRings.length === 0) {
    ElMessage.info('当前没有可换的当前环，请先在区间台账录入环片')
    return
  }
  void router.push('/sections')
}

function openOrder(order: ReplacementRow): void {
  wizardOrder.value = order
  wizardRing.value = null
  wizardVisible.value = true
}

function onConfirmed(): void {
  wizardOrder.value = null
  wizardRing.value = null
}

async function retryConfirm(order: ReplacementRow): Promise<void> {
  try {
    const done = await replacementStore.confirm(order.id)
    ElMessage.success(`第 ${oldRingOf(done)?.ringNo ?? ''} 环换环已完成`)
  } catch (error) {
    const code = error instanceof ReplacementError ? error.code : null
    ElMessage.error(code ? replacementErrorText(code) : '确认失败，换环单与范围已保留')
  }
}

async function discard(order: ReplacementRow): Promise<void> {
  const ring = oldRingOf(order)
  const confirmed = await ElMessageBox.confirm(
    `作废第 ${ring?.ringNo ?? ''} 环的换环单？该单尚未确认，作废不影响任何环片与裂缝数据。`,
    '作废确认',
    { type: 'warning', confirmButtonText: '作废换环单', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return
  await replacementStore.discard(order.id)
  ElMessage.success('换环单已作废')
}

function orderRowKey(row: ReplacementRow): string {
  return row.id
}

function goRingHistory(order: ReplacementRow): void {
  // 跳区间台账并打开历史开关查看原环留档
  const ring = oldRingOf(order)
  if (ring) {
    void sectionStore.selectSection(ring.sectionId)
    sectionStore.showArchivedRings = true
  }
  void router.push('/sections')
}

const currentCrackCount = computed(() => crackStore.currentCracks.length)
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-head__title">换环管理（大修整环更换）</h2>
        <p class="page-head__desc">
          先登记换环日期、原因与新环安装信息，预览受影响的裂缝、复测与整治建议；确认后原环整体留档、新环沿用原环号从零建档。
        </p>
      </div>
      <div class="page-head__actions">
        <el-button :icon="Switch" @click="openForRing">从区间台账选环</el-button>
        <el-button type="primary" @click="openCreate">登记换环</el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="待确认" :value="replacementStore.statusCount('draft')" suffix="单" icon="Histogram" tone="warning" />
      <StatBadge label="确认失败" :value="replacementStore.statusCount('failed')" suffix="单" icon="WarningFilled" tone="danger" />
      <StatBadge label="已确认留档" :value="replacementStore.statusCount('done')" suffix="单" icon="CircleCheckFilled" tone="success" />
      <StatBadge label="当前环裂缝" :value="currentCrackCount" suffix="条" icon="Files" tone="info" />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="搜索环号 / 线路 / 原因 / 施工单位"
      @change="onFilterChange"
    />

    <div class="panel" style="margin-top: 16px">
      <div class="panel-head">
        <h3 class="panel-title">换环单（{{ rows.length }}）</h3>
        <span class="muted">待确认单据不改动任何业务数据；失败可凭原范围重试，不重复建环</span>
      </div>

      <EmptyPanel
        v-if="rows.length === 0"
        title="还没有换环单"
        description="隧道大修更换整环管片时，在此登记换环日期、原因与新环安装信息，确认后系统自动完成原环留档与新环建档。"
        action-text="登记换环"
        compact
        @action="openCreate"
      />

      <el-table v-else :data="rows" border stripe :row-key="orderRowKey">
        <el-table-column label="状态" width="132">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small">
              {{ REPLACEMENT_STATUS_LABEL[row.status as ReplacementStatus] }}
            </el-tag>
            <div v-if="row.status === 'failed'" class="cell-sub danger">
              {{ row.lastErrorCode ? replacementErrorText(row.lastErrorCode) : '确认失败' }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="线路 / 环号" width="150">
          <template #default="{ row }">
            <div>{{ sectionLineOf(row) }}</div>
            <div class="cell-sub">
              {{ oldRingOf(row) ? ringGenerationLabel(oldRingOf(row)!) : '原环缺失' }}
              <template v-if="newRingOf(row)"> → {{ ringGenerationLabel(newRingOf(row)!) }}</template>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="里程" width="104">
          <template #default="{ row }">
            {{ oldRingOf(row) ? formatMileage(oldRingOf(row)!.mileage) : '—' }}
          </template>
        </el-table-column>
        <el-table-column prop="replaceDate" label="换环日期" width="112" />
        <el-table-column prop="reason" label="换环原因" min-width="220" show-overflow-tooltip />
        <el-table-column label="新环安装信息" min-width="170">
          <template #default="{ row }">
            <div>{{ row.newSegmentType }} · {{ row.newInstallDate }}</div>
            <div class="cell-sub">{{ row.installer || '未填施工单位' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="留档范围" width="170">
          <template #default="{ row }">{{ scopeText(row) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="openOrder(row)">
              {{ row.status === 'done' ? '查看留档' : '预览/确认' }}
            </el-button>
            <el-button
              v-if="row.status === 'failed'"
              size="small"
              text
              type="danger"
              @click="retryConfirm(row)"
            >
              重试
            </el-button>
            <el-button v-if="row.status === 'done'" size="small" text type="primary" @click="goRingHistory(row)">
              历史台账
            </el-button>
            <el-button v-if="row.status !== 'done'" size="small" text type="danger" @click="discard(row)">
              作废
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <ReplacementWizard
      v-model="wizardVisible"
      :ring="wizardRing"
      :order="wizardOrder"
      @registered="() => {}"
      @confirmed="onConfirmed"
    />
  </div>
</template>

<style scoped>
.panel-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.panel-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}

.cell-sub {
  margin-top: 2px;
  font-size: 12px;
  color: #8c99ab;
}

.cell-sub.danger {
  color: #c0392b;
}
</style>
