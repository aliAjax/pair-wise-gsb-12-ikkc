// 地铁夜间检修派车领域模型与核对引擎
// 夜间时刻模型：12:00 之前视为次日凌晨（+1440 分钟），如 01:30 -> 1530

export interface Section {
  id: string;
  name: string;
  startKm: number;
  endKm: number;
}

export interface Spot {
  id: string;
  name: string;
  sectionId: string;
  km: number;
}

export type JobStatus = "待派" | "已派";

export interface Job {
  id: string;
  name: string;
  sectionId: string; // 行车区间
  blockStart: string; // 封锁时段 HH:MM
  blockEnd: string;
  vehicleType: string; // 车型
  spotId: string; // 驻车点
  status: JobStatus;
  locked: boolean; // 确认派车后锁住关系
  vehicleId: string | null; // 已派车辆 / 待派时的意向车辆
  crossKm: number | null; // 串车距离
  needBattery: number | null; // 往返耗电（含安全余量）
  reasons: string[]; // 待派原因
  createdAt: string;
}

export interface Vehicle {
  id: string;
  code: string;
  type: string;
  availStart: string; // 可用时段 HH:MM
  availEnd: string;
  battery: number; // 剩余电量 %
  rate: number; // 电耗 %/km
  spotId: string; // 驻车点
}

export const SECTIONS: Section[] = [
  { id: "sec-1", name: "S1 车辆段—大学城", startKm: 0, endKm: 3.2 },
  { id: "sec-2", name: "S2 大学城—科技园", startKm: 3.2, endKm: 6.8 },
  { id: "sec-3", name: "S3 科技园—中心站", startKm: 6.8, endKm: 9.5 },
  { id: "sec-4", name: "S4 中心站—湖滨", startKm: 9.5, endKm: 12.6 },
  { id: "sec-5", name: "S5 湖滨—机场东", startKm: 12.6, endKm: 15.4 }
];

export const SPOTS: Spot[] = [
  { id: "spot-1", name: "车辆段A库", sectionId: "sec-1", km: 0.4 },
  { id: "spot-2", name: "科技园存车线", sectionId: "sec-2", km: 6.0 },
  { id: "spot-3", name: "中心站折返线", sectionId: "sec-3", km: 9.2 },
  { id: "spot-4", name: "湖滨停车场", sectionId: "sec-4", km: 12.2 }
];

export const VEHICLE_TYPES = ["接触网检修车", "轨道检测车", "工程平板车", "打磨车"] as const;

// 往返耗电安全余量（%）
export const BATTERY_RESERVE = 10;

export function toNightMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  const mins = (h || 0) * 60 + (m || 0);
  return (h || 0) < 12 ? mins + 1440 : mins;
}

export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return toNightMinutes(aStart) < toNightMinutes(bEnd) && toNightMinutes(bStart) < toNightMinutes(aEnd);
}

export function covers(outerStart: string, outerEnd: string, innerStart: string, innerEnd: string): boolean {
  return toNightMinutes(outerStart) <= toNightMinutes(innerStart) && toNightMinutes(innerEnd) <= toNightMinutes(outerEnd);
}

export function validWindow(start: string, end: string): boolean {
  return toNightMinutes(start) < toNightMinutes(end);
}

export function sectionById(id: string): Section {
  return SECTIONS.find((s) => s.id === id) ?? SECTIONS[0];
}

export function spotById(id: string): Spot {
  return SPOTS.find((s) => s.id === id) ?? SPOTS[0];
}

function sectionMidKm(section: Section): number {
  return (section.startKm + section.endKm) / 2;
}

// 串车距离：车辆驻车点到作业区间中点的里程
export function crossKm(spot: Spot, target: Section): number {
  return Math.round(Math.abs(spot.km - sectionMidKm(target)) * 10) / 10;
}

// 开往作业区间需途经的区间（不含作业区间本身，含驻车点所在区间）
export function crossedSections(spot: Spot, target: Section): Section[] {
  const from = SECTIONS.findIndex((s) => s.id === spot.sectionId);
  const to = SECTIONS.findIndex((s) => s.id === target.id);
  if (from === -1 || to === -1 || from === to) return [];
  const [lo, hi] = from < to ? [from, to] : [to, from];
  return SECTIONS.slice(lo, hi + 1).filter((s) => s.id !== target.id);
}

// 往返耗电 = 往返里程 × 电耗 + 安全余量
export function roundTripNeed(vehicle: Vehicle, km: number): number {
  return Math.ceil(2 * km * vehicle.rate) + BATTERY_RESERVE;
}

export interface CheckResult {
  ok: boolean;
  reasons: string[];
  crossKm: number;
  needBattery: number;
}

// 派车核对：车型、车辆时段、同区间占用、相邻区间串车、往返耗电、车辆重复占用
export function checkDispatch(job: Job, vehicle: Vehicle, jobs: Job[]): CheckResult {
  const reasons: string[] = [];
  const target = sectionById(job.sectionId);
  const others = jobs.filter((j) => j.id !== job.id && j.status === "已派");

  if (vehicle.type !== job.vehicleType) {
    reasons.push(`车型不符：作业需「${job.vehicleType}」，${vehicle.code} 为「${vehicle.type}」`);
  }

  if (!covers(vehicle.availStart, vehicle.availEnd, job.blockStart, job.blockEnd)) {
    reasons.push(`时段不覆盖：${vehicle.code} 可用 ${vehicle.availStart}–${vehicle.availEnd}，作业封锁 ${job.blockStart}–${job.blockEnd}`);
  }

  const busy = others.find(
    (j) => j.vehicleId === vehicle.id && overlaps(j.blockStart, j.blockEnd, job.blockStart, job.blockEnd)
  );
  if (busy) {
    reasons.push(`车辆冲突：${vehicle.code} 此时段已派给《${busy.name}》（${busy.blockStart}–${busy.blockEnd}）`);
  }

  const same = others.find(
    (j) => j.sectionId === job.sectionId && overlaps(j.blockStart, j.blockEnd, job.blockStart, job.blockEnd)
  );
  if (same) {
    reasons.push(`冲突区间：${target.name} 已被《${same.name}》封锁（${same.blockStart}–${same.blockEnd}）`);
  }

  const spot = spotById(vehicle.spotId);
  const km = crossKm(spot, target);
  const hitSection = crossedSections(spot, target).find((sec) =>
    others.some((j) => j.sectionId === sec.id && overlaps(j.blockStart, j.blockEnd, job.blockStart, job.blockEnd))
  );
  if (hitSection) {
    const hitJob = others.find((j) => j.sectionId === hitSection.id)!;
    reasons.push(
      `相邻区间串车：开往 ${target.name} 需穿越 ${hitSection.name}（《${hitJob.name}》${hitJob.blockStart}–${hitJob.blockEnd} 占用），串车距离 ${km} km`
    );
  }

  const need = roundTripNeed(vehicle, km);
  if (vehicle.battery < need) {
    reasons.push(
      `电量不足：往返 ${(2 * km).toFixed(1)} km 约需 ${need}%（含安全余量 ${BATTERY_RESERVE}%），${vehicle.code} 仅剩 ${vehicle.battery}%，缺 ${need - vehicle.battery}%`
    );
  }

  return { ok: reasons.length === 0, reasons, crossKm: km, needBattery: need };
}

export function seedVehicles(): Vehicle[] {
  return [
    { id: "veh-1", code: "GCY-01", type: "接触网检修车", availStart: "23:00", availEnd: "04:00", battery: 86, rate: 2.2, spotId: "spot-1" },
    { id: "veh-2", code: "GCY-02", type: "轨道检测车", availStart: "23:30", availEnd: "03:30", battery: 34, rate: 2.6, spotId: "spot-3" },
    { id: "veh-3", code: "GCY-03", type: "工程平板车", availStart: "22:30", availEnd: "05:00", battery: 92, rate: 1.8, spotId: "spot-2" },
    { id: "veh-4", code: "GCY-04", type: "打磨车", availStart: "00:00", availEnd: "04:30", battery: 71, rate: 3.1, spotId: "spot-4" }
  ];
}

export function seedJobs(vehicles: Vehicle[]): Job[] {
  const now = new Date().toISOString();
  const jobs: Job[] = [
    {
      id: "job-1", name: "接触网巡检", sectionId: "sec-2", blockStart: "00:00", blockEnd: "02:00",
      vehicleType: "接触网检修车", spotId: "spot-2", status: "已派", locked: true,
      vehicleId: "veh-1", crossKm: null, needBattery: null, reasons: [], createdAt: now
    },
    {
      id: "job-2", name: "钢轨探伤", sectionId: "sec-5", blockStart: "00:30", blockEnd: "02:30",
      vehicleType: "轨道检测车", spotId: "spot-4", status: "待派", locked: false,
      vehicleId: "veh-2", crossKm: null, needBattery: null, reasons: [], createdAt: now
    },
    {
      id: "job-3", name: "道床清扫", sectionId: "sec-1", blockStart: "01:00", blockEnd: "03:00",
      vehicleType: "工程平板车", spotId: "spot-1", status: "待派", locked: false,
      vehicleId: "veh-3", crossKm: null, needBattery: null, reasons: [], createdAt: now
    }
  ];
  // 预填已派作业的里程/耗电，并为待派作业算出待派原因
  for (const job of jobs) {
    const vehicle = vehicles.find((v) => v.id === job.vehicleId);
    if (!vehicle) continue;
    const result = checkDispatch(job, vehicle, jobs);
    job.crossKm = result.crossKm;
    job.needBattery = result.needBattery;
    if (job.status === "待派") {
      job.reasons = result.ok ? ["待派车：核对通过，可直接派车"] : result.reasons;
    }
  }
  return jobs;
}
