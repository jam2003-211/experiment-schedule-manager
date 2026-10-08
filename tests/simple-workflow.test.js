const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../core.js");

test("テンプレート適用から完了後の予定更新までの実運用シナリオ", () => {
  const now = "2031-06-01T00:00:00.000Z";
  const data = core.createEmptyData();
  data.updatedAt = now;
  data.experimentIdeas.push({
    id: "idea", name: "実運用確認", purpose: "", materials: "", priority: "中",
    desiredCompletionDate: "", notes: "", status: "未計画", createdAt: now, updatedAt: now
  });
  data.templates.push({ id: "template", name: "基本工程", description: "", createdAt: now, updatedAt: now });
  for (const [index, name] of ["調製", "測定", "解析"].entries()) {
    data.steps.push({
      id: `template_${index}`, ownerType: "template", ownerId: "template", name,
      displayOrder: index, workDurationMinutes: 60, waitDurationMinutes: index === 0 ? 30 : 0,
      waitDurationType: "calendar", workLocation: "lab", interruptible: true, notes: "",
      createdAt: now, updatedAt: now
    });
  }

  const created = core.createPlanFromTemplate(data, "template", "idea");
  data.plans.push(created.plan);
  data.steps.push(...created.steps);
  created.plan.scheduleMode = "forward";
  created.plan.experimentStartDateTime = "2031-06-02T09:00";

  const initial = core.calculateForwardSchedule(data, created.plan.id, created.plan.experimentStartDateTime);
  assert.equal(initial.feasible, true);
  assert.deepEqual(initial.stepSchedules.map((item) => item.stepName), ["調製", "測定", "解析"]);
  data.scheduleVersions.push(initial);
  created.plan.activeScheduleVersionId = initial.id;
  initial.stepSchedules.forEach((scheduled) => {
    core.assignProgressFields(data.steps.find((step) => step.id === scheduled.stepId), {
      plannedStartDateTime: scheduled.startAt,
      plannedEndDateTime: scheduled.endAt
    });
  });

  const first = created.steps[0];
  core.assignProgressFields(first, {
    completed: true,
    actualStartDateTime: initial.stepSchedules[0].startAt,
    actualEndDateTime: "2031-06-02T00:30:00.000Z"
  });
  const updated = core.recalculatePlanProgress(data, created.plan.id, first.id, {
    nowIso: first.actualEndDateTime
  });
  assert.equal(updated.feasible, true);
  assert.deepEqual(updated.affectedStepIds, created.steps.slice(1).map((step) => step.id));
  assert.ok(new Date(updated.stepSchedules[1].startAt) < new Date(initial.stepSchedules[1].startAt));

  const restored = core.parseBackup(core.serializeData(data));
  assert.equal(restored.valid, true);
  assert.equal(core.progressFields(restored.data.steps.find((step) => step.id === first.id)).completed, true);
});
