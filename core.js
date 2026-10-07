(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ExperimentCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SCHEMA_VERSION = 4;
  const STORAGE_KEY = "experimentScheduleManager.data";
  const MIGRATION_BACKUP_KEY = "experimentScheduleManager.data.preMigration.v1";
  const migrationBackupKey = (version) => `${STORAGE_KEY}.preMigration.v${version}`;
  const PRIORITIES = ["高", "中", "低"];
  const STATUSES = ["未計画", "計画中", "実施中", "完了"];
  const WAIT_TYPES = ["calendar", "working"];
  const nowIso = () => new Date().toISOString();

  function defaultWeekly() {
    return [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, enabled: dayOfWeek >= 1 && dayOfWeek <= 5, startTime: "09:00", endTime: "18:00" }));
  }
  function defaultAvailability() {
    return { timeZone: "Asia/Tokyo", activeProfileId: "profile_lab", profiles: [{ id: "profile_lab", name: "研究室", locationType: "lab", weekly: defaultWeekly() }, { id: "profile_home", name: "自宅", locationType: "home", weekly: defaultWeekly().map((day) => ({ ...day, enabled: false })) }], holidays: [], exceptions: [] };
  }

  function createEmptyData() {
    return { schemaVersion: SCHEMA_VERSION, updatedAt: nowIso(), experimentIdeas: [], templates: [], plans: [], steps: [], availability: defaultAvailability(), equipment: [], workers: [{ id: "worker_default", name: "既定の作業者", labAvailabilityProfileId: "profile_lab", homeAvailabilityProfileId: "profile_home", unavailablePeriods: [], active: true }], attendancePreferences: [], scheduleVersions: [], optimizationRuns: [], optimizationResults: [], confirmedOptimizationResultId: null };
  }
  function makeId(prefix) {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
  const normalizeText = (value) => typeof value === "string" ? value.trim() : "";
  const finiteNumber = (value) => { const number = Number(value); return Number.isFinite(number) ? number : NaN; };

  function splitWaitDurationMinutes(value) {
    const totalMinutes = finiteNumber(value);
    if (!Number.isInteger(totalMinutes) || totalMinutes < 0) return { days: 0, hours: 0, minutes: 0 };
    return { days: Math.floor(totalMinutes / 1440), hours: Math.floor((totalMinutes % 1440) / 60), minutes: totalMinutes % 60 };
  }
  function combineWaitDurationParts(input) {
    const days = finiteNumber(input?.days), hours = finiteNumber(input?.hours), minutes = finiteNumber(input?.minutes), errors = {};
    if (!Number.isInteger(days) || days < 0) errors.waitDurationDays = "待機日数は0以上の整数で入力してください。";
    if (!Number.isInteger(hours) || hours < 0 || hours > 23) errors.waitDurationHours = "待機時間は0〜23の整数で入力してください。";
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) errors.waitDurationMinutesPart = "待機分は0〜59の整数で入力してください。";
    return { valid: Object.keys(errors).length === 0, errors, totalMinutes: Object.keys(errors).length ? NaN : days * 1440 + hours * 60 + minutes };
  }

  function validateIdea(input) {
    const errors = {}, name = normalizeText(input.name), priority = normalizeText(input.priority), status = normalizeText(input.status), date = normalizeText(input.desiredCompletionDate);
    if (!name) errors.name = "実験名を入力してください。";
    if (name.length > 100) errors.name = "実験名は100文字以内で入力してください。";
    if (!PRIORITIES.includes(priority)) errors.priority = "優先度を選択してください。";
    if (!STATUSES.includes(status)) errors.status = "ステータスを選択してください。";
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.desiredCompletionDate = "希望完成日を正しく入力してください。";
    return { valid: Object.keys(errors).length === 0, errors };
  }
  function sanitizeIdea(input, existing) {
    const now = nowIso();
    return { id: existing?.id || makeId("idea"), name: normalizeText(input.name), purpose: normalizeText(input.purpose), materials: normalizeText(input.materials), plannedEquipment: normalizeText(input.plannedEquipment), priority: normalizeText(input.priority), desiredCompletionDate: normalizeText(input.desiredCompletionDate), notes: normalizeText(input.notes), status: normalizeText(input.status), createdAt: existing?.createdAt || now, updatedAt: now };
  }
  function validateTemplate(input) {
    const errors = {}, name = normalizeText(input.name);
    if (!name) errors.name = "テンプレート名を入力してください。";
    if (name.length > 100) errors.name = "テンプレート名は100文字以内で入力してください。";
    return { valid: Object.keys(errors).length === 0, errors };
  }
  function sanitizeTemplate(input, existing) {
    const now = nowIso();
    return { id: existing?.id || makeId("template"), name: normalizeText(input.name), description: normalizeText(input.description), createdAt: existing?.createdAt || now, updatedAt: now };
  }

  function validateStep(input, siblingSteps, editingId) {
    const errors = {}, name = normalizeText(input.name), work = finiteNumber(input.workDurationMinutes), wait = finiteNumber(input.waitDurationMinutes), check = finiteNumber(input.waitCheckIntervalMinutes || 0);
    const predecessorIds = Array.isArray(input.predecessorIds) ? input.predecessorIds : [], requirements = Array.isArray(input.equipmentRequirements) ? input.equipmentRequirements : [], lab = input.labRequirement || {};
    if (!name) errors.name = "工程名を入力してください。";
    if (!Number.isInteger(work) || work < 0) errors.workDurationMinutes = "作業時間は0以上の整数で入力してください。";
    if (!Number.isInteger(wait) || wait < 0) errors.waitDurationMinutes = "待機時間は0以上の整数で入力してください。";
    if (work === 0 && wait === 0) errors.workDurationMinutes = "作業時間または待機時間を設定してください。";
    if (!WAIT_TYPES.includes(input.waitDurationType)) errors.waitDurationType = "待機時間の種類を選択してください。";
    if (lab.waitCheck && wait <= 0) errors.labWaitCheck = "待機中の確認には待機時間が必要です。";
    if (lab.waitCheck && (!Number.isInteger(check) || check <= 0)) errors.waitCheckIntervalMinutes = "待機中の確認間隔を1分以上で入力してください。";
    if (!lab.waitCheck && check < 0) errors.waitCheckIntervalMinutes = "確認間隔は0以上で入力してください。";
    if (predecessorIds.includes(editingId)) errors.predecessorIds = "工程自身を先行工程にはできません。";
    const siblingIds = new Set((siblingSteps || []).map((step) => step.id));
    if (predecessorIds.some((id) => !siblingIds.has(id))) errors.predecessorIds = "存在しない先行工程が含まれています。";
    requirements.forEach((requirement, index) => {
      const occupancy = finiteNumber(requirement.occupancyMinutes);
      const startOffset = finiteNumber(requirement.occupancyStartOffsetMinutes || 0), endOffset = finiteNumber(requirement.occupancyEndOffsetMinutes ?? occupancy);
      if (!normalizeText(requirement.equipmentName) && !normalizeText(requirement.equipmentId)) errors[`equipment_${index}`] = `装置 ${index + 1} の名前を入力してください。`;
      if (!Number.isInteger(occupancy) || occupancy <= 0) errors[`equipment_${index}`] = `装置 ${index + 1} の占有時間は1分以上で入力してください。`;
      if (!Number.isInteger(startOffset) || startOffset < 0 || !Number.isInteger(endOffset) || endOffset <= startOffset) errors[`equipment_${index}`] = `装置 ${index + 1} の占有開始・終了位置が正しくありません。`;
    });
    if (lab.waitCheck && (!Number.isInteger(finiteNumber(input.waitCheckDurationMinutes || 5)) || finiteNumber(input.waitCheckDurationMinutes || 5) <= 0)) errors.waitCheckDurationMinutes = "確認作業時間を1分以上で入力してください。";
    if (input.workLocation && !["lab", "home"].includes(input.workLocation)) errors.workLocation = "作業場所が正しくありません。";
    return { valid: Object.keys(errors).length === 0, errors };
  }
  function sanitizeStep(input, existing, ownerType, ownerId) {
    const now = nowIso();
    return {
      id: existing?.id || makeId("step"), ownerType, ownerId, sourceTemplateStepId: existing?.sourceTemplateStepId || null,
      name: normalizeText(input.name), workDurationMinutes: finiteNumber(input.workDurationMinutes), waitDurationMinutes: finiteNumber(input.waitDurationMinutes), waitDurationType: input.waitDurationType,
      predecessorIds: [...new Set(input.predecessorIds || [])],
      labRequirement: { start: !!input.labRequirement?.start, end: !!input.labRequirement?.end, waitCheck: !!input.labRequirement?.waitCheck },
      waitCheckIntervalMinutes: input.labRequirement?.waitCheck ? finiteNumber(input.waitCheckIntervalMinutes) : 0,
      waitCheckDurationMinutes: input.labRequirement?.waitCheck ? finiteNumber(input.waitCheckDurationMinutes || existing?.waitCheckDurationMinutes || 5) : 0,
      waitCheckWorkerId: input.waitCheckWorkerId || existing?.waitCheckWorkerId || "worker_default",
      waitCheckRequiresLab: input.labRequirement?.waitCheck ? (input.waitCheckRequiresLab !== false) : false,
      assignedWorkerId: input.assignedWorkerId || existing?.assignedWorkerId || "worker_default",
      workLocation: input.workLocation || existing?.workLocation || "lab",
      interruptible: input.interruptible !== false,
      manualStartAt: input.manualStartAt || existing?.manualStartAt || null, plannedStartAt: existing?.plannedStartAt || null, plannedEndAt: existing?.plannedEndAt || null,
      equipmentRequirements: (input.equipmentRequirements || []).map((item) => {
        const occupancy = finiteNumber(item.occupancyMinutes);
        return { equipmentId: normalizeText(item.equipmentId), equipmentName: normalizeText(item.equipmentName), occupancyMinutes: occupancy, occupancyStartOffsetMinutes: finiteNumber(item.occupancyStartOffsetMinutes || 0), occupancyEndOffsetMinutes: finiteNumber(item.occupancyEndOffsetMinutes ?? occupancy), requiresContinuousMonitoring: !!item.requiresContinuousMonitoring };
      }),
      notes: normalizeText(input.notes), displayOrder: Number.isInteger(existing?.displayOrder) ? existing.displayOrder : null, createdAt: existing?.createdAt || now, updatedAt: now,
      actualWorkMinutes: existing?.actualWorkMinutes ?? null, actualStartedAt: existing?.actualStartedAt ?? null, actualEndedAt: existing?.actualEndedAt ?? null, actualSegments: existing?.actualSegments || [], remainingWorkMinutes: existing?.remainingWorkMinutes ?? finiteNumber(input.workDurationMinutes), progressUpdatedAt: existing?.progressUpdatedAt || null, status: existing?.status || "未着手"
    };
  }

  function validateDependencyGraph(steps) {
    const errors = [], ids = new Set(steps.map((step) => step.id)), state = new Map(), names = new Map(steps.map((step) => [step.id, step.name]));
    for (const step of steps) for (const predecessor of step.predecessorIds || []) {
      if (!ids.has(predecessor)) errors.push(`「${step.name}」の先行工程が見つかりません。`);
      if (predecessor === step.id) errors.push(`「${step.name}」が自身に依存しています。`);
    }
    function visit(id, path) {
      if (state.get(id) === 1) { const cycle = [...path.slice(path.indexOf(id)), id].map((item) => names.get(item) || item).join(" → "); errors.push(`循環する依存関係があります: ${cycle}`); return; }
      if (state.get(id) === 2) return;
      state.set(id, 1);
      const step = steps.find((item) => item.id === id);
      (step?.predecessorIds || []).forEach((predecessor) => { if (ids.has(predecessor)) visit(predecessor, [...path, id]); });
      state.set(id, 2);
    }
    steps.forEach((step) => visit(step.id, []));
    return { valid: errors.length === 0, errors: [...new Set(errors)] };
  }

  function orderedOwnerSteps(steps, ownerType, ownerId) {
    const owned = (steps || []).map((step, sourceIndex) => ({ step, sourceIndex })).filter((item) => item.step.ownerType === ownerType && item.step.ownerId === ownerId);
    if (!owned.every((item) => Number.isInteger(item.step.displayOrder))) return owned.map((item) => item.step);
    return owned.sort((a, b) => a.step.displayOrder - b.step.displayOrder || a.sourceIndex - b.sourceIndex).map((item) => item.step);
  }

  function moveOwnerStepDisplayOrder(steps, ownerType, ownerId, stepId, offset) {
    const ordered = orderedOwnerSteps(steps, ownerType, ownerId), currentIndex = ordered.findIndex((step) => step.id === stepId), targetIndex = currentIndex + Number(offset);
    if (currentIndex < 0) return { moved: false, error: "並べ替える工程が見つかりません。", orderedStepIds: ordered.map((step) => step.id) };
    if (!Number.isInteger(Number(offset)) || ![-1, 1].includes(Number(offset)) || targetIndex < 0 || targetIndex >= ordered.length) return { moved: false, error: "これ以上移動できません。", orderedStepIds: ordered.map((step) => step.id) };
    [ordered[currentIndex], ordered[targetIndex]] = [ordered[targetIndex], ordered[currentIndex]];
    ordered.forEach((step, index) => { step.displayOrder = index; });
    return { moved: true, error: null, orderedStepIds: ordered.map((step) => step.id) };
  }
  function movePlanStepDisplayOrder(steps, planId, stepId, offset) { return moveOwnerStepDisplayOrder(steps, "plan", planId, stepId, offset); }

  function createPlanFromTemplate(data, templateId, experimentIdeaId) {
    const template = data.templates.find((item) => item.id === templateId), idea = data.experimentIdeas.find((item) => item.id === experimentIdeaId);
    if (!template || !idea) throw new Error("テンプレートまたは実験が見つかりません。");
    const sourceSteps = orderedOwnerSteps(data.steps, "template", templateId);
    const graph = validateDependencyGraph(sourceSteps); if (!graph.valid) throw new Error(graph.errors[0]);
    const now = nowIso();
    const targetCompletionDate = idea.desiredCompletionDate || "";
    const plan = { id: makeId("plan"), experimentIdeaId, sourceTemplateId: templateId, name: `${idea.name} — ${template.name}`, targetCompletionDate, targetCompletionDateTime: targetCompletionDate ? zonedLocalToIso(`${targetCompletionDate}T18:00`, data.availability?.timeZone || "Asia/Tokyo") : "", activeScheduleVersionId: null, status: "下書き", createdAt: now, updatedAt: now };
    const idMap = new Map(sourceSteps.map((step) => [step.id, makeId("step")]));
    const steps = sourceSteps.map((step, index) => ({ ...JSON.parse(JSON.stringify(step)), id: idMap.get(step.id), ownerType: "plan", ownerId: plan.id, sourceTemplateStepId: step.id, displayOrder: index, predecessorIds: (step.predecessorIds || []).map((id) => idMap.get(id)), createdAt: now, updatedAt: now, actualWorkMinutes: null, actualStartedAt: null, actualEndedAt: null, status: "未着手" }));
    return { plan, steps };
  }

  function deepClone(value) { return JSON.parse(JSON.stringify(value)); }
  function pad2(value) { return String(value).padStart(2, "0"); }
  function parseDateKey(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
    if (!match) return null;
    const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
    const check = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    return check.getUTCFullYear() === parts.year && check.getUTCMonth() === parts.month - 1 && check.getUTCDate() === parts.day ? parts : null;
  }
  function addDaysKey(dateKey, amount) {
    const parts = parseDateKey(dateKey); if (!parts) return null;
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + amount));
    return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
  }
  function zonedParts(instant, timeZone) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
    return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  }
  function dateKeyInZone(instant, timeZone) { const p = zonedParts(instant, timeZone); return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`; }
  function zonedLocalToIso(localValue, timeZone) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(localValue || "");
    if (!match) return null;
    const wanted = { year: +match[1], month: +match[2], day: +match[3], hour: +match[4], minute: +match[5], second: +(match[6] || 0) };
    if (!parseDateKey(`${match[1]}-${match[2]}-${match[3]}`) || wanted.hour > 23 || wanted.minute > 59 || wanted.second > 59) return null;
    const target = Date.UTC(wanted.year, wanted.month - 1, wanted.day, wanted.hour, wanted.minute, wanted.second);
    let guess = target;
    for (let index = 0; index < 4; index++) {
      const shown = zonedParts(guess, timeZone), shownAsUtc = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second);
      const difference = target - shownAsUtc; guess += difference; if (!difference) break;
    }
    const verified = zonedParts(guess, timeZone);
    if (["year", "month", "day", "hour", "minute", "second"].some((key) => verified[key] !== wanted[key])) return null;
    return new Date(guess).toISOString();
  }
  function isoToZonedInput(iso, timeZone) {
    if (!iso || Number.isNaN(new Date(iso).getTime())) return "";
    const p = zonedParts(iso, timeZone); return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}`;
  }
  function formatZoned(iso, timeZone, options) {
    if (!iso || Number.isNaN(new Date(iso).getTime())) return "";
    return new Intl.DateTimeFormat("ja-JP", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(options || {}) }).format(new Date(iso));
  }
  function timeToMinutes(value) { const match = /^(\d{2}):(\d{2})$/.exec(value || ""); return match ? Number(match[1]) * 60 + Number(match[2]) : NaN; }
  function validateAvailability(availability) {
    const errors = [];
    if (!availability || typeof availability !== "object" || Array.isArray(availability)) return { valid: false, errors: ["作業可能時間設定はオブジェクトである必要があります。"] };
    if (!availability.timeZone) return { valid: false, errors: ["タイムゾーンが設定されていません。"] };
    try { new Intl.DateTimeFormat("ja-JP", { timeZone: availability.timeZone }).format(); } catch (_error) { errors.push("タイムゾーンが正しくありません。"); }
    if (!Array.isArray(availability.profiles) || !availability.profiles.length) errors.push("作業可能時間のプロファイルがありません。");
    if (!Array.isArray(availability.holidays)) errors.push("休日設定は配列である必要があります。");
    if (!Array.isArray(availability.exceptions)) errors.push("日付別例外は配列である必要があります。");
    (Array.isArray(availability.profiles) ? availability.profiles : []).forEach((profile) => {
      if (!profile.id || !profile.name || !Array.isArray(profile.weekly)) errors.push("作業可能時間プロファイルの形式が正しくありません。");
      (Array.isArray(profile.weekly) ? profile.weekly : []).forEach((day) => { if (!Number.isInteger(day.dayOfWeek) || day.dayOfWeek < 0 || day.dayOfWeek > 6 || typeof day.enabled !== "boolean") errors.push(`${profile.name || "作業可能時間"}の曜日設定の形式が正しくありません。`); if (day.enabled && (!Number.isFinite(timeToMinutes(day.startTime)) || !Number.isFinite(timeToMinutes(day.endTime)) || timeToMinutes(day.startTime) >= timeToMinutes(day.endTime))) errors.push(`${profile.name}の曜日設定に、開始時刻が終了時刻以降の行があります。`); });
    });
    (Array.isArray(availability.holidays) ? availability.holidays : []).forEach((item) => { if (!item?.id || !parseDateKey(item.date)) errors.push("休日設定のIDまたは日付が正しくありません。"); });
    (Array.isArray(availability.exceptions) ? availability.exceptions : []).forEach((item) => { if (!item?.id || !parseDateKey(item.date) || !["available", "unavailable"].includes(item.type)) errors.push("日付別例外のID、日付、種類が正しくありません。"); if (item.type === "available" && (!Number.isFinite(timeToMinutes(item.startTime)) || !Number.isFinite(timeToMinutes(item.endTime)) || timeToMinutes(item.startTime) >= timeToMinutes(item.endTime))) errors.push(`${item.date}の日付別例外で開始時刻が終了時刻以降です。`); });
    return { valid: errors.length === 0, errors: [...new Set(errors)] };
  }
  function intervalForDate(dateKey, availability, profileId) {
    const timeZone = availability.timeZone, profile = availability.profiles.find((item) => item.id === profileId) || availability.profiles[0];
    if (!profile) return null;
    const exception = (availability.exceptions || []).find((item) => item.date === dateKey && (!item.profileId || item.profileId === profile.id));
    if (exception?.type === "unavailable") return null;
    let startTime, endTime;
    if (exception?.type === "available") { startTime = exception.startTime; endTime = exception.endTime; }
    else {
      if ((availability.holidays || []).some((item) => item.date === dateKey)) return null;
      const date = parseDateKey(dateKey); if (!date) return null;
      const dayOfWeek = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay(), weekly = (profile.weekly || []).find((item) => item.dayOfWeek === dayOfWeek);
      if (!weekly?.enabled) return null; startTime = weekly.startTime; endTime = weekly.endTime;
    }
    const startAt = zonedLocalToIso(`${dateKey}T${startTime}`, timeZone), endAt = zonedLocalToIso(`${dateKey}T${endTime}`, timeZone);
    return startAt && endAt && new Date(endAt) > new Date(startAt) ? { startAt, endAt } : null;
  }
  function isWorkingInstant(iso, availability, profileId) {
    const interval = intervalForDate(dateKeyInZone(iso, availability.timeZone), availability, profileId); if (!interval) return false;
    const value = new Date(iso).getTime(); return value >= new Date(interval.startAt).getTime() && value <= new Date(interval.endAt).getTime();
  }
  function subtractWorkingMinutes(endIso, minutes, availability, profileId) {
    let remaining = Number(minutes), cursor = new Date(endIso); const segments = [];
    if (!Number.isInteger(remaining) || remaining < 0 || Number.isNaN(cursor.getTime())) throw new Error("逆算する時間または日時が正しくありません。");
    if (remaining === 0) return { startAt: cursor.toISOString(), endAt: cursor.toISOString(), segments };
    for (let days = 0; days < 3660 && remaining > 0; days++) {
      const dateKey = dateKeyInZone(cursor, availability.timeZone), interval = intervalForDate(dateKey, availability, profileId);
      if (interval) {
        const start = new Date(interval.startAt).getTime(), end = new Date(interval.endAt).getTime(), usableEnd = Math.min(cursor.getTime(), end);
        if (usableEnd > start) {
          const available = Math.floor((usableEnd - start) / 60000), take = Math.min(remaining, available), segmentStart = usableEnd - take * 60000;
          segments.unshift({ startAt: new Date(segmentStart).toISOString(), endAt: new Date(usableEnd).toISOString(), durationMinutes: take }); remaining -= take;
          if (remaining === 0) break;
        }
      }
      const previousDate = addDaysKey(dateKey, -1), previousEnd = zonedLocalToIso(`${previousDate}T23:59:59`, availability.timeZone);
      cursor = new Date(new Date(previousEnd).getTime() + 999);
    }
    if (remaining > 0) throw new Error("過去10年間を探索しても必要な作業可能時間を確保できません。曜日設定・休日・例外を確認してください。");
    return { startAt: segments[0].startAt, endAt: segments[segments.length - 1].endAt, segments };
  }
  function workingCheckTimes(segments, intervalMinutes) {
    const results = []; let next = intervalMinutes, elapsed = 0;
    for (const segment of segments) {
      const duration = segment.durationMinutes;
      while (next < elapsed + duration) { results.push(new Date(new Date(segment.startAt).getTime() + (next - elapsed) * 60000).toISOString()); next += intervalMinutes; }
      elapsed += duration;
    }
    return results;
  }
  function scheduleOneStep(step, deadlineIso, availability, profileId) {
    const workMinutes = step.workDurationMinutes, waitMinutes = step.waitDurationMinutes, deadlineMs = new Date(deadlineIso).getTime();
    let work = { startAt: deadlineIso, endAt: deadlineIso, segments: [] }, waitStartAt = null, waitEndAt = null, waitSegments = [], workDeadline = deadlineIso;
    if (waitMinutes > 0 && step.waitDurationType === "calendar") workDeadline = new Date(deadlineMs - waitMinutes * 60000).toISOString();
    if (waitMinutes > 0 && step.waitDurationType === "working") {
      const waitResult = subtractWorkingMinutes(deadlineIso, waitMinutes, availability, profileId); waitSegments = waitResult.segments; workDeadline = waitResult.startAt; waitEndAt = waitResult.endAt;
    }
    if (workMinutes > 0) work = subtractWorkingMinutes(workDeadline, workMinutes, availability, profileId);
    const workEndAt = workMinutes > 0 ? work.endAt : workDeadline;
    if (waitMinutes > 0) {
      waitStartAt = workEndAt;
      if (step.waitDurationType === "calendar") waitEndAt = new Date(new Date(waitStartAt).getTime() + waitMinutes * 60000).toISOString();
    }
    const startAt = workMinutes > 0 ? work.startAt : (waitStartAt || deadlineIso), endAt = waitMinutes > 0 ? waitEndAt : workEndAt;
    const checkTimes = step.labRequirement?.waitCheck && waitMinutes > 0
      ? (step.waitDurationType === "calendar"
        ? (() => { const values = []; for (let at = new Date(waitStartAt).getTime() + step.waitCheckIntervalMinutes * 60000; at < new Date(waitEndAt).getTime(); at += step.waitCheckIntervalMinutes * 60000) values.push(new Date(at).toISOString()); return values; })()
        : workingCheckTimes(waitSegments, step.waitCheckIntervalMinutes))
      : [];
    const visits = [];
    if (step.labRequirement?.start) visits.push({ kind: "start", at: startAt, label: `${step.name} 開始` });
    if (step.labRequirement?.end) visits.push({ kind: "end", at: endAt, label: `${step.name} 終了` });
    checkTimes.forEach((at) => visits.push({ kind: "waitCheck", at, label: `${step.name} 待機確認` }));
    visits.forEach((visit) => { visit.available = isWorkingInstant(visit.at, availability, profileId); });
    return { stepId: step.id, stepName: step.name, startAt, endAt, deadlineAt: deadlineIso, workStartAt: workMinutes ? work.startAt : null, workEndAt: workMinutes ? work.endAt : null, waitStartAt, waitEndAt, workSegments: work.segments, waitSegments, labVisits: visits };
  }
  function calculatePlanSchedule(data, planId, targetLocalValue, options) {
    const plan = data.plans.find((item) => item.id === planId), availability = deepClone(data.availability), errors = [], warnings = [];
    const versionBase = { id: makeId("schedule"), planId, calculatedAt: nowIso(), timeZone: availability.timeZone || "Asia/Tokyo", availabilitySnapshot: availability, stepSchedules: [], labVisitDates: [], warnings, errors };
    if (!plan) return { ...versionBase, feasible: false, errors: ["対象の実験計画が見つかりません。"] };
    const availabilityValidation = validateAvailability(availability); if (!availabilityValidation.valid) return { ...versionBase, feasible: false, errors: availabilityValidation.errors };
    const targetIso = /(?:Z|[+-]\d{2}:\d{2})$/.test(targetLocalValue || "") ? new Date(targetLocalValue).toISOString() : zonedLocalToIso(targetLocalValue, availability.timeZone);
    if (!targetIso) return { ...versionBase, feasible: false, errors: ["完成予定日時が正しくありません。"] };
    versionBase.targetCompletionDateTime = targetIso;
    const steps = data.steps.filter((step) => step.ownerType === "plan" && step.ownerId === planId), graph = validateDependencyGraph(steps);
    if (!steps.length) return { ...versionBase, feasible: false, errors: ["計算対象の工程がありません。"] };
    if (!graph.valid) return { ...versionBase, feasible: false, errors: graph.errors };
    for (const step of steps) { const validation = validateStep(step, steps.filter((item) => item.id !== step.id), step.id); if (!validation.valid) errors.push(...Object.values(validation.errors).map((message) => `工程「${step.name}」: ${message}`)); }
    if (errors.length) return { ...versionBase, feasible: false, errors: [...new Set(errors)] };
    const successors = new Map(steps.map((step) => [step.id, []])), indegree = new Map(steps.map((step) => [step.id, (step.predecessorIds || []).length]));
    steps.forEach((step) => (step.predecessorIds || []).forEach((id) => successors.get(id)?.push(step.id)));
    const queue = steps.filter((step) => indegree.get(step.id) === 0).map((step) => step.id), order = [];
    while (queue.length) { const id = queue.shift(); order.push(id); successors.get(id).forEach((next) => { indegree.set(next, indegree.get(next) - 1); if (indegree.get(next) === 0) queue.push(next); }); }
    const schedules = new Map(), profileId = availability.activeProfileId || availability.profiles[0].id;
    const profile = availability.profiles.find((item) => item.id === profileId) || availability.profiles[0];
    if (!(profile.weekly || []).some((day) => day.enabled) && !(availability.exceptions || []).some((item) => item.type === "available" && (!item.profileId || item.profileId === profileId))) {
      return { ...versionBase, feasible: false, errors: ["作業可能な曜日または日付別例外が1件もありません。"] };
    }
    try {
      [...order].reverse().forEach((id) => {
        const successorStarts = successors.get(id).map((nextId) => schedules.get(nextId).startAt), deadline = successorStarts.length ? successorStarts.sort()[0] : targetIso;
        schedules.set(id, scheduleOneStep(steps.find((step) => step.id === id), deadline, availability, profileId));
      });
    } catch (error) { return { ...versionBase, feasible: false, errors: [error.message] }; }
    versionBase.stepSchedules = order.map((id) => schedules.get(id));
    const allVisits = versionBase.stepSchedules.flatMap((schedule) => schedule.labVisits);
    allVisits.filter((visit) => !visit.available).forEach((visit) => warnings.push(`${formatZoned(visit.at, availability.timeZone)} の「${visit.label}」は作業不可時間です。日時は自動変更していません。`));
    versionBase.labVisitDates = [...new Set(allVisits.map((visit) => dateKeyInZone(visit.at, availability.timeZone)))].sort();
    const earliest = versionBase.stepSchedules.map((item) => item.startAt).sort()[0], referenceNow = options?.nowIso || nowIso();
    if (new Date(earliest) < new Date(referenceNow)) errors.push(`必要開始日時 ${formatZoned(earliest, availability.timeZone)} が現在より前のため、現時点からは完成予定日時に間に合いません。`);
    return { ...versionBase, feasible: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)], requiredStartAt: earliest };
  }

  function hydrateData(candidate) {
    const empty = createEmptyData();
    const sourceAvailability = candidate.availability || {}, defaults = defaultAvailability();
    const availability = Array.isArray(sourceAvailability.profiles)
      ? { ...defaults, ...sourceAvailability, profiles: sourceAvailability.profiles, holidays: sourceAvailability.holidays || [], exceptions: sourceAvailability.exceptions || [] }
      : { ...defaults, profiles: [{ ...defaults.profiles[0], weekly: sourceAvailability.weekly?.length ? sourceAvailability.weekly : defaultWeekly() }], exceptions: sourceAvailability.exceptions || [], holidays: sourceAvailability.holidays || [] };
    return { ...empty, ...candidate, experimentIdeas: Array.isArray(candidate.experimentIdeas) ? candidate.experimentIdeas : [], templates: Array.isArray(candidate.templates) ? candidate.templates : [], plans: Array.isArray(candidate.plans) ? candidate.plans : [], steps: Array.isArray(candidate.steps) ? candidate.steps : [], equipment: Array.isArray(candidate.equipment) ? candidate.equipment : [], workers: Array.isArray(candidate.workers) ? candidate.workers : empty.workers, attendancePreferences: Array.isArray(candidate.attendancePreferences) ? candidate.attendancePreferences : [], scheduleVersions: Array.isArray(candidate.scheduleVersions) ? candidate.scheduleVersions : [], optimizationRuns: Array.isArray(candidate.optimizationRuns) ? candidate.optimizationRuns : [], optimizationResults: Array.isArray(candidate.optimizationResults) ? candidate.optimizationResults : [], availability, updatedAt: candidate.updatedAt || empty.updatedAt };
  }
  function migrateData(candidate) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return { valid: false, errors: ["JSONのルートはオブジェクトである必要があります。"] };
    if (candidate.schemaVersion === SCHEMA_VERSION) {
      const validation = validateData(candidate);
      return validation.valid ? { valid: true, data: deepClone(candidate), migrated: false, errors: [] } : { valid: false, errors: validation.errors };
    }
    if (candidate.schemaVersion === 1 || candidate.schemaVersion === 2 || candidate.schemaVersion === 3) {
      const legacyArrayKeys = ["experimentIdeas", "templates", "plans", "steps", "equipment", "scheduleVersions"];
      const invalidLegacyKey = legacyArrayKeys.find((key) => candidate[key] !== undefined && !Array.isArray(candidate[key]));
      if (invalidLegacyKey) return { valid: false, errors: [`旧バージョンの ${invalidLegacyKey} は配列である必要があります。`] };
      const migrated = hydrateData({ ...candidate, schemaVersion: SCHEMA_VERSION });
      if (!migrated.availability.profiles.some((profile) => profile.locationType === "home")) migrated.availability.profiles.push({ id: "profile_home", name: "自宅", locationType: "home", weekly: defaultWeekly().map((day) => ({ ...day, enabled: false })) });
      if (!migrated.workers.length) migrated.workers = [{ id: "worker_default", name: "既定の作業者", labAvailabilityProfileId: "profile_lab", homeAvailabilityProfileId: "profile_home", unavailablePeriods: [], active: true }];
      migrated.templates = (candidate.templates || []).map((item) => ({ ...item, description: item.description || "" })); migrated.updatedAt = nowIso();
      migrated.plans = (candidate.plans || []).map((plan) => ({ ...plan, targetCompletionDateTime: plan.targetCompletionDateTime || (plan.targetCompletionDate ? zonedLocalToIso(`${plan.targetCompletionDate}T18:00`, migrated.availability.timeZone) : ""), activeScheduleVersionId: plan.activeScheduleVersionId || null }));
      migrated.steps = (candidate.steps || []).map((step) => ({ ...step, assignedWorkerId: step.assignedWorkerId || "worker_default", workLocation: step.workLocation || "lab", interruptible: step.interruptible !== false, manualStartAt: step.manualStartAt || null, waitCheckDurationMinutes: step.labRequirement?.waitCheck ? (step.waitCheckDurationMinutes || 5) : 0, waitCheckWorkerId: step.waitCheckWorkerId || "worker_default", waitCheckRequiresLab: step.labRequirement?.waitCheck ? step.waitCheckRequiresLab !== false : false, actualSegments: step.actualSegments || [], remainingWorkMinutes: step.remainingWorkMinutes ?? step.workDurationMinutes, progressUpdatedAt: step.progressUpdatedAt || null, equipmentRequirements: (step.equipmentRequirements || []).map((requirement) => ({ ...requirement, occupancyStartOffsetMinutes: requirement.occupancyStartOffsetMinutes || 0, occupancyEndOffsetMinutes: requirement.occupancyEndOffsetMinutes ?? requirement.occupancyMinutes, requiresContinuousMonitoring: !!requirement.requiresContinuousMonitoring })) }));
      migrated.equipment = (candidate.equipment || []).map((item) => ({ ...item, capacity: item.capacity || 1, unavailablePeriods: item.unavailablePeriods || [] }));
      migrated.attendancePreferences = candidate.attendancePreferences || []; migrated.optimizationRuns = candidate.optimizationRuns || []; migrated.optimizationResults = candidate.optimizationResults || []; migrated.confirmedOptimizationResultId = candidate.confirmedOptimizationResultId || null;
      const validation = validateData(migrated);
      return validation.valid ? { valid: true, data: migrated, migrated: true, fromVersion: candidate.schemaVersion, errors: [] } : { valid: false, errors: validation.errors };
    }
    return { valid: false, errors: [`対応していないスキーマバージョンです（対応: 1〜${SCHEMA_VERSION}）。`] };
  }
  function validateData(candidate) {
    const errors = [];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return { valid: false, errors: ["JSONのルートはオブジェクトである必要があります。"] };
    if (candidate.schemaVersion !== SCHEMA_VERSION) errors.push(`スキーマバージョン${SCHEMA_VERSION}ではありません。`);
    const arrayKeys = ["experimentIdeas", "templates", "plans", "steps", "equipment", "workers", "attendancePreferences", "scheduleVersions", "optimizationRuns", "optimizationResults"];
    arrayKeys.forEach((key) => { if (!Array.isArray(candidate[key])) errors.push(`${key} は配列である必要があります。`); });
    const validIso = (value) => typeof value === "string" && value.trim() !== "" && Number.isFinite(new Date(value).getTime());
    const optionalIso = (value) => value === null || value === undefined || value === "" || validIso(value);
    const validPeriod = (period) => period && validIso(period.startAt) && validIso(period.endAt) && new Date(period.endAt) > new Date(period.startAt);
    if (!validIso(candidate.updatedAt)) errors.push("updatedAt は有効な日時である必要があります。");
    const availabilityValidation = validateAvailability(candidate.availability);
    if (!availabilityValidation.valid) errors.push(...availabilityValidation.errors);
    const availability = candidate.availability && typeof candidate.availability === "object" ? candidate.availability : {};
    const profiles = Array.isArray(availability.profiles) ? availability.profiles : [], profileIds = new Set();
    profiles.forEach((profile, index) => { if (profileIds.has(profile.id)) errors.push(`作業可能時間プロファイル ${index + 1}: IDが重複しています。`); profileIds.add(profile.id); if (!["lab", "home"].includes(profile.locationType)) errors.push(`作業可能時間プロファイル ${index + 1}: 場所の種類が正しくありません。`); });
    if (availability.activeProfileId && !profileIds.has(availability.activeProfileId)) errors.push("使用中の作業可能時間プロファイルが見つかりません。");
    if (Array.isArray(availability.exceptions)) availability.exceptions.forEach((item, index) => { if (item.profileId && !profileIds.has(item.profileId)) errors.push(`日付別例外 ${index + 1}: 参照するプロファイルが見つかりません。`); });
    if (Array.isArray(candidate.experimentIdeas)) {
      const ids = new Set(); candidate.experimentIdeas.forEach((idea, index) => { const result = validateIdea(idea || {}); if (!idea?.id) errors.push(`実験ストック ${index + 1}: IDがありません。`); else if (ids.has(idea.id)) errors.push(`実験ストック ${index + 1}: IDが重複しています。`); else ids.add(idea.id); if (idea?.desiredCompletionDate && !parseDateKey(idea.desiredCompletionDate)) errors.push(`実験ストック ${index + 1}: 希望完成日が実在する日付ではありません。`); if (!optionalIso(idea?.createdAt) || !optionalIso(idea?.updatedAt)) errors.push(`実験ストック ${index + 1}: 作成・更新日時が正しくありません。`); Object.values(result.errors).forEach((message) => errors.push(`実験ストック ${index + 1}: ${message}`)); });
    }
    const allIds = new Set();
    for (const key of arrayKeys) if (Array.isArray(candidate[key])) candidate[key].forEach((item, index) => { if (!item || typeof item !== "object" || Array.isArray(item)) errors.push(`${key} ${index + 1}: オブジェクトである必要があります。`); else if (!item.id || typeof item.id !== "string") errors.push(`${key} ${index + 1}: IDがありません。`); else if (allIds.has(item.id)) errors.push(`${key} ${index + 1}: IDが重複しています。`); else allIds.add(item.id); });
    if (Array.isArray(candidate.templates)) candidate.templates.forEach((template, index) => { const result = validateTemplate(template || {}); Object.values(result.errors).forEach((message) => errors.push(`テンプレート ${index + 1}: ${message}`)); });
    const ideaIds = new Set(Array.isArray(candidate.experimentIdeas) ? candidate.experimentIdeas.map((item) => item?.id).filter(Boolean) : []), templateIds = new Set(Array.isArray(candidate.templates) ? candidate.templates.map((item) => item?.id).filter(Boolean) : []), planIds = new Set(Array.isArray(candidate.plans) ? candidate.plans.map((item) => item?.id).filter(Boolean) : []), equipmentIds = new Set(Array.isArray(candidate.equipment) ? candidate.equipment.map((item) => item?.id).filter(Boolean) : []), workerIds = new Set(Array.isArray(candidate.workers) ? candidate.workers.map((item) => item?.id).filter(Boolean) : []), scheduleIds = new Set(Array.isArray(candidate.scheduleVersions) ? candidate.scheduleVersions.map((item) => item?.id).filter(Boolean) : []), runIds = new Set(Array.isArray(candidate.optimizationRuns) ? candidate.optimizationRuns.map((item) => item?.id).filter(Boolean) : []), resultIds = new Set(Array.isArray(candidate.optimizationResults) ? candidate.optimizationResults.map((item) => item?.id).filter(Boolean) : []);
    if (Array.isArray(candidate.plans)) candidate.plans.forEach((plan, index) => { if (!normalizeText(plan?.name)) errors.push(`実験計画 ${index + 1}: 計画名がありません。`); if (plan?.experimentIdeaId && !ideaIds.has(plan.experimentIdeaId)) errors.push(`実験計画 ${index + 1}: 参照する実験ストックが見つかりません。`); if (plan?.sourceTemplateId && !templateIds.has(plan.sourceTemplateId)) errors.push(`実験計画 ${index + 1}: 参照するテンプレートが見つかりません。`); if (!optionalIso(plan?.targetCompletionDateTime)) errors.push(`実験計画 ${index + 1}: 完成予定日時が正しくありません。`); if (plan?.activeScheduleVersionId && !scheduleIds.has(plan.activeScheduleVersionId)) errors.push(`実験計画 ${index + 1}: 有効な逆算結果が見つかりません。`); if (plan?.confirmedOptimizationResultId && !resultIds.has(plan.confirmedOptimizationResultId)) errors.push(`実験計画 ${index + 1}: 確定した最適化結果が見つかりません。`); });
    if (Array.isArray(candidate.equipment)) candidate.equipment.forEach((item, index) => { if (!normalizeText(item?.name)) errors.push(`装置 ${index + 1}: 装置名がありません。`); if (!Number.isInteger(Number(item?.capacity)) || Number(item.capacity) < 1) errors.push(`装置 ${index + 1}: 同時利用数が正しくありません。`); if (!Array.isArray(item?.unavailablePeriods)) errors.push(`装置 ${index + 1}: 利用不可期間は配列である必要があります。`); else item.unavailablePeriods.forEach((period) => { if (!validPeriod(period)) errors.push(`装置 ${index + 1}: 利用不可期間の日時が正しくありません。`); }); });
    if (Array.isArray(candidate.workers)) candidate.workers.forEach((worker, index) => { if (!normalizeText(worker?.name)) errors.push(`作業者 ${index + 1}: 名前がありません。`); if (!profileIds.has(worker?.labAvailabilityProfileId) || !profileIds.has(worker?.homeAvailabilityProfileId)) errors.push(`作業者 ${index + 1}: 作業可能時間プロファイルが見つかりません。`); if (!Array.isArray(worker?.unavailablePeriods)) errors.push(`作業者 ${index + 1}: 利用不可期間は配列である必要があります。`); else worker.unavailablePeriods.forEach((period) => { if (!validPeriod(period)) errors.push(`作業者 ${index + 1}: 利用不可期間の日時が正しくありません。`); }); });
    if (Array.isArray(candidate.attendancePreferences)) candidate.attendancePreferences.forEach((item, index) => { if (!parseDateKey(item?.date) || !["normal", "preferOff", "cannotVisit"].includes(item?.type)) errors.push(`来室設定 ${index + 1}: 日付または種類が正しくありません。`); });
    if (Array.isArray(candidate.steps)) {
      const ownerGroups = new Map();
      candidate.steps.forEach((step, index) => {
        if (!step || !["template", "plan"].includes(step.ownerType) || !step.ownerId) { errors.push(`工程 ${index + 1}: 所属情報が正しくありません。`); return; }
        if (step.ownerType === "template" && !templateIds.has(step.ownerId) || step.ownerType === "plan" && !planIds.has(step.ownerId)) errors.push(`工程 ${index + 1}: 所属先が見つかりません。`);
        if (!workerIds.has(step.assignedWorkerId)) errors.push(`工程 ${index + 1}: 担当作業者が見つかりません。`);
        if (step.labRequirement?.waitCheck && !workerIds.has(step.waitCheckWorkerId)) errors.push(`工程 ${index + 1}: 確認担当者が見つかりません。`);
        if (!Array.isArray(step.predecessorIds)) errors.push(`工程 ${index + 1}: 先行工程IDは配列である必要があります。`);
        if (step.displayOrder !== undefined && step.displayOrder !== null && (!Number.isInteger(step.displayOrder) || step.displayOrder < 0)) errors.push(`工程 ${index + 1}: 表示順は0以上の整数である必要があります。`);
        if (!Array.isArray(step.equipmentRequirements)) errors.push(`工程 ${index + 1}: 使用装置は配列である必要があります。`); else step.equipmentRequirements.forEach((requirement) => { if (!equipmentIds.has(requirement.equipmentId)) errors.push(`工程 ${index + 1}: 使用装置「${requirement.equipmentId || "未設定"}」が見つかりません。`); });
        for (const [label, value] of [["手動開始日時", step.manualStartAt], ["実績開始日時", step.actualStartedAt], ["実績終了日時", step.actualEndedAt], ["進捗更新日時", step.progressUpdatedAt], ["予定開始日時", step.plannedStartAt], ["予定終了日時", step.plannedEndAt]]) if (!optionalIso(value)) errors.push(`工程 ${index + 1}: ${label}が正しくありません。`);
        if (step.actualStartedAt && step.actualEndedAt && new Date(step.actualEndedAt) < new Date(step.actualStartedAt)) errors.push(`工程 ${index + 1}: 実績終了日時が開始日時より前です。`);
        const key = `${step.ownerType}:${step.ownerId}`; if (!ownerGroups.has(key)) ownerGroups.set(key, []); ownerGroups.get(key).push(step);
      });
      ownerGroups.forEach((steps) => {
        const displayOrders = new Set(); steps.forEach((step) => { if (Number.isInteger(step.displayOrder)) { if (displayOrders.has(step.displayOrder)) errors.push(`工程「${step.name || step.id}」: 表示順が重複しています。`); displayOrders.add(step.displayOrder); } });
        steps.forEach((step) => { const result = validateStep(step, steps.filter((item) => item.id !== step.id), step.id); Object.values(result.errors).forEach((message) => errors.push(`工程「${step.name || step.id}」: ${message}`)); });
        errors.push(...validateDependencyGraph(steps).errors);
      });
    }
    if (Array.isArray(candidate.scheduleVersions)) candidate.scheduleVersions.forEach((version, index) => { if (!planIds.has(version?.planId)) errors.push(`逆算結果 ${index + 1}: 実験計画が見つかりません。`); if (!validIso(version?.calculatedAt)) errors.push(`逆算結果 ${index + 1}: 計算日時が正しくありません。`); if (!optionalIso(version?.targetCompletionDateTime)) errors.push(`逆算結果 ${index + 1}: 完成予定日時が正しくありません。`); if (!Array.isArray(version?.stepSchedules) || !Array.isArray(version?.labVisitDates) || !Array.isArray(version?.warnings) || !Array.isArray(version?.errors)) errors.push(`逆算結果 ${index + 1}: 結果配列の形式が正しくありません。`); });
    if (Array.isArray(candidate.optimizationRuns)) candidate.optimizationRuns.forEach((run, index) => { if (!Array.isArray(run?.selectedPlanIds) || run.selectedPlanIds.some((id) => !planIds.has(id))) errors.push(`最適化実行 ${index + 1}: 対象計画の参照が正しくありません。`); if (!validIso(run?.requestedAt) || !validIso(run?.completedAt)) errors.push(`最適化実行 ${index + 1}: 実行日時が正しくありません。`); if (run?.fastestResultId && !resultIds.has(run.fastestResultId) || run?.attendanceReducedResultId && !resultIds.has(run.attendanceReducedResultId)) errors.push(`最適化実行 ${index + 1}: 比較結果が見つかりません。`); });
    if (Array.isArray(candidate.optimizationResults)) candidate.optimizationResults.forEach((result, index) => { if (!runIds.has(result?.optimizationRunId)) errors.push(`最適化結果 ${index + 1}: 実行情報が見つかりません。`); if (!validIso(result?.generatedAt)) errors.push(`最適化結果 ${index + 1}: 生成日時が正しくありません。`); if (!Array.isArray(result?.errors || []) || result.feasible && (!Array.isArray(result.stepSchedules) || !Array.isArray(result.workerReservations) || !Array.isArray(result.equipmentReservations) || !Array.isArray(result.planResults))) errors.push(`最適化結果 ${index + 1}: 結果配列の形式が正しくありません。`); });
    if (candidate.confirmedOptimizationResultId && !resultIds.has(candidate.confirmedOptimizationResultId)) errors.push("確定した最適化結果が見つかりません。");
    return { valid: errors.length === 0, errors };
  }
  function serializeData(data) { return JSON.stringify({ ...data, schemaVersion: SCHEMA_VERSION, updatedAt: nowIso() }, null, 2); }
  function parseBackup(text) {
    let candidate; try { candidate = JSON.parse(text); } catch (_error) { return { valid: false, errors: ["JSONを読み取れません。ファイル形式を確認してください。"] }; }
    const migration = migrateData(candidate); if (!migration.valid) return migration;
    const validation = validateData(migration.data);
    return validation.valid ? { valid: true, data: migration.data, migrated: migration.migrated, errors: [] } : { valid: false, errors: validation.errors };
  }

  return { SCHEMA_VERSION, STORAGE_KEY, MIGRATION_BACKUP_KEY, migrationBackupKey, PRIORITIES, STATUSES, WAIT_TYPES, createEmptyData, defaultWeekly, defaultAvailability, makeId, splitWaitDurationMinutes, combineWaitDurationParts, validateIdea, sanitizeIdea, validateTemplate, sanitizeTemplate, validateStep, sanitizeStep, validateDependencyGraph, orderedOwnerSteps, moveOwnerStepDisplayOrder, movePlanStepDisplayOrder, createPlanFromTemplate, validateAvailability, intervalForDate, isWorkingInstant, subtractWorkingMinutes, zonedLocalToIso, isoToZonedInput, formatZoned, dateKeyInZone, addDaysKey, calculatePlanSchedule, migrateData, validateData, hydrateData, serializeData, parseBackup };
});
