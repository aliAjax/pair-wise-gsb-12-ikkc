// 地铁夜间检修派车台：领域模型与核对规则（纯函数，便于测试与复用）

export interface Section {
  id: string;
  name: string;
  order: number; // 线路顺序，相差 1 即相邻区间
  distanceKm: number; // 区间中点距车辆段的单程里程
}

export interface Vehicle {
  id: string;
  code: string; // 轨道车编号
  type: string; // 车型
  availFrom: string; // 可用时段起 HH:MM，支持跨零点
  availTo: string; // 可用时段止 HH:MM
  battery: number; // 登记剩余电量 %
  rate: number; // 耗电率 %/km
  parking: string; // 驻车点
}

export type JobStatus = "pending" | "locked";

export interface JobLog {
  at: string;
  text: string;
}

export interface Job {
  id: string;
  title: string; // 作业名称
  sectionId: string; // 行车区间
  blockStart: string; // 封锁时段起 HH:MM
  blockEnd: string; // 封锁时段止 HH:MM
  vehicleType: string; // 需求车型
  parking: string; // 驻车点
  workKm: number; // 作业点里程，用于相邻区间串车距离
  status: JobStatus;
  vehicleId: string | null; // 锁定后指向轨道车
  reason: string; // 当前待派原因
  log: JobLog[]; // 全程留痕，新的在前
  createdAt: string;
  lockedAt: string | null;
}

export interface JobPayload {
  title: string;
  sectionId: string;
  blockStart: string;
  blockEnd: string;
  vehicleType: string;
  parking: string;
  workKm: number;
}

export interface VehiclePayload {
  code: string;
  type: string;
  availFrom: string;
  availTo: string;
  battery: number;
  rate: number;
  parking: string;
}

export const SECTIONS: Section[] = [
  { id: "S1", name: "车辆段—人民广场", order: 1, distanceKm: 2.0 },
  { id: "S2", name: "人民广场—文化宫", order: 2, distanceKm: 4.5 },
  { id: "S3", name: "文化宫—体育馆", order: 3, distanceKm: 7.0 },
  { id: "S4", name: "体育馆—火车站", order: 4, distanceKm: 9.5 },
  { id: "S5", name: "火车站—机场北", order: 5, distanceKm: 13.0 },
];

export const VEHICLE_TYPES = ["接触网作业车", "轨道检测车", "平板运输车"];

export const BATTERY_RESERVE = 20; // 往返后须保留的保底电量 %
export const SAFE_GAP_KM = 1.0; // 相邻区间同时作业的最小安全间距 km

export function sectionById(id: string): Section {
  return SECTIONS.find((s) => s.id === id) ?? SECTIONS[0];
}

export function sectionLabel(section: Section): string {
  return `${section.id} ${section.name}`;
}

/** 夜间时段归一化：12:00 前视为次日凌晨，支持 23:00–01:00 这类跨零点时段 */
export function toMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  const mins = (h || 0) * 60 + (m || 0);
  return mins < 12 * 60 ? mins + 1440 : mins;
}

export function timeOverlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return toMinutes(aStart) < toMinutes(bEnd) && toMinutes(bStart) < toMinutes(aEnd);
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 往返里程：驻车段场到区间中点往返 */
export function roundTripKm(job: Job): number {
  return round1(sectionById(job.sectionId).distanceKm * 2);
}

/** 往返耗电 % */
export function powerNeedPct(job: Job, vehicle: Vehicle): number {
  return round1(roundTripKm(job) * vehicle.rate);
}

/** 车辆被已锁定作业预扣的电量 */
export function usedBatteryPct(vehicleId: string, jobs: Job[], vehicles: Vehicle[]): number {
  const vehicle = vehicles.find((v) => v.id === vehicleId);
  if (!vehicle) return 0;
  return round1(
    jobs
      .filter((j) => j.status === "locked" && j.vehicleId === vehicleId)
      .reduce((acc, j) => acc + powerNeedPct(j, vehicle), 0)
  );
}

/** 车辆当前剩余电量 = 登记电量 - 已锁定作业预扣 */
export function batteryLeft(vehicle: Vehicle, jobs: Job[], vehicles: Vehicle[]): number {
  return round1(vehicle.battery - usedBatteryPct(vehicle.id, jobs, vehicles));
}

/** 区间级核对：同区间占用 + 相邻区间串车（只与已锁定作业比，待派不占资源） */
export function occupancyConflicts(job: Job, jobs: Job[]): string[] {
  const msgs: string[] = [];
  const section = sectionById(job.sectionId);
  for (const other of jobs) {
    if (other.id === job.id || other.status !== "locked") continue;
    if (!timeOverlaps(job.blockStart, job.blockEnd, other.blockStart, other.blockEnd)) continue;
    const oSection = sectionById(other.sectionId);
    if (other.sectionId === job.sectionId) {
      msgs.push(
        `冲突区间「${sectionLabel(section)}」：${other.blockStart}–${other.blockEnd} 已被「${other.title}」占用`
      );
    } else if (Math.abs(oSection.order - section.order) === 1) {
      const gap = round1(Math.abs(job.workKm - other.workKm));
      if (gap < SAFE_GAP_KM) {
        msgs.push(
          `与相邻区间「${sectionLabel(oSection)}」作业「${other.title}」串车，串车距离 ${gap.toFixed(1)} km < 安全 ${SAFE_GAP_KM.toFixed(1)} km`
        );
      }
    }
  }
  return msgs;
}

/** 车辆级核对：车型、可用时段、往返耗电 */
export function vehicleFailures(job: Job, vehicle: Vehicle, jobs: Job[], vehicles: Vehicle[]): string[] {
  const failures: string[] = [];
  if (vehicle.type !== job.vehicleType) {
    failures.push(`车型不符：需 ${job.vehicleType}，${vehicle.code} 是 ${vehicle.type}`);
  }
  if (
    !(
      toMinutes(vehicle.availFrom) <= toMinutes(job.blockStart) &&
      toMinutes(vehicle.availTo) >= toMinutes(job.blockEnd)
    )
  ) {
    failures.push(`可用时段 ${vehicle.availFrom}–${vehicle.availTo} 盖不住封锁 ${job.blockStart}–${job.blockEnd}`);
  }
  const need = powerNeedPct(job, vehicle);
  const left = batteryLeft(vehicle, jobs, vehicles);
  if (left - need < BATTERY_RESERVE) {
    const short = round1(need + BATTERY_RESERVE - left);
    failures.push(
      `往返 ${roundTripKm(job)} km 需 ${need}%，剩 ${left}%，保底 ${BATTERY_RESERVE}%，缺 ${short}% 电`
    );
  }
  return failures;
}

export interface VehicleEvaluation {
  vehicle: Vehicle;
  failures: string[];
}

export interface DispatchEvaluation {
  occupancy: string[];
  perVehicle: VehicleEvaluation[];
  ok: boolean;
}

/** 派车核对：区间占用 + 逐台车辆核对 */
export function evaluateDispatch(job: Job, vehicles: Vehicle[], jobs: Job[]): DispatchEvaluation {
  const occupancy = occupancyConflicts(job, jobs);
  const perVehicle = vehicles.map((vehicle) => ({
    vehicle,
    failures: vehicleFailures(job, vehicle, jobs, vehicles),
  }));
  const ok = occupancy.length === 0 && perVehicle.some((pv) => pv.failures.length === 0);
  return { occupancy, perVehicle, ok };
}

/** 待派原因一句话：占用冲突优先，其次可派车辆，最后写清卡在哪 */
export function pendingEvaluation(job: Job, vehicles: Vehicle[], jobs: Job[]): string {
  const occupancy = occupancyConflicts(job, jobs);
  if (occupancy.length > 0) return occupancy.join("；");
  const perVehicle = vehicles.map((vehicle) => ({
    vehicle,
    failures: vehicleFailures(job, vehicle, jobs, vehicles),
  }));
  const passing = perVehicle.filter((pv) => pv.failures.length === 0);
  if (passing.length > 0) {
    return `可派：${passing.map((pv) => pv.vehicle.code).join("、")} 通过核对`;
  }
  if (perVehicle.length === 0) return "无可用轨道车，请先登记";
  const best = perVehicle.reduce((a, b) => (a.failures.length <= b.failures.length ? a : b));
  return best.failures.join("；");
}
