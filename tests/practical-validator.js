(function (root, factory) {
  const api = factory(root?.ExperimentCore || (typeof require === "function" ? require("../core.js") : null));
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PracticalValidator = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (C) {
  "use strict";
  const time = (value) => new Date(value).getTime();
  const overlaps = (a, b) => time(a.startAt) < time(b.endAt) && time(b.startAt) < time(a.endAt);

  function peakUsage(reservations) {
    const events = reservations.flatMap((item) => [{ at: time(item.startAt), delta: 1 }, { at: time(item.endAt), delta: -1 }]).sort((a, b) => a.at - b.at || a.delta - b.delta);
    let active = 0, peak = 0;
    events.forEach((event) => { active += event.delta; peak = Math.max(peak, active); });
    return peak;
  }

  function validate(data, result) {
    const errors = [], checks = { dependencies: 0, equipment: 0, workers: 0, attendance: 0, deadlines: 0, mandatoryChecks: 0, workDurations: 0 };
    if (!result?.feasible) return { valid: false, errors: result?.errors || ["結果が実行可能ではありません。"], checks };
    const schedules = new Map(result.stepSchedules.map((item) => [item.stepId, item]));
    const steps = new Map(data.steps.map((item) => [item.id, item]));

    result.stepSchedules.forEach((schedule) => {
      const step = steps.get(schedule.stepId); if (!step) { errors.push(`未知の工程 ${schedule.stepId}`); return; }
      (step.predecessorIds || []).forEach((predecessorId) => {
        checks.dependencies++;
        const predecessor = schedules.get(predecessorId);
        if (!predecessor || time(predecessor.endAt) > time(schedule.scheduledWorkStartAt || schedule.startAt)) errors.push(`依存関係違反: ${predecessorId} -> ${step.id}`);
      });
      const expectedWork = step.status === "実施中" ? Number(step.remainingWorkMinutes) : step.status === "完了" ? 0 : Number(step.workDurationMinutes);
      const actualWork = (schedule.workSegments || []).reduce((sum, item) => sum + (time(item.endAt) - time(item.startAt)) / 60000, 0);
      checks.workDurations++;
      if (actualWork !== expectedWork) errors.push(`作業時間不一致: ${step.id} (${actualWork}/${expectedWork}分)`);
      if (step.interruptible === false && expectedWork > 0 && schedule.workSegments.length !== 1) errors.push(`中断不可工程が分割されています: ${step.id}`);

      const actualChecks = (schedule.workerReservations || []).filter((item) => item.kind === "waitCheck");
      let expectedChecks = 0;
      if (step.labRequirement?.waitCheck && step.waitCheckIntervalMinutes > 0) {
        if (step.waitDurationType === "calendar") expectedChecks = Math.max(0, Math.ceil(step.waitDurationMinutes / step.waitCheckIntervalMinutes) - 1);
        else expectedChecks = Math.max(0, Math.ceil(step.waitDurationMinutes / step.waitCheckIntervalMinutes) - 1);
      }
      checks.mandatoryChecks += expectedChecks;
      if (actualChecks.length !== expectedChecks) errors.push(`定期確認数不一致: ${step.id} (${actualChecks.length}/${expectedChecks})`);
      actualChecks.forEach((item) => {
        if ((time(item.endAt) - time(item.startAt)) / 60000 !== Number(step.waitCheckDurationMinutes)) errors.push(`確認時間不一致: ${step.id}`);
        if (item.workerId !== step.waitCheckWorkerId) errors.push(`確認担当者不一致: ${step.id}`);
      });
    });

    const equipmentGroups = new Map();
    (result.equipmentReservations || []).forEach((reservation) => { if (!equipmentGroups.has(reservation.resourceId)) equipmentGroups.set(reservation.resourceId, []); equipmentGroups.get(reservation.resourceId).push(reservation); });
    equipmentGroups.forEach((reservations, id) => {
      checks.equipment += reservations.length;
      const equipment = data.equipment.find((item) => item.id === id), capacity = equipment?.capacity || 1;
      if (peakUsage(reservations) > capacity) errors.push(`装置容量超過: ${id}`);
      reservations.forEach((reservation) => { if ((equipment?.unavailablePeriods || []).some((period) => overlaps(reservation, period))) errors.push(`装置利用不可期間との重複: ${id}`); });
    });

    const workerGroups = new Map();
    (result.workerReservations || []).forEach((reservation) => { if (!workerGroups.has(reservation.resourceId)) workerGroups.set(reservation.resourceId, []); workerGroups.get(reservation.resourceId).push(reservation); });
    workerGroups.forEach((reservations, id) => {
      checks.workers += reservations.length;
      const crossStepOverlap = reservations.some((item, index) => reservations.slice(index + 1).some((other) => item.stepId !== other.stepId && overlaps(item, other)));
      if (crossStepOverlap) errors.push(`作業者重複: ${id}`);
      const worker = data.workers.find((item) => item.id === id);
      reservations.forEach((reservation) => {
        if ((worker?.unavailablePeriods || []).some((period) => overlaps(reservation, period))) errors.push(`作業者利用不可期間との重複: ${id}`);
      });
    });

    result.stepSchedules.flatMap((item) => item.labEvents || []).forEach((event) => {
      checks.attendance++;
      const date = C.dateKeyInZone(event.at, data.availability.timeZone), preference = data.attendancePreferences.find((item) => item.date === date)?.type;
      if (preference === "cannotVisit") errors.push(`来室不可日の来室: ${date}`);
      const profile = data.availability.profiles.find((item) => item.locationType === "lab");
      if (!profile || !C.isWorkingInstant(event.at, data.availability, profile.id)) errors.push(`作業不可時間の来室: ${event.at}`);
    });

    (result.planResults || []).forEach((planResult) => {
      checks.deadlines++;
      if (time(planResult.completionAt) > time(planResult.targetCompletionDateTime) || !planResult.meetsDeadline) errors.push(`完成期限超過: ${planResult.planId}`);
    });
    return { valid: errors.length === 0, errors: [...new Set(errors)], checks };
  }

  function exactSolve(scenario) {
    const tasks = scenario.tasks, slots = scenario.slots, assignments = new Map(), feasible = [], taskById = new Map(tasks.map((task) => [task.id, task]));
    function canPlace(task, startIndex) {
      const endIndex = startIndex + task.durationSlots; if (endIndex > slots.length) return false;
      if ((task.predecessorIds || []).some((id) => !assignments.has(id) || assignments.get(id).endIndex > startIndex)) return false;
      for (const [id, placed] of assignments) {
        const other = taskById.get(id), overlap = startIndex < placed.endIndex && placed.startIndex < endIndex;
        if (overlap && (other.workerId === task.workerId || (other.equipmentId && other.equipmentId === task.equipmentId))) return false;
      }
      return true;
    }
    function visit(index) {
      if (index === tasks.length) {
        const planCompletion = {};
        tasks.forEach((task) => { const placed = assignments.get(task.id); planCompletion[task.planId] = Math.max(planCompletion[task.planId] || 0, placed.endIndex); });
        if (Object.entries(planCompletion).some(([planId, end]) => end > scenario.deadlineSlots[planId])) return;
        const completionValues = Object.values(planCompletion), visitDays = new Set(tasks.filter((task) => task.requiresLab).map((task) => slots[assignments.get(task.id).startIndex].date)).size;
        feasible.push({ assignments: Object.fromEntries([...assignments].map(([id, value]) => [id, { ...value }])), makespan: Math.max(...completionValues), completionSum: completionValues.reduce((sum, value) => sum + value, 0), visitDays }); return;
      }
      const task = tasks[index];
      for (let startIndex = 0; startIndex < slots.length; startIndex++) if (canPlace(task, startIndex)) { assignments.set(task.id, { startIndex, endIndex: startIndex + task.durationSlots }); visit(index + 1); assignments.delete(task.id); }
    }
    visit(0);
    const fastest = feasible.slice().sort((a, b) => a.makespan - b.makespan || a.completionSum - b.completionSum)[0] || null;
    const attendance = feasible.slice().sort((a, b) => a.visitDays - b.visitDays || a.makespan - b.makespan || a.completionSum - b.completionSum)[0] || null;
    return { evaluated: Math.pow(slots.length, tasks.length), feasibleCount: feasible.length, fastest, attendance };
  }

  return { validate, exactSolve, peakUsage };
});
