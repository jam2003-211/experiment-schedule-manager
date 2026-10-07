(function (root, factory) {
  const api = factory(root?.ExperimentCore || (typeof require === "function" ? require("./core.js") : null));
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ExperimentOptimizer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (C) {
  "use strict";
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const ms = (iso) => new Date(iso).getTime();
  const iso = (value) => new Date(value).toISOString();
  const overlap = (a, b) => ms(a.startAt) < ms(b.endAt) && ms(b.startAt) < ms(a.endAt);
  const priorityRank = (value) => ({ "高": 0, "中": 1, "低": 2 })[value] ?? 1;

  function attendanceType(data, dateKey) {
    return data.attendancePreferences.find((item) => item.date === dateKey)?.type || "normal";
  }
  function workerProfile(data, worker, location) {
    const id = location === "home" ? worker.homeAvailabilityProfileId : worker.labAvailabilityProfileId;
    return data.availability.profiles.find((profile) => profile.id === id) || data.availability.profiles.find((profile) => profile.locationType === location);
  }
  function intervalAllowed(data, worker, location, startAt, endAt) {
    const profile = workerProfile(data, worker, location); if (!profile) return false;
    let key = C.dateKeyInZone(startAt, data.availability.timeZone), endKey = C.dateKeyInZone(new Date(ms(endAt) - 1).toISOString(), data.availability.timeZone), guard = 0;
    while (key <= endKey && guard++ < 370) {
      if (location === "lab" && attendanceType(data, key) === "cannotVisit") return false;
      const available = C.intervalForDate(key, data.availability, profile.id); if (!available) return false;
      const sliceStart = Math.max(ms(startAt), ms(available.startAt)), sliceEnd = Math.min(ms(endAt), ms(available.endAt));
      if (sliceEnd <= sliceStart) return false;
      key = C.addDaysKey(key, 1);
    }
    return !(worker.unavailablePeriods || []).some((period) => overlap({ startAt, endAt }, period));
  }
  function reservationFree(reservations, resourceId, startAt, endAt, capacity = 1) {
    const start = ms(startAt), end = ms(endAt), events = [];
    reservations.filter((item) => item.resourceId === resourceId && overlap(item, { startAt, endAt })).forEach((item) => {
      events.push({ at: Math.max(start, ms(item.startAt)), delta: 1 }, { at: Math.min(end, ms(item.endAt)), delta: -1 });
    });
    events.sort((a, b) => a.at - b.at || a.delta - b.delta);
    let active = 0;
    for (const event of events) { active += event.delta; if (active >= capacity) return false; }
    return true;
  }
  function nextSlot(value, granularity) { return iso(Math.ceil(ms(value) / (granularity * 60000)) * granularity * 60000); }
  function addWorkingMinutes(startAt, minutes, data, profileId, limitAt) {
    let remaining = minutes, cursor = ms(startAt), segments = [], iterations = 0, granularity = 1;
    while (remaining > 0 && iterations++ < 300000) {
      if (limitAt && cursor >= ms(limitAt)) return null;
      const at = iso(cursor), key = C.dateKeyInZone(at, data.availability.timeZone), interval = C.intervalForDate(key, data.availability, profileId);
      if (interval && cursor < ms(interval.endAt)) {
        cursor = Math.max(cursor, ms(interval.startAt)); const take = Math.min(remaining, Math.floor((ms(interval.endAt) - cursor) / 60000));
        if (take > 0) { segments.push({ startAt: iso(cursor), endAt: iso(cursor + take * 60000), durationMinutes: take }); cursor += take * 60000; remaining -= take; continue; }
      }
      const next = C.addDaysKey(key, 1), nextIso = C.zonedLocalToIso(`${next}T00:00`, data.availability.timeZone); cursor = ms(nextIso);
    }
    return remaining === 0 ? { startAt, endAt: iso(cursor), segments } : null;
  }
  function checkTimes(step, waitStartAt, waitEndAt, waitSegments) {
    if (!step.labRequirement?.waitCheck || !step.waitCheckIntervalMinutes) return [];
    const result = [], interval = step.waitCheckIntervalMinutes;
    if (step.waitDurationType === "calendar") {
      for (let value = ms(waitStartAt) + interval * 60000; value < ms(waitEndAt); value += interval * 60000) result.push(iso(value));
    } else {
      let elapsed = 0, next = interval;
      for (const segment of waitSegments) {
        while (next < elapsed + segment.durationMinutes) { result.push(iso(ms(segment.startAt) + (next - elapsed) * 60000)); next += interval; }
        elapsed += segment.durationMinutes;
      }
    }
    return result;
  }
  function candidatePlacement(context, step, earliestAt, deadlineAt, preferredAt) {
    const { data, workerReservations, equipmentReservations, granularity } = context;
    const worker = data.workers.find((item) => item.id === step.assignedWorkerId && item.active !== false); if (!worker) return { error: `工程「${step.name}」の担当作業者が見つかりません。`, proven: true };
    const location = step.workLocation || "lab", profile = workerProfile(data, worker, location); if (!profile) return { error: `工程「${step.name}」の${location === "lab" ? "研究室" : "自宅"}作業時間がありません。`, proven: true };
    const progress = C.progressFields(step), remaining = step.status === "実施中" ? Number(step.remainingWorkMinutes ?? step.workDurationMinutes) : Number(step.workDurationMinutes);
    const fixedStart = step.manualStartAt || null, searchStart = fixedStart || preferredAt || earliestAt, maxTries = fixedStart ? 1 : Math.max(1, Math.ceil((ms(deadlineAt) - ms(searchStart)) / (granularity * 60000)));
    if (fixedStart && ms(fixedStart) < ms(earliestAt)) return { error: `工程「${step.name}」の手動開始日時が、先行工程の完了または再計算基準日時より前です。`, proven: true };
    if (fixedStart && remaining > 0) {
      const firstEnd = iso(ms(fixedStart) + Math.min(granularity, remaining) * 60000);
      if (!intervalAllowed(data, worker, location, fixedStart, firstEnd) || !reservationFree(workerReservations, worker.id, fixedStart, firstEnd)) {
        return { error: `工程「${step.name}」は指定した手動開始日時に開始できません。作業可能時間、来室不可日、作業者の予定を確認してください。`, proven: true };
      }
    }
    if (!step.interruptible) {
      const maxDaily = Math.max(0, ...(profile.weekly || []).filter((day) => day.enabled).map((day) => { const [sh, sm] = day.startTime.split(":").map(Number), [eh, em] = day.endTime.split(":").map(Number); return eh * 60 + em - sh * 60 - sm; }), ...(data.availability.exceptions || []).filter((item) => item.type === "available" && (!item.profileId || item.profileId === profile.id)).map((item) => { const [sh, sm] = item.startTime.split(":").map(Number), [eh, em] = item.endTime.split(":").map(Number); return eh * 60 + em - sh * 60 - sm; }));
      if (remaining > maxDaily) return { error: `中断不可工程「${step.name}」に必要な連続${remaining}分の作業枠がありません。`, proven: true };
    }
    for (let attempt = 0, cursor = fixedStart ? fixedStart : nextSlot(searchStart, granularity); attempt < maxTries && ms(cursor) <= ms(deadlineAt); attempt++, cursor = iso(ms(cursor) + granularity * 60000)) {
      if (context.searchDeadline && Date.now() > context.searchDeadline) return { error: "探索時間の上限に達しました。", proven: false };
      if (!fixedStart && remaining > 0) {
        let skipGuard = 0;
        while (ms(cursor) <= ms(deadlineAt) && skipGuard++ < 100000) {
          const firstEnd = iso(ms(cursor) + Math.min(granularity, remaining) * 60000);
          if (intervalAllowed(data, worker, location, cursor, firstEnd) && reservationFree(workerReservations, worker.id, cursor, firstEnd)) break;
          const key = C.dateKeyInZone(cursor, data.availability.timeZone), interval = C.intervalForDate(key, data.availability, profile.id);
          if (interval && ms(cursor) < ms(interval.startAt)) cursor = nextSlot(interval.startAt, granularity);
          else if (!interval || ms(cursor) >= ms(interval.endAt)) cursor = C.zonedLocalToIso(`${C.addDaysKey(key, 1)}T00:00`, data.availability.timeZone);
          else cursor = iso(ms(cursor) + granularity * 60000);
        }
        if (ms(cursor) > ms(deadlineAt)) break;
      }
      let workSegments = [], workEndAt = cursor, workRemaining = remaining, scan = ms(cursor), guard = 0;
      if (!step.interruptible && remaining > 0) {
        const endAt = iso(scan + remaining * 60000);
        if (!intervalAllowed(data, worker, location, cursor, endAt) || !reservationFree(workerReservations, worker.id, cursor, endAt)) continue;
        workSegments = [{ startAt: cursor, endAt, durationMinutes: remaining }]; workEndAt = endAt; workRemaining = 0;
      } else {
        while (workRemaining > 0 && scan < ms(deadlineAt) && guard++ < 100000) {
          const slotMinutes = Math.min(granularity, workRemaining), slotEnd = scan + slotMinutes * 60000, startIso = iso(scan), endIso = iso(slotEnd);
          if (intervalAllowed(data, worker, location, startIso, endIso) && reservationFree(workerReservations, worker.id, startIso, endIso)) {
            const previous = workSegments[workSegments.length - 1];
            if (previous && previous.endAt === startIso) { previous.endAt = endIso; previous.durationMinutes += slotMinutes; } else workSegments.push({ startAt: startIso, endAt: endIso, durationMinutes: slotMinutes });
            workRemaining -= slotMinutes; workEndAt = endIso;
          }
          scan = slotEnd;
        }
      }
      if (workRemaining > 0) continue;
      const workStartAt = workSegments[0]?.startAt || cursor;
      let waitEndAt = workEndAt, waitSegments = [];
      if (step.waitDurationMinutes > 0) {
        if (step.waitDurationType === "calendar") waitEndAt = iso(ms(workEndAt) + step.waitDurationMinutes * 60000);
        else { const wait = addWorkingMinutes(workEndAt, step.waitDurationMinutes, data, profile.id, deadlineAt); if (!wait) continue; waitEndAt = wait.endAt; waitSegments = wait.segments; }
      }
      const equipment = [], monitoring = [];
      let equipmentOk = true;
      for (const requirement of step.equipmentRequirements || []) {
        const device = data.equipment.find((item) => item.id === requirement.equipmentId); if (!device) return { error: `工程「${step.name}」の装置が見つかりません。`, proven: true };
        const startAt = iso(ms(workStartAt) + Number(requirement.occupancyStartOffsetMinutes || 0) * 60000), endAt = iso(ms(workStartAt) + Number(requirement.occupancyEndOffsetMinutes ?? requirement.occupancyMinutes) * 60000);
        if (ms(endAt) <= ms(startAt) || !reservationFree(equipmentReservations.concat(equipment), device.id, startAt, endAt, device.capacity || 1) || (device.unavailablePeriods || []).some((period) => overlap({ startAt, endAt }, period))) { equipmentOk = false; break; }
        equipment.push({ resourceId: device.id, equipmentId: device.id, startAt, endAt, stepId: step.id, monitoring: !!requirement.requiresContinuousMonitoring });
        if (requirement.requiresContinuousMonitoring) {
          if (!intervalAllowed(data, worker, "lab", startAt, endAt) || !reservationFree(workerReservations, worker.id, startAt, endAt)) { equipmentOk = false; break; }
          monitoring.push({ resourceId: worker.id, workerId: worker.id, startAt, endAt, stepId: step.id, kind: "monitoring" });
        }
      }
      if (!equipmentOk) continue;
      const checks = [], times = checkTimes(step, workEndAt, waitEndAt, waitSegments), checkWorker = data.workers.find((item) => item.id === (step.waitCheckWorkerId || step.assignedWorkerId));
      let checksOk = true;
      for (const at of times) {
        const endAt = iso(ms(at) + Number(step.waitCheckDurationMinutes || 5) * 60000), checkLocation = step.waitCheckRequiresLab === false ? "home" : "lab";
        if (!checkWorker || !intervalAllowed(data, checkWorker, checkLocation, at, endAt) || !reservationFree(workerReservations.concat(monitoring, checks), checkWorker.id, at, endAt)) { checksOk = false; break; }
        checks.push({ resourceId: checkWorker.id, workerId: checkWorker.id, startAt: at, endAt, stepId: step.id, kind: "waitCheck", location: checkLocation });
      }
      if (!checksOk) continue;
      const stepEndAt = waitEndAt;
      if (ms(stepEndAt) > ms(deadlineAt)) continue;
      const labEvents = [];
      workSegments.forEach((segment) => { if (location === "lab") labEvents.push({ at: segment.startAt, kind: "work" }, { at: segment.endAt, kind: "work" }); });
      if (step.labRequirement?.start) labEvents.push({ at: workStartAt, kind: "start" });
      if (step.labRequirement?.end) labEvents.push({ at: stepEndAt, kind: "end" });
      checks.filter((item) => item.location === "lab").forEach((item) => labEvents.push({ at: item.startAt, kind: "waitCheck" }));
      monitoring.forEach((item) => labEvents.push({ at: item.startAt, kind: "monitoring" }));
      const labProfile = workerProfile(data, worker, "lab");
      if (labEvents.some((event) => attendanceType(data, C.dateKeyInZone(event.at, data.availability.timeZone)) === "cannotVisit" || !labProfile || !C.isWorkingInstant(event.at, data.availability, labProfile.id))) continue;
      return { placement: { stepId: step.id, planId: step.ownerId, stepName: step.name, startAt: step.status === "実施中" && progress.actualStartDateTime ? progress.actualStartDateTime : workStartAt, scheduledWorkStartAt: workStartAt, workEndAt, waitStartAt: workEndAt, endAt: stepEndAt, workSegments, waitSegments, equipmentReservations: equipment, workerReservations: workSegments.map((segment) => ({ resourceId: worker.id, workerId: worker.id, ...segment, stepId: step.id, kind: "work" })).concat(monitoring, checks), labEvents, manual: !!fixedStart } };
    }
    return { error: fixedStart ? `工程「${step.name}」の手動開始日時では制約を満たせません。` : `工程「${step.name}」を期限内の空き時間へ配置できませんでした。`, proven: !!fixedStart };
  }

  function scheduleWithStrategy(data, planIds, mode, strategy, options) {
    const now = options.nowIso || new Date().toISOString(), granularity = options.granularityMinutes || 15, selected = new Set(planIds), plans = data.plans.filter((plan) => selected.has(plan.id)), steps = data.steps.filter((step) => step.ownerType === "plan" && selected.has(step.ownerId));
    const planMap = new Map(plans.map((plan) => [plan.id, plan])), ideaMap = new Map(data.experimentIdeas.map((idea) => [idea.id, idea]));
    if (!selected.size) return { feasible: false, resolution: "provenInfeasible", errors: ["最適化する実験計画が選択されていません。"] };
    if (plans.length !== selected.size) return { feasible: false, resolution: "provenInfeasible", errors: ["選択した実験計画の一部が見つかりません。"] };
    const invalidDeadline = plans.find((plan) => !Number.isFinite(ms(plan.targetCompletionDateTime)));
    if (invalidDeadline) return { feasible: false, resolution: "provenInfeasible", errors: [`「${invalidDeadline.name}」の完成予定日時が正しくありません。`] };
    const emptyPlan = plans.find((plan) => !steps.some((step) => step.ownerId === plan.id));
    if (emptyPlan) return { feasible: false, resolution: "provenInfeasible", errors: [`「${emptyPlan.name}」には工程がありません。`] };
    const graph = C.validateDependencyGraph(steps); if (!graph.valid) return { feasible: false, resolution: "provenInfeasible", errors: graph.errors };
    const byId = new Map(steps.map((step) => [step.id, step])), successor = new Map(steps.map((step) => [step.id, []]));
    steps.forEach((step) => (step.predecessorIds || []).forEach((id) => successor.get(id)?.push(step.id)));
    const scheduled = new Map(), workerReservations = [], equipmentReservations = [], labDays = new Set(), errors = [];
    for (const step of steps.filter((item) => C.progressFields(item).completed)) {
      const progress = C.progressFields(step); if (!progress.actualStartDateTime || !progress.actualEndDateTime) return { feasible: false, resolution: "provenInfeasible", errors: [`完了工程「${step.name}」の実績日時がありません。`] };
      scheduled.set(step.id, { stepId: step.id, planId: step.ownerId, stepName: step.name, startAt: progress.actualStartDateTime, workEndAt: progress.actualEndDateTime, waitStartAt: progress.actualEndDateTime, endAt: progress.actualEndDateTime, workSegments: step.actualSegments || [], waitSegments: [], equipmentReservations: [], workerReservations: [], labEvents: [], fixed: true });
    }
    const unscheduled = new Set(steps.filter((step) => !C.progressFields(step).completed).map((step) => step.id)), context = { data, workerReservations, equipmentReservations, granularity, searchDeadline: options.searchDeadline };
    while (unscheduled.size) {
      if (options.searchDeadline && Date.now() > options.searchDeadline) return { feasible: false, resolution: "searchLimit", errors: ["探索時間の上限に達しました。"], alternatives: ["探索時間を延長する", "対象実験を分けて計算する"] };
      const ready = [...unscheduled].map((id) => byId.get(id)).filter((step) => (step.predecessorIds || []).every((id) => scheduled.has(id)));
      if (!ready.length) return { feasible: false, resolution: "provenInfeasible", errors: ["未完了工程の依存関係を解決できません。"] };
      ready.sort((a, b) => {
        const pa = planMap.get(a.ownerId), pb = planMap.get(b.ownerId), da = ms(pa.targetCompletionDateTime), db = ms(pb.targetCompletionDateTime), ia = priorityRank(ideaMap.get(pa.experimentIdeaId)?.priority), ib = priorityRank(ideaMap.get(pb.experimentIdeaId)?.priority);
        if (strategy === "priority" && ia !== ib) return ia - ib;
        if (da !== db) return da - db; if (ia !== ib) return ia - ib; return (b.workDurationMinutes + b.waitDurationMinutes) - (a.workDurationMinutes + a.waitDurationMinutes);
      });
      const step = ready[0], plan = planMap.get(step.ownerId), predecessorEnd = (step.predecessorIds || []).map((id) => scheduled.get(id).endAt).sort().at(-1), earliest = step.status === "実施中" ? now : (predecessorEnd && ms(predecessorEnd) > ms(now) ? predecessorEnd : now);
      let starts = [earliest];
      if (mode === "attendanceReduced" && (step.workLocation || "lab") === "lab") {
        starts = [earliest, ...[...labDays].map((date) => C.zonedLocalToIso(`${date}T09:00`, data.availability.timeZone)).filter((at) => at && ms(at) >= ms(earliest))];
      }
      const candidates = starts.map((at) => candidatePlacement(context, step, earliest, plan.targetCompletionDateTime, at)).filter((item) => item.placement);
      if (!candidates.length) { const failed = candidatePlacement(context, step, earliest, plan.targetCompletionDateTime, step.manualStartAt || null); return { feasible: false, resolution: failed.proven ? "provenInfeasible" : "searchLimit", errors: [failed.error], alternatives: [`「${plan.name}」の完成予定日時を延長する`, `工程「${step.name}」の作業者・装置・手動開始日時を見直す`] }; }
      const score = (candidate) => {
        const days = new Set(candidate.placement.labEvents.map((event) => C.dateKeyInZone(event.at, data.availability.timeZone))), newDays = [...days].filter((day) => !labDays.has(day)).length, prefer = [...days].filter((day) => attendanceType(data, day) === "preferOff").length;
        return mode === "attendanceReduced" ? [newDays, prefer, ms(candidate.placement.endAt)] : [ms(candidate.placement.endAt), newDays, prefer];
      };
      candidates.sort((a, b) => { const sa = score(a), sb = score(b); for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i] - sb[i]; return 0; });
      const placement = candidates[0].placement; scheduled.set(step.id, placement); unscheduled.delete(step.id); workerReservations.push(...placement.workerReservations); equipmentReservations.push(...placement.equipmentReservations); placement.labEvents.forEach((event) => labDays.add(C.dateKeyInZone(event.at, data.availability.timeZone)));
    }
    const planResults = plans.map((plan) => { const own = [...scheduled.values()].filter((item) => item.planId === plan.id), completionAt = own.map((item) => item.endAt).sort().at(-1); return { planId: plan.id, planName: plan.name, targetCompletionDateTime: plan.targetCompletionDateTime, completionAt, meetsDeadline: ms(completionAt) <= ms(plan.targetCompletionDateTime), priority: ideaMap.get(plan.experimentIdeaId)?.priority || "中" }; });
    if (planResults.some((item) => !item.meetsDeadline)) return { feasible: false, resolution: "provenInfeasible", errors: planResults.filter((item) => !item.meetsDeadline).map((item) => `「${item.planName}」が完成予定日時を超過します。`) };
    const preferOffDates = [...labDays].filter((day) => attendanceType(data, day) === "preferOff"), completionTimes = planResults.map((item) => ms(item.completionAt));
    return { feasible: true, resolution: "feasible", stepSchedules: [...scheduled.values()], workerReservations, equipmentReservations, labVisitDates: [...labDays].sort(), preferOffVisitDates: preferOffDates.sort(), planResults, metrics: { makespan: iso(Math.max(...completionTimes)), completionTimeSum: completionTimes.reduce((sum, value) => sum + value, 0), labVisitDays: labDays.size, preferOffVisitDays: preferOffDates.length } };
  }

  function recalculatePlanProgress(data, planId, changedStepId, options) {
    const settings = { granularityMinutes: 15, rejectLate: false, ...(options || {}) }, plan = data.plans.find((item) => item.id === planId);
    const steps = C.orderedOwnerSteps(data.steps, "plan", planId), changed = steps.find((item) => item.id === changedStepId), errors = [];
    const versionBase = { id: C.makeId("schedule"), planId, kind: "rolling", calculatedAt: new Date().toISOString(), timeZone: data.availability.timeZone, availabilitySnapshot: clone(data.availability), targetCompletionDateTime: plan?.targetCompletionDateTime || null, previousScheduleVersionId: plan?.activeScheduleVersionId || null, changedStepId, affectedStepIds: [], stepSchedules: [], labVisitDates: [], warnings: [], errors };
    if (!plan || !changed) return { ...versionBase, feasible: false, errors: ["対象の実験計画または工程が見つかりません。"] };
    if (!Number.isFinite(ms(plan.targetCompletionDateTime))) return { ...versionBase, feasible: false, errors: ["完成希望日時が正しくありません。"] };
    const graph = C.validateDependencyGraph(steps); if (!graph.valid) return { ...versionBase, feasible: false, errors: graph.errors };

    const byId = new Map(steps.map((step) => [step.id, step])), successors = new Map(steps.map((step) => [step.id, []]));
    steps.forEach((step) => (step.predecessorIds || []).forEach((id) => successors.get(id)?.push(step.id)));
    const affected = new Set(), queue = C.progressFields(changed).completed ? [...(successors.get(changed.id) || [])] : [changed.id];
    while (queue.length) { const id = queue.shift(); if (affected.has(id)) continue; affected.add(id); (successors.get(id) || []).forEach((next) => queue.push(next)); }
    [...affected].forEach((id) => { if (C.progressFields(byId.get(id)).completed) affected.delete(id); });
    versionBase.affectedStepIds = [...affected];

    const previousVersion = data.scheduleVersions.find((item) => item.id === plan.activeScheduleVersionId) || null;
    const previousById = new Map((previousVersion?.stepSchedules || []).map((item) => [item.stepId, item]));
    const scheduled = new Map(), workerReservations = [], equipmentReservations = [], labDays = new Set();
    const fixedPlacement = (step, completed) => {
      const progress = C.progressFields(step), previous = previousById.get(step.id), startAt = completed ? progress.actualStartDateTime : (progress.plannedStartDateTime || previous?.startAt), endAt = completed ? progress.actualEndDateTime : (progress.plannedEndDateTime || previous?.endAt);
      if (!startAt || !endAt) return null;
      const placement = { ...(previous || {}), stepId: step.id, planId, stepName: step.name, startAt, scheduledWorkStartAt: previous?.scheduledWorkStartAt || previous?.workStartAt || startAt, workEndAt: completed ? endAt : (previous?.workEndAt || endAt), waitStartAt: previous?.waitStartAt || null, waitEndAt: previous?.waitEndAt || null, endAt, workSegments: completed ? (step.actualSegments || []) : (previous?.workSegments || []), waitSegments: completed ? [] : (previous?.waitSegments || []), equipmentReservations: [], workerReservations: [], labEvents: [], fixed: true, completed };
      if (!placement.workSegments.length && ms(placement.workEndAt) > ms(placement.scheduledWorkStartAt)) placement.workSegments = [{ startAt: placement.scheduledWorkStartAt, endAt: placement.workEndAt, durationMinutes: Math.max(0, Math.round((ms(placement.workEndAt) - ms(placement.scheduledWorkStartAt)) / 60000)) }];
      placement.workerReservations = placement.workSegments.map((segment) => ({ resourceId: step.assignedWorkerId, workerId: step.assignedWorkerId, stepId: step.id, kind: completed ? "actual" : "fixed", ...segment }));
      const base = placement.scheduledWorkStartAt;
      placement.equipmentReservations = (step.equipmentRequirements || []).map((requirement) => ({ resourceId: requirement.equipmentId, equipmentId: requirement.equipmentId, stepId: step.id, startAt: iso(ms(base) + Number(requirement.occupancyStartOffsetMinutes || 0) * 60000), endAt: iso(ms(base) + Number(requirement.occupancyEndOffsetMinutes ?? requirement.occupancyMinutes) * 60000), fixed: true }));
      return placement;
    };

    for (const step of steps) {
      const progress = C.progressFields(step), completed = progress.completed;
      if (!completed && affected.has(step.id)) continue;
      const placement = fixedPlacement(step, completed);
      if (!placement) {
        if ((successors.get(step.id) || []).some((id) => affected.has(id))) errors.push(`工程「${step.name}」の現在の予定日時がないため、後続工程を再計算できません。`);
        continue;
      }
      scheduled.set(step.id, placement); workerReservations.push(...placement.workerReservations); equipmentReservations.push(...placement.equipmentReservations);
    }
    if (errors.length) return { ...versionBase, feasible: false, errors };

    const changedProgress = C.progressFields(changed), referenceAt = settings.nowIso || changedProgress.actualEndDateTime || new Date().toISOString();
    const targetMs = ms(plan.targetCompletionDateTime), referenceMs = ms(referenceAt), horizonAt = iso(Math.max(targetMs, referenceMs) + 366 * 86400000);
    const unscheduled = new Set(affected), context = { data, workerReservations, equipmentReservations, granularity: settings.granularityMinutes, searchDeadline: Date.now() + (settings.maxMilliseconds || 10000) };
    while (unscheduled.size) {
      const ready = [...unscheduled].map((id) => byId.get(id)).filter((step) => (step.predecessorIds || []).every((id) => scheduled.has(id)));
      if (!ready.length) return { ...versionBase, feasible: false, errors: ["影響を受ける後続工程の依存関係を解決できません。"] };
      ready.sort((a, b) => (a.displayOrder ?? steps.indexOf(a)) - (b.displayOrder ?? steps.indexOf(b)));
      const step = ready[0], predecessorEnds = (step.predecessorIds || []).map((id) => scheduled.get(id)?.endAt).filter(Boolean), earliestDependency = predecessorEnds.sort().at(-1);
      const earliestAt = earliestDependency && ms(earliestDependency) > referenceMs ? earliestDependency : referenceAt;
      const candidate = candidatePlacement(context, step, earliestAt, horizonAt, step.manualStartAt || null);
      if (!candidate.placement) return { ...versionBase, feasible: false, errors: [candidate.error] };
      const placement = candidate.placement; scheduled.set(step.id, placement); unscheduled.delete(step.id); workerReservations.push(...placement.workerReservations); equipmentReservations.push(...placement.equipmentReservations); placement.labEvents.forEach((event) => labDays.add(C.dateKeyInZone(event.at, data.availability.timeZone)));
    }

    const finalSchedules = steps.map((step) => {
      const progress = C.progressFields(step), previous = previousById.get(step.id), placement = scheduled.get(step.id), recalculated = affected.has(step.id);
      const plannedStart = recalculated ? placement?.startAt : (progress.plannedStartDateTime || previous?.startAt || placement?.startAt), plannedEnd = recalculated ? placement?.endAt : (progress.plannedEndDateTime || previous?.endAt || placement?.endAt);
      const labVisits = (placement?.labEvents || previous?.labVisits || []).map((event) => ({ ...event, available: event.available !== false, label: event.label || `${step.name} ${event.kind || "来室"}` }));
      return { ...(previous || {}), ...(placement || {}), stepId: step.id, planId, stepName: step.name, startAt: plannedStart || progress.actualStartDateTime, endAt: plannedEnd || progress.actualEndDateTime, plannedStartAt: plannedStart || null, plannedEndAt: plannedEnd || null, actualStartAt: progress.actualStartDateTime, actualEndAt: progress.actualEndDateTime, completed: progress.completed, status: progress.completed ? "完了" : (step.status || "未着手"), workSegments: progress.completed && previous?.workSegments?.length ? previous.workSegments : (placement?.workSegments || previous?.workSegments || []), previousStartAt: previous?.startAt || progress.plannedStartDateTime || null, previousEndAt: previous?.endAt || progress.plannedEndDateTime || null, recalculated, labVisits };
    }).filter((item) => item.startAt && item.endAt);
    const completionTimes = finalSchedules.map((item) => item.actualEndAt && item.completed ? ms(item.actualEndAt) : ms(item.endAt)).filter(Number.isFinite), forecastCompletionAt = completionTimes.length ? iso(Math.max(...completionTimes)) : null;
    const delayMinutes = forecastCompletionAt ? Math.max(0, Math.ceil((ms(forecastCompletionAt) - targetMs) / 60000)) : 0, late = delayMinutes > 0;
    if (late) versionBase.warnings.push("現在の進捗では完成希望日時に間に合わない可能性があります");
    if (late && settings.rejectLate) return { ...versionBase, feasible: false, late, forecastCompletionAt, delayMinutes, affectedStepIds: [...affected], errors: ["指定した予定開始日時では完成希望日時に間に合いません。"] };
    const allVisits = finalSchedules.flatMap((item) => item.labVisits || []), visitDates = new Set([...labDays]); allVisits.forEach((visit) => visitDates.add(C.dateKeyInZone(visit.at, data.availability.timeZone)));
    return { ...versionBase, feasible: true, resolution: "feasible", stepSchedules: finalSchedules, workerReservations, equipmentReservations, labVisitDates: [...visitDates].filter(Boolean).sort(), requiredStartAt: finalSchedules.map((item) => item.startAt).sort()[0] || null, forecastCompletionAt, delayMinutes, late, affectedStepNames: [...affected].map((id) => byId.get(id)?.name).filter(Boolean) };
  }

  function validateResult(data, result) {
    const errors = [];
    if (!result?.feasible) return { valid: false, errors: result?.errors || ["実行可能な結果ではありません。"] };
    const schedules = new Map(result.stepSchedules.map((item) => [item.stepId, item]));
    result.stepSchedules.forEach((schedule) => { const step = data.steps.find((item) => item.id === schedule.stepId); (step?.predecessorIds || []).forEach((id) => { if (schedules.has(id) && ms(schedules.get(id).endAt) > ms(schedule.scheduledWorkStartAt || schedule.startAt)) errors.push(`工程「${step.name}」が先行工程より前に開始しています。`); }); });
    const validateCapacity = (reservations, capacityFor) => {
      const resourceIds = [...new Set(reservations.map((item) => item.resourceId))];
      resourceIds.forEach((resourceId) => {
        const events = reservations.filter((item) => item.resourceId === resourceId).flatMap((item) => [{ at: ms(item.startAt), delta: 1 }, { at: ms(item.endAt), delta: -1 }]).sort((a, b) => a.at - b.at || a.delta - b.delta);
        let active = 0, peak = 0; events.forEach((event) => { active += event.delta; peak = Math.max(peak, active); });
        if (peak > capacityFor(resourceId)) errors.push(`資源 ${resourceId} の同時利用数が上限を超えています。`);
      });
    };
    const workerReservations = result.workerReservations || [];
    for (let i = 0; i < workerReservations.length; i++) for (let j = i + 1; j < workerReservations.length; j++) if (workerReservations[i].resourceId === workerReservations[j].resourceId && workerReservations[i].stepId !== workerReservations[j].stepId && overlap(workerReservations[i], workerReservations[j])) errors.push(`作業者 ${workerReservations[i].resourceId} の予定が重複しています。`);
    validateCapacity(result.equipmentReservations || [], (id) => data.equipment.find((item) => item.id === id)?.capacity || 1);
    result.planResults.forEach((item) => { if (!item.meetsDeadline) errors.push(`「${item.planName}」が期限を超過しています。`); });
    return { valid: errors.length === 0, errors: [...new Set(errors)] };
  }

  function optimize(data, planIds, options) {
    const started = Date.now(), limits = { granularityMinutes: 15, maxMilliseconds: 10000, maxCandidates: 20000, ...(options || {}) }; limits.searchDeadline = started + limits.maxMilliseconds;
    const snapshot = clone({ plans: data.plans.filter((item) => planIds.includes(item.id)), steps: data.steps.filter((item) => item.ownerType === "plan" && planIds.includes(item.ownerId)), workers: data.workers, equipment: data.equipment, availability: data.availability, attendancePreferences: data.attendancePreferences, timeZone: data.availability.timeZone });
    const isValidCandidate = (item) => item.feasible && validateResult(data, item).valid;
    const invalidResult = (attempts) => attempts.find((item) => !item.feasible) || { feasible: false, resolution: "searchLimit", errors: ["必須制約を満たす候補を探索時間内に確認できませんでした。"], alternatives: ["探索時間を延長する", "対象実験を分けて計算する"] };
    const strategies = ["deadline", "priority"], fastestAttempts = strategies.map((strategy) => scheduleWithStrategy(data, planIds, "fastest", strategy, limits)), fastestCandidates = fastestAttempts.filter(isValidCandidate);
    const fastest = fastestCandidates.sort((a, b) => ms(a.metrics.makespan) - ms(b.metrics.makespan) || a.metrics.completionTimeSum - b.metrics.completionTimeSum)[0] || invalidResult(fastestAttempts);
    const attendanceAttempts = strategies.map((strategy) => scheduleWithStrategy(data, planIds, "attendanceReduced", strategy, limits)), attendanceCandidates = [fastest, ...attendanceAttempts].filter(isValidCandidate);
    const attendance = attendanceCandidates.sort((a, b) => a.metrics.labVisitDays - b.metrics.labVisitDays || a.metrics.preferOffVisitDays - b.metrics.preferOffVisitDays || ms(a.metrics.makespan) - ms(b.metrics.makespan))[0] || invalidResult(attendanceAttempts);
    const runId = C.makeId("optimization"), decorate = (result, type) => ({ id: C.makeId("optresult"), optimizationRunId: runId, type, approximate: true, generatedAt: new Date().toISOString(), inputSnapshot: snapshot, ...result, validation: validateResult(data, result) });
    const results = [decorate(fastest, "fastest"), decorate(attendance, "attendanceReduced")];
    const run = { id: runId, selectedPlanIds: [...planIds], requestedAt: new Date(started).toISOString(), completedAt: new Date().toISOString(), status: results.every((item) => item.feasible) ? "completed" : "infeasible", algorithmVersion: "4.0-heuristic", randomSeed: limits.randomSeed || 1, limits, inputSnapshot: snapshot, fastestResultId: results[0].id, attendanceReducedResultId: results[1].id, diagnostics: results.flatMap((item) => item.errors || []), elapsedMilliseconds: Date.now() - started };
    return { run, results };
  }

  return { optimize, validateResult, scheduleWithStrategy, recalculatePlanProgress };
});
