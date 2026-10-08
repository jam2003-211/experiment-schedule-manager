(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ExperimentCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SCHEMA_VERSION = 4;
  const STORAGE_KEY = "experimentScheduleManager.data";
  const MIGRATION_BACKUP_KEY = "experimentScheduleManager.data.preMigration.v1";
  const SIMPLIFICATION_BACKUP_KEY = "experimentScheduleManager.data.preSimplification.v4";
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
    return { schemaVersion: SCHEMA_VERSION, updatedAt: nowIso(), experimentIdeas: [], templates: [], plans: [], steps: [], availability: defaultAvailability(), attendancePreferences: [], scheduleVersions: [] };
  }
  function makeId(prefix) {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
  const normalizeText = (value) => typeof value === "string" ? value.trim() : "";
  const finiteNumber = (value) => { const number = Number(value); return Number.isFinite(number) ? number : NaN; };
  const planScheduleMode = (plan) => plan?.scheduleMode === "forward" ? "forward" : "backward";

  function progressFields(step) {
    const has = (key) => !!step && Object.prototype.hasOwnProperty.call(step, key);
    const plannedStartDateTime = has("plannedStartDateTime") ? step.plannedStartDateTime : (step?.plannedStartAt || null);
    const plannedEndDateTime = has("plannedEndDateTime") ? step.plannedEndDateTime : (step?.plannedEndAt || null);
    const actualStartDateTime = has("actualStartDateTime") ? step.actualStartDateTime : (step?.actualStartedAt || null);
    const actualEndDateTime = has("actualEndDateTime") ? step.actualEndDateTime : (step?.actualEndedAt || null);
    const completed = step?.completed === true || step?.status === "完了";
    return { plannedStartDateTime, plannedEndDateTime, actualStartDateTime, actualEndDateTime, completed };
  }
  function assignProgressFields(step, values) {
    const current = progressFields({ ...step, ...(values || {}) });
    step.plannedStartDateTime = current.plannedStartDateTime; step.plannedEndDateTime = current.plannedEndDateTime;
    step.actualStartDateTime = current.actualStartDateTime; step.actualEndDateTime = current.actualEndDateTime; step.completed = current.completed;
    step.plannedStartAt = current.plannedStartDateTime; step.plannedEndAt = current.plannedEndDateTime;
    step.actualStartedAt = current.actualStartDateTime; step.actualEndedAt = current.actualEndDateTime;
    if (current.completed) step.status = "完了";
    return step;
  }

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
    return { id: existing?.id || makeId("idea"), name: normalizeText(input.name), purpose: normalizeText(input.purpose), materials: normalizeText(input.materials), priority: normalizeText(input.priority), desiredCompletionDate: normalizeText(input.desiredCompletionDate), notes: normalizeText(input.notes), status: normalizeText(input.status), createdAt: existing?.createdAt || now, updatedAt: now };
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
    const errors = {}, name = normalizeText(input.name), work = finiteNumber(input.workDurationMinutes), wait = finiteNumber(input.waitDurationMinutes);
    if (!name) errors.name = "工程名を入力してください。";
    if (!Number.isInteger(work) || work < 0) errors.workDurationMinutes = "作業時間は0以上の整数で入力してください。";
    if (!Number.isInteger(wait) || wait < 0) errors.waitDurationMinutes = "待機時間は0以上の整数で入力してください。";
    if (work === 0 && wait === 0) errors.workDurationMinutes = "作業時間または待機時間を設定してください。";
    if (!WAIT_TYPES.includes(input.waitDurationType)) errors.waitDurationType = "待機時間の種類を選択してください。";
    if (input.workLocation && !["lab", "home"].includes(input.workLocation)) errors.workLocation = "作業場所が正しくありません。";
    return { valid: Object.keys(errors).length === 0, errors };
  }
  function sanitizeStep(input, existing, ownerType, ownerId) {
    const now = nowIso();
    return {
      id: existing?.id || makeId("step"), ownerType, ownerId, sourceTemplateId: existing?.sourceTemplateId || null, sourceTemplateStepId: existing?.sourceTemplateStepId || null, templateApplicationId: existing?.templateApplicationId || null,
      name: normalizeText(input.name), workDurationMinutes: finiteNumber(input.workDurationMinutes), waitDurationMinutes: finiteNumber(input.waitDurationMinutes), waitDurationType: input.waitDurationType,
      workLocation: input.workLocation || existing?.workLocation || "lab",
      interruptible: input.interruptible !== false,
      manualStartAt: input.manualStartAt || existing?.manualStartAt || null, plannedStartAt: progressFields(existing).plannedStartDateTime, plannedEndAt: progressFields(existing).plannedEndDateTime,
      plannedStartDateTime: progressFields(existing).plannedStartDateTime, plannedEndDateTime: progressFields(existing).plannedEndDateTime,
      notes: normalizeText(input.notes), displayOrder: Number.isInteger(existing?.displayOrder) ? existing.displayOrder : null, createdAt: existing?.createdAt || now, updatedAt: now,
      actualWorkMinutes: existing?.actualWorkMinutes ?? null, actualStartedAt: progressFields(existing).actualStartDateTime, actualEndedAt: progressFields(existing).actualEndDateTime,
      actualStartDateTime: progressFields(existing).actualStartDateTime, actualEndDateTime: progressFields(existing).actualEndDateTime, completed: progressFields(existing).completed,
      actualSegments: existing?.actualSegments || [], remainingWorkMinutes: existing?.remainingWorkMinutes ?? finiteNumber(input.workDurationMinutes), progressUpdatedAt: existing?.progressUpdatedAt || null, status: existing?.status || "未着手"
    };
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

  function cloneTemplateStepsForPlan(data, templateId, planId, startingDisplayOrder, applicationId) {
    const template = data.templates.find((item) => item.id === templateId), plan = data.plans.find((item) => item.id === planId);
    if (!template || !plan) throw new Error("テンプレートまたは実験計画が見つかりません。");
    const sourceSteps = orderedOwnerSteps(data.steps, "template", templateId);
    if (!sourceSteps.length) throw new Error("テンプレートに工程がありません。");
    const now = nowIso(), idMap = new Map(sourceSteps.map((step) => [step.id, makeId("step")]));
    return sourceSteps.map((step, index) => ({
      ...deepClone(step), id: idMap.get(step.id), ownerType: "plan", ownerId: planId, sourceTemplateId: templateId, sourceTemplateStepId: step.id, templateApplicationId: applicationId,
      displayOrder: startingDisplayOrder + index, predecessorIds: [], createdAt: now, updatedAt: now,
      actualWorkMinutes: null, actualStartedAt: null, actualEndedAt: null, actualStartDateTime: null, actualEndDateTime: null, completed: false, actualSegments: [], remainingWorkMinutes: step.workDurationMinutes, progressUpdatedAt: null, status: "未着手", plannedStartAt: null, plannedEndAt: null, plannedStartDateTime: null, plannedEndDateTime: null
    }));
  }

  function hasTemplateBeenApplied(data, planId, templateId) {
    const plan = data.plans.find((item) => item.id === planId); if (!plan) return false;
    if (plan.sourceTemplateId === templateId || (plan.templateApplications || []).some((item) => item.templateId === templateId)) return true;
    const templateStepIds = new Set(data.steps.filter((step) => step.ownerType === "template" && step.ownerId === templateId).map((step) => step.id));
    return data.steps.some((step) => step.ownerType === "plan" && step.ownerId === planId && (step.sourceTemplateId === templateId || templateStepIds.has(step.sourceTemplateStepId)));
  }

  function appendTemplateToPlan(data, templateId, planId) {
    const template = data.templates.find((item) => item.id === templateId), plan = data.plans.find((item) => item.id === planId);
    if (!template || !plan) throw new Error("テンプレートまたは実験計画が見つかりません。");
    const existingSteps = orderedOwnerSteps(data.steps, "plan", planId), highestOrder = existingSteps.reduce((highest, step) => Number.isInteger(step.displayOrder) ? Math.max(highest, step.displayOrder) : highest, -1);
    const startingDisplayOrder = Math.max(existingSteps.length, highestOrder + 1), application = { id: makeId("templateApplication"), templateId, templateName: template.name, appliedAt: nowIso(), stepIds: [] };
    const steps = cloneTemplateStepsForPlan(data, templateId, planId, startingDisplayOrder, application.id); application.stepIds = steps.map((step) => step.id);
    return { application, steps, alreadyApplied: hasTemplateBeenApplied(data, planId, templateId) };
  }

  function createPlanFromTemplate(data, templateId, experimentIdeaId) {
    const template = data.templates.find((item) => item.id === templateId), idea = data.experimentIdeas.find((item) => item.id === experimentIdeaId);
    if (!template || !idea) throw new Error("テンプレートまたは実験が見つかりません。");
    const now = nowIso();
    const targetCompletionDate = idea.desiredCompletionDate || "";
    const applicationId = makeId("templateApplication"), plan = { id: makeId("plan"), experimentIdeaId, sourceTemplateId: templateId, name: `${idea.name} — ${template.name}`, scheduleMode: "backward", experimentStartDateTime: null, forecastCompletionDateTime: null, targetCompletionDate, targetCompletionDateTime: targetCompletionDate ? zonedLocalToIso(`${targetCompletionDate}T18:00`, data.availability?.timeZone || "Asia/Tokyo") : "", activeScheduleVersionId: null, status: "下書き", templateApplications: [], createdAt: now, updatedAt: now };
    const dataWithPlan = { ...data, plans: [...data.plans, plan] }, steps = cloneTemplateStepsForPlan(dataWithPlan, templateId, plan.id, 0, applicationId);
    plan.templateApplications.push({ id: applicationId, templateId, templateName: template.name, appliedAt: now, stepIds: steps.map((step) => step.id) });
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
  function availabilityForStep(data, step) {
    const availability = deepClone(data.availability), labWork = (step.workLocation || "lab") === "lab";
    if (labWork) {
      const blocked = new Set((data.attendancePreferences || []).filter((item) => item.type === "cannotVisit").map((item) => item.date));
      availability.exceptions = (availability.exceptions || []).filter((item) => !blocked.has(item.date));
      blocked.forEach((date) => { if (!(availability.holidays || []).some((item) => item.date === date)) availability.holidays.push({ id: `cannotVisit_${date}`, date, name: "来室不可日" }); });
    }
    return availability;
  }
  function addWorkingMinutes(startIso, minutes, availability, profileId) {
    let remaining = Number(minutes), cursor = new Date(startIso), segments = [];
    if (!Number.isInteger(remaining) || remaining < 0 || Number.isNaN(cursor.getTime())) throw new Error("計算する時間または日時が正しくありません。");
    if (remaining === 0) return { startAt: cursor.toISOString(), endAt: cursor.toISOString(), segments };
    for (let days = 0; days < 3660 && remaining > 0; days++) {
      const dateKey = dateKeyInZone(cursor, availability.timeZone), interval = intervalForDate(dateKey, availability, profileId);
      if (interval) {
        const start = new Date(interval.startAt).getTime(), end = new Date(interval.endAt).getTime(), usableStart = Math.max(cursor.getTime(), start);
        if (usableStart < end) {
          const available = Math.floor((end - usableStart) / 60000), take = Math.min(remaining, available), segmentEnd = usableStart + take * 60000;
          segments.push({ startAt: new Date(usableStart).toISOString(), endAt: new Date(segmentEnd).toISOString(), durationMinutes: take }); remaining -= take; cursor = new Date(segmentEnd);
          if (remaining === 0) break;
        }
      }
      const nextDate = addDaysKey(dateKey, 1); cursor = new Date(zonedLocalToIso(`${nextDate}T00:00`, availability.timeZone));
    }
    if (remaining > 0) throw new Error("今後10年間を探索しても必要な作業可能時間を確保できません。曜日設定・休日・例外を確認してください。");
    return { startAt: segments[0].startAt, endAt: segments.at(-1).endAt, segments };
  }
  function subtractContinuousMinutes(endIso, minutes, availability, profileId) {
    let cursor = new Date(endIso);
    for (let days = 0; days < 3660; days++) {
      const key = dateKeyInZone(cursor, availability.timeZone), interval = intervalForDate(key, availability, profileId);
      if (interval) {
        const start = new Date(interval.startAt).getTime(), usableEnd = Math.min(cursor.getTime(), new Date(interval.endAt).getTime());
        if (usableEnd - start >= minutes * 60000) { const segmentStart = usableEnd - minutes * 60000; return { startAt: new Date(segmentStart).toISOString(), endAt: new Date(usableEnd).toISOString(), segments: [{ startAt: new Date(segmentStart).toISOString(), endAt: new Date(usableEnd).toISOString(), durationMinutes: minutes }] }; }
      }
      const previous = addDaysKey(key, -1); cursor = new Date(new Date(zonedLocalToIso(`${previous}T23:59:59`, availability.timeZone)).getTime() + 999);
    }
    throw new Error("中断不可工程に必要な連続作業時間を確保できません。");
  }
  function addContinuousMinutes(startIso, minutes, availability, profileId) {
    let cursor = new Date(startIso);
    for (let days = 0; days < 3660; days++) {
      const key = dateKeyInZone(cursor, availability.timeZone), interval = intervalForDate(key, availability, profileId);
      if (interval) {
        const usableStart = Math.max(cursor.getTime(), new Date(interval.startAt).getTime()), end = new Date(interval.endAt).getTime();
        if (end - usableStart >= minutes * 60000) { const segmentEnd = usableStart + minutes * 60000; return { startAt: new Date(usableStart).toISOString(), endAt: new Date(segmentEnd).toISOString(), segments: [{ startAt: new Date(usableStart).toISOString(), endAt: new Date(segmentEnd).toISOString(), durationMinutes: minutes }] }; }
      }
      const next = addDaysKey(key, 1); cursor = new Date(zonedLocalToIso(`${next}T00:00`, availability.timeZone));
    }
    throw new Error("中断不可工程に必要な連続作業時間を確保できません。");
  }
  function labVisitsFor(step, workSegments) {
    if ((step.workLocation || "lab") !== "lab") return [];
    return (workSegments || []).flatMap((segment) => [{ kind: "workStart", at: segment.startAt, label: `${step.name} 作業開始`, available: true }, { kind: "workEnd", at: segment.endAt, label: `${step.name} 作業終了`, available: true }]);
  }
  function scheduleOneStepBackward(data, step, deadlineIso) {
    const availability = availabilityForStep(data, step), profileId = availability.activeProfileId || availability.profiles[0].id, workMinutes = Number(step.workDurationMinutes), waitMinutes = Number(step.waitDurationMinutes), deadlineMs = new Date(deadlineIso).getTime();
    let waitStartAt = null, waitEndAt = null, waitSegments = [], workDeadline = deadlineIso;
    if (waitMinutes > 0 && step.waitDurationType === "calendar") workDeadline = new Date(deadlineMs - waitMinutes * 60000).toISOString();
    if (waitMinutes > 0 && step.waitDurationType === "working") { const wait = subtractWorkingMinutes(deadlineIso, waitMinutes, availability, profileId); waitSegments = wait.segments; workDeadline = wait.startAt; waitEndAt = wait.endAt; }
    const work = workMinutes > 0 ? (step.interruptible === false ? subtractContinuousMinutes(workDeadline, workMinutes, availability, profileId) : subtractWorkingMinutes(workDeadline, workMinutes, availability, profileId)) : { startAt: workDeadline, endAt: workDeadline, segments: [] };
    const workEndAt = workMinutes > 0 ? work.endAt : workDeadline;
    if (waitMinutes > 0) { waitStartAt = workEndAt; if (step.waitDurationType === "calendar") waitEndAt = new Date(new Date(waitStartAt).getTime() + waitMinutes * 60000).toISOString(); }
    const startAt = workMinutes > 0 ? work.startAt : (waitStartAt || deadlineIso), endAt = waitMinutes > 0 ? waitEndAt : workEndAt;
    return { stepId: step.id, stepName: step.name, startAt, endAt, deadlineAt: deadlineIso, workStartAt: workMinutes ? work.startAt : null, workEndAt: workMinutes ? work.endAt : null, waitStartAt, waitEndAt, workSegments: work.segments, waitSegments, labVisits: labVisitsFor(step, work.segments) };
  }
  function scheduleOneStepForward(data, step, earliestIso, manualStartAt) {
    const availability = availabilityForStep(data, step), profileId = availability.activeProfileId || availability.profiles[0].id, workMinutes = Number(step.status === "実施中" ? (step.remainingWorkMinutes ?? step.workDurationMinutes) : step.workDurationMinutes), waitMinutes = Number(step.waitDurationMinutes);
    let requestedStart = manualStartAt || earliestIso;
    if (manualStartAt && new Date(manualStartAt) < new Date(earliestIso)) throw new Error(`工程「${step.name}」の手動開始日時は前工程の終了より前です。`);
    if (manualStartAt && workMinutes > 0 && !isWorkingInstant(manualStartAt, availability, profileId)) throw new Error(`工程「${step.name}」は指定した開始予定日時に開始できません。作業可能時間、休日、来室不可日を確認してください。`);
    const work = workMinutes > 0 ? (step.interruptible === false ? addContinuousMinutes(requestedStart, workMinutes, availability, profileId) : addWorkingMinutes(requestedStart, workMinutes, availability, profileId)) : { startAt: requestedStart, endAt: requestedStart, segments: [] };
    if (manualStartAt && work.startAt !== manualStartAt) throw new Error(`工程「${step.name}」は指定した開始予定日時に開始できません。`);
    const workEndAt = work.endAt, waitStartAt = waitMinutes > 0 ? workEndAt : null;
    let waitEndAt = null, waitSegments = [];
    if (waitMinutes > 0 && step.waitDurationType === "calendar") waitEndAt = new Date(new Date(workEndAt).getTime() + waitMinutes * 60000).toISOString();
    if (waitMinutes > 0 && step.waitDurationType === "working") { const wait = addWorkingMinutes(workEndAt, waitMinutes, availability, profileId); waitEndAt = wait.endAt; waitSegments = wait.segments; }
    const startAt = step.status === "実施中" && progressFields(step).actualStartDateTime ? progressFields(step).actualStartDateTime : work.startAt, endAt = waitEndAt || workEndAt;
    return { stepId: step.id, stepName: step.name, startAt, scheduledWorkStartAt: work.startAt, endAt, workStartAt: workMinutes ? work.startAt : null, workEndAt: workMinutes ? workEndAt : null, waitStartAt, waitEndAt, workSegments: work.segments, waitSegments, labVisits: labVisitsFor(step, work.segments), manual: !!manualStartAt };
  }
  function collectVisitDates(schedules, timeZone) { return [...new Set(schedules.flatMap((item) => item.labVisits || []).map((visit) => dateKeyInZone(visit.at, timeZone)))].sort(); }
  function calculatePlanSchedule(data, planId, targetLocalValue, options) {
    const plan = data.plans.find((item) => item.id === planId), availability = deepClone(data.availability), errors = [], warnings = [];
    const versionBase = { id: makeId("schedule"), planId, scheduleMode: "backward", kind: "backward", calculatedAt: nowIso(), timeZone: availability.timeZone || "Asia/Tokyo", availabilitySnapshot: availability, stepSchedules: [], labVisitDates: [], warnings, errors };
    if (!plan) return { ...versionBase, feasible: false, errors: ["対象の実験計画が見つかりません。"] };
    const availabilityValidation = validateAvailability(availability); if (!availabilityValidation.valid) return { ...versionBase, feasible: false, errors: availabilityValidation.errors };
    const targetIso = /(?:Z|[+-]\d{2}:\d{2})$/.test(targetLocalValue || "") ? new Date(targetLocalValue).toISOString() : zonedLocalToIso(targetLocalValue, availability.timeZone);
    if (!targetIso) return { ...versionBase, feasible: false, errors: ["完成予定日時が正しくありません。"] };
    versionBase.targetCompletionDateTime = targetIso;
    const steps = orderedOwnerSteps(data.steps, "plan", planId);
    if (!steps.length) return { ...versionBase, feasible: false, errors: ["計算対象の工程がありません。"] };
    for (const step of steps) { const validation = validateStep(step, steps.filter((item) => item.id !== step.id), step.id); if (!validation.valid) errors.push(...Object.values(validation.errors).map((message) => `工程「${step.name}」: ${message}`)); }
    if (errors.length) return { ...versionBase, feasible: false, errors: [...new Set(errors)] };
    const schedules = new Map(), profileId = availability.activeProfileId || availability.profiles[0].id;
    const profile = availability.profiles.find((item) => item.id === profileId) || availability.profiles[0];
    if (!(profile.weekly || []).some((day) => day.enabled) && !(availability.exceptions || []).some((item) => item.type === "available" && (!item.profileId || item.profileId === profileId))) {
      return { ...versionBase, feasible: false, errors: ["作業可能な曜日または日付別例外が1件もありません。"] };
    }
    try {
      [...steps].reverse().forEach((step, reverseIndex) => {
        const next = steps[steps.length - reverseIndex]; const deadline = next ? schedules.get(next.id).startAt : targetIso;
        schedules.set(step.id, scheduleOneStepBackward(data, step, deadline));
      });
    } catch (error) { return { ...versionBase, feasible: false, errors: [error.message] }; }
    versionBase.stepSchedules = steps.map((step) => schedules.get(step.id)); versionBase.labVisitDates = collectVisitDates(versionBase.stepSchedules, availability.timeZone);
    const earliest = versionBase.stepSchedules.map((item) => item.startAt).sort()[0], referenceNow = options?.nowIso || nowIso();
    if (new Date(earliest) < new Date(referenceNow)) errors.push(`必要開始日時 ${formatZoned(earliest, availability.timeZone)} が現在より前のため、現時点からは完成予定日時に間に合いません。`);
    return { ...versionBase, feasible: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)], requiredStartAt: earliest };
  }

  function calculateForwardSchedule(data, planId, startValue, options) {
    const plan = data.plans.find((item) => item.id === planId), availability = deepClone(data.availability), errors = [], warnings = [], timeZone = availability.timeZone || "Asia/Tokyo";
    const versionBase = { id: makeId("schedule"), planId, scheduleMode: "forward", kind: "forward", calculatedAt: nowIso(), timeZone, availabilitySnapshot: availability, experimentStartDateTime: null, targetCompletionDateTime: null, forecastCompletionAt: null, stepSchedules: [], labVisitDates: [], warnings, errors };
    if (!plan) return { ...versionBase, feasible: false, errors: ["対象の実験計画が見つかりません。"] };
    const validation = validateAvailability(availability); if (!validation.valid) return { ...versionBase, feasible: false, errors: validation.errors };
    const startAt = /(?:Z|[+-]\d{2}:\d{2})$/.test(startValue || "") ? new Date(startValue).toISOString() : zonedLocalToIso(startValue, timeZone); if (!startAt) return { ...versionBase, feasible: false, errors: ["実験開始予定日時が正しくありません。"] };
    const targetValue = options?.targetCompletionDateTime || "", targetAt = targetValue ? (/(?:Z|[+-]\d{2}:\d{2})$/.test(targetValue) ? new Date(targetValue).toISOString() : zonedLocalToIso(targetValue, timeZone)) : null; if (targetValue && !targetAt) return { ...versionBase, feasible: false, errors: ["完成希望日時が正しくありません。"] };
    versionBase.experimentStartDateTime = startAt; versionBase.requiredStartAt = startAt; versionBase.targetCompletionDateTime = targetAt;
    const steps = orderedOwnerSteps(data.steps, "plan", planId); if (!steps.length) return { ...versionBase, feasible: false, errors: ["計算対象の工程がありません。"] };
    let cursor = startAt; try { versionBase.stepSchedules = steps.map((step) => { const schedule = scheduleOneStepForward(data, step, cursor, step.manualStartAt || null); cursor = schedule.endAt; return schedule; }); } catch (error) { return { ...versionBase, feasible: false, errors: [error.message] }; }
    const forecastCompletionAt = versionBase.stepSchedules.at(-1).endAt, late = !!targetAt && new Date(forecastCompletionAt) > new Date(targetAt), delayMinutes = late ? Math.ceil((new Date(forecastCompletionAt) - new Date(targetAt)) / 60000) : 0;
    if (late) warnings.push("現在の進捗では完成希望日時に間に合わない可能性があります"); versionBase.labVisitDates = collectVisitDates(versionBase.stepSchedules, timeZone);
    return { ...versionBase, feasible: true, resolution: "feasible", forecastCompletionAt, late, delayMinutes, deadlineStatus: targetAt ? (late ? "late" : "onTime") : null };
  }

  function recalculatePlanProgress(data, planId, changedStepId, options) {
    const plan = data.plans.find((item) => item.id === planId), steps = orderedOwnerSteps(data.steps, "plan", planId), changedIndex = steps.findIndex((item) => item.id === changedStepId), scheduleMode = planScheduleMode(plan), hasDeadline = !!plan?.targetCompletionDateTime && !Number.isNaN(new Date(plan.targetCompletionDateTime).getTime()), errors = [], warnings = [];
    const base = { id: makeId("schedule"), planId, scheduleMode, kind: "rolling", calculatedAt: nowIso(), timeZone: data.availability.timeZone, availabilitySnapshot: deepClone(data.availability), experimentStartDateTime: plan?.experimentStartDateTime || null, targetCompletionDateTime: hasDeadline ? plan.targetCompletionDateTime : null, previousScheduleVersionId: plan?.activeScheduleVersionId || null, changedStepId, affectedStepIds: [], stepSchedules: [], labVisitDates: [], warnings, errors };
    if (!plan || changedIndex < 0) return { ...base, feasible: false, errors: ["対象の実験計画または工程が見つかりません。"] }; if (scheduleMode === "backward" && !hasDeadline) return { ...base, feasible: false, errors: ["完成希望日時が正しくありません。"] };
    const previous = data.scheduleVersions.find((item) => item.id === plan.activeScheduleVersionId), previousById = new Map((previous?.stepSchedules || []).map((item) => [item.stepId, item])), affected = steps.slice(changedIndex + 1).filter((step) => !progressFields(step).completed), affectedIds = new Set(affected.map((step) => step.id)); base.affectedStepIds = [...affectedIds];
    const fixed = steps.slice(0, changedIndex + 1), changed = steps[changedIndex], changedProgress = progressFields(changed); let cursor = changedProgress.actualEndDateTime || changedProgress.plannedEndDateTime || options?.nowIso || nowIso();
    const schedules = [];
    for (const step of fixed) { const progress = progressFields(step), old = previousById.get(step.id); const startAt = progress.plannedStartDateTime || old?.startAt || progress.actualStartDateTime, endAt = progress.plannedEndDateTime || old?.endAt || progress.actualEndDateTime; if (startAt && endAt) schedules.push({ ...(old || {}), stepId: step.id, stepName: step.name, startAt, endAt, actualStartAt: progress.actualStartDateTime, actualEndAt: progress.actualEndDateTime, completed: progress.completed, fixed: true, recalculated: false }); }
    try {
      for (const step of steps.slice(changedIndex + 1)) {
        const progress = progressFields(step), old = previousById.get(step.id);
        if (progress.completed) { const startAt = progress.plannedStartDateTime || old?.startAt || progress.actualStartDateTime, endAt = progress.plannedEndDateTime || old?.endAt || progress.actualEndDateTime; schedules.push({ ...(old || {}), stepId: step.id, stepName: step.name, startAt, endAt, actualStartAt: progress.actualStartDateTime, actualEndAt: progress.actualEndDateTime, completed: true, fixed: true, recalculated: false }); cursor = endAt; continue; }
        const placement = scheduleOneStepForward(data, step, cursor, step.manualStartAt || null); schedules.push({ ...placement, actualStartAt: progress.actualStartDateTime, actualEndAt: progress.actualEndDateTime, completed: false, previousStartAt: old?.startAt || progress.plannedStartDateTime || null, previousEndAt: old?.endAt || progress.plannedEndDateTime || null, recalculated: true }); cursor = placement.endAt;
      }
    } catch (error) { return { ...base, feasible: false, errors: [error.message] }; }
    const forecastCompletionAt = schedules.at(-1)?.endAt || cursor, delayMinutes = hasDeadline ? Math.max(0, Math.ceil((new Date(forecastCompletionAt) - new Date(plan.targetCompletionDateTime)) / 60000)) : 0, late = delayMinutes > 0;
    if (late) warnings.push("現在の進捗では完成希望日時に間に合わない可能性があります"); if (late && options?.rejectLate) return { ...base, feasible: false, late, forecastCompletionAt, delayMinutes, errors: ["指定した開始予定日時では完成希望日時に間に合いません。"] };
    return { ...base, feasible: true, resolution: "feasible", stepSchedules: schedules, labVisitDates: collectVisitDates(schedules, data.availability.timeZone), requiredStartAt: schedules[0]?.startAt || null, forecastCompletionAt, delayMinutes, late, deadlineStatus: hasDeadline ? (late ? "late" : "onTime") : null, affectedStepNames: affected.map((step) => step.name) };
  }

  function hydrateData(candidate) {
    const empty = createEmptyData();
    const sourceAvailability = candidate.availability || {}, defaults = defaultAvailability();
    const availability = Array.isArray(sourceAvailability.profiles)
      ? { ...defaults, ...sourceAvailability, profiles: sourceAvailability.profiles, holidays: sourceAvailability.holidays || [], exceptions: sourceAvailability.exceptions || [] }
      : { ...defaults, profiles: [{ ...defaults.profiles[0], weekly: sourceAvailability.weekly?.length ? sourceAvailability.weekly : defaultWeekly() }], exceptions: sourceAvailability.exceptions || [], holidays: sourceAvailability.holidays || [] };
    return { ...empty, ...candidate, experimentIdeas: Array.isArray(candidate.experimentIdeas) ? candidate.experimentIdeas : [], templates: Array.isArray(candidate.templates) ? candidate.templates : [], plans: Array.isArray(candidate.plans) ? candidate.plans : [], steps: Array.isArray(candidate.steps) ? candidate.steps : [], attendancePreferences: Array.isArray(candidate.attendancePreferences) ? candidate.attendancePreferences : [], scheduleVersions: Array.isArray(candidate.scheduleVersions) ? candidate.scheduleVersions : [], availability, updatedAt: candidate.updatedAt || empty.updatedAt };
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
      migrated.templates = (candidate.templates || []).map((item) => ({ ...item, description: item.description || "" })); migrated.updatedAt = nowIso();
      migrated.plans = (candidate.plans || []).map((plan) => ({ ...plan, scheduleMode: planScheduleMode(plan), experimentStartDateTime: plan.experimentStartDateTime || null, forecastCompletionDateTime: plan.forecastCompletionDateTime || null, targetCompletionDateTime: plan.targetCompletionDateTime || (plan.targetCompletionDate ? zonedLocalToIso(`${plan.targetCompletionDate}T18:00`, migrated.availability.timeZone) : ""), activeScheduleVersionId: plan.activeScheduleVersionId || null }));
      migrated.steps = (candidate.steps || []).map((step) => { const progress = progressFields(step); return ({ ...step, workLocation: step.workLocation || "lab", interruptible: step.interruptible !== false, manualStartAt: step.manualStartAt || null, plannedStartAt: progress.plannedStartDateTime, plannedEndAt: progress.plannedEndDateTime, plannedStartDateTime: progress.plannedStartDateTime, plannedEndDateTime: progress.plannedEndDateTime, actualStartedAt: progress.actualStartDateTime, actualEndedAt: progress.actualEndDateTime, actualStartDateTime: progress.actualStartDateTime, actualEndDateTime: progress.actualEndDateTime, completed: progress.completed, actualSegments: step.actualSegments || [], remainingWorkMinutes: step.remainingWorkMinutes ?? step.workDurationMinutes, progressUpdatedAt: step.progressUpdatedAt || null }); });
      migrated.attendancePreferences = candidate.attendancePreferences || [];
      const validation = validateData(migrated);
      return validation.valid ? { valid: true, data: migrated, migrated: true, fromVersion: candidate.schemaVersion, errors: [] } : { valid: false, errors: validation.errors };
    }
    return { valid: false, errors: [`対応していないスキーマバージョンです（対応: 1〜${SCHEMA_VERSION}）。`] };
  }
  function validateData(candidate) {
    const errors = [];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return { valid: false, errors: ["JSONのルートはオブジェクトである必要があります。"] };
    if (candidate.schemaVersion !== SCHEMA_VERSION) errors.push(`スキーマバージョン${SCHEMA_VERSION}ではありません。`);
    const arrayKeys = ["experimentIdeas", "templates", "plans", "steps", "attendancePreferences", "scheduleVersions"];
    arrayKeys.forEach((key) => { if (!Array.isArray(candidate[key])) errors.push(`${key} は配列である必要があります。`); });
    const legacyArrayKeys = ["equipment", "workers", "optimizationRuns", "optimizationResults"]; legacyArrayKeys.forEach((key) => { if (candidate[key] !== undefined && !Array.isArray(candidate[key])) errors.push(`${key} は配列である必要があります。`); });
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
    for (const key of [...arrayKeys, ...legacyArrayKeys]) if (Array.isArray(candidate[key])) candidate[key].forEach((item, index) => { if (!item || typeof item !== "object" || Array.isArray(item)) errors.push(`${key} ${index + 1}: オブジェクトである必要があります。`); else if (!item.id || typeof item.id !== "string") errors.push(`${key} ${index + 1}: IDがありません。`); else if (allIds.has(item.id)) errors.push(`${key} ${index + 1}: IDが重複しています。`); else allIds.add(item.id); });
    if (Array.isArray(candidate.templates)) candidate.templates.forEach((template, index) => { const result = validateTemplate(template || {}); Object.values(result.errors).forEach((message) => errors.push(`テンプレート ${index + 1}: ${message}`)); });
    const ideaIds = new Set(Array.isArray(candidate.experimentIdeas) ? candidate.experimentIdeas.map((item) => item?.id).filter(Boolean) : []), templateIds = new Set(Array.isArray(candidate.templates) ? candidate.templates.map((item) => item?.id).filter(Boolean) : []), planIds = new Set(Array.isArray(candidate.plans) ? candidate.plans.map((item) => item?.id).filter(Boolean) : []), scheduleIds = new Set(Array.isArray(candidate.scheduleVersions) ? candidate.scheduleVersions.map((item) => item?.id).filter(Boolean) : []);
    if (Array.isArray(candidate.plans)) candidate.plans.forEach((plan, index) => {
      if (!normalizeText(plan?.name)) errors.push(`実験計画 ${index + 1}: 計画名がありません。`); if (plan?.experimentIdeaId && !ideaIds.has(plan.experimentIdeaId)) errors.push(`実験計画 ${index + 1}: 参照する実験ストックが見つかりません。`); if (plan?.scheduleMode !== undefined && !["backward", "forward"].includes(plan.scheduleMode)) errors.push(`実験計画 ${index + 1}: スケジュール方式が正しくありません。`); if (!optionalIso(plan?.experimentStartDateTime)) errors.push(`実験計画 ${index + 1}: 実験開始予定日時が正しくありません。`); if (!optionalIso(plan?.forecastCompletionDateTime)) errors.push(`実験計画 ${index + 1}: 予想完成日時が正しくありません。`); if (!optionalIso(plan?.targetCompletionDateTime)) errors.push(`実験計画 ${index + 1}: 完成予定日時が正しくありません。`); if (plan?.activeScheduleVersionId && !scheduleIds.has(plan.activeScheduleVersionId)) errors.push(`実験計画 ${index + 1}: 有効なスケジュール結果が見つかりません。`);
      if (plan?.templateApplications !== undefined) {
        if (!Array.isArray(plan.templateApplications)) errors.push(`実験計画 ${index + 1}: テンプレート適用履歴は配列である必要があります。`);
        else { const applicationIds = new Set(); plan.templateApplications.forEach((application) => { if (!application || typeof application !== "object" || !normalizeText(application.id) || !normalizeText(application.templateId) || !normalizeText(application.templateName) || !validIso(application.appliedAt) || !Array.isArray(application.stepIds)) errors.push(`実験計画 ${index + 1}: テンプレート適用履歴が正しくありません。`); else if (applicationIds.has(application.id)) errors.push(`実験計画 ${index + 1}: テンプレート適用履歴IDが重複しています。`); else applicationIds.add(application.id); }); }
      }
    });
    if (Array.isArray(candidate.attendancePreferences)) candidate.attendancePreferences.forEach((item, index) => { if (!parseDateKey(item?.date) || !["normal", "preferOff", "cannotVisit"].includes(item?.type)) errors.push(`来室設定 ${index + 1}: 日付または種類が正しくありません。`); });
    if (Array.isArray(candidate.steps)) {
      const ownerGroups = new Map();
      candidate.steps.forEach((step, index) => {
        if (!step || !["template", "plan"].includes(step.ownerType) || !step.ownerId) { errors.push(`工程 ${index + 1}: 所属情報が正しくありません。`); return; }
        if (step.ownerType === "template" && !templateIds.has(step.ownerId) || step.ownerType === "plan" && !planIds.has(step.ownerId)) errors.push(`工程 ${index + 1}: 所属先が見つかりません。`);
        if (step.displayOrder !== undefined && step.displayOrder !== null && (!Number.isInteger(step.displayOrder) || step.displayOrder < 0)) errors.push(`工程 ${index + 1}: 表示順は0以上の整数である必要があります。`);
        for (const [label, value] of [["手動開始日時", step.manualStartAt], ["開始", step.actualStartedAt], ["終了", step.actualEndedAt], ["開始", step.actualStartDateTime], ["終了", step.actualEndDateTime], ["進捗更新日時", step.progressUpdatedAt], ["開始予定", step.plannedStartAt], ["終了予定", step.plannedEndAt], ["開始予定", step.plannedStartDateTime], ["終了予定", step.plannedEndDateTime]]) if (!optionalIso(value)) errors.push(`工程 ${index + 1}: ${label}が正しくありません。`);
        const progress = progressFields(step); if (step.completed !== undefined && typeof step.completed !== "boolean") errors.push(`工程 ${index + 1}: 完了状態が正しくありません。`);
        if (progress.actualStartDateTime && progress.actualEndDateTime && new Date(progress.actualEndDateTime) < new Date(progress.actualStartDateTime)) errors.push(`工程 ${index + 1}: 終了日時が開始日時より前です。`);
        const key = `${step.ownerType}:${step.ownerId}`; if (!ownerGroups.has(key)) ownerGroups.set(key, []); ownerGroups.get(key).push(step);
      });
      ownerGroups.forEach((steps) => {
        const displayOrders = new Set(); steps.forEach((step) => { if (Number.isInteger(step.displayOrder)) { if (displayOrders.has(step.displayOrder)) errors.push(`工程「${step.name || step.id}」: 表示順が重複しています。`); displayOrders.add(step.displayOrder); } });
        steps.forEach((step) => { const result = validateStep(step, steps.filter((item) => item.id !== step.id), step.id); Object.values(result.errors).forEach((message) => errors.push(`工程「${step.name || step.id}」: ${message}`)); });
      });
    }
    if (Array.isArray(candidate.scheduleVersions)) candidate.scheduleVersions.forEach((version, index) => { if (!planIds.has(version?.planId)) errors.push(`逆算結果 ${index + 1}: 実験計画が見つかりません。`); if (!validIso(version?.calculatedAt)) errors.push(`逆算結果 ${index + 1}: 計算日時が正しくありません。`); if (!optionalIso(version?.targetCompletionDateTime)) errors.push(`逆算結果 ${index + 1}: 完成予定日時が正しくありません。`); if (!Array.isArray(version?.stepSchedules) || !Array.isArray(version?.labVisitDates) || !Array.isArray(version?.warnings) || !Array.isArray(version?.errors)) errors.push(`逆算結果 ${index + 1}: 結果配列の形式が正しくありません。`); });
    return { valid: errors.length === 0, errors };
  }
  function serializeData(data) { return JSON.stringify({ ...data, schemaVersion: SCHEMA_VERSION, updatedAt: nowIso() }, null, 2); }
  function parseBackup(text) {
    let candidate; try { candidate = JSON.parse(text); } catch (_error) { return { valid: false, errors: ["JSONを読み取れません。ファイル形式を確認してください。"] }; }
    const migration = migrateData(candidate); if (!migration.valid) return migration;
    const validation = validateData(migration.data);
    return validation.valid ? { valid: true, data: migration.data, migrated: migration.migrated, errors: [] } : { valid: false, errors: validation.errors };
  }

  return { SCHEMA_VERSION, STORAGE_KEY, MIGRATION_BACKUP_KEY, SIMPLIFICATION_BACKUP_KEY, migrationBackupKey, PRIORITIES, STATUSES, WAIT_TYPES, createEmptyData, defaultWeekly, defaultAvailability, makeId, planScheduleMode, progressFields, assignProgressFields, splitWaitDurationMinutes, combineWaitDurationParts, validateIdea, sanitizeIdea, validateTemplate, sanitizeTemplate, validateStep, sanitizeStep, orderedOwnerSteps, moveOwnerStepDisplayOrder, movePlanStepDisplayOrder, hasTemplateBeenApplied, appendTemplateToPlan, createPlanFromTemplate, validateAvailability, intervalForDate, isWorkingInstant, subtractWorkingMinutes, addWorkingMinutes, zonedLocalToIso, isoToZonedInput, formatZoned, dateKeyInZone, addDaysKey, calculatePlanSchedule, calculateForwardSchedule, recalculatePlanProgress, migrateData, validateData, hydrateData, serializeData, parseBackup };
});
