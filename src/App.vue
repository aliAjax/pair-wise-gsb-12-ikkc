<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import {
  SECTIONS,
  SPOTS,
  VEHICLE_TYPES,
  checkDispatch,
  seedJobs,
  seedVehicles,
  sectionById,
  spotById,
  toNightMinutes,
  validWindow,
  type Job,
  type Vehicle
} from "./domain";

const STORAGE_KEY = "metro-night-dispatch-v1";

function load(): { jobs: Job[]; vehicles: Vehicle[] } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as { jobs: Job[]; vehicles: Vehicle[] };
      if (Array.isArray(data.jobs) && Array.isArray(data.vehicles)) return data;
    }
  } catch {
    // 数据损坏时回退到示例数据
  }
  const vehicles = seedVehicles();
  return { jobs: seedJobs(vehicles), vehicles };
}

const loaded = load();
const jobs = ref<Job[]>(loaded.jobs);
const vehicles = ref<Vehicle[]>(loaded.vehicles);

const jobForm = reactive({
  name: "",
  sectionId: "",
  blockStart: "23:30",
  blockEnd: "01:30",
  vehicleType: "",
  spotId: ""
});

const vehicleForm = reactive({
  code: "",
  type: "",
  availStart: "23:00",
  availEnd: "04:00",
  battery: 80,
  rate: 2.5,
  spotId: ""
});

const editingId = ref<string | null>(null);
const editForm = reactive({ sectionId: "", blockStart: "", blockEnd: "", spotId: "" });

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ jobs: jobs.value, vehicles: vehicles.value }));
}

const byStart = (a: Job, b: Job) => toNightMinutes(a.blockStart) - toNightMinutes(b.blockStart);
const pendingJobs = computed(() => jobs.value.filter((j) => j.status === "待派").sort(byStart));
const lockedJobs = computed(() => jobs.value.filter((j) => j.status === "已派").sort(byStart));

const sectionBoard = computed(() =>
  SECTIONS.map((section) => ({
    section,
    jobs: lockedJobs.value.filter((j) => j.sectionId === section.id)
  }))
);

const busySectionCount = computed(() => new Set(lockedJobs.value.map((j) => j.sectionId)).size);

function sectionName(id: string) {
  return sectionById(id).name;
}

function spotName(id: string) {
  return spotById(id).name;
}

function vehicleOf(job: Job) {
  return vehicles.value.find((v) => v.id === job.vehicleId) ?? null;
}

function vehicleCode(id: string | null) {
  return vehicles.value.find((v) => v.id === id)?.code ?? "未指派";
}

function assignedName(vehicleId: string) {
  return lockedJobs.value.find((j) => j.vehicleId === vehicleId)?.name ?? "空闲";
}

function batteryClass(battery: number) {
  if (battery >= 60) return "";
  if (battery >= 30) return "mid";
  return "low";
}

function addJob() {
  if (!validWindow(jobForm.blockStart, jobForm.blockEnd)) {
    alert("封锁结束需晚于开始（跨零点按次日凌晨计，如 23:30–01:30）");
    return;
  }
  jobs.value = [
    {
      ...jobForm,
      id: crypto.randomUUID(),
      status: "待派",
      locked: false,
      vehicleId: null,
      crossKm: null,
      needBattery: null,
      reasons: ["待派车：登记成功，请选择轨道车核对派车"],
      createdAt: new Date().toISOString()
    },
    ...jobs.value
  ];
  Object.assign(jobForm, { name: "", sectionId: "", blockStart: "23:30", blockEnd: "01:30", vehicleType: "", spotId: "" });
  persist();
}

function addVehicle() {
  if (!validWindow(vehicleForm.availStart, vehicleForm.availEnd)) {
    alert("可用时段结束需晚于开始（跨零点按次日凌晨计）");
    return;
  }
  const battery = Math.min(100, Math.max(0, Number(vehicleForm.battery) || 0));
  vehicles.value = [
    ...vehicles.value,
    { ...vehicleForm, battery, rate: Number(vehicleForm.rate) || 2.5, id: crypto.randomUUID() }
  ];
  Object.assign(vehicleForm, { code: "", type: "", availStart: "23:00", availEnd: "04:00", battery: 80, rate: 2.5, spotId: "" });
  persist();
}

// 派车：核对通过则确认并锁住关系，否则留在待派区并写明原因
function dispatch(job: Job) {
  const vehicle = vehicleOf(job);
  if (!vehicle) {
    job.reasons = ["请先选择轨道车再派车"];
    return;
  }
  const result = checkDispatch(job, vehicle, jobs.value);
  job.crossKm = result.crossKm;
  job.needBattery = result.needBattery;
  if (result.ok) {
    job.status = "已派";
    job.locked = true;
    job.reasons = [];
  } else {
    job.status = "待派";
    job.locked = false;
    job.reasons = result.reasons;
  }
  persist();
}

// 重开：解锁并释放占用，保留待派原因可继续跟进
function reopen(job: Job) {
  job.status = "待派";
  job.locked = false;
  job.reasons = [...job.reasons, `人工重开：已释放 ${sectionName(job.sectionId)} 与车辆占用，需重新核对`];
  persist();
}

// 撤单：释放区间与车辆占用
function cancelJob(job: Job) {
  if (!confirm(`确认撤单《${job.name}》？撤单后立即释放区间与车辆占用。`)) return;
  jobs.value = jobs.value.filter((j) => j.id !== job.id);
  persist();
}

function removeJob(id: string) {
  jobs.value = jobs.value.filter((j) => j.id !== id);
  persist();
}

function startReschedule(job: Job) {
  editingId.value = job.id;
  Object.assign(editForm, {
    sectionId: job.sectionId,
    blockStart: job.blockStart,
    blockEnd: job.blockEnd,
    spotId: job.spotId
  });
}

// 改点：先释放原占用，按新区间/时段重新核对；不通过则退回待派区
function saveReschedule(job: Job) {
  if (!validWindow(editForm.blockStart, editForm.blockEnd)) {
    alert("封锁结束需晚于开始（跨零点按次日凌晨计）");
    return;
  }
  const vehicle = vehicleOf(job);
  if (!vehicle) return;
  const candidate: Job = { ...job, ...editForm };
  const result = checkDispatch(candidate, vehicle, jobs.value);
  Object.assign(job, {
    sectionId: editForm.sectionId,
    blockStart: editForm.blockStart,
    blockEnd: editForm.blockEnd,
    spotId: editForm.spotId,
    crossKm: result.crossKm,
    needBattery: result.needBattery
  });
  if (result.ok) {
    job.reasons = [];
  } else {
    job.status = "待派";
    job.locked = false;
    job.reasons = ["改点后核对未通过，原占用已释放：", ...result.reasons];
  }
  editingId.value = null;
  persist();
}

function removeVehicle(vehicle: Vehicle) {
  const locked = lockedJobs.value.find((j) => j.vehicleId === vehicle.id);
  if (locked) {
    alert(`${vehicle.code} 已派给锁定作业《${locked.name}》，请先撤单或重开。`);
    return;
  }
  if (!confirm(`确认删除轨道车 ${vehicle.code}？`)) return;
  vehicles.value = vehicles.value.filter((v) => v.id !== vehicle.id);
  for (const job of jobs.value) {
    if (job.vehicleId === vehicle.id) job.vehicleId = null;
  }
  persist();
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">地铁夜间检修 · 值班派车</p>
          <h1>检修派车台</h1>
          <p class="subtitle">
            登记检修作业的行车区间、封锁时段、车型与驻车点，轨道车登记可用时段与剩余电量。
            派车前自动核对同区间占用、相邻区间串车与往返耗电，核对不过的作业留在待派区并写明原因。
          </p>
        </div>
        <div class="stack">
          <span class="tag">Vue3</span>
          <span class="tag">TypeScript</span>
          <span class="tag">localStorage</span>
        </div>
      </header>

      <section class="metrics">
        <article class="metric"><span>待派作业</span><strong>{{ pendingJobs.length }}</strong></article>
        <article class="metric"><span>已派锁定</span><strong>{{ lockedJobs.length }}</strong></article>
        <article class="metric"><span>轨道车</span><strong>{{ vehicles.length }}</strong></article>
        <article class="metric"><span>今晚封锁区间</span><strong>{{ busySectionCount }}</strong></article>
      </section>

      <section class="workspace">
        <div class="side">
          <form class="panel" @submit.prevent="addJob">
            <h2>作业登记</h2>
            <div class="form-grid">
              <label>
                作业名称
                <input v-model.trim="jobForm.name" required placeholder="如：接触网巡检" />
              </label>
              <label>
                行车区间
                <select v-model="jobForm.sectionId" required>
                  <option value="" disabled>请选择</option>
                  <option v-for="s in SECTIONS" :key="s.id" :value="s.id">{{ s.name }}（{{ s.startKm }}–{{ s.endKm }}km）</option>
                </select>
              </label>
              <div class="time-pair">
                <label>封锁开始<input v-model="jobForm.blockStart" type="time" required /></label>
                <label>封锁结束<input v-model="jobForm.blockEnd" type="time" required /></label>
              </div>
              <label>
                车型
                <select v-model="jobForm.vehicleType" required>
                  <option value="" disabled>请选择</option>
                  <option v-for="t in VEHICLE_TYPES" :key="t" :value="t">{{ t }}</option>
                </select>
              </label>
              <label>
                驻车点
                <select v-model="jobForm.spotId" required>
                  <option value="" disabled>请选择</option>
                  <option v-for="p in SPOTS" :key="p.id" :value="p.id">{{ p.name }}</option>
                </select>
              </label>
              <button type="submit">登记作业（进入待派区）</button>
            </div>
          </form>

          <form class="panel" @submit.prevent="addVehicle">
            <h2>轨道车登记</h2>
            <div class="form-grid">
              <label>
                车辆编号
                <input v-model.trim="vehicleForm.code" required placeholder="如：GCY-05" />
              </label>
              <label>
                车型
                <select v-model="vehicleForm.type" required>
                  <option value="" disabled>请选择</option>
                  <option v-for="t in VEHICLE_TYPES" :key="t" :value="t">{{ t }}</option>
                </select>
              </label>
              <div class="time-pair">
                <label>可用开始<input v-model="vehicleForm.availStart" type="time" required /></label>
                <label>可用结束<input v-model="vehicleForm.availEnd" type="time" required /></label>
              </div>
              <div class="time-pair">
                <label>剩余电量（%）<input v-model.number="vehicleForm.battery" type="number" min="0" max="100" required /></label>
                <label>电耗（%/km）<input v-model.number="vehicleForm.rate" type="number" min="0.5" max="8" step="0.1" required /></label>
              </div>
              <label>
                驻车点
                <select v-model="vehicleForm.spotId" required>
                  <option value="" disabled>请选择</option>
                  <option v-for="p in SPOTS" :key="p.id" :value="p.id">{{ p.name }}</option>
                </select>
              </label>
              <button type="submit">登记轨道车</button>
            </div>
          </form>
        </div>

        <section class="list-panel">
          <div class="toolbar">
            <h2>区间占用看板</h2>
            <span class="hint">仅统计已派锁定作业</span>
          </div>
          <div class="board">
            <div v-for="row in sectionBoard" :key="row.section.id" class="section-row" :class="{ busy: row.jobs.length }">
              <div class="section-name">
                {{ row.section.name }}
                <small>{{ row.section.startKm }}–{{ row.section.endKm }} km</small>
              </div>
              <div class="chips">
                <span v-if="!row.jobs.length" class="chip free">空闲</span>
                <span v-for="j in row.jobs" :key="j.id" class="chip busy-chip">
                  🔒 {{ j.name }} · {{ j.blockStart }}–{{ j.blockEnd }} · {{ vehicleCode(j.vehicleId) }}
                </span>
              </div>
            </div>
          </div>

          <div class="toolbar sub">
            <h2>待派区</h2>
            <span class="hint">核对不通过的作业留在这里，写明冲突区间、串车距离或缺电量</span>
          </div>
          <div class="record-grid">
            <div v-if="!pendingJobs.length" class="empty">待派区已清空</div>
            <article v-for="job in pendingJobs" :key="job.id" class="record pending-card">
              <div class="record-head">
                <p class="record-title">{{ job.name }}</p>
                <span class="status pending">待派</span>
              </div>
              <div class="details">
                <span>行车区间: {{ sectionName(job.sectionId) }}</span>
                <span>封锁时段: {{ job.blockStart }}–{{ job.blockEnd }}</span>
                <span>车型: {{ job.vehicleType }}</span>
                <span>驻车点: {{ spotName(job.spotId) }}</span>
              </div>
              <ul v-if="job.reasons.length" class="reasons">
                <li v-for="(reason, i) in job.reasons" :key="i">{{ reason }}</li>
              </ul>
              <div class="dispatch-row">
                <select v-model="job.vehicleId">
                  <option :value="null" disabled>选择轨道车</option>
                  <option v-for="v in vehicles" :key="v.id" :value="v.id">
                    {{ v.code }} · {{ v.type }} · 电 {{ v.battery }}% · {{ spotName(v.spotId) }}
                  </option>
                </select>
                <button type="button" @click="dispatch(job)">派车</button>
                <button class="danger" type="button" @click="removeJob(job.id)">删除</button>
              </div>
            </article>
          </div>

          <div class="toolbar sub">
            <h2>已派锁定</h2>
            <span class="hint">确认派车后锁住关系，改点/重开/撤单才会释放占用</span>
          </div>
          <div class="record-grid">
            <div v-if="!lockedJobs.length" class="empty">暂无已派作业</div>
            <article v-for="job in lockedJobs" :key="job.id" class="record locked-card">
              <div class="record-head">
                <p class="record-title">{{ job.name }}</p>
                <span class="status locked">🔒 已派锁定</span>
              </div>
              <div class="details">
                <span>行车区间: {{ sectionName(job.sectionId) }}</span>
                <span>封锁时段: {{ job.blockStart }}–{{ job.blockEnd }}</span>
                <span>轨道车: {{ vehicleCode(job.vehicleId) }}</span>
                <span>驻车点: {{ spotName(job.spotId) }}</span>
                <span>串车距离: {{ job.crossKm ?? "—" }} km</span>
                <span>往返耗电: 约 {{ job.needBattery ?? "—" }}%</span>
              </div>
              <div v-if="editingId === job.id" class="edit-box">
                <label>
                  行车区间
                  <select v-model="editForm.sectionId">
                    <option v-for="s in SECTIONS" :key="s.id" :value="s.id">{{ s.name }}</option>
                  </select>
                </label>
                <div class="time-pair">
                  <label>封锁开始<input v-model="editForm.blockStart" type="time" required /></label>
                  <label>封锁结束<input v-model="editForm.blockEnd" type="time" required /></label>
                </div>
                <label>
                  驻车点
                  <select v-model="editForm.spotId">
                    <option v-for="p in SPOTS" :key="p.id" :value="p.id">{{ p.name }}</option>
                  </select>
                </label>
                <div class="actions">
                  <button type="button" @click="saveReschedule(job)">保存改点</button>
                  <button class="secondary" type="button" @click="editingId = null">取消</button>
                </div>
                <p class="hint">保存即释放原占用并重新核对；核对不通过将退回待派区并写明原因。</p>
              </div>
              <div v-else class="actions">
                <button type="button" @click="startReschedule(job)">改点</button>
                <button class="secondary" type="button" @click="reopen(job)">重开</button>
                <button class="danger" type="button" @click="cancelJob(job)">撤单</button>
              </div>
            </article>
          </div>

          <div class="toolbar sub">
            <h2>轨道车</h2>
            <span class="hint">电量低于往返需求时无法派出</span>
          </div>
          <div class="record-grid">
            <div v-if="!vehicles.length" class="empty">暂无轨道车</div>
            <article v-for="v in vehicles" :key="v.id" class="record">
              <div class="record-head">
                <p class="record-title">{{ v.code }}</p>
                <span class="tag">{{ v.type }}</span>
              </div>
              <div class="battery-row">
                <div class="battery-track">
                  <div class="battery-fill" :class="batteryClass(v.battery)" :style="{ width: `${v.battery}%` }" />
                </div>
                <strong>{{ v.battery }}%</strong>
              </div>
              <div class="details">
                <span>可用时段: {{ v.availStart }}–{{ v.availEnd }}</span>
                <span>驻车点: {{ spotName(v.spotId) }}</span>
                <span>电耗: {{ v.rate }} %/km</span>
                <span>当前任务: {{ assignedName(v.id) }}</span>
              </div>
              <div class="dispatch-row">
                <label class="inline">
                  更新电量
                  <input v-model.number="v.battery" type="number" min="0" max="100" @change="persist" />
                </label>
                <button class="danger" type="button" @click="removeVehicle(v)">删除</button>
              </div>
            </article>
          </div>
        </section>
      </section>
    </div>
  </main>
</template>
