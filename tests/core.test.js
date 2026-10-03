const assert = require("node:assert/strict");
const test = require("node:test");
const core = require("../core.js");

function step(id, work, wait = 0, type = "calendar", predecessors = [], lab = {}) {
  return { id, ownerType: "plan", ownerId: "p", name: id, workDurationMinutes: work, waitDurationMinutes: wait, waitDurationType: type, predecessorIds: predecessors, labRequirement: { start: !!lab.start, end: !!lab.end, waitCheck: !!lab.waitCheck }, waitCheckIntervalMinutes: lab.interval || 0, equipmentRequirements: [], notes: "", status: "未着手" };
}
function scheduleData(steps) {
  const data = core.createEmptyData();
  data.plans = [{ id: "p", name: "Plan", experimentIdeaId: "i", sourceTemplateId: "t" }]; data.steps = steps;
  return data;
}
const opts = { nowIso: "2029-01-01T00:00:00.000Z" };
const local = (iso) => core.isoToZonedInput(iso, "Asia/Tokyo");

test("v2データを退避可能なv4構造へ移行する", () => {
  const legacy = { ...core.createEmptyData(), schemaVersion: 2, availability: { weekly: core.defaultWeekly(), exceptions: [] } };
  const result = core.migrateData(legacy);
  assert.equal(result.valid, true); assert.equal(result.fromVersion, 2); assert.equal(result.data.schemaVersion, 4);
  assert.equal(result.data.availability.profiles[0].locationType, "lab");
});

test("単一工程を完成予定日時から逆算する", () => {
  const result = core.calculatePlanSchedule(scheduleData([step("a", 60)]), "p", "2030-01-07T18:00", opts);
  assert.equal(result.feasible, true); assert.equal(local(result.stepSchedules[0].startAt), "2030-01-07T17:00");
  assert.equal(result.targetCompletionDateTime, "2030-01-07T09:00:00.000Z");
});

test("直列工程、並行工程、複数先行工程を処理する", () => {
  const result = core.calculatePlanSchedule(scheduleData([step("a", 60), step("b", 120), step("c", 30, 0, "calendar", ["a", "b"])]), "p", "2030-01-07T18:00", opts);
  const byId = Object.fromEntries(result.stepSchedules.map((item) => [item.stepId, item]));
  assert.equal(byId.a.endAt, byId.c.startAt); assert.equal(byId.b.endAt, byId.c.startAt);
});

test("休日を飛ばして作業時間を繰り越す", () => {
  const data = scheduleData([step("a", 120)]); data.availability.holidays = [{ id: "h", date: "2030-01-07", name: "休日" }];
  const result = core.calculatePlanSchedule(data, "p", "2030-01-08T10:00", opts), item = result.stepSchedules[0];
  assert.equal(local(item.startAt), "2030-01-04T17:00"); assert.equal(item.workSegments.length, 2);
});

test("作業終了と待機開始を一致させ、待機種別を区別する", () => {
  for (const type of ["calendar", "working"]) {
    const result = core.calculatePlanSchedule(scheduleData([step("a", 60, 120, type)]), "p", "2030-01-07T18:00", opts), item = result.stepSchedules[0];
    assert.equal(item.workEndAt, item.waitStartAt);
  }
});

test("休日中の暦待機終了と確認を移動せず警告する", () => {
  const result = core.calculatePlanSchedule(scheduleData([step("a", 0, 60, "calendar", [], { end: true, waitCheck: true, interval: 30 })]), "p", "2030-01-13T12:00", opts), item = result.stepSchedules[0];
  assert.equal(local(item.endAt), "2030-01-13T12:00"); assert.ok(result.warnings.length >= 2); assert.ok(item.labVisits.every((visit) => !visit.available));
});

test("作業枠不足と期限超過を検出する", () => {
  const unavailable = scheduleData([step("a", 60)]); unavailable.availability.profiles[0].weekly.forEach((day) => { day.enabled = false; });
  assert.equal(core.calculatePlanSchedule(unavailable, "p", "2030-01-07T18:00", opts).feasible, false);
  assert.equal(core.calculatePlanSchedule(scheduleData([step("a", 60)]), "p", "2030-01-07T18:00", { nowIso: "2030-01-08T00:00:00.000Z" }).feasible, false);
});

test("計算時の作業可能時間をスナップショット保存する", () => {
  const data = scheduleData([step("a", 60)]), result = core.calculatePlanSchedule(data, "p", "2030-01-07T18:00", opts);
  data.availability.profiles[0].weekly[1].enabled = false;
  assert.equal(result.availabilitySnapshot.profiles[0].weekly[1].enabled, true);
});
