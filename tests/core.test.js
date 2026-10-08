const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../core.js");

const now = "2031-06-01T00:00:00.000Z";
function makeStep(id, order, extra = {}) {
  return {
    id, ownerType: "plan", ownerId: "plan", name: id, displayOrder: order,
    workDurationMinutes: 60, waitDurationMinutes: 0, waitDurationType: "calendar",
    workLocation: "lab", interruptible: true, manualStartAt: null, notes: "",
    plannedStartDateTime: null, plannedEndDateTime: null, actualStartDateTime: null,
    actualEndDateTime: null, completed: false, remainingWorkMinutes: 60, status: "未着手",
    createdAt: now, updatedAt: now, ...extra
  };
}
function baseData(steps = [makeStep("a", 0), makeStep("b", 1)]) {
  const data = core.createEmptyData();
  data.updatedAt = now;
  data.experimentIdeas = [{ id: "idea", name: "Test", purpose: "", materials: "", priority: "中", desiredCompletionDate: "", notes: "", status: "計画中", createdAt: now, updatedAt: now }];
  data.plans = [{ id: "plan", name: "Plan", experimentIdeaId: "idea", sourceTemplateId: null, scheduleMode: "forward", experimentStartDateTime: null, forecastCompletionDateTime: null, targetCompletionDateTime: "", activeScheduleVersionId: null, status: "下書き", createdAt: now, updatedAt: now }];
  data.steps = steps;
  return data;
}
function saveSchedule(data, result) {
  data.scheduleVersions.push(result); data.plans[0].activeScheduleVersionId = result.id;
  result.stepSchedules.forEach((schedule) => core.assignProgressFields(data.steps.find((step) => step.id === schedule.stepId), { plannedStartDateTime: schedule.startAt, plannedEndDateTime: schedule.endAt }));
}

test("テンプレート工程を上下へ並べ替え、再読込後も順序を維持する", () => {
  const steps = [makeStep("a", 0), makeStep("b", 1)]; steps.forEach((step) => { step.ownerType = "template"; step.ownerId = "template"; });
  assert.equal(core.moveOwnerStepDisplayOrder(steps, "template", "template", "b", -1).moved, true);
  assert.deepEqual(core.orderedOwnerSteps(JSON.parse(JSON.stringify(steps)), "template", "template").map((step) => step.id), ["b", "a"]);
});

test("テンプレート複製時に表示順を個別計画へ継承する", () => {
  const data = core.createEmptyData(); data.updatedAt = now; data.templates = [{ id: "template", name: "T", description: "", createdAt: now, updatedAt: now }]; data.experimentIdeas = [{ id: "idea", name: "I", purpose: "", materials: "", priority: "中", desiredCompletionDate: "", notes: "", status: "未計画", createdAt: now, updatedAt: now }];
  data.steps = [makeStep("ta", 1), makeStep("tb", 0)].map((step) => ({ ...step, ownerType: "template", ownerId: "template" }));
  const made = core.createPlanFromTemplate(data, "template", "idea"); assert.deepEqual(made.steps.map((step) => step.sourceTemplateStepId), ["tb", "ta"]); assert.deepEqual(made.steps.map((step) => step.displayOrder), [0, 1]);
});

test("同じ計画へ複数テンプレートを末尾追加できる", () => {
  const data = baseData([makeStep("existing", 0)]); data.templates = [{ id: "template", name: "T", description: "", createdAt: now, updatedAt: now }]; data.steps.push({ ...makeStep("source", 0), ownerType: "template", ownerId: "template" });
  const first = core.appendTemplateToPlan(data, "template", "plan"); data.steps.push(...first.steps); data.plans[0].templateApplications = [first.application]; const second = core.appendTemplateToPlan(data, "template", "plan");
  assert.equal(second.alreadyApplied, true); assert.equal(second.steps[0].displayOrder, 2); assert.notEqual(first.steps[0].id, second.steps[0].id);
});

test("表示順が実施順になり並べ替えで実施順も変わる", () => {
  const data = baseData(); core.movePlanStepDisplayOrder(data.steps, "plan", "b", -1);
  const result = core.calculateForwardSchedule(data, "plan", "2031-06-02T09:00"); assert.equal(result.feasible, true); assert.deepEqual(result.stepSchedules.map((item) => item.stepId), ["b", "a"]); assert.ok(new Date(result.stepSchedules[1].startAt) >= new Date(result.stepSchedules[0].endAt));
});

test("旧先行工程IDは直列スケジュールへ影響しない", () => {
  const data = baseData([makeStep("a", 0, { predecessorIds: ["missing"] }), makeStep("b", 1, { predecessorIds: [] })]);
  const result = core.calculateForwardSchedule(data, "plan", "2031-06-02T09:00"); assert.equal(result.feasible, true); assert.deepEqual(result.stepSchedules.map((item) => item.stepId), ["a", "b"]);
});

test("1500分を1日1時間0分へ分解する", () => assert.deepEqual(core.splitWaitDurationMinutes(1500), { days: 1, hours: 1, minutes: 0 }));
test("2日3時間30分を3090分へ変換する", () => assert.equal(core.combineWaitDurationParts({ days: 2, hours: 3, minutes: 30 }).totalMinutes, 3090));
test("待機時間の小数・負数・範囲外を拒否する", () => {
  assert.equal(core.combineWaitDurationParts({ days: -1, hours: 0, minutes: 0 }).valid, false); assert.equal(core.combineWaitDurationParts({ days: 0, hours: 24, minutes: 0 }).valid, false); assert.equal(core.combineWaitDurationParts({ days: 0, hours: 0, minutes: 60 }).valid, false); assert.equal(core.combineWaitDurationParts({ days: 0.5, hours: 0, minutes: 0 }).valid, false);
});
test("旧分単位待機データを読み込める", () => { const data = baseData([makeStep("a", 0, { waitDurationMinutes: 1500 })]); const parsed = core.parseBackup(core.serializeData(data)); assert.equal(parsed.valid, true); assert.equal(parsed.data.steps[0].waitDurationMinutes, 1500); });

test("逆算は最後の工程から先頭へ直列配置する", () => {
  const data = baseData(); data.plans[0].scheduleMode = "backward"; const result = core.calculatePlanSchedule(data, "plan", "2031-06-03T18:00", { nowIso: "2031-01-01T00:00:00.000Z" });
  assert.equal(result.feasible, true); assert.equal(result.stepSchedules[1].endAt, "2031-06-03T09:00:00.000Z"); assert.equal(result.stepSchedules[0].endAt, result.stepSchedules[1].startAt);
});
test("逆算で作業後の待機時間を反映する", () => { const data = baseData([makeStep("a", 0, { waitDurationMinutes: 120 })]); data.plans[0].scheduleMode = "backward"; const result = core.calculatePlanSchedule(data, "plan", "2031-06-03T18:00", { nowIso: "2031-01-01T00:00:00.000Z" }); assert.equal((new Date(result.stepSchedules[0].endAt) - new Date(result.stepSchedules[0].workEndAt)) / 60000, 120); });
test("逆算で休日を飛ばす", () => { const data = baseData([makeStep("a", 0, { workDurationMinutes: 120 })]); data.plans[0].scheduleMode = "backward"; data.availability.holidays.push({ id: "holiday", date: "2031-06-02", name: "休" }); const result = core.calculatePlanSchedule(data, "plan", "2031-06-03T10:00", { nowIso: "2031-01-01T00:00:00.000Z" }); assert.equal(core.dateKeyInZone(result.requiredStartAt, "Asia/Tokyo"), "2031-05-30"); });

test("完成希望日時なしで順方向スケジュールを作れる", () => { const result = core.calculateForwardSchedule(baseData(), "plan", "2031-06-02T09:00"); assert.equal(result.feasible, true); assert.equal(result.targetCompletionDateTime, null); });
test("順方向は先頭から最後へ配置し予想完成を算出する", () => { const result = core.calculateForwardSchedule(baseData(), "plan", "2031-06-02T09:00"); assert.deepEqual(result.stepSchedules.map((item) => item.stepId), ["a", "b"]); assert.equal(result.forecastCompletionAt, result.stepSchedules[1].endAt); });
test("完成希望日時なしでは期限警告を出さない", () => { const result = core.calculateForwardSchedule(baseData(), "plan", "2031-06-02T09:00"); assert.equal(result.late, false); assert.equal(result.deadlineStatus, null); assert.equal(result.warnings.length, 0); });
test("順方向へ後から完成希望日時を追加し比較できる", () => { const result = core.calculateForwardSchedule(baseData(), "plan", "2031-06-02T09:00", { targetCompletionDateTime: "2031-06-02T10:00" }); assert.equal(result.deadlineStatus, "late"); assert.ok(result.delayMinutes > 0); });
test("既存計画はデフォルトで逆算モード", () => assert.equal(core.planScheduleMode({}), "backward"));

test("完了チェックと開始・終了を互換フィールドへ保存する", () => { const step = makeStep("a", 0); core.assignProgressFields(step, { completed: true, actualStartDateTime: "2031-06-02T00:00:00.000Z", actualEndDateTime: "2031-06-02T01:00:00.000Z" }); assert.equal(step.completed, true); assert.equal(step.actualStartedAt, step.actualStartDateTime); assert.equal(step.actualEndedAt, step.actualEndDateTime); });
test("進捗状態をJSON再読込後も維持する", () => { const data = baseData(); core.assignProgressFields(data.steps[0], { completed: true, actualStartDateTime: "2031-06-02T00:00:00.000Z", actualEndDateTime: "2031-06-02T01:00:00.000Z" }); const parsed = core.parseBackup(core.serializeData(data)); assert.equal(parsed.valid, true); assert.equal(core.progressFields(parsed.data.steps[0]).completed, true); });

function rollingData(actualEnd) {
  const data = baseData(); const initial = core.calculateForwardSchedule(data, "plan", "2031-06-02T09:00"); saveSchedule(data, initial); data.plans[0].experimentStartDateTime = initial.experimentStartDateTime; core.assignProgressFields(data.steps[0], { completed: true, actualStartDateTime: initial.stepSchedules[0].startAt, actualEndDateTime: actualEnd }); return { data, initial };
}
test("完了工程と前工程はローリング再計算で動かない", () => { const { data, initial } = rollingData("2031-06-02T00:30:00.000Z"); const result = core.recalculatePlanProgress(data, "plan", "a", { nowIso: data.steps[0].actualEndDateTime }); assert.equal(result.stepSchedules[0].startAt, initial.stepSchedules[0].startAt); assert.equal(result.stepSchedules[0].endAt, initial.stepSchedules[0].endAt); });
test("後ろの未完了工程だけ再計算する", () => { const data = baseData([makeStep("a", 0), makeStep("b", 1), makeStep("c", 2)]); const initial = core.calculateForwardSchedule(data, "plan", "2031-06-02T09:00"); saveSchedule(data, initial); core.assignProgressFields(data.steps[1], { completed: true, actualStartDateTime: initial.stepSchedules[1].startAt, actualEndDateTime: "2031-06-02T02:30:00.000Z" }); const result = core.recalculatePlanProgress(data, "plan", "b", { nowIso: data.steps[1].actualEndDateTime }); assert.deepEqual(result.affectedStepIds, ["c"]); assert.equal(result.stepSchedules.find((item) => item.stepId === "a").recalculated, false); });
test("早期完了で後続工程を前倒しする", () => { const { data, initial } = rollingData("2031-06-02T00:30:00.000Z"); const result = core.recalculatePlanProgress(data, "plan", "a", { nowIso: data.steps[0].actualEndDateTime }); assert.ok(new Date(result.stepSchedules[1].startAt) < new Date(initial.stepSchedules[1].startAt)); });
test("遅延完了で後続工程を後ろ倒しする", () => { const { data, initial } = rollingData("2031-06-02T02:00:00.000Z"); const result = core.recalculatePlanProgress(data, "plan", "a", { nowIso: data.steps[0].actualEndDateTime }); assert.ok(new Date(result.stepSchedules[1].startAt) > new Date(initial.stepSchedules[1].startAt)); });
test("期限超過時に警告・予想完成・影響工程を返す", () => { const { data } = rollingData("2031-06-02T02:00:00.000Z"); data.plans[0].targetCompletionDateTime = "2031-06-02T02:30:00.000Z"; const result = core.recalculatePlanProgress(data, "plan", "a", { nowIso: data.steps[0].actualEndDateTime }); assert.equal(result.late, true); assert.ok(result.forecastCompletionAt); assert.deepEqual(result.affectedStepNames, ["b"]); });

test("前工程より前の手動開始を拒否する", () => { const { data } = rollingData("2031-06-02T01:00:00.000Z"); data.steps[1].manualStartAt = "2031-06-02T00:30:00.000Z"; const result = core.recalculatePlanProgress(data, "plan", "a", { nowIso: data.steps[0].actualEndDateTime }); assert.equal(result.feasible, false); assert.match(result.errors[0], /前工程/); });
test("休日の手動開始を拒否する", () => { const { data } = rollingData("2031-06-02T01:00:00.000Z"); data.availability.holidays.push({ id: "h", date: "2031-06-03", name: "休" }); data.steps[1].manualStartAt = "2031-06-03T00:00:00.000Z"; const result = core.recalculatePlanProgress(data, "plan", "a", { nowIso: data.steps[0].actualEndDateTime }); assert.equal(result.feasible, false); assert.match(result.errors[0], /作業可能時間|休日/); });
test("来室不可日の研究室作業を繰り越す", () => { const data = baseData([makeStep("a", 0)]); data.attendancePreferences.push({ id: "no", date: "2031-06-02", type: "cannotVisit", note: "" }); const result = core.calculateForwardSchedule(data, "plan", "2031-06-02T09:00"); assert.equal(core.dateKeyInZone(result.stepSchedules[0].startAt, "Asia/Tokyo"), "2031-06-03"); });
test("作業者・装置の旧競合情報は計算へ影響しない", () => { const data = baseData(); data.workers = [{ id: "w", name: "W", unavailablePeriods: [{ startAt: "2031-06-01T00:00:00.000Z", endAt: "2031-07-01T00:00:00.000Z" }] }]; data.equipment = [{ id: "e", name: "E", capacity: 1, unavailablePeriods: [{ startAt: "2031-06-01T00:00:00.000Z", endAt: "2031-07-01T00:00:00.000Z" }] }]; data.steps.forEach((step) => { step.assignedWorkerId = "w"; step.equipmentRequirements = [{ equipmentId: "e" }]; }); assert.equal(core.calculateForwardSchedule(data, "plan", "2031-06-02T09:00").feasible, true); });

test("既存v4 JSONを読み込める", () => assert.equal(core.parseBackup(core.serializeData(baseData())).valid, true));
test("旧作業者・装置・先行工程・確認フィールドを含むJSONを読み込める", () => { const data = baseData(); data.workers = [{ id: "w", name: "W" }]; data.equipment = [{ id: "e", name: "E" }]; Object.assign(data.steps[0], { predecessorIds: ["legacy"], assignedWorkerId: "w", equipmentRequirements: [{ equipmentId: "e" }], waitCheckIntervalMinutes: 30, waitCheckWorkerId: "w", labRequirement: { waitCheck: true } }); assert.equal(core.parseBackup(JSON.stringify(data)).valid, true); });
test("JSONバックアップ復元でモード・順序・進捗を保持する", () => { const data = baseData(); data.plans[0].scheduleMode = "forward"; data.steps[0].displayOrder = 1; data.steps[1].displayOrder = 0; core.assignProgressFields(data.steps[1], { completed: true, actualStartDateTime: now, actualEndDateTime: "2031-06-01T01:00:00.000Z" }); const parsed = core.parseBackup(core.serializeData(data)); assert.equal(parsed.valid, true); assert.equal(parsed.data.plans[0].scheduleMode, "forward"); assert.deepEqual(core.orderedOwnerSteps(parsed.data.steps, "plan", "plan").map((step) => step.id), ["b", "a"]); });
test("不正JSONの復元を拒否する", () => { const data = baseData(); const original = JSON.stringify(data); data.steps = "broken"; const result = core.parseBackup(JSON.stringify(data)); assert.equal(result.valid, false); assert.equal(JSON.stringify(baseData()), original); });
test("スキーマv4を維持する", () => assert.equal(core.SCHEMA_VERSION, 4));
test("簡素化前データ退避キーを公開する", () => assert.equal(core.SIMPLIFICATION_BACKUP_KEY, "experimentScheduleManager.data.preSimplification.v4"));
