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

test("個別計画の表示順だけを上下移動して保存できる", () => {
  const steps = [step("a", 30), step("b", 30, 0, "calendar", ["a"]), step("c", 30, 0, "calendar", ["b"])];
  const dependencies = JSON.stringify(steps.map((item) => item.predecessorIds));
  const result = core.movePlanStepDisplayOrder(steps, "p", "a", 1);
  assert.equal(result.moved, true);
  assert.deepEqual(core.orderedOwnerSteps(steps, "plan", "p").map((item) => item.id), ["b", "a", "c"]);
  assert.equal(JSON.stringify(steps.map((item) => item.predecessorIds)), dependencies);
  const reloaded = JSON.parse(JSON.stringify(steps));
  assert.deepEqual(core.orderedOwnerSteps(reloaded, "plan", "p").map((item) => item.id), ["b", "a", "c"]);
  assert.equal(core.validateDependencyGraph(reloaded).valid, true);
});

test("個別計画の並べ替えはテンプレート工程に影響しない", () => {
  const templateSteps = [
    { ...step("ta", 30), ownerType: "template", ownerId: "t" },
    { ...step("tb", 30, 0, "calendar", ["ta"]), ownerType: "template", ownerId: "t" }
  ];
  const planSteps = [step("pa", 30), step("pb", 30, 0, "calendar", ["pa"])];
  const allSteps = [...templateSteps, ...planSteps], before = JSON.stringify(templateSteps);
  core.movePlanStepDisplayOrder(allSteps, "p", "pa", 1);
  assert.equal(JSON.stringify(templateSteps), before);
  assert.deepEqual(core.orderedOwnerSteps(allSteps, "template", "t").map((item) => item.id), ["ta", "tb"]);
});

test("旧データと表示順付き工程が混在しても元の配列順を維持する", () => {
  const steps = [step("legacy-a", 30), step("legacy-b", 30), { ...step("new-c", 30), displayOrder: 2 }];
  assert.deepEqual(core.orderedOwnerSteps(steps, "plan", "p").map((item) => item.id), ["legacy-a", "legacy-b", "new-c"]);
});

test("テンプレート工程の表示順を依存関係と分離して保存・再読込できる", () => {
  const steps = [
    { ...step("ta", 30), ownerType: "template", ownerId: "t", displayOrder: 0 },
    { ...step("tb", 30, 0, "calendar", ["ta"]), ownerType: "template", ownerId: "t", displayOrder: 1 }
  ];
  const dependencies = JSON.stringify(steps.map((item) => item.predecessorIds));
  const result = core.moveOwnerStepDisplayOrder(steps, "template", "t", "ta", 1);
  assert.equal(result.moved, true);
  assert.deepEqual(core.orderedOwnerSteps(steps, "template", "t").map((item) => item.id), ["tb", "ta"]);
  assert.equal(JSON.stringify(steps.map((item) => item.predecessorIds)), dependencies);
  const reloaded = JSON.parse(JSON.stringify(steps));
  assert.deepEqual(core.orderedOwnerSteps(reloaded, "template", "t").map((item) => item.id), ["tb", "ta"]);
  assert.equal(core.validateDependencyGraph(reloaded).valid, true);
});

test("テンプレートの表示順を複製した個別計画へ引き継ぐ", () => {
  const data = core.createEmptyData();
  data.templates = [{ id: "t", name: "Template", description: "" }];
  data.experimentIdeas = [{ id: "i", name: "Idea", desiredCompletionDate: "2030-01-10" }];
  data.steps = [
    { ...step("ta", 30), ownerType: "template", ownerId: "t", displayOrder: 1 },
    { ...step("tb", 30, 0, "calendar", ["ta"]), ownerType: "template", ownerId: "t", displayOrder: 0 }
  ];
  const result = core.createPlanFromTemplate(data, "t", "i");
  assert.deepEqual(result.steps.map((item) => item.sourceTemplateStepId), ["tb", "ta"]);
  assert.deepEqual(result.steps.map((item) => item.displayOrder), [0, 1]);
  assert.equal(result.steps[0].predecessorIds[0], result.steps[1].id);
  assert.deepEqual(core.orderedOwnerSteps(JSON.parse(JSON.stringify(result.steps)), "plan", result.plan.id).map((item) => item.sourceTemplateStepId), ["tb", "ta"]);
  data.plans = [result.plan]; data.steps = result.steps;
  const schedule = core.calculatePlanSchedule(data, result.plan.id, "2030-01-10T18:00", opts), bySource = Object.fromEntries(schedule.stepSchedules.map((item) => [result.steps.find((stepItem) => stepItem.id === item.stepId).sourceTemplateStepId, item]));
  assert.equal(schedule.feasible, true);
  assert.equal(bySource.ta.endAt, bySource.tb.startAt);
});

test("既存の1500分を1日1時間0分へ分解する", () => {
  assert.deepEqual(core.splitWaitDurationMinutes(1500), { days: 1, hours: 1, minutes: 0 });
});

test("2日3時間30分を3090分へ変換する", () => {
  assert.deepEqual(core.combineWaitDurationParts({ days: "2", hours: "3", minutes: "30" }), { valid: true, errors: {}, totalMinutes: 3090 });
});

test("既存の分単位データとJSONバックアップの互換性を維持する", () => {
  const data = core.createEmptyData();
  data.templates = [{ id: "t", name: "Template", description: "" }];
  data.steps = [{ ...step("legacy", 30, 1500), ownerType: "template", ownerId: "t", assignedWorkerId: "worker_default", waitCheckWorkerId: "worker_default", workLocation: "lab" }];
  const parsed = core.parseBackup(core.serializeData(data));
  assert.equal(parsed.valid, true);
  assert.equal(parsed.data.steps[0].waitDurationMinutes, 1500);
  assert.deepEqual(core.splitWaitDurationMinutes(parsed.data.steps[0].waitDurationMinutes), { days: 1, hours: 1, minutes: 0 });
});

test("待機時間の日・時間・分の不正値を拒否する", () => {
  for (const parts of [
    { days: -1, hours: 0, minutes: 0 }, { days: 0.5, hours: 0, minutes: 0 },
    { days: 0, hours: 24, minutes: 0 }, { days: 0, hours: 0, minutes: 60 },
    { days: 0, hours: -1, minutes: 0 }, { days: 0, hours: 0, minutes: 1.5 }
  ]) assert.equal(core.combineWaitDurationParts(parts).valid, false);
  assert.equal(core.combineWaitDurationParts({ days: 0, hours: 0, minutes: 0 }).totalMinutes, 0);
});

function fullTemplateStep(id, ownerId, displayOrder, predecessors = []) {
  return { ...step(id, 30, 0, "calendar", predecessors), ownerType: "template", ownerId, displayOrder, assignedWorkerId: "worker_default", waitCheckWorkerId: "worker_default", workLocation: "lab", interruptible: true, waitCheckDurationMinutes: 0, waitCheckRequiresLab: false, actualSegments: [], remainingWorkMinutes: 30 };
}

function multipleTemplateData() {
  const data = core.createEmptyData();
  data.templates = [{ id: "t1", name: "First", description: "" }, { id: "t2", name: "Second", description: "" }];
  data.experimentIdeas = [{ id: "i", name: "Idea", priority: "中", status: "計画中", desiredCompletionDate: "2030-01-10", purpose: "", materials: "", plannedEquipment: "", notes: "" }];
  data.steps = [fullTemplateStep("t1a", "t1", 0), fullTemplateStep("t2a", "t2", 1), fullTemplateStep("t2b", "t2", 0, ["t2a"])];
  const created = core.createPlanFromTemplate(data, "t1", "i"); data.plans.push(created.plan); data.steps.push(...created.steps);
  return { data, plan: created.plan, originalSteps: created.steps };
}

test("既存計画の末尾へ別テンプレートを順序と内部依存を保って追加する", () => {
  const { data, plan, originalSteps } = multipleTemplateData(), originalJson = JSON.stringify(originalSteps);
  const appended = core.appendTemplateToPlan(data, "t2", plan.id);
  assert.equal(appended.alreadyApplied, false);
  assert.equal(JSON.stringify(originalSteps), originalJson);
  assert.deepEqual(appended.steps.map((item) => item.sourceTemplateStepId), ["t2b", "t2a"]);
  assert.deepEqual(appended.steps.map((item) => item.displayOrder), [1, 2]);
  assert.equal(appended.steps[0].predecessorIds[0], appended.steps[1].id);
  assert.ok(appended.steps.every((item) => item.predecessorIds.every((id) => appended.steps.some((candidate) => candidate.id === id))));
  assert.ok(appended.steps.every((item) => !originalSteps.some((existing) => existing.id === item.id)));
});

test("同じテンプレートを複数回追加しても工程IDと適用IDが重複しない", () => {
  const { data, plan } = multipleTemplateData(), first = core.appendTemplateToPlan(data, "t2", plan.id);
  data.steps.push(...first.steps); plan.templateApplications.push(first.application);
  assert.equal(core.hasTemplateBeenApplied(data, plan.id, "t2"), true);
  const second = core.appendTemplateToPlan(data, "t2", plan.id), ids = [...first.steps, ...second.steps].map((item) => item.id);
  assert.equal(second.alreadyApplied, true);
  assert.equal(new Set(ids).size, ids.length);
  assert.notEqual(first.application.id, second.application.id);
  assert.deepEqual(second.steps.map((item) => item.displayOrder), [3, 4]);
});

test("追加工程は元テンプレートと独立しJSON復元後も保持される", () => {
  const { data, plan } = multipleTemplateData(), appended = core.appendTemplateToPlan(data, "t2", plan.id);
  data.steps.push(...appended.steps); plan.templateApplications.push(appended.application); plan.scheduleNeedsRecalculation = true;
  const copiedNames = appended.steps.map((item) => item.name); data.steps.find((item) => item.id === "t2a").name = "Changed source";
  assert.deepEqual(appended.steps.map((item) => item.name), copiedNames);
  let parsed = core.parseBackup(core.serializeData(data)); assert.equal(parsed.valid, true);
  assert.equal(core.orderedOwnerSteps(parsed.data.steps, "plan", plan.id).length, 3);
  parsed.data.templates = parsed.data.templates.filter((item) => item.id !== "t2"); parsed.data.steps = parsed.data.steps.filter((item) => !(item.ownerType === "template" && item.ownerId === "t2"));
  parsed = core.parseBackup(core.serializeData(parsed.data));
  assert.equal(parsed.valid, true);
  assert.equal(parsed.data.steps.filter((item) => item.ownerType === "plan" && item.ownerId === plan.id && item.sourceTemplateId === "t2").length, 2);
});
