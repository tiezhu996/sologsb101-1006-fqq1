<script setup lang="ts">
/**
 * <ReplacementWizard> 换环三步向导：
 * 1. 登记：换环日期、原因、新环安装信息（含确认人）；
 * 2. 预览：受影响裂缝、复测、整治建议，确认范围无误后才允许进入下一步；
 * 3. 确认：原子执行（原环整体留档、新环按预生成 id 从零建档），失败保留单据可重试。
 */
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { ArrowLeft, ArrowRight, Check, WarningFilled } from '@element-plus/icons-vue'
import LevelTag from '@/components/common/LevelTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useReplacementStore, type ReplacementPreview } from '@/stores/replacementStore'
import { useSectionStore } from '@/stores/sectionStore'
import {
  EMPTY_REPLACEMENT_DRAFT,
  REPLACEMENT_REASONS,
  replacementStatusType,
  type Replacement,
  type ReplacementDraft
} from '@/types/replacement'
import { SEGMENT_TYPES } from '@/types/ring'
import { validateReplacementDraft } from '@/types/replacement'
import { formatMileage } from '@/types/section'

const props = defineProps<{
  modelValue: boolean
  /** 传入已存在的换环单 id 时为「预览/确认/重试」模式；不传为新登记模式 */
  replacementId?: string | null
  /** 新登记时预选的原环 id */
  defaultOldRingId?: string | null
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'completed', payload: { replacementId: string; newRingId: string }): void
}>()

const sectionStore = useSectionStore()
const replacementStore = useReplacementStore()

const step = ref<1 | 2 | 3>(1)
const formRef = ref<FormInstance>()
const submitting = ref(false)
const previewLoading = ref(false)
const preview = ref<ReplacementPreview | null>(null)
const scopeAcknowledged = ref(false)
const activeId = ref<string | null>(null)
const activeReplacement = ref<Replacement | null>(null)
const scopeDriftError = ref(false)

const form = reactive<ReplacementDraft>({ ...EMPTY_REPLACEMENT_DRAFT })

const rules: FormRules = {
  oldRingId: [{ required: true, message: '请选择被更换的原环', trigger: 'change' }],
  replaceDate: [{ required: true, message: '请选择换环施工日期', trigger: 'change' }],
  reason: [{ required: true, message: '请选择换环原因', trigger: 'change' }],
  reasonDetail: [{ required: true, message: '请填写换环原因说明', trigger: 'blur' }],
  newMileage: [{ required: true, message: '请填写新环里程（m）', trigger: 'blur' }],
  newSegmentType: [{ required: true, message: '请选择管片类型', trigger: 'change' }],
  newInstallDate: [{ required: true, message: '请选择新环安装日期', trigger: 'change' }],
  confirmedBy: [{ required: true, message: '请填写确认人', trigger: 'blur' }]
}

const dialogVisible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})

const isEditMode = computed(() => Boolean(props.replacementId))

const ringOptions = computed(() =>
  sectionStore.currentRings.map((ring) => {
    const section = sectionStore.sectionById.get(ring.sectionId)
    return {
      label: `${section ? section.line : '未知线路'} · 第 ${ring.ringNo} 环 · ${formatMileage(ring.mileage)} · ${ring.segmentType}`,
      value: ring.id
    }
  })
)

const selectedOldRing = computed(() =>
  form.oldRingId ? sectionStore.ringById.get(form.oldRingId) ?? null : null
)

const pendingOnSelected = computed(() =>
  form.oldRingId ? replacementStore.pendingOfRing(form.oldRingId) : null
)

const drawerTitle = computed(() => {
  if (activeReplacement.value) return `换环单 · ${activeReplacement.value.id}`
  return '登记换环'
})

watch(
  () => props.modelValue,
  async (visible) => {
    if (!visible) return
    step.value = 1
    preview.value = null
    scopeAcknowledged.value = false
    scopeDriftError.value = false
    submitting.value = false
    activeId.value = props.replacementId ?? null

    if (props.replacementId) {
      const rep = replacementStore.replacements.find((item) => item.id === props.replacementId) ?? null
      activeReplacement.value = rep
      if (rep) {
        Object.assign(form, {
          oldRingId: rep.oldRingId,
          replaceDate: rep.replaceDate,
          reason: rep.reason,
          reasonDetail: rep.reasonDetail,
          newMileage: rep.newMileage,
          newSegmentType: rep.newSegmentType,
          newInstallDate: rep.newInstallDate,
          manufacturer: rep.manufacturer,
          batchNo: rep.batchNo,
          constructionUnit: rep.constructionUnit,
          confirmedBy: rep.confirmedBy
        })
        // 失败/待确认单打开即回到预览，已完成单只给看详情
        step.value = rep.status === '已完成' ? 3 : 2
        await loadPreview()
      }
    } else {
      activeReplacement.value = null
      const presetRing = props.defaultOldRingId ?? sectionStore.currentRings[0]?.id ?? ''
      const ring = presetRing ? sectionStore.ringById.get(presetRing) : undefined
      Object.assign(form, {
        ...EMPTY_REPLACEMENT_DRAFT,
        oldRingId: presetRing,
        newMileage: ring ? ring.mileage : 0,
        newSegmentType: ring ? ring.segmentType : '钢筋混凝土',
        replaceDate: new Date().toISOString().slice(0, 10)
      })
    }
  }
)

watch(
  () => form.oldRingId,
  (ringId) => {
    const ring = ringId ? sectionStore.ringById.get(ringId) : undefined
    if (ring) {
      form.newMileage = ring.mileage
      if (!form.newSegmentType) form.newSegmentType = ring.segmentType
    }
  }
)

async function submitRegistration(): Promise<void> {
  const instance = formRef.value
  if (!instance) return
  const valid = await instance.validate().catch(() => false)
  if (!valid) return
  const fieldErrors = validateReplacementDraft(form)
  if (Object.keys(fieldErrors).length > 0) {
    ElMessage.error(Object.values(fieldErrors)[0])
    return
  }
  submitting.value = true
  try {
    if (activeId.value) {
      const updated = await replacementStore.updateDraft(activeId.value, { ...form })
      activeReplacement.value = updated
    } else {
      const created = await replacementStore.register({ ...form })
      activeId.value = created.id
      activeReplacement.value = created
    }
    await loadPreview()
    step.value = 2
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '登记换环单失败')
  } finally {
    submitting.value = false
  }
}

async function loadPreview(): Promise<void> {
  if (!activeId.value) return
  previewLoading.value = true
  try {
    preview.value = await replacementStore.preview(activeId.value)
    scopeDriftError.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '预览失败')
  } finally {
    previewLoading.value = false
  }
}

async function confirmExecute(): Promise<void> {
  if (!activeId.value) return
  if (!scopeAcknowledged.value) {
    ElMessage.warning('请先勾选确认影响范围')
    return
  }
  submitting.value = true
  try {
    const result = await replacementStore.confirm(activeId.value, {
      confirmedBy: form.confirmedBy.trim(),
      allowScopeDrift: true
    })
    ElMessage.success(result.executed ? '换环已完成：原环已留档，新环从零建档' : '换环单此前已完成，未重复建环')
    step.value = 3
    activeReplacement.value =
      replacementStore.replacements.find((item) => item.id === activeId.value) ?? activeReplacement.value
    emit('completed', { replacementId: activeId.value, newRingId: result.newRingId })
  } catch (error) {
    scopeDriftError.value = true
    activeReplacement.value =
      replacementStore.replacements.find((item) => item.id === activeId.value) ?? activeReplacement.value
    ElMessage.error(error instanceof Error ? error.message : '换环执行失败，换环单与确认范围已保留，可重试')
  } finally {
    submitting.value = false
  }
}

function goCurrentRings(): void {
  dialogVisible.value = false
}
</script>

<template>
  <el-drawer v-model="dialogVisible" :title="drawerTitle" size="720px" :close-on-click-modal="false">
    <el-steps v-if="!activeReplacement || activeReplacement.status !== '已完成'" :active="step - 1" align-center finish-status="success" style="margin-bottom: 20px">
      <el-step title="登记信息" description="换环日期/原因/新环安装" />
      <el-step title="预览影响" description="裂缝/复测/建议" />
      <el-step title="确认换环" description="留档原环·新建新环" />
    </el-steps>

    <!-- 第一步：登记 -->
    <div v-show="step === 1">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="登记后原环及其裂缝、复测、建议暂不改动；预览确认无误后才会执行换环。"
        style="margin-bottom: 16px"
      />
      <el-form ref="formRef" :model="form" :rules="rules" label-width="128px">
        <el-form-item label="被更换原环" prop="oldRingId">
          <el-select v-model="form.oldRingId" filterable style="width: 100%" :disabled="isEditMode" placeholder="选择在役环片">
            <el-option v-for="item in ringOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-alert
          v-if="pendingOnSelected && pendingOnSelected.id !== activeId"
          type="error"
          :closable="false"
          show-icon
          :title="`该环已有${pendingOnSelected.status === '失败' ? '失败待重试' : '待确认'}换环单 ${pendingOnSelected.id}，请在原单上处理，不能重复登记`"
          style="margin: -4px 0 12px"
        />
        <el-form-item label="沿用环号">
          <el-input :model-value="selectedOldRing ? `第 ${selectedOldRing.ringNo} 环（新环沿用原环号）` : ''" disabled />
        </el-form-item>
        <el-form-item label="换环施工日期" prop="replaceDate">
          <el-date-picker v-model="form.replaceDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="换环原因" prop="reason">
          <el-select v-model="form.reason" style="width: 100%">
            <el-option v-for="item in REPLACEMENT_REASONS" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="原因说明" prop="reasonDetail">
          <el-input v-model="form.reasonDetail" type="textarea" :rows="2" placeholder="如：拱顶纵向裂缝月均发展 0.31 mm/月，宽度超限" />
        </el-form-item>

        <el-divider content-position="left">新环安装信息</el-divider>
        <el-form-item label="新环里程(m)" prop="newMileage">
          <el-input-number v-model="form.newMileage" :min="0" :step="1" style="width: 100%" />
        </el-form-item>
        <el-form-item label="管片类型" prop="newSegmentType">
          <el-select v-model="form.newSegmentType" style="width: 100%">
            <el-option v-for="item in SEGMENT_TYPES" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="新环安装日期" prop="newInstallDate">
          <el-date-picker v-model="form.newInstallDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="管片厂家">
          <el-input v-model="form.manufacturer" placeholder="选填" />
        </el-form-item>
        <el-form-item label="批次编号">
          <el-input v-model="form.batchNo" placeholder="选填" />
        </el-form-item>
        <el-form-item label="施工单位">
          <el-input v-model="form.constructionUnit" placeholder="选填" />
        </el-form-item>
        <el-form-item label="确认人" prop="confirmedBy">
          <el-input v-model="form.confirmedBy" placeholder="换环确认负责人" />
        </el-form-item>
      </el-form>
    </div>

    <!-- 第二步：预览 -->
    <div v-show="step === 2" v-loading="previewLoading">
      <template v-if="activeReplacement && preview">
        <el-descriptions :column="2" border size="small" style="margin-bottom: 14px">
          <el-descriptions-item label="换环单">{{ activeReplacement.id }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag size="small" :type="replacementStatusType(activeReplacement.status)">
              {{ activeReplacement.status }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="原环">
            第 {{ preview.oldRingNo }} 环 · {{ preview.oldSegmentType }} · {{ preview.oldInstallDate }} 安装
          </el-descriptions-item>
          <el-descriptions-item label="新环（沿用环号）">
            第 {{ preview.newRingNo }} 环 · {{ form.newSegmentType }} · {{ form.newInstallDate }} 安装
          </el-descriptions-item>
          <el-descriptions-item label="换环日期">{{ activeReplacement.replaceDate }}</el-descriptions-item>
          <el-descriptions-item label="原因">{{ activeReplacement.reason }}</el-descriptions-item>
          <el-descriptions-item label="原因说明" :span="2">{{ activeReplacement.reasonDetail }}</el-descriptions-item>
        </el-descriptions>

        <el-alert
          v-if="activeReplacement.status === '失败'"
          type="error"
          :closable="false"
          show-icon
          :title="`上次执行失败：${activeReplacement.lastError || '未知错误'}。换环单与已确认范围已保留，修正信息后重试不会重复建环。`"
          style="margin-bottom: 12px"
        />

        <h4 class="wizard-subtitle">受影响范围（换环后整体留档，不迁移到新环）</h4>
        <el-row :gutter="12" style="margin-bottom: 12px">
          <el-col :span="8">
            <div class="wizard-stat">裂缝 <strong>{{ preview.cracks.length }}</strong> 条</div>
          </el-col>
          <el-col :span="8">
            <div class="wizard-stat">复测记录 <strong>{{ preview.surveyCount }}</strong> 条</div>
          </el-col>
          <el-col :span="8">
            <div class="wizard-stat">整治建议 <strong>{{ preview.adviceCount }}</strong> 条</div>
          </el-col>
        </el-row>

        <el-table :data="preview.cracks" border stripe size="small" max-height="280">
          <el-table-column prop="code" label="裂缝编号" width="130" />
          <el-table-column label="部位/走向" width="120">
            <template #default="{ row }">{{ row.position }} / {{ row.direction }}</template>
          </el-table-column>
          <el-table-column prop="state" label="状态" width="90" />
          <el-table-column label="当前宽度" width="100">
            <template #default="{ row }">{{ row.widthMm.toFixed(2) }} mm</template>
          </el-table-column>
          <el-table-column label="复测/建议" width="90">
            <template #default="{ row }">{{ row.surveyCount }} / {{ row.adviceCount }}</template>
          </el-table-column>
          <el-table-column label="末次速率" min-width="150">
            <template #default="{ row }">
              <LevelTag :level="row.latestLevel" :rate="row.surveyCount > 1 ? row.latestRate : undefined" size="small" />
            </template>
          </el-table-column>
          <template #empty>
            <span class="muted">原环暂无裂缝，换环后新环直接以空档案启用</span>
          </template>
        </el-table>

        <el-alert
          type="warning"
          :closable="false"
          show-icon
          style="margin-top: 14px"
          title="确认后：原环标记为「已换环」整体留档（裂缝与全部复测仍可按原环片在历史中查询），新环沿用环号从零建档，老裂缝记录不会挂到新环片。"
        />
        <el-checkbox v-model="scopeAcknowledged" style="margin-top: 12px">
          我已核对上述影响范围，确认按此换环（新环安装信息完整、无跨环冲突）
        </el-checkbox>
        <el-alert
          v-if="scopeDriftError"
          type="error"
          :closable="false"
          show-icon
          :icon="WarningFilled"
          title="执行未成功，换环单与已确认范围已保留。可修正信息后重试，已建档的新环不会重复创建。"
          style="margin-top: 10px"
        />
      </template>
      <EmptyPanel v-else compact title="预览加载中" description="正在汇总原环裂缝、复测与整治建议…" />
    </div>

    <!-- 第三步：完成/详情 -->
    <div v-show="step === 3">
      <template v-if="activeReplacement">
        <el-result icon="success" title="换环已完成" :sub-title="`换环单 ${activeReplacement.id}`" />
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="原环（已留档）">
            第 {{ activeReplacement.oldRingNo }} 环 · 换环日期 {{ activeReplacement.replaceDate }}
          </el-descriptions-item>
          <el-descriptions-item label="留档裂缝">
            {{ activeReplacement.confirmedCrackIds.length }} 条裂缝及其全部复测、建议均按原环片可查
          </el-descriptions-item>
          <el-descriptions-item label="新环（从零建档）">
            第 {{ activeReplacement.newRingNo }} 环 · {{ activeReplacement.newSegmentType }} ·
            {{ activeReplacement.newInstallDate }} 安装 · 环 id {{ activeReplacement.newRingId }}
          </el-descriptions-item>
          <el-descriptions-item label="管片批次">
            {{ activeReplacement.manufacturer || '—' }} / {{ activeReplacement.batchNo || '—' }}
          </el-descriptions-item>
          <el-descriptions-item label="确认人 / 时间">
            {{ activeReplacement.confirmedBy }} /
            {{ activeReplacement.confirmedAt ? new Date(activeReplacement.confirmedAt).toLocaleString('zh-CN') : '—' }}
          </el-descriptions-item>
        </el-descriptions>
        <div style="margin-top: 16px; text-align: center">
          <el-button type="primary" @click="goCurrentRings">完成</el-button>
        </div>
      </template>
    </div>

    <template #footer>
      <div style="display: flex; justify-content: space-between">
        <el-button
          v-if="step === 2 && activeReplacement && activeReplacement.status !== '已完成'"
          :icon="ArrowLeft"
          @click="step = 1"
        >
          返回修改
        </el-button>
        <span v-else />
        <div>
          <el-button @click="dialogVisible = false">{{ step === 3 ? '关闭' : '取消' }}</el-button>
          <el-button v-if="step === 1" type="primary" :icon="ArrowRight" :loading="submitting" @click="submitRegistration">
            登记并预览影响
          </el-button>
          <template v-if="step === 2 && activeReplacement && activeReplacement.status !== '已完成'">
            <el-button type="primary" :icon="Check" :loading="submitting" @click="confirmExecute">
              {{ activeReplacement.status === '失败' ? '重试换环（不重复建环）' : '确认换环' }}
            </el-button>
          </template>
        </div>
      </div>
    </template>
  </el-drawer>
</template>

<style scoped>
.wizard-subtitle {
  margin: 4px 0 8px;
  font-size: 14px;
  font-weight: 600;
}

.wizard-stat {
  padding: 10px 12px;
  background: #fbfcfe;
  border: 1px solid var(--tc-line);
  border-radius: 8px;
  font-size: 13px;
  color: var(--tc-ink-soft);
}

.wizard-stat strong {
  font-size: 18px;
  color: var(--tc-ink);
  margin: 0 2px;
}
</style>
