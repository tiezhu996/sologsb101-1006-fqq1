<script setup lang="ts">
/**
 * /replacements 换环管理
 * 换环单台账：登记换环（日期/原因/新环安装信息）→ 预览受影响裂缝/复测/建议 →
 * 确认后原环整体留档、新环从零建档；失败单保留确认范围可重试，不重复建环。
 */
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CircleCloseFilled, RefreshRight, Switch, View } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import ReplacementWizard from '@/components/ReplacementWizard.vue'
import { useReplacementStore } from '@/stores/replacementStore'
import { useSectionStore } from '@/stores/sectionStore'
import { replacementStatusType, type Replacement, type ReplacementStatus } from '@/types/replacement'
import { formatMileage } from '@/types/section'

const sectionStore = useSectionStore()
const replacementStore = useReplacementStore()

const wizardVisible = ref(false)
const editingId = ref<string | null>(null)
const defaultOldRingId = ref<string | null>(null)
const statusFilter = ref<ReplacementStatus[]>([])

const filteredRows = computed(() => {
  if (statusFilter.value.length === 0) return replacementStore.replacements
  return replacementStore.replacements.filter((row) => statusFilter.value.includes(row.status))
})

function sectionLineOf(sectionId: string): string {
  return sectionStore.sectionById.get(sectionId)?.line ?? '区间已删除'
}

function openRegister(): void {
  editingId.value = null
  defaultOldRingId.value = null
  wizardVisible.value = true
}

function openRow(row: Replacement): void {
  editingId.value = row.id
  defaultOldRingId.value = null
  wizardVisible.value = true
}

async function cancelRow(row: Replacement): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `作废换环单 ${row.id}？仅待确认单据可作废；作废后原环保持在役，可重新登记。`,
    '作废确认',
    { type: 'warning', confirmButtonText: '确认作废', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return
  try {
    await replacementStore.cancel(row.id)
    ElMessage.success('换环单已作废')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '作废失败')
  }
}

function onWizardCompleted(payload: { replacementId: string; newRingId: string }): void {
  // 向导内部已提示；页面不跳转，留在台账便于继续处理
  void payload
}

function rowKey(row: Replacement): string {
  return row.id
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-head__title">换环管理</h2>
        <p class="page-head__desc">
          隧道大修换掉整环管片时先登记换环日期、原因与新环安装信息，预览受影响裂缝、复测与整治建议，确认后原环整体留档、新环沿用原环号从零建档。
        </p>
      </div>
      <div class="page-head__actions">
        <el-button type="primary" :icon="Switch" @click="openRegister">登记换环</el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="换环单总数" :value="replacementStore.replacements.length" suffix="张" icon="Files" tone="primary" />
      <StatBadge label="待确认" :value="replacementStore.pendingCount" suffix="张" icon="WarningFilled" tone="warning" />
      <StatBadge label="失败待重试" :value="replacementStore.failedCount" suffix="张" icon="CircleCloseFilled" tone="danger" />
      <StatBadge label="已完成" :value="replacementStore.completedCount" suffix="张" icon="CircleCheckFilled" tone="success" />
      <StatBadge label="留档环片" :value="sectionStore.archivedRings.length" suffix="环" icon="Grid" tone="info" />
    </div>

    <div class="panel" style="margin-top: 16px">
      <div class="panel-head">
        <h3 class="panel-title">换环单（{{ filteredRows.length }} / {{ replacementStore.replacements.length }}）</h3>
        <el-radio-group v-model="statusFilter" size="small">
          <el-radio-button :value="[]">全部</el-radio-button>
          <el-radio-button :value="['待确认']">待确认</el-radio-button>
          <el-radio-button :value="['失败']">失败</el-radio-button>
          <el-radio-button :value="['已完成']">已完成</el-radio-button>
        </el-radio-group>
      </div>

      <EmptyPanel
        v-if="filteredRows.length === 0"
        title="还没有换环单"
        description="大修换掉整环管片前，先在此登记换环日期、原因和新环安装信息；系统会先预览受影响的裂缝、复测与整治建议。"
        action-text="登记换环"
        compact
        @action="openRegister"
      />

      <el-table v-else :data="filteredRows" border stripe :row-key="rowKey">
        <el-table-column prop="id" label="换环单号" width="180" />
        <el-table-column label="线路 / 里程" min-width="180">
          <template #default="{ row }">
            {{ sectionLineOf(row.sectionId) }} · {{ formatMileage(row.oldMileage) }}
          </template>
        </el-table-column>
        <el-table-column label="原环 → 新环" width="150">
          <template #default="{ row }">
            <span>第 {{ row.oldRingNo }} 环</span>
            <el-icon style="margin: 0 4px; color: #5b6b82"><RefreshRight /></el-icon>
            <strong>第 {{ row.newRingNo }} 环</strong>
          </template>
        </el-table-column>
        <el-table-column prop="replaceDate" label="换环日期" width="110" />
        <el-table-column prop="reason" label="原因" width="100" />
        <el-table-column label="新环安装" min-width="190">
          <template #default="{ row }">
            {{ row.newSegmentType }} · {{ row.newInstallDate }}
            <span v-if="row.batchNo" class="muted"> · 批次 {{ row.batchNo }}</span>
          </template>
        </el-table-column>
        <el-table-column label="留档裂缝" width="90">
          <template #default="{ row }">{{ row.confirmedCrackIds.length }} 条</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="replacementStatusType(row.status)">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="openRow(row)">
              <el-icon><View /></el-icon>
              {{ row.status === '已完成' ? '查看' : row.status === '失败' ? '重试' : '预览/确认' }}
            </el-button>
            <el-button
              size="small"
              text
              type="danger"
              :disabled="row.status !== '待确认'"
              @click="cancelRow(row)"
            >
              <el-icon><CircleCloseFilled /></el-icon> 作废
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <ReplacementWizard
      v-model="wizardVisible"
      :replacement-id="editingId"
      :default-old-ring-id="defaultOldRingId"
      @completed="onWizardCompleted"
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
</style>
