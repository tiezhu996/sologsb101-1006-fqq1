<script setup lang="ts">
/**
 * <ReplacementWizard> 换环登记向导：登记换环日期/原因/新环安装信息 → 预览受影响范围 → 确认执行。
 * - 第一步只写换环单（draft），不碰任何环片/裂缝数据；
 * - 第二步展示受影响裂缝、全部复测与整治建议，确认后才原环留档、新环建档；
 * - 未确认、跨环、缺安装信息、范围漂移由领域服务拒绝写入；失败保留单据可重试。
 */
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { ArrowLeft, ArrowRight, CircleCheckFilled, WarningFilled } from '@element-plus/icons-vue'
import { useSectionStore } from '@/stores/sectionStore'
import { useReplacementStore } from '@/stores/replacementStore'
import { db, type AdviceRow, type CrackRow, type ReplacementRow, type RingRow, type SurveyRow } from '@/utils/db'
import { buildPreview, type ReplacementPreview } from '@/utils/replacement'
import {
  EMPTY_REPLACEMENT_DRAFT,
  ReplacementError,
  replacementErrorText,
  type ReplacementDraft
} from '@/types/replacement'
import { formatMileage, type Section } from '@/types/section'

const props = defineProps<{
  modelValue: boolean
  /** 为某当前环新开换环单 */
  ring?: RingRow | null
  /** 打开已存在的待确认/失败换环单（重试/编辑） */
  order?: ReplacementRow | null
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  /** 换环单登记成功（第二步预览就绪） */
  (event: 'registered', order: ReplacementRow): void
  /** 确认完成：原环已留档、新环已建档 */
  (event: 'confirmed', order: ReplacementRow): void
}>()

const sectionStore = useSectionStore()
const replacementStore = useReplacementStore()

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})

const step = ref(0)
const submitting = ref(false)
const formRef = ref<FormInstance>()
const form = reactive<ReplacementDraft>({ ...EMPTY_REPLACEMENT_DRAFT })

/** 当前向导对应的换环单（登记后存在） */
const currentOrderId = ref<string | null>(null)
const preview = ref<ReplacementPreview | null>(null)

/** 管理页直接登记时选择的原环 id */
const selectedRingId = ref('')

/** 只允许对当前环登记换环（已留档环不能再换） */
const selectableRings = computed<RingRow[]>(() =>
  sectionStore.currentRings.filter((ring) => !replacementStore.activeOrderMap.has(ring.id))
)

const ringOptions = computed(() =>
  selectableRings.value.map((ring) => {
    const section = sectionStore.sectionById.get(ring.sectionId)
    return {
      label: `${section ? `${section.line} · ` : ''}第 ${ring.ringNo} 环 · ${formatMileage(ring.mileage)} · ${ring.segmentType}`,
      value: ring.id
    }
  })
)

const oldRing = computed<RingRow | null>(() => {
  if (props.ring) return props.ring
  if (props.order) return sectionStore.ringById.get(props.order.oldRingId) ?? null
  return sectionStore.ringById.get(selectedRingId.value) ?? null
})

const oldSection = computed<Section | null>(() =>
  oldRing.value ? sectionStore.sectionById.get(oldRing.value.sectionId) ?? null : null
)

const isRetry = computed(() => props.order?.status === 'failed')
const dialogTitle = computed(() => {
  if (props.order?.status === 'done') return `换环留档详情 · 第 ${oldRing.value?.ringNo ?? ''} 环`
  if (props.order) return isRetry.value ? '重试换环确认' : `换环登记 · 第 ${oldRing.value?.ringNo ?? ''} 环`
  return `换环登记 · 第 ${oldRing.value?.ringNo ?? ''} 环`
})

/** 已确认单据只读查看 */
const readonly = computed(() => props.order?.status === 'done')

const rules: FormRules = {
  replaceDate: [{ required: true, message: '请选择换环日期', trigger: 'change' }],
  reason: [{ required: true, message: '请填写换环原因', trigger: 'blur' }],
  newSegmentType: [{ required: true, message: '请选择新环管片类型', trigger: 'change' }],
  newInstallDate: [{ required: true, message: '请选择新环安装日期', trigger: 'change' }]
}

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return
    step.value = 0
    preview.value = null
    submitting.value = false
    if (props.order) {
      currentOrderId.value = props.order.id
      Object.assign(form, {
        oldRingId: props.order.oldRingId,
        replaceDate: props.order.replaceDate,
        reason: props.order.reason,
        newSegmentType: props.order.newSegmentType,
        newInstallDate: props.order.newInstallDate,
        newMileage: props.order.newMileage,
        installer: props.order.installer ?? '',
        remark: props.order.remark ?? ''
      })
      // 失败重试 / 已确认查看：直接进入预览步骤（已确认为只读）
      if (props.order.status === 'failed' || props.order.status === 'done') {
        step.value = 1
        await loadPreview(props.order)
      }
    } else if (props.ring) {
      currentOrderId.value = null
      selectedRingId.value = props.ring.id
      Object.assign(form, replacementStore.draftFromRing(props.ring))
    } else {
      currentOrderId.value = null
      selectedRingId.value = ringOptions.value[0]?.value ?? ''
      const first = selectableRings.value[0]
      Object.assign(form, first ? replacementStore.draftFromRing(first) : { ...EMPTY_REPLACEMENT_DRAFT })
    }
  }
)

function onSelectRing(ringId: string): void {
  selectedRingId.value = ringId
  const ring = sectionStore.ringById.get(ringId)
  if (ring) Object.assign(form, replacementStore.draftFromRing(ring))
}

function handleClose(): void {
  visible.value = false
}

/** 第一步 → 第二步：登记（或保存修改）并加载预览 */
async function goPreview(): Promise<void> {
  if (!oldRing.value) {
    ElMessage.error('缺少原环信息，不能登记')
    return
  }
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    const order = await replacementStore.registerReplacement(
      {
        ...form,
        oldRingId: oldRing.value.id,
        newMileage: form.newMileage === null || Number.isNaN(form.newMileage as number) ? undefined : form.newMileage
      },
      currentOrderId.value ?? undefined
    )
    currentOrderId.value = order.id
    await loadPreview(order)
    step.value = 1
    emit('registered', order)
  } catch (error) {
    ElMessage.error(error instanceof ReplacementError ? replacementErrorText(error.code) : '登记失败，请重试')
  } finally {
    submitting.value = false
  }
}

async function loadPreview(order: ReplacementRow): Promise<void> {
  preview.value = await buildPreview(order)
}

async function refreshPreview(): Promise<void> {
  if (!currentOrderId.value) return
  submitting.value = true
  try {
    const order = await replacementStore.resnapshot(currentOrderId.value)
    await loadPreview(order)
    ElMessage.success('已按当前数据重新生成预览范围')
  } finally {
    submitting.value = false
  }
}

/** 确认执行：成功后关闭并通知父级刷新 */
async function confirmExecute(): Promise<void> {
  if (!currentOrderId.value) return
  submitting.value = true
  try {
    const order = await replacementStore.confirm(currentOrderId.value)
    ElMessage.success('换环完成：原环已整体留档，新环已从零建档')
    emit('confirmed', order)
    visible.value = false
  } catch (error) {
    const code = error instanceof ReplacementError ? error.code : null
    ElMessage.error(code ? replacementErrorText(code) : '换环确认失败，换环单与范围已保留，可重试')
    if (currentOrderId.value) {
      const fresh = await db.replacements.get(currentOrderId.value)
      if (fresh) await loadPreview(fresh)
    }
  } finally {
    submitting.value = false
  }
}

function crackCodeOf(crackId: string): string {
  return preview.value?.cracks.find((crack) => crack.id === crackId)?.code ?? crackId
}

function levelTagType(advice: AdviceRow): 'success' | 'warning' | 'danger' | 'info' {
  if (advice.level === '严重') return 'danger'
  if (advice.level === '较重') return 'warning'
  if (advice.level === '一般') return 'success'
  return 'info'
}

function surveyRowsOfCrack(crack: CrackRow): SurveyRow[] {
  return (preview.value?.surveys ?? [])
    .filter((survey) => survey.crackId === crack.id)
    .sort((a, b) => a.seq - b.seq)
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    :title="dialogTitle"
    width="860px"
    :close-on-click-modal="false"
    @update:model-value="visible = $event"
    @closed="step = 0"
  >
    <el-steps :active="step" align-center finish-status="success" style="margin: 4px 0 18px">
      <el-step title="1 登记换环信息" description="日期 / 原因 / 新环安装信息" />
      <el-step title="2 预览受影响范围" description="裂缝 / 复测 / 整治建议" />
    </el-steps>

    <!-- --------------------------- 第一步：登记 --------------------------- -->
    <template v-if="step === 0">
      <el-form v-if="!ring && !order" label-width="128px" style="margin-bottom: 8px">
        <el-form-item label="被换原环" required>
          <el-select
            :model-value="selectedRingId"
            filterable
            placeholder="选择要更换的当前环（仅当前环可登记，已留档环不可再换）"
            style="width: 100%"
            @update:model-value="onSelectRing"
          >
            <el-option v-for="item in ringOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
      </el-form>
      <el-empty
        v-else-if="!oldRing"
        description="没有可登记换环的当前环（可能都有待确认换环单），请先到区间台账录入环片"
        :image-size="72"
      />
      <el-alert
        v-if="oldRing"
        type="info"
        :closable="false"
        show-icon
        style="margin-bottom: 16px"
        :title="`原环：${oldSection ? `${oldSection.line} · ` : ''}第 ${oldRing.ringNo} 环（第 ${oldRing.generation ?? 1} 代）· ${formatMileage(oldRing.mileage)} · ${oldRing.segmentType} · 安装于 ${oldRing.installDate}`"
        description="换环后新环沿用原环号并记为下一代；原环整体留档，其裂缝与全部复测记录仍按原环片可查，不会挂到新环。"
      />
      <el-form ref="formRef" :model="form" :rules="rules" label-width="128px">
        <el-form-item label="换环日期" prop="replaceDate">
          <el-date-picker v-model="form.replaceDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="换环原因" prop="reason">
          <el-input
            v-model="form.reason"
            type="textarea"
            :rows="2"
            placeholder="如：拱顶纵向裂缝超限持续发展 / 整环错台超标，大修更换整环"
          />
        </el-form-item>
        <el-form-item label="新环管片类型" prop="newSegmentType">
          <el-radio-group v-model="form.newSegmentType">
            <el-radio-button v-for="item in sectionStore.segmentTypeOptions" :key="item" :value="item">
              {{ item }}
            </el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="新环安装日期" prop="newInstallDate">
          <el-date-picker v-model="form.newInstallDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="新环里程(m)">
          <el-input-number v-model="form.newMileage" :min="0" :step="1" controls-position="right" style="width: 100%" placeholder="留空沿用原环里程" />
        </el-form-item>
        <el-form-item label="施工单位">
          <el-input v-model="form.installer" placeholder="如 隧道维保一分队（选填）" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" placeholder="选填" />
        </el-form-item>
      </el-form>
    </template>

    <!-- --------------------------- 第二步：预览 --------------------------- -->
    <template v-else-if="step === 1 && preview && oldRing">
      <el-alert
        v-if="readonly"
        type="info"
        :closable="false"
        show-icon
        style="margin-bottom: 14px"
        title="该换环单已确认：原环已整体留档，新环已从零建档；以下为留档时的原始范围，仅供查看。"
      />
      <el-alert
        v-else-if="preview && oldRing"
        :type="preview.drifted ? 'warning' : 'success'"
        :closable="false"
        show-icon
        style="margin-bottom: 14px"
      >
        <template #title>
          <div style="display: flex; align-items: center; gap: 6px">
            <el-icon><WarningFilled v-if="preview.drifted" /><CircleCheckFilled v-else /></el-icon>
            <span>
              {{
                preview.drifted
                  ? '范围已变化：登记后裂缝/复测/建议有增减，请先「重新预览」再确认'
                  : `确认后第 ${oldRing.ringNo} 环（第 ${oldRing.generation ?? 1} 代）整体留档，新环（第 ${(oldRing.generation ?? 1) + 1} 代）从零建档`
              }}
            </span>
          </div>
        </template>
      </el-alert>

      <el-descriptions :column="3" border size="small" style="margin-bottom: 12px">
        <el-descriptions-item label="换环日期">{{ form.replaceDate }}</el-descriptions-item>
        <el-descriptions-item label="新环类型">{{ form.newSegmentType }}</el-descriptions-item>
        <el-descriptions-item label="新环安装日期">{{ form.newInstallDate }}</el-descriptions-item>
        <el-descriptions-item label="受影响裂缝">{{ preview.cracks.length }} 条</el-descriptions-item>
        <el-descriptions-item label="受影响复测">{{ preview.surveys.length }} 条测次</el-descriptions-item>
        <el-descriptions-item label="受影响建议">{{ preview.advices.length }} 条</el-descriptions-item>
      </el-descriptions>

      <p v-if="preview.order.lastErrorCode" class="wizard-retry">
        上次确认失败：{{ replacementErrorText(preview.order.lastErrorCode) }}（已重试 {{ preview.order.attempts ?? 0 }} 次，单据与范围已保留，重试不会重复建环）
      </p>

      <h4 class="wizard-subtitle">随原环留档的裂缝（{{ preview.cracks.length }}）</h4>
      <el-table :data="preview.cracks" border stripe size="small">
        <el-table-column prop="code" label="裂缝编号" width="130" />
        <el-table-column prop="position" label="部位" width="76" />
        <el-table-column prop="direction" label="走向" width="76" />
        <el-table-column label="当前宽度" width="100">
          <template #default="{ row }">{{ row.widthMm.toFixed(2) }} mm</template>
        </el-table-column>
        <el-table-column label="复测次数" width="80">
          <template #default="{ row }">{{ surveyRowsOfCrack(row).length }}</template>
        </el-table-column>
        <el-table-column prop="state" label="状态" width="90" />
        <template #empty><span class="wizard-empty">原环暂无裂缝，新环将从零建档</span></template>
      </el-table>

      <h4 class="wizard-subtitle">随原环留档的全部复测记录（{{ preview.surveys.length }}）</h4>
      <el-table :data="preview.surveys.sort((a, b) => a.crackId.localeCompare(b.crackId) || a.seq - b.seq)" border stripe size="small" max-height="220">
        <el-table-column label="裂缝编号" width="130">
          <template #default="{ row }">{{ crackCodeOf(row.crackId) }}</template>
        </el-table-column>
        <el-table-column prop="seq" label="测次" width="64" />
        <el-table-column prop="date" label="复测日期" width="112" />
        <el-table-column label="宽度(mm)" width="100">
          <template #default="{ row }">{{ row.widthMm.toFixed(2) }}</template>
        </el-table-column>
        <el-table-column label="变化量(mm)" width="100">
          <template #default="{ row }">{{ row.deltaWidthMm.toFixed(2) }}</template>
        </el-table-column>
        <el-table-column prop="surveyor" label="复测人" width="90" />
        <template #empty><span class="wizard-empty">无复测记录</span></template>
      </el-table>

      <h4 class="wizard-subtitle">随原环留档的整治建议（{{ preview.advices.length }}）</h4>
      <el-table :data="preview.advices" border stripe size="small">
        <el-table-column label="裂缝编号" width="130">
          <template #default="{ row }">{{ crackCodeOf(row.crackId) }}</template>
        </el-table-column>
        <el-table-column label="等级" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="levelTagType(row)">{{ row.level }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="measure" label="措施" width="90" />
        <el-table-column prop="state" label="状态" width="90" />
        <el-table-column prop="basis" label="判定依据" min-width="200" show-overflow-tooltip />
        <template #empty><span class="wizard-empty">无整治建议</span></template>
      </el-table>
    </template>

    <template #footer>
      <el-button @click="handleClose">{{ order?.status === 'done' ? '关闭' : '取消' }}</el-button>
      <template v-if="!order || order.status !== 'done'">
        <el-button v-if="step === 1" :icon="ArrowLeft" :loading="submitting" @click="step = 0">
          返回修改
        </el-button>
        <el-button v-if="step === 1" :loading="submitting" @click="refreshPreview">重新预览</el-button>
        <el-button v-if="step === 0" type="primary" :icon="ArrowRight" :loading="submitting" @click="goPreview">
          登记并预览影响范围
        </el-button>
        <el-button
          v-else
          type="danger"
          :loading="submitting"
          :disabled="!!preview?.drifted"
          @click="confirmExecute"
        >
          确认换环：原环留档 / 新环建档
        </el-button>
      </template>
    </template>
  </el-dialog>
</template>

<style scoped>
.wizard-subtitle {
  margin: 14px 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--tc-ink, #16233a);
}

.wizard-empty {
  font-size: 12px;
  color: #8c99ab;
}

.wizard-retry {
  margin: 0 0 10px;
  padding: 8px 12px;
  font-size: 12px;
  color: #c0392b;
  background: #fdecea;
  border-radius: 8px;
}
</style>
