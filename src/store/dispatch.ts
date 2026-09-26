import { computed, ref } from "vue";
import { defineStore } from "pinia";
import {
  occupancyConflicts,
  pendingEvaluation,
  powerNeedPct,
  roundTripKm,
  vehicleFailures,
  type Job,
  type JobPayload,
  type Vehicle,
  type VehiclePayload,
} from "../domain";

const STORAGE_KEY = "metro-night-dispatch-v1";

interface Persisted {
  vehicles: Vehicle[];
  jobs: Job[];
}

function load(): Persisted | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Persisted;
  } catch {
    return null;
  }
}

function seedVehicles(): Vehicle[] {
  return [
    { id: "veh-gc01", code: "GC-01", type: "接触网作业车", availFrom: "22:00", availTo: "04:00", battery: 92, rate: 1.2, parking: "车辆段A端" },
    { id: "veh-gc02", code: "GC-02", type: "接触网作业车", availFrom: "23:00", availTo: "03:00", battery: 46, rate: 1.2, parking: "车辆段A端" },
    { id: "veh-jc01", code: "JC-01", type: "轨道检测车", availFrom: "22:30", availTo: "04:00", battery: 81, rate: 0.9, parking: "车辆段B端" },
    { id: "veh-pb01", code: "PB-01", type: "平板运输车", availFrom: "22:00", availTo: "02:00", battery: 88, rate: 1.0, parking: "文化宫存车线" },
  ];
}

function seedJobs(vehicles: Vehicle[]): Job[] {
  const now = Date.now();
  const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60000).toISOString();
  const gc01 = vehicles[0];
  const lockedAt = iso(40);

  const locked: Job = {
    id: "job-wanbi",
    title: "接触网腕臂检修",
    sectionId: "S2",
    blockStart: "23:00",
    blockEnd: "01:00",
    vehicleType: "接触网作业车",
    parking: "文化宫存车线",
    workKm: 4.6,
    status: "locked",
    vehicleId: gc01.id,
    reason: "",
    log: [],
    createdAt: iso(55),
    lockedAt,
  };
  locked.log.push({ at: locked.createdAt, text: "登记作业，进入待派区" });
  locked.log.unshift({
    at: lockedAt,
    text: `确认派车 ${gc01.code}，往返 ${roundTripKm(locked)} km 预扣 ${powerNeedPct(locked, gc01)}% 电，关系已锁定`,
  });

  const pendingPayloads: Array<JobPayload & { id: string; minutesAgo: number }> = [
    { id: "job-tanshang", title: "钢轨探伤", sectionId: "S3", blockStart: "23:30", blockEnd: "01:30", vehicleType: "轨道检测车", parking: "体育馆存车线", workKm: 7.4, minutesAgo: 50 },
    { id: "job-daocha", title: "道岔转辙机养护", sectionId: "S2", blockStart: "00:00", blockEnd: "02:00", vehicleType: "接触网作业车", parking: "文化宫存车线", workKm: 5.2, minutesAgo: 35 },
    { id: "job-mohao", title: "接触线磨耗测量", sectionId: "S5", blockStart: "01:00", blockEnd: "03:00", vehicleType: "接触网作业车", parking: "机场北折返线", workKm: 12.0, minutesAgo: 25 },
    { id: "job-koujian", title: "轨枕扣件紧固", sectionId: "S3", blockStart: "23:00", blockEnd: "00:30", vehicleType: "轨道检测车", parking: "文化宫存车线", workKm: 5.0, minutesAgo: 15 },
  ];

  const pending: Job[] = pendingPayloads.map(({ minutesAgo, ...payload }) => ({
    ...payload,
    status: "pending",
    vehicleId: null,
    reason: "",
    log: [{ at: iso(minutesAgo), text: "登记作业，进入待派区" }],
    createdAt: iso(minutesAgo),
    lockedAt: null,
  }));

  const all = [locked, ...pending];
  for (const job of pending) {
    job.reason = pendingEvaluation(job, vehicles, all);
  }
  return all;
}

export const useDispatchStore = defineStore("dispatch", () => {
  const persisted = load();
  const vehicles = ref<Vehicle[]>(
    persisted && persisted.vehicles?.length ? persisted.vehicles : seedVehicles()
  );
  const jobs = ref<Job[]>(persisted?.jobs ?? seedJobs(vehicles.value));

  const pendingJobs = computed(() => jobs.value.filter((j) => j.status === "pending"));
  const lockedJobs = computed(() => jobs.value.filter((j) => j.status === "locked"));

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ vehicles: vehicles.value, jobs: jobs.value }));
  }

  function vehicleById(id: string | null | undefined): Vehicle | null {
    return vehicles.value.find((v) => v.id === id) ?? null;
  }

  function addLog(job: Job, text: string) {
    job.log.unshift({ at: new Date().toISOString(), text });
  }

  function registerJob(payload: JobPayload) {
    const job: Job = {
      id: crypto.randomUUID(),
      ...payload,
      status: "pending",
      vehicleId: null,
      reason: "",
      log: [],
      createdAt: new Date().toISOString(),
      lockedAt: null,
    };
    job.reason = pendingEvaluation(job, vehicles.value, jobs.value);
    job.log.unshift({ at: job.createdAt, text: "登记作业，进入待派区" });
    jobs.value = [job, ...jobs.value];
    persist();
  }

  function registerVehicle(payload: VehiclePayload) {
    vehicles.value = [...vehicles.value, { id: crypto.randomUUID(), ...payload }];
    persist();
  }

  /** 派车：核对通过则锁定关系并预扣电量；不足项留在待派区并写清原因 */
  function attemptDispatch(jobId: string, vehicleId: string): boolean {
    const job = jobs.value.find((j) => j.id === jobId);
    const vehicle = vehicles.value.find((v) => v.id === vehicleId);
    if (!job || !vehicle || job.status !== "pending") return false;
    const failures = [
      ...occupancyConflicts(job, jobs.value),
      ...vehicleFailures(job, vehicle, jobs.value, vehicles.value),
    ];
    if (failures.length > 0) {
      job.reason = failures.join("；");
      addLog(job, `派车未过（${vehicle.code}）：${job.reason}`);
      persist();
      return false;
    }
    job.status = "locked";
    job.vehicleId = vehicle.id;
    job.lockedAt = new Date().toISOString();
    job.reason = "";
    addLog(job, `确认派车 ${vehicle.code}，往返 ${roundTripKm(job)} km 预扣 ${powerNeedPct(job, vehicle)}% 电，关系已锁定`);
    persist();
    return true;
  }

  /** 撤单：删除作业，车辆电量与区间占用随锁定记录一并释放 */
  function cancelJob(jobId: string) {
    jobs.value = jobs.value.filter((j) => j.id !== jobId);
    persist();
  }

  /** 改点：更新封锁时段；已锁定的先解除锁定、释放占用再回待派区 */
  function rescheduleJob(jobId: string, start: string, end: string) {
    const job = jobs.value.find((j) => j.id === jobId);
    if (!job) return;
    const old = `${job.blockStart}–${job.blockEnd}`;
    job.blockStart = start;
    job.blockEnd = end;
    if (job.status === "locked") {
      const code = vehicleById(job.vehicleId)?.code ?? "未知车辆";
      job.status = "pending";
      job.vehicleId = null;
      job.lockedAt = null;
      job.reason = `改点待重派：原 ${old} 的派车与区间占用已释放`;
      addLog(job, `改点 ${old} → ${start}–${end}，解除与 ${code} 的锁定，车辆与区间占用已释放`);
    } else {
      addLog(job, `改点 ${old} → ${start}–${end}`);
      job.reason = pendingEvaluation(job, vehicles.value, jobs.value);
    }
    persist();
  }

  /** 重开：解除锁定回待派区，历史待派原因保留在记录里可追 */
  function reopenJob(jobId: string) {
    const job = jobs.value.find((j) => j.id === jobId);
    if (!job || job.status !== "locked") return;
    const code = vehicleById(job.vehicleId)?.code ?? "未知车辆";
    job.status = "pending";
    job.vehicleId = null;
    job.lockedAt = null;
    job.reason = `人工重开，待重派（原派 ${code}）`;
    addLog(job, `重开：解除与 ${code} 的锁定，车辆与区间占用已释放，历史待派原因见记录`);
    persist();
  }

  /** 重新核对：按当前占用与电量刷新待派原因 */
  function reevaluate(jobId: string) {
    const job = jobs.value.find((j) => j.id === jobId);
    if (!job || job.status !== "pending") return;
    job.reason = pendingEvaluation(job, vehicles.value, jobs.value);
    persist();
  }

  return {
    vehicles,
    jobs,
    pendingJobs,
    lockedJobs,
    vehicleById,
    registerJob,
    registerVehicle,
    attemptDispatch,
    cancelJob,
    rescheduleJob,
    reopenJob,
    reevaluate,
  };
});
