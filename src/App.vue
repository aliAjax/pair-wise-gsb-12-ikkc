<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { storeToRefs } from "pinia";
import { useDispatchStore } from "./store/dispatch";
import {
  BATTERY_RESERVE,
  SAFE_GAP_KM,
  SECTIONS,
  VEHICLE_TYPES,
  batteryLeft,
  evaluateDispatch,
  powerNeedPct,
  roundTripKm,
  sectionById,
  sectionLabel,
  toMinutes,
  usedBatteryPct,
  type Job,
} from "./domain";

const store = useDispatchStore();
const { jobs, vehicles, pendingJobs, lockedJobs } = storeToRefs(store);

const jobForm = reactive({
  title: "",
  sectionId: "",
  blockStart: "23:00",
  blockEnd: "01:00",
  vehicleType: "",
  parking: "",
  workKm: 4.0,
});

const vehicleForm = reactive({
  code: "",
  type: "",
  availFrom: "22:00",
  availTo: "04:00",
  battery: 90,
  rate: 1.0,
  parking: "",
});

const jobError = ref("");
const vehicleError = ref("");
const rescheduleError = ref("");

const pickerJobId = ref<string | null>(null);
const pickedVehicleId = ref("");
const rescheduleJobId = ref<string | null>(null);
const rescheduleForm = reactive({ start: "", end: "" });

const pickerJob = computed(() => jobs.value.find((j) => j.id === pickerJobId.value) ?? null);
const pickerEval = computed(() =>
  pickerJob.value ? evaluateDispatch(pickerJob.value, vehicles.value, jobs.value) : null
);
const canConfirm = computed(() => {
  const ev = pickerEval.value;
  if (!ev || ev.occupancy.length > 0 || !pickedVehicleId.value) return false;
  const picked = ev.perVehicle.find((pv) => pv.vehicle.id === pickedVehicleId.value);
  return !!picked && picked.failures.length === 0;
});

const metrics = computed(() => [
  { label: "待派作业", value: pendingJobs.value.length },
  { label: "已派锁定", value: lockedJobs.value.length },
  { label: "轨道车", value: vehicles.value.length },
  { label: "今夜作业", value: jobs.value.length },
]);

const chartRows = computed(() =>
  SECTIONS.map((s) => ({
    label: `${s.id} 已锁作业`,
    value: lockedJobs.value.filter((j) => j.sectionId === s.id).length,
  }))
);
const maxChart = computed(() => Math.max(1, ...chartRows.value.map((row) => row.value)));

function fmtTime(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function vehicleCode(id: string | null) {
  return vehicles.value.find((v) => v.id === id)?.code ?? "—";
}

function lockedPower(job: Job) {
  const vehicle = vehicles.value.find((v) => v.id === job.vehicleId);
  return vehicle ? powerNeedPct(job, vehicle) : 0;
}

function assignedCount(vehicleId: string) {
  return lockedJobs.value.filter((j) => j.vehicleId === vehicleId).length;
}

function submitJob() {
  if (toMinutes(jobForm.blockEnd) <= toMinutes(jobForm.blockStart)) {
    jobError.value = "封锁结束需晚于开始（跨零点请用 01:00 这类凌晨时刻）";
    return;
  }
  jobError.value = "";
  store.registerJob({ ...jobForm, workKm: Number(jobForm.workKm) });
  Object.assign(jobForm, {
    title: "",
    sectionId: "",
    blockStart: "23:00",
    blockEnd: "01:00",
    vehicleType: "",
    parking: "",
    workKm: 4.0,
  });
}

function submitVehicle() {
  if (toMinutes(vehicleForm.availTo) <= toMinutes(vehicleForm.availFrom)) {
    vehicleError.value = "可用结束需晚于开始（跨零点请用 04:00 这类凌晨时刻）";
    return;
  }
  vehicleError.value = "";
  store.registerVehicle({
    ...vehicleForm,
    battery: Number(vehicleForm.battery),
    rate: Number(vehicleForm.rate),
  });
  Object.assign(vehicleForm, {
    code: "",
    type: "",
    availFrom: "22:00",
    availTo: "04:00",
    battery: 90,
    rate: 1.0,
    parking: "",
  });
}

function togglePicker(job: Job) {
  if (pickerJobId.value === job.id) {
    pickerJobId.value = null;
    return;
  }
  pickerJobId.value = job.id;
  rescheduleJobId.value = null;
  const ev = evaluateDispatch(job, vehicles.value, jobs.value);
  const firstPass = ev.perVehicle.find((pv) => pv.failures.length === 0);
  pickedVehicleId.value = ev.occupancy.length === 0 && firstPass ? firstPass.vehicle.id : "";
}

function confirmDispatch() {
  if (!pickerJob.value || !pickedVehicleId.value) return;
  if (store.attemptDispatch(pickerJob.value.id, pickedVehicleId.value)) {
    pickerJobId.value = null;
  }
}

function openReschedule(job: Job) {
  rescheduleJobId.value = job.id;
  pickerJobId.value = null;
  rescheduleErrorReset();
  rescheduleForm.start = job.blockStart;
  rescheduleForm.end = job.blockEnd;
}

function rescheduleErrorReset() {
  rescheduleError.value = "";
}

function confirmReschedule(job: Job) {
  if (toMinutes(rescheduleForm.end) <= toMinutes(rescheduleForm.start)) {
    rescheduleError.value = "结束需晚于开始（跨零点请用凌晨时刻）";
    return;
  }
  rescheduleError.value = "";
  store.rescheduleJob(job.id, rescheduleForm.start, rescheduleForm.end);
  rescheduleJobId.value = null;
}

function cancel(job: Job) {
  if (window.confirm(`确认撤单「${job.title}」？已派车辆与区间占用将立即释放。`)) {
    if (pickerJobId.value === job.id) pickerJobId.value = null;
    if (rescheduleJobId.value === job.id) rescheduleJobId.value = null;
    store.cancelJob(job.id);
  }
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">地铁运营 · 夜间检修</p>
          <h1>地铁夜间检修派车台</h1>
          <p class="subtitle">
            作业登记行车区间、封锁时段、车型与驻车点，轨道车登记可用时段与剩余电量。派车自动核对同区间占用、相邻区间串车与往返耗电，不足项留在待派区并写清原因。
          </p>
        </div>
        <div class="stack">
          <span class="tag">Vue3</span>
          <span class="tag">Pinia</span>
          <span class="tag">TypeScript</span>
          <span class="tag">localStorage</span>
        </div>
      </header>

      <section class="metrics">
        <article v-for="m in metrics" :key="m.label" class="metric">
          <span>{{ m.label }}</span>
          <strong>{{ m.value }}</strong>
        </article>
      </section>

      <p class="hint">
        核对规则：同区间封锁时段重叠即占用冲突 · 相邻区间作业点间距须 ≥ {{ SAFE_GAP_KM.toFixed(1) }} km ·
        往返耗电后须保留 {{ BATTERY_RESERVE }}% 保底电量 · 撤单、改点、重开立即释放车辆与区间占用
      </p>

      <section class="workspace">
        <div class="form-column">
          <form class="panel" @submit.prevent="submitJob">
            <h2>登记检修作业</h2>
            <div class="form-grid">
              <label>
                作业名称
                <input v-model="jobForm.title" required placeholder="如：接触网腕臂检修" />
              </label>
              <label>
                行车区间
                <select v-model="jobForm.sectionId" required>
                  <option value="">请选择</option>
                  <option v-for="s in SECTIONS" :key="s.id" :value="s.id">
                    {{ sectionLabel(s) }}（单程 {{ s.distanceKm }} km）
                  </option>
                </select>
              </label>
              <div class="field-pair">
                <label>
                  封锁开始
                  <input v-model="jobForm.blockStart" type="time" required />
                </label>
                <label>
                  封锁结束
                  <input v-model="jobForm.blockEnd" type="time" required />
                </label>
              </div>
              <label>
                需求车型
                <select v-model="jobForm.vehicleType" required>
                  <option value="">请选择</option>
                  <option v-for="t in VEHICLE_TYPES" :key="t">{{ t }}</option>
                </select>
              </label>
              <label>
                作业点里程（km）
                <input v-model.number="jobForm.workKm" type="number" step="0.1" min="0" max="30" required />
              </label>
              <label>
                驻车点
                <input v-model="jobForm.parking" required placeholder="如：文化宫存车线" />
              </label>
              <p v-if="jobError" class="form-error">{{ jobError }}</p>
              <button type="submit">登记作业</button>
            </div>
          </form>

          <form class="panel" @submit.prevent="submitVehicle">
            <h2>登记轨道车</h2>
            <div class="form-grid">
              <label>
                车辆编号
                <input v-model="vehicleForm.code" required placeholder="如：GC-03" />
              </label>
              <label>
                车型
                <select v-model="vehicleForm.type" required>
                  <option value="">请选择</option>
                  <option v-for="t in VEHICLE_TYPES" :key="t">{{ t }}</option>
                </select>
              </label>
              <div class="field-pair">
                <label>
                  可用自
                  <input v-model="vehicleForm.availFrom" type="time" required />
                </label>
                <label>
                  可用至
                  <input v-model="vehicleForm.availTo" type="time" required />
                </label>
              </div>
              <label>
                剩余电量（%）
                <input v-model.number="vehicleForm.battery" type="number" min="0" max="100" required />
              </label>
              <label>
                耗电率（%/km）
                <input v-model.number="vehicleForm.rate" type="number" step="0.1" min="0.1" max="10" required />
              </label>
              <label>
                驻车点
                <input v-model="vehicleForm.parking" required placeholder="如：车辆段A端" />
              </label>
              <p v-if="vehicleError" class="form-error">{{ vehicleError }}</p>
              <button type="submit">登记轨道车</button>
            </div>
          </form>
        </div>

        <div class="board-column">
          <section class="list-panel">
            <div class="toolbar">
              <h2>待派区 <span class="count-badge">{{ pendingJobs.length }}</span></h2>
            </div>
            <div class="record-grid">
              <div v-if="pendingJobs.length === 0" class="empty">待派区已清空</div>
              <article v-for="job in pendingJobs" :key="job.id" class="record">
                <div class="record-head">
                  <p class="record-title">{{ job.title }}</p>
                  <span class="status">待派</span>
                </div>
                <div class="details">
                  <span>行车区间: {{ sectionLabel(sectionById(job.sectionId)) }}</span>
                  <span>封锁时段: {{ job.blockStart }}–{{ job.blockEnd }}</span>
                  <span>需求车型: {{ job.vehicleType }}</span>
                  <span>驻车点: {{ job.parking }}</span>
                  <span>作业点里程: km {{ Number(job.workKm).toFixed(1) }}</span>
                  <span>往返里程: {{ roundTripKm(job) }} km</span>
                </div>
                <p class="reason" :class="{ ok: job.reason.startsWith('可派') }">待派原因：{{ job.reason }}</p>

                <div v-if="pickerJobId === job.id && pickerEval" class="picker">
                  <div v-if="pickerEval.occupancy.length > 0" class="fail-box">
                    <strong>区间占用冲突，需先改点或撤掉冲突作业</strong>
                    <ul class="fail-list">
                      <li v-for="msg in pickerEval.occupancy" :key="msg">{{ msg }}</li>
                    </ul>
                  </div>
                  <label
                    v-for="pv in pickerEval.perVehicle"
                    :key="pv.vehicle.id"
                    class="vehicle-option"
                    :class="{ selected: pickedVehicleId === pv.vehicle.id }"
                  >
                    <input
                      v-model="pickedVehicleId"
                      type="radio"
                      name="picked-vehicle"
                      :value="pv.vehicle.id"
                      :disabled="pv.failures.length > 0"
                    />
                    <span class="vehicle-option-body">
                      <strong>{{ pv.vehicle.code }} · {{ pv.vehicle.type }}</strong>
                      <span class="vehicle-meta">
                        可用 {{ pv.vehicle.availFrom }}–{{ pv.vehicle.availTo }} · 剩余电量
                        {{ batteryLeft(pv.vehicle, jobs, vehicles) }}%
                      </span>
                      <span v-if="pv.failures.length === 0" class="pass">
                        ✓ 通过核对，往返 {{ roundTripKm(job) }} km 预扣 {{ powerNeedPct(job, pv.vehicle) }}%
                      </span>
                      <ul v-else class="fail-list">
                        <li v-for="f in pv.failures" :key="f">{{ f }}</li>
                      </ul>
                    </span>
                  </label>
                  <div class="actions">
                    <button type="button" :disabled="!canConfirm" @click="confirmDispatch">确认派车并锁定</button>
                    <button type="button" class="secondary" @click="pickerJobId = null">收起</button>
                  </div>
                </div>

                <div v-if="rescheduleJobId === job.id" class="reschedule">
                  <input v-model="rescheduleForm.start" type="time" />
                  <input v-model="rescheduleForm.end" type="time" />
                  <button type="button" @click="confirmReschedule(job)">确认改点</button>
                  <button type="button" class="secondary" @click="rescheduleJobId = null">取消</button>
                  <p v-if="rescheduleError" class="form-error">{{ rescheduleError }}</p>
                </div>

                <div class="actions">
                  <button type="button" @click="togglePicker(job)">派车核对</button>
                  <button type="button" class="secondary" @click="store.reevaluate(job.id)">重新核对</button>
                  <button type="button" class="secondary" @click="openReschedule(job)">改点</button>
                  <button type="button" class="danger" @click="cancel(job)">撤单</button>
                </div>
                <ul class="log">
                  <li v-for="entry in job.log" :key="entry.at + entry.text">
                    <time>{{ fmtTime(entry.at) }}</time>{{ entry.text }}
                  </li>
                </ul>
              </article>
            </div>
          </section>

          <section class="list-panel">
            <div class="toolbar">
              <h2>已派锁定 <span class="count-badge">{{ lockedJobs.length }}</span></h2>
            </div>
            <div class="record-grid">
              <div v-if="lockedJobs.length === 0" class="empty">暂无已派作业</div>
              <article v-for="job in lockedJobs" :key="job.id" class="record">
                <div class="record-head">
                  <p class="record-title">{{ job.title }}</p>
                  <span class="status locked">已锁定</span>
                </div>
                <div class="details">
                  <span>行车区间: {{ sectionLabel(sectionById(job.sectionId)) }}</span>
                  <span>封锁时段: {{ job.blockStart }}–{{ job.blockEnd }}</span>
                  <span>需求车型: {{ job.vehicleType }}</span>
                  <span>驻车点: {{ job.parking }}</span>
                  <span>派车: {{ vehicleCode(job.vehicleId) }}</span>
                  <span>预扣电量: {{ lockedPower(job) }}%</span>
                </div>

                <div v-if="rescheduleJobId === job.id" class="reschedule">
                  <input v-model="rescheduleForm.start" type="time" />
                  <input v-model="rescheduleForm.end" type="time" />
                  <button type="button" @click="confirmReschedule(job)">确认改点</button>
                  <button type="button" class="secondary" @click="rescheduleJobId = null">取消</button>
                  <p v-if="rescheduleError" class="form-error">{{ rescheduleError }}</p>
                </div>

                <div class="actions">
                  <button type="button" class="secondary" @click="store.reopenJob(job.id)">重开</button>
                  <button type="button" class="secondary" @click="openReschedule(job)">改点</button>
                  <button type="button" class="danger" @click="cancel(job)">撤单</button>
                </div>
                <ul class="log">
                  <li v-for="entry in job.log" :key="entry.at + entry.text">
                    <time>{{ fmtTime(entry.at) }}</time>{{ entry.text }}
                  </li>
                </ul>
              </article>
            </div>
          </section>

          <section class="list-panel">
            <div class="toolbar">
              <h2>轨道车 <span class="count-badge">{{ vehicles.length }}</span></h2>
            </div>
            <div class="vehicle-grid">
              <article v-for="v in vehicles" :key="v.id" class="record">
                <div class="record-head">
                  <p class="record-title">{{ v.code }}</p>
                  <span class="status">{{ v.type }}</span>
                </div>
                <div class="details">
                  <span>可用时段: {{ v.availFrom }}–{{ v.availTo }}</span>
                  <span>剩余电量: {{ batteryLeft(v, jobs, vehicles) }}%</span>
                  <span>登记电量: {{ v.battery }}%</span>
                  <span>已占电量: {{ usedBatteryPct(v.id, jobs, vehicles) }}%</span>
                  <span>耗电率: {{ v.rate }}%/km</span>
                  <span>驻车点: {{ v.parking }}</span>
                  <span>已挂作业: {{ assignedCount(v.id) }} 项</span>
                </div>
              </article>
            </div>
            <div class="mini-chart">
              <div v-for="row in chartRows" :key="row.label" class="bar">
                <span>{{ row.label }}</span>
                <div class="bar-track"><div class="bar-fill" :style="{ width: `${(row.value / maxChart) * 100}%` }" /></div>
                <strong>{{ row.value }}</strong>
              </div>
            </div>
          </section>
        </div>
      </section>
    </div>
  </main>
</template>
