(function () {
  "use strict";
  const C = window.ExperimentCore;
  const O = window.ExperimentOptimizer;
  let migratedOnLoad = false, pendingConfirm = null, calendarCursor = null, optimizationWorker = null, optimizationCancelled = false, availabilityEditingProfileId = null;
  let data = loadData();
  const $ = (id) => document.getElementById(id);
  const elements = {
    ideaList: $("ideaList"), emptyState: $("emptyState"), ideaDialog: $("ideaDialog"), ideaForm: $("ideaForm"),
    confirmDialog: $("confirmDialog"), search: $("searchInput"), filter: $("statusFilter"), sort: $("sortSelect"),
    toast: $("toast"), saveStatus: $("saveStatus"), formAlert: $("formAlert"), templateList: $("templateList"),
    templateDialog: $("templateDialog"), templateForm: $("templateForm"), stepDialog: $("stepDialog"), stepForm: $("stepForm"),
    planList: $("planList"), applyDialog: $("applyDialog"), applyForm: $("applyForm"), appendTemplateDialog: $("appendTemplateDialog"), appendTemplateForm: $("appendTemplateForm")
  };

  function loadData() {
    const raw = localStorage.getItem(C.STORAGE_KEY);
    if (!raw) return C.createEmptyData();
    try {
      const migration = C.migrateData(JSON.parse(raw));
      if (!migration.valid) throw new Error(migration.errors.join("\n"));
      const validation = C.validateData(migration.data);
      if (!validation.valid) throw new Error(validation.errors.join("\n"));
      if (migration.migrated) {
        migratedOnLoad = true;
        const originalVersion = JSON.parse(raw).schemaVersion, backupKey = C.migrationBackupKey(originalVersion);
        if (!localStorage.getItem(backupKey)) localStorage.setItem(backupKey, raw);
        localStorage.setItem(C.STORAGE_KEY, JSON.stringify(migration.data));
      }
      return migration.data;
    } catch (error) { console.warn("保存データを読み込めませんでした。元データは上書きしていません。", error); return C.createEmptyData(); }
  }
  function saveData(message) {
    data.schemaVersion = C.SCHEMA_VERSION; data.updatedAt = new Date().toISOString();
    localStorage.setItem(C.STORAGE_KEY, JSON.stringify(data)); elements.saveStatus.textContent = "保存済み"; render();
    if (message) showToast(message);
  }
  const escapeHtml = (value) => String(value || "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  function formatDate(date) { if (!date) return "未設定"; const [y, m, d] = date.split("-").map(Number); return new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "short", day: "numeric" }).format(new Date(y, m - 1, d)); }
  function duration(minutes) { const value = Number(minutes) || 0; if (value < 60) return `${value}分`; const hours = Math.floor(value / 60), rest = value % 60; return rest ? `${hours}時間${rest}分` : `${hours}時間`; }
  function progressDate(value) { return value ? C.formatZoned(value, data.availability.timeZone) : "—"; }
  function stepState(step) { const progress = C.progressFields(step), late = !progress.completed && progress.plannedEndDateTime && new Date(progress.plannedEndDateTime) < new Date(); if (progress.completed) return "完了"; if (late) return "遅延"; if (progress.actualStartDateTime || step.status === "実施中") return "実施中"; if (progress.plannedStartDateTime) return "予定中"; return "未開始"; }
  const priorityRank = (priority) => ({ "高": 0, "中": 1, "低": 2 })[priority] ?? 9;
  const ownerSteps = (ownerType, ownerId) => C.orderedOwnerSteps(data.steps, ownerType, ownerId);

  function filteredIdeas() {
    const query = elements.search.value.trim().toLocaleLowerCase("ja"), status = elements.filter.value;
    return data.experimentIdeas.filter((idea) => [idea.name, idea.purpose, idea.materials, idea.plannedEquipment, idea.notes].join(" ").toLocaleLowerCase("ja").includes(query) && (!status || idea.status === status)).sort((a, b) => {
      if (elements.sort.value === "priority") return priorityRank(a.priority) - priorityRank(b.priority) || a.name.localeCompare(b.name, "ja");
      if (elements.sort.value === "date") return (a.desiredCompletionDate || "9999").localeCompare(b.desiredCompletionDate || "9999");
      if (elements.sort.value === "name") return a.name.localeCompare(b.name, "ja");
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }

  function render() {
    renderIdeas(); renderTemplates(); renderPlans(); renderAvailability(); renderScheduleControls(); renderResources(); renderOptimizationSetup();
    $("lastUpdated").textContent = data.updatedAt ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(data.updatedAt)) : "—";
    $("ideaCount").textContent = `${data.experimentIdeas.length}件`; $("schemaVersion").textContent = `v${data.schemaVersion}`;
  }
  function renderIdeas() {
    const ideas = filteredIdeas();
    $("statAll").textContent = data.experimentIdeas.length; $("statUnplanned").textContent = data.experimentIdeas.filter((x) => x.status === "未計画").length;
    $("statActive").textContent = data.experimentIdeas.filter((x) => ["計画中", "実施中"].includes(x.status)).length; $("statDone").textContent = data.experimentIdeas.filter((x) => x.status === "完了").length;
    elements.ideaList.innerHTML = ideas.map(ideaCard).join(""); elements.emptyState.hidden = data.experimentIdeas.length > 0 || elements.search.value || elements.filter.value;
    if (!ideas.length && (elements.search.value || elements.filter.value)) elements.ideaList.innerHTML = '<div class="no-results">条件に一致する実験はありません。</div>';
  }
  function ideaCard(idea) {
    return `<article class="idea-card card" data-id="${escapeHtml(idea.id)}"><div class="card-accent priority-${escapeHtml(idea.priority)}"></div><div class="idea-card-head"><div><span class="status status-${escapeHtml(idea.status)}">${escapeHtml(idea.status)}</span><span class="priority">優先度 ${escapeHtml(idea.priority)}</span></div><div class="card-actions"><button class="icon-button edit-button" aria-label="${escapeHtml(idea.name)}を編集">✎</button><button class="icon-button delete-button" aria-label="${escapeHtml(idea.name)}を削除">⌫</button></div></div><h2>${escapeHtml(idea.name)}</h2><p class="purpose">${escapeHtml(idea.purpose) || "目的は未入力です"}</p><dl><div><dt>希望完成日</dt><dd>${escapeHtml(formatDate(idea.desiredCompletionDate))}</dd></div><div><dt>使用予定装置</dt><dd>${escapeHtml(idea.plannedEquipment) || "未設定"}</dd></div></dl>${idea.materials ? `<p class="meta"><strong>材料</strong> ${escapeHtml(idea.materials)}</p>` : ""}</article>`;
  }

  function renderTemplates() {
    elements.templateList.innerHTML = data.templates.map((template) => ownerCard("template", template)).join("");
    $("templateEmpty").hidden = data.templates.length > 0;
  }
  function renderPlans() {
    elements.planList.innerHTML = data.plans.map((plan) => ownerCard("plan", plan)).join("");
    $("planEmpty").hidden = data.plans.length > 0;
  }
  function ownerCard(type, owner) {
    const steps = ownerSteps(type, owner.id), isTemplate = type === "template";
    const idea = isTemplate ? null : data.experimentIdeas.find((item) => item.id === owner.experimentIdeaId);
    const source = isTemplate ? null : data.templates.find((item) => item.id === owner.sourceTemplateId);
    const title = isTemplate ? owner.name : owner.name;
    const subtitle = isTemplate ? (owner.description || "説明はありません") : `実験: ${idea?.name || "削除済み"} ／ 元テンプレート: ${source?.name || "削除済み"}`;
    const controls = isTemplate
      ? `<button class="secondary" data-action="apply">計画へ適用</button><button class="icon-button" data-action="edit-owner" aria-label="編集">✎</button><button class="icon-button" data-action="delete-owner" aria-label="削除">⌫</button>`
      : `<span class="independent-badge">独立コピー</span><button class="secondary" data-action="add-template">テンプレートを追加</button><button class="icon-button" data-action="delete-owner" aria-label="削除">⌫</button>`;
    const targetText = owner.targetCompletionDateTime ? C.formatZoned(owner.targetCompletionDateTime, data.availability.timeZone) : formatDate(owner.targetCompletionDate), completedCount = steps.filter((step) => C.progressFields(step).completed).length;
    const forecast = !isTemplate && owner.progressForecast?.late ? `<div class="schedule-alert warning progress-warning"><strong>現在の進捗では完成希望日時に間に合わない可能性があります</strong><span>新しい予想完成日時: ${escapeHtml(progressDate(owner.progressForecast.forecastCompletionAt))}</span><span> ／ 遅延時間: ${escapeHtml(duration(owner.progressForecast.delayMinutes))}</span><span> ／ 影響工程: ${escapeHtml((owner.progressForecast.affectedStepNames || []).join("、") || "なし")}</span></div>` : "", recalcError = !isTemplate && owner.progressRecalculationError ? `<div class="schedule-alert error"><strong>予定を自動再計算できませんでした</strong>${escapeHtml(owner.progressRecalculationError)}</div>` : "";
    return `<article class="card process-card" data-owner-type="${type}" data-owner-id="${escapeHtml(owner.id)}"><header><div><p class="eyebrow">${isTemplate ? "TEMPLATE" : "EXPERIMENT PLAN"}</p><h2>${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p>${!isTemplate && owner.scheduleNeedsRecalculation ? '<span class="result-state">スケジュールの再計算が必要です</span>' : ""}</div><div class="process-actions">${controls}</div></header><div class="process-summary"><span><strong>${steps.length}</strong> 工程</span>${!isTemplate ? `<span class="plan-progress"><strong>進捗：${completedCount} / ${steps.length}工程完了</strong></span>` : ""}<span>作業 <strong>${duration(steps.reduce((sum, step) => sum + step.workDurationMinutes, 0))}</strong></span><span>待機 <strong>${duration(steps.reduce((sum, step) => sum + step.waitDurationMinutes, 0))}</strong></span>${!isTemplate ? `<span>目標 <strong>${escapeHtml(targetText)}</strong></span>` : ""}</div>${forecast}${recalcError}${steps.length ? '<p class="display-order-note">↑↓は表示順だけを変更します。実施順序を変える場合は鉛筆ボタンで先行工程を編集してください。</p>' : ""}<div class="step-flow">${steps.length ? steps.map((step, index) => stepCard(step, steps, index)).join("") : '<div class="no-steps">工程はまだありません。</div>'}</div><button class="add-step-button" data-action="add-step">＋ 工程を追加</button></article>`;
  }
  function stepCard(step, siblings, index) {
    const predecessors = (step.predecessorIds || []).map((id) => siblings.find((item) => item.id === id)?.name).filter(Boolean);
    const lab = []; if (step.labRequirement?.start) lab.push("開始時"); if (step.labRequirement?.end) lab.push("終了時"); if (step.labRequirement?.waitCheck) lab.push(`待機確認 ${duration(step.waitCheckIntervalMinutes)}ごと`);
    const equipment = (step.equipmentRequirements || []).map((item) => `${item.equipmentName} ${item.occupancyStartOffsetMinutes || 0}〜${item.occupancyEndOffsetMinutes ?? item.occupancyMinutes}分${item.requiresContinuousMonitoring ? "・監視" : ""}`).join("、"), worker = data.workers.find((item) => item.id === step.assignedWorkerId);
    const orderControls = `<button class="icon-button order-button" data-action="move-step-up" aria-label="${escapeHtml(step.name)}を上へ移動" title="表示順を上へ" ${index === 0 ? "disabled" : ""}>↑</button><button class="icon-button order-button" data-action="move-step-down" aria-label="${escapeHtml(step.name)}を下へ移動" title="表示順を下へ" ${index === siblings.length - 1 ? "disabled" : ""}>↓</button>`, progress = C.progressFields(step), state = stepState(step);
    const timing = step.ownerType === "plan" ? `<dl class="step-timing"><div><dt>予定開始</dt><dd>${escapeHtml(progressDate(progress.plannedStartDateTime))}</dd></div><div><dt>予定終了</dt><dd>${escapeHtml(progressDate(progress.plannedEndDateTime))}</dd></div><div><dt>実績開始</dt><dd>${escapeHtml(progressDate(progress.actualStartDateTime))}</dd></div><div><dt>実績終了</dt><dd>${escapeHtml(progressDate(progress.actualEndDateTime))}</dd></div><div><dt>状態</dt><dd><span class="progress-state state-${escapeHtml(state)}">${escapeHtml(state)}</span></dd></div><div><dt>完了</dt><dd><label class="completion-check"><input type="checkbox" data-action="complete-step" ${progress.completed ? "checked" : ""}> 完了</label></dd></div></dl>` : "";
    return `<div class="step-row ${progress.completed ? "step-completed" : ""} ${state === "遅延" ? "step-delayed" : ""}" data-step-id="${escapeHtml(step.id)}"><div class="step-index">${index + 1}</div><div class="step-content"><div class="step-title"><strong>${escapeHtml(step.name)}</strong><span>作業 ${duration(step.workDurationMinutes)}</span>${step.waitDurationMinutes ? `<span class="wait-chip">待機 ${duration(step.waitDurationMinutes)}・${step.waitDurationType === "calendar" ? "暦時間" : "作業時間"}</span>` : ""}<span>${step.interruptible === false ? "中断不可" : "中断可能"}</span></div>${predecessors.length ? `<p class="dependency">↳ 先行: ${escapeHtml(predecessors.join("、"))}</p>` : '<p class="dependency">開始工程</p>'}<div class="step-meta"><span>${step.workLocation === "home" ? "自宅" : "研究室"}・${escapeHtml(worker?.name || "担当未設定")}</span>${equipment ? `<span>装置: ${escapeHtml(equipment)}</span>` : ""}${lab.length ? `<span>来室: ${escapeHtml(lab.join("、"))}</span>` : '<span>来室条件なし</span>'}</div>${timing}</div><div class="card-actions">${orderControls}${step.ownerType === "plan" ? '<button class="icon-button" data-action="progress-step" aria-label="進捗を編集">✓</button>' : ""}<button class="icon-button" data-action="edit-step" aria-label="工程を編集">✎</button><button class="icon-button" data-action="delete-step" aria-label="工程を削除">⌫</button></div></div>`;
  }

  function openIdeaForm(idea) {
    elements.ideaForm.reset(); elements.formAlert.hidden = true; $("ideaId").value = idea?.id || ""; $("dialogTitle").textContent = idea ? "実験を編集" : "実験を登録";
    if (idea) ["name", "purpose", "materials", "plannedEquipment", "priority", "desiredCompletionDate", "notes", "status"].forEach((key) => { $(key).value = idea[key] || ""; }); else { $("priority").value = "中"; $("status").value = "未計画"; }
    elements.ideaDialog.showModal(); setTimeout(() => $("name").focus(), 0);
  }
  function submitIdea(event) {
    event.preventDefault(); const input = Object.fromEntries(["name", "purpose", "materials", "plannedEquipment", "priority", "desiredCompletionDate", "notes", "status"].map((key) => [key, $(key).value])); const validation = C.validateIdea(input);
    if (!validation.valid) return showFormError(elements.formAlert, Object.values(validation.errors)[0], Object.keys(validation.errors)[0]);
    const index = data.experimentIdeas.findIndex((idea) => idea.id === $("ideaId").value), updated = C.sanitizeIdea(input, index >= 0 ? data.experimentIdeas[index] : null);
    if (index >= 0) data.experimentIdeas[index] = updated; else data.experimentIdeas.push(updated); elements.ideaDialog.close(); saveData(index >= 0 ? "実験を更新しました" : "実験を登録しました");
  }

  function openTemplateForm(template) {
    elements.templateForm.reset(); $("templateAlert").hidden = true; $("templateId").value = template?.id || ""; $("templateDialogTitle").textContent = template ? "テンプレートを編集" : "テンプレートを作成"; $("templateName").value = template?.name || ""; $("templateDescription").value = template?.description || ""; elements.templateDialog.showModal(); setTimeout(() => $("templateName").focus(), 0);
  }
  function submitTemplate(event) {
    event.preventDefault(); const input = { name: $("templateName").value, description: $("templateDescription").value }, validation = C.validateTemplate(input);
    if (!validation.valid) return showFormError($("templateAlert"), Object.values(validation.errors)[0], "templateName");
    const index = data.templates.findIndex((item) => item.id === $("templateId").value), updated = C.sanitizeTemplate(input, index >= 0 ? data.templates[index] : null);
    if (index >= 0) data.templates[index] = updated; else data.templates.push(updated); elements.templateDialog.close(); saveData(index >= 0 ? "テンプレートを更新しました" : "テンプレートを作成しました");
  }

  function addEquipmentRow(requirement) {
    const start = requirement?.occupancyStartOffsetMinutes ?? 0, end = requirement?.occupancyEndOffsetMinutes ?? requirement?.occupancyMinutes ?? "";
    $("equipmentRows").insertAdjacentHTML("beforeend", `<div class="equipment-row equipment-row-extended"><label><span>装置名</span><input class="equipment-name" maxlength="100" value="${escapeHtml(requirement?.equipmentName || "")}" placeholder="例：遠心機"></label><label><span>開始位置（分）</span><input class="equipment-start" type="number" min="0" step="1" value="${escapeHtml(start)}"></label><label><span>終了位置（分）</span><input class="equipment-end" type="number" min="1" step="1" value="${escapeHtml(end)}"></label><label class="monitor-field"><input class="equipment-monitor" type="checkbox" ${requirement?.requiresContinuousMonitoring ? "checked" : ""}> 常時監視</label><button type="button" class="icon-button remove-equipment" aria-label="装置を削除">×</button></div>`);
  }
  function openStepForm(ownerType, ownerId, step) {
    elements.stepForm.reset(); $("stepAlert").hidden = true; $("stepId").value = step?.id || ""; $("stepOwnerType").value = ownerType; $("stepOwnerId").value = ownerId; $("stepDialogTitle").textContent = step ? "工程を編集" : "工程を追加";
    $("stepName").value = step?.name || ""; $("workDurationMinutes").value = step?.workDurationMinutes ?? 30; const waitParts = C.splitWaitDurationMinutes(step?.waitDurationMinutes ?? 0); $("waitDurationDays").value = waitParts.days; $("waitDurationHours").value = waitParts.hours; $("waitDurationMinutesPart").value = waitParts.minutes; $("waitDurationType").value = step?.waitDurationType || "calendar";
    const workerOptions = data.workers.filter((worker) => worker.active !== false).map((worker) => `<option value="${escapeHtml(worker.id)}">${escapeHtml(worker.name)}</option>`).join(""); $("assignedWorkerId").innerHTML = workerOptions; $("waitCheckWorkerId").innerHTML = workerOptions;
    $("assignedWorkerId").value = step?.assignedWorkerId || data.workers[0]?.id || ""; $("workLocation").value = step?.workLocation || "lab"; $("interruptible").checked = step?.interruptible !== false;
    $("labAtStart").checked = !!step?.labRequirement?.start; $("labAtEnd").checked = !!step?.labRequirement?.end; $("labDuringWait").checked = !!step?.labRequirement?.waitCheck; $("waitCheckIntervalMinutes").value = step?.waitCheckIntervalMinutes || 60; $("waitCheckDurationMinutes").value = step?.waitCheckDurationMinutes || 5; $("waitCheckWorkerId").value = step?.waitCheckWorkerId || step?.assignedWorkerId || data.workers[0]?.id || ""; $("waitCheckRequiresLab").checked = step?.waitCheckRequiresLab !== false; $("stepNotes").value = step?.notes || "";
    const siblings = ownerSteps(ownerType, ownerId).filter((item) => item.id !== step?.id);
    $("predecessorOptions").innerHTML = siblings.length ? siblings.map((item) => `<label><input type="checkbox" value="${escapeHtml(item.id)}" ${(step?.predecessorIds || []).includes(item.id) ? "checked" : ""}> ${escapeHtml(item.name)}</label>`).join("") : '<p class="muted">先行工程はありません。</p>';
    $("equipmentRows").innerHTML = ""; (step?.equipmentRequirements || []).forEach(addEquipmentRow); updateWaitCheck(); elements.stepDialog.showModal(); setTimeout(() => $("stepName").focus(), 0);
  }
  function collectStepInput(waitDurationMinutes) {
    return {
      name: $("stepName").value, workDurationMinutes: $("workDurationMinutes").value, waitDurationMinutes, waitDurationType: $("waitDurationType").value,
      predecessorIds: [...$("predecessorOptions").querySelectorAll("input:checked")].map((input) => input.value),
      labRequirement: { start: $("labAtStart").checked, end: $("labAtEnd").checked, waitCheck: $("labDuringWait").checked }, waitCheckIntervalMinutes: $("waitCheckIntervalMinutes").value, waitCheckDurationMinutes: $("waitCheckDurationMinutes").value, waitCheckWorkerId: $("waitCheckWorkerId").value, waitCheckRequiresLab: $("waitCheckRequiresLab").checked,
      assignedWorkerId: $("assignedWorkerId").value, workLocation: $("workLocation").value, interruptible: $("interruptible").checked,
      equipmentRequirements: [...$("equipmentRows").querySelectorAll(".equipment-row")].map((row) => { const start = Number(row.querySelector(".equipment-start").value), end = Number(row.querySelector(".equipment-end").value); return { equipmentName: row.querySelector(".equipment-name").value, occupancyStartOffsetMinutes: start, occupancyEndOffsetMinutes: end, occupancyMinutes: end - start, requiresContinuousMonitoring: row.querySelector(".equipment-monitor").checked }; }), notes: $("stepNotes").value
    };
  }
  function submitStep(event) {
    event.preventDefault(); const ownerType = $("stepOwnerType").value, ownerId = $("stepOwnerId").value, stepId = $("stepId").value, siblings = ownerSteps(ownerType, ownerId);
    const waitDuration = C.combineWaitDurationParts({ days: $("waitDurationDays").value, hours: $("waitDurationHours").value, minutes: $("waitDurationMinutesPart").value });
    if (!waitDuration.valid) { const fieldId = Object.keys(waitDuration.errors)[0]; return showFormError($("stepAlert"), waitDuration.errors[fieldId], fieldId); }
    const input = collectStepInput(waitDuration.totalMinutes);
    const validation = C.validateStep(input, siblings.filter((step) => step.id !== stepId), stepId || null);
    if (!validation.valid) return showFormError($("stepAlert"), Object.values(validation.errors)[0]);
    const index = data.steps.findIndex((step) => step.id === stepId), existing = index >= 0 ? data.steps[index] : null, candidate = C.sanitizeStep(input, existing, ownerType, ownerId);
    input.equipmentRequirements.forEach((requirement, reqIndex) => {
      let equipment = data.equipment.find((item) => item.name.toLocaleLowerCase("ja") === requirement.equipmentName.trim().toLocaleLowerCase("ja"));
      if (!equipment) { equipment = { id: C.makeId("equipment"), name: requirement.equipmentName.trim(), capacity: 1, unavailablePeriods: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; data.equipment.push(equipment); }
      candidate.equipmentRequirements[reqIndex].equipmentId = equipment.id; candidate.equipmentRequirements[reqIndex].equipmentName = equipment.name;
    });
    const prospective = siblings.filter((step) => step.id !== candidate.id).concat(candidate), graph = C.validateDependencyGraph(prospective);
    if (!graph.valid) return showFormError($("stepAlert"), graph.errors[0]);
    const existingPosition = siblings.findIndex((step) => step.id === stepId);
    siblings.forEach((step, position) => { step.displayOrder = position; });
    candidate.displayOrder = existingPosition >= 0 ? existingPosition : siblings.length;
    if (index >= 0) data.steps[index] = candidate; else data.steps.push(candidate); markPlanScheduleStale(ownerType, ownerId); elements.stepDialog.close(); saveData(index >= 0 ? "工程を更新しました" : "工程を追加しました");
  }
  function updateWaitCheck() { const disabled = !$("labDuringWait").checked; ["waitCheckIntervalMinutes", "waitCheckDurationMinutes", "waitCheckWorkerId", "waitCheckRequiresLab"].forEach((id) => { $(id).disabled = disabled; }); $("waitCheckField").classList.toggle("disabled", disabled); }

  function activeProfile() { return data.availability.profiles.find((item) => item.id === (availabilityEditingProfileId || data.availability.activeProfileId)) || data.availability.profiles[0]; }
  function renderAvailability() {
    const profile = activeProfile(), dayNames = ["日", "月", "火", "水", "木", "金", "土"];
    $("availabilityTimeZone").textContent = data.availability.timeZone;
    $("availabilityProfileSelect").innerHTML = data.availability.profiles.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join(""); $("availabilityProfileSelect").value = profile.id;
    $("weeklyRows").innerHTML = dayNames.map((name, dayOfWeek) => {
      const setting = profile.weekly.find((item) => item.dayOfWeek === dayOfWeek) || { dayOfWeek, enabled: false, startTime: "09:00", endTime: "18:00" };
      return `<div class="weekly-row" data-day="${dayOfWeek}"><strong>${name}曜日</strong><label><input class="weekly-enabled" type="checkbox" ${setting.enabled ? "checked" : ""}> 作業可能</label><input class="weekly-start" type="time" value="${escapeHtml(setting.startTime)}" ${setting.enabled ? "" : "disabled"}><span>〜</span><input class="weekly-end" type="time" value="${escapeHtml(setting.endTime)}" ${setting.enabled ? "" : "disabled"}></div>`;
    }).join("");
    $("holidayList").innerHTML = data.availability.holidays.length ? data.availability.holidays.slice().sort((a, b) => a.date.localeCompare(b.date)).map((item) => `<div class="setting-item" data-holiday-id="${escapeHtml(item.id)}"><span><strong>${escapeHtml(item.date)}</strong><small>${escapeHtml(item.name || "休日")}</small></span><button class="icon-button" data-action="delete-holiday" aria-label="削除">×</button></div>`).join("") : '<p class="muted list-empty">休日は未登録です。</p>';
    $("exceptionList").innerHTML = data.availability.exceptions.length ? data.availability.exceptions.slice().sort((a, b) => a.date.localeCompare(b.date)).map((item) => `<div class="setting-item" data-exception-id="${escapeHtml(item.id)}"><span><strong>${escapeHtml(item.date)}・${item.type === "available" ? "作業可能" : "作業不可"}</strong><small>${item.type === "available" ? `${escapeHtml(item.startTime)}〜${escapeHtml(item.endTime)}` : "終日"}${item.label ? ` ／ ${escapeHtml(item.label)}` : ""}</small></span><div><button class="icon-button" data-action="edit-exception" aria-label="編集">✎</button><button class="icon-button" data-action="delete-exception" aria-label="削除">×</button></div></div>`).join("") : '<p class="muted list-empty">日付別例外は未登録です。</p>';
    $("attendanceList").innerHTML = data.attendancePreferences.length ? data.attendancePreferences.slice().sort((a, b) => a.date.localeCompare(b.date)).map((item) => `<div class="setting-item" data-attendance-id="${escapeHtml(item.id)}"><span><strong>${escapeHtml(item.date)}・${item.type === "preferOff" ? "可能なら休みたい" : item.type === "cannotVisit" ? "研究室に行けない" : "通常"}</strong><small>${escapeHtml(item.note || "")}</small></span><button class="icon-button" data-action="delete-attendance">×</button></div>`).join("") : '<p class="muted list-empty">個別の来室方針は未登録です。</p>';
  }
  function saveAvailability() {
    const profile = activeProfile();
    profile.weekly = [...$("weeklyRows").querySelectorAll(".weekly-row")].map((row) => ({ dayOfWeek: Number(row.dataset.day), enabled: row.querySelector(".weekly-enabled").checked, startTime: row.querySelector(".weekly-start").value, endTime: row.querySelector(".weekly-end").value }));
    const validation = C.validateAvailability(data.availability);
    if (!validation.valid) { alert(validation.errors.join("\n")); return; }
    profile.updatedAt = new Date().toISOString(); saveData("作業可能時間を保存しました");
  }
  function submitHoliday(event) {
    event.preventDefault(); const date = $("holidayDate").value; if (!date) return;
    const existing = data.availability.holidays.find((item) => item.date === date);
    if (existing) existing.name = $("holidayName").value.trim(); else data.availability.holidays.push({ id: C.makeId("holiday"), date, name: $("holidayName").value.trim() });
    event.target.reset(); saveData("休日を保存しました");
  }
  function toggleExceptionTimes() { const enabled = $("exceptionType").value === "available"; document.querySelectorAll(".exception-time input").forEach((input) => { input.disabled = !enabled; }); }
  function submitException(event) {
    event.preventDefault();
    const item = { id: $("exceptionId").value || C.makeId("exception"), profileId: activeProfile().id, date: $("exceptionDate").value, type: $("exceptionType").value, startTime: $("exceptionStart").value, endTime: $("exceptionEnd").value, label: $("exceptionLabel").value.trim() };
    const candidate = { ...data.availability, exceptions: data.availability.exceptions.filter((entry) => entry.id !== item.id).concat(item) }, validation = C.validateAvailability(candidate);
    if (!validation.valid) { alert(validation.errors.join("\n")); return; }
    const index = data.availability.exceptions.findIndex((entry) => entry.id === item.id); if (index >= 0) data.availability.exceptions[index] = item; else data.availability.exceptions.push(item);
    event.target.reset(); $("exceptionId").value = ""; $("exceptionStart").value = "09:00"; $("exceptionEnd").value = "18:00"; toggleExceptionTimes(); saveData("日付別例外を保存しました");
  }
  function handleAvailabilityAction(event) {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "delete-holiday") { const id = event.target.closest("[data-holiday-id]").dataset.holidayId; data.availability.holidays = data.availability.holidays.filter((item) => item.id !== id); saveData("休日を削除しました"); }
    const row = event.target.closest("[data-exception-id]"); if (!row) return; const item = data.availability.exceptions.find((entry) => entry.id === row.dataset.exceptionId);
    if (action === "delete-exception") { data.availability.exceptions = data.availability.exceptions.filter((entry) => entry.id !== item.id); saveData("日付別例外を削除しました"); }
    if (action === "edit-exception") { $("exceptionId").value = item.id; $("exceptionDate").value = item.date; $("exceptionType").value = item.type; $("exceptionStart").value = item.startTime || "09:00"; $("exceptionEnd").value = item.endTime || "18:00"; $("exceptionLabel").value = item.label || ""; toggleExceptionTimes(); }
  }
  function submitAttendance(event) {
    event.preventDefault(); const date = $("attendanceDate").value; if (!date) return; const existing = data.attendancePreferences.find((item) => item.date === date), value = { id: existing?.id || C.makeId("attendance"), date, type: $("attendanceType").value, note: $("attendanceNote").value.trim() };
    if (existing) Object.assign(existing, value); else data.attendancePreferences.push(value); event.target.reset(); saveData("来室日の優先設定を保存しました");
  }
  function handleAttendanceAction(event) { if (event.target.closest("[data-action]")?.dataset.action !== "delete-attendance") return; const id = event.target.closest("[data-attendance-id]").dataset.attendanceId; data.attendancePreferences = data.attendancePreferences.filter((item) => item.id !== id); saveData("来室日の優先設定を削除しました"); }

  function activeSchedule(plan) { return data.scheduleVersions.find((item) => item.id === plan?.activeScheduleVersionId) || null; }
  function renderScheduleControls() {
    const select = $("schedulePlanSelect"), previous = select.value;
    select.innerHTML = data.plans.length ? data.plans.map((plan) => `<option value="${escapeHtml(plan.id)}">${escapeHtml(plan.name)}</option>`).join("") : '<option value="">実験計画がありません</option>';
    if (data.plans.some((plan) => plan.id === previous)) select.value = previous;
    const plan = data.plans.find((item) => item.id === select.value) || data.plans[0];
    if (plan) { select.value = plan.id; $("targetCompletionDateTime").value = C.isoToZonedInput(plan.targetCompletionDateTime, data.availability.timeZone); const version = activeSchedule(plan); if (version) renderSchedule(version); else clearSchedule(); }
    else { $("targetCompletionDateTime").value = ""; clearSchedule(); }
  }
  function selectSchedulePlan() {
    const plan = data.plans.find((item) => item.id === $("schedulePlanSelect").value); $("targetCompletionDateTime").value = C.isoToZonedInput(plan?.targetCompletionDateTime, data.availability.timeZone); calendarCursor = null; const version = activeSchedule(plan); if (version) renderSchedule(version); else clearSchedule();
  }
  function clearSchedule() { $("scheduleMessages").innerHTML = ""; $("scheduleResults").hidden = true; }
  function calculateSchedule() {
    const plan = data.plans.find((item) => item.id === $("schedulePlanSelect").value); if (!plan) { showToast("実験計画を作成してください"); return; }
    const target = $("targetCompletionDateTime").value, result = C.calculatePlanSchedule(data, plan.id, target);
    data.scheduleVersions.push(result); plan.activeScheduleVersionId = result.id; plan.targetCompletionDateTime = result.targetCompletionDateTime || ""; plan.scheduleNeedsRecalculation = false; plan.progressForecast = null; plan.progressRecalculationError = null; plan.updatedAt = new Date().toISOString();
    if (result.stepSchedules.length) result.stepSchedules.forEach((schedule) => { const step = data.steps.find((item) => item.id === schedule.stepId); if (step) C.assignProgressFields(step, { plannedStartDateTime: schedule.startAt, plannedEndDateTime: schedule.endAt }); });
    calendarCursor = result.targetCompletionDateTime ? C.dateKeyInZone(result.targetCompletionDateTime, result.timeZone).slice(0, 7) : null; saveData(result.feasible ? "逆算結果を保存しました" : "実行できない理由を保存しました"); switchView("schedule");
  }
  function renderSchedule(version) {
    const messages = [];
    if (version.errors?.length) messages.push(`<div class="schedule-alert error"><strong>実行できない条件があります</strong><ul>${version.errors.map((message) => `<li>${escapeHtml(message)}</li>`).join("")}</ul></div>`);
    const generalWarnings = (version.warnings || []).filter((message) => message !== "現在の進捗では完成希望日時に間に合わない可能性があります"); if (generalWarnings.length) messages.push(`<div class="schedule-alert warning"><strong>${version.kind === "rolling" ? "進捗反映後に確認が必要です" : "確認が必要です（日時は自動変更していません）"}</strong><ul>${generalWarnings.map((message) => `<li>${escapeHtml(message)}</li>`).join("")}</ul></div>`);
    if (version.late) messages.push(`<div class="schedule-alert warning rolling-delay-warning"><strong>現在の進捗では完成希望日時に間に合わない可能性があります</strong><p>新しい予想完成日時: ${escapeHtml(progressDate(version.forecastCompletionAt))} ／ 遅延時間: ${escapeHtml(duration(version.delayMinutes))}</p><p>影響を受ける工程: ${escapeHtml((version.affectedStepNames || []).join("、") || "なし")}</p></div>`);
    $("scheduleMessages").innerHTML = messages.join("");
    if (!version.stepSchedules?.length) { $("scheduleResults").hidden = true; return; }
    $("scheduleResults").hidden = false;
    $("scheduleSummary").innerHTML = `<article class="card"><span>判定</span><strong class="${version.late || !version.feasible ? "danger-text" : "success-text"}">${version.late ? "遅延見込み" : (version.feasible ? "計算可能" : "期限に間に合いません")}</strong></article><article class="card"><span>必要開始日時</span><strong>${escapeHtml(progressDate(version.requiredStartAt))}</strong></article><article class="card"><span>${version.kind === "rolling" ? "予想完成日時" : "完成予定日時"}</span><strong>${escapeHtml(progressDate(version.forecastCompletionAt || version.targetCompletionDateTime))}</strong></article><article class="card"><span>来室日</span><strong>${version.labVisitDates.length}日</strong><small>${version.kind === "rolling" ? "進捗反映後" : "最適化前の計算値"}</small></article>`;
    $("scheduleTableBody").innerHTML = version.stepSchedules.map((item) => { const step = data.steps.find((entry) => entry.id === item.stepId), progress = C.progressFields(step), state = step ? stepState(step) : (item.completed ? "完了" : "予定中"); return `<tr class="${item.completed ? "schedule-completed" : ""} ${item.recalculated ? "schedule-recalculated" : ""}"><td><strong>${escapeHtml(item.stepName)}</strong>${item.recalculated ? '<small>再計算</small>' : ""}</td><td>${escapeHtml(progressDate(item.startAt))}${item.recalculated && item.previousStartAt && item.previousStartAt !== item.startAt ? `<small>変更前 ${escapeHtml(progressDate(item.previousStartAt))}</small>` : ""}</td><td>${escapeHtml(progressDate(item.endAt))}${item.recalculated && item.previousEndAt && item.previousEndAt !== item.endAt ? `<small>変更前 ${escapeHtml(progressDate(item.previousEndAt))}</small>` : ""}</td><td>${escapeHtml(progressDate(item.actualStartAt || progress.actualStartDateTime))}<br>${escapeHtml(progressDate(item.actualEndAt || progress.actualEndDateTime))}</td><td><span class="progress-state state-${escapeHtml(state)}">${escapeHtml(state)}</span></td></tr>`; }).join("");
    if (!calendarCursor) calendarCursor = C.dateKeyInZone(version.targetCompletionDateTime, version.timeZone).slice(0, 7); renderCalendar(version); renderGantt(version);
  }
  function renderCalendar(version) {
    const [year, month] = calendarCursor.split("-").map(Number), first = new Date(Date.UTC(year, month - 1, 1)), startOffset = first.getUTCDay(), daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate(), previousDays = new Date(Date.UTC(year, month - 1, 0)).getUTCDate();
    $("calendarMonthLabel").textContent = `${year}年${month}月`;
    const eventMap = new Map();
    version.stepSchedules.forEach((schedule) => { let key = C.dateKeyInZone(schedule.startAt, version.timeZone), end = C.dateKeyInZone(schedule.endAt, version.timeZone), guard = 0; while (key <= end && guard++ < 370) { if (!eventMap.has(key)) eventMap.set(key, []); eventMap.get(key).push({ type: schedule.completed ? "completed" : (schedule.recalculated ? "recalculated" : "step"), label: `${schedule.completed ? "完了予定" : "予定"}: ${schedule.stepName}` }); key = C.addDaysKey(key, 1); } if (schedule.recalculated && schedule.previousStartAt && schedule.previousEndAt && (schedule.previousStartAt !== schedule.startAt || schedule.previousEndAt !== schedule.endAt)) { let oldKey = C.dateKeyInZone(schedule.previousStartAt, version.timeZone), oldEnd = C.dateKeyInZone(schedule.previousEndAt, version.timeZone), oldGuard = 0; while (oldKey <= oldEnd && oldGuard++ < 370) { if (!eventMap.has(oldKey)) eventMap.set(oldKey, []); eventMap.get(oldKey).push({ type: "previous", label: `変更前: ${schedule.stepName}` }); oldKey = C.addDaysKey(oldKey, 1); } } if (schedule.actualStartAt) { const actualKey = C.dateKeyInZone(schedule.actualStartAt, version.timeZone); if (!eventMap.has(actualKey)) eventMap.set(actualKey, []); eventMap.get(actualKey).push({ type: schedule.completed ? "completed" : "actual", label: `実績: ${schedule.stepName}` }); } (schedule.labVisits || []).forEach((visit) => { const visitKey = C.dateKeyInZone(visit.at, version.timeZone); if (!eventMap.has(visitKey)) eventMap.set(visitKey, []); eventMap.get(visitKey).push({ type: visit.available ? "visit" : "visit-warning", label: `来室: ${visit.label}` }); }); });
    const cells = [];
    for (let index = 0; index < 42; index++) {
      const dayNumber = index - startOffset + 1; let cellYear = year, cellMonth = month, day = dayNumber, outside = false;
      if (dayNumber < 1) { outside = true; cellMonth--; if (cellMonth < 1) { cellMonth = 12; cellYear--; } day = previousDays + dayNumber; }
      else if (dayNumber > daysInMonth) { outside = true; day = dayNumber - daysInMonth; cellMonth++; if (cellMonth > 12) { cellMonth = 1; cellYear++; } }
      const key = `${cellYear}-${String(cellMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`, events = eventMap.get(key) || [], working = !!C.intervalForDate(key, version.availabilitySnapshot, version.availabilitySnapshot.activeProfileId);
      cells.push(`<div class="calendar-day ${outside ? "outside" : ""} ${working ? "" : "nonworking"} ${version.labVisitDates.includes(key) ? "lab-day" : ""}"><span class="day-number">${day}</span><div>${events.slice(0, 4).map((event) => `<span class="calendar-event ${event.type}">${escapeHtml(event.label)}</span>`).join("")}${events.length > 4 ? `<small>ほか${events.length - 4}件</small>` : ""}</div></div>`);
    }
    $("scheduleCalendar").innerHTML = cells.join("");
  }
  function shiftCalendar(amount) { const [year, month] = calendarCursor.split("-").map(Number), date = new Date(Date.UTC(year, month - 1 + amount, 1)); calendarCursor = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`; const plan = data.plans.find((item) => item.id === $("schedulePlanSelect").value); const version = activeSchedule(plan); if (version) renderCalendar(version); }
  function renderGantt(version) {
    const dates = version.stepSchedules.flatMap((item) => [item.startAt, item.endAt, item.previousStartAt, item.previousEndAt, item.actualStartAt, item.actualEndAt]).filter(Boolean).map((item) => new Date(item).getTime()), start = Math.min(...dates), end = Math.max(new Date(version.targetCompletionDateTime).getTime(), ...dates), span = Math.max(1, end - start), position = (value) => ((new Date(value).getTime() - start) / span) * 100, bar = (from, to, className, title) => from && to ? `<span class="gantt-bar ${className}" style="left:${position(from)}%;width:${Math.max(.5, position(to) - position(from))}%" title="${title}"></span>` : "";
    $("ganttChart").innerHTML = `<div class="gantt-axis"><span>${escapeHtml(C.formatZoned(new Date(start).toISOString(), version.timeZone))}</span><span>${escapeHtml(C.formatZoned(new Date(end).toISOString(), version.timeZone))}</span></div>${version.stepSchedules.map((item) => `<div class="gantt-row ${item.completed ? "schedule-completed" : ""}"><strong title="${escapeHtml(item.stepName)}">${escapeHtml(item.stepName)}</strong><div class="gantt-track">${item.recalculated && item.previousStartAt !== item.startAt ? bar(item.previousStartAt, item.previousEndAt, "previous", "再計算前の予定") : ""}${(item.workSegments || []).map((segment) => bar(segment.startAt, segment.endAt, item.recalculated ? "work recalculated" : "work", "予定作業")).join("")}${!item.workSegments?.length ? bar(item.startAt, item.endAt, item.recalculated ? "work recalculated" : "work", "予定") : ""}${item.waitStartAt ? bar(item.waitStartAt, item.waitEndAt, "wait", "待機") : ""}${bar(item.actualStartAt, item.actualEndAt || new Date().toISOString(), item.completed ? "completed" : "actual", item.completed ? "完了実績" : "実績")}</div></div>`).join("")}`;
  }

  function renderResources() {
    $("workerList").innerHTML = data.workers.map((worker) => `<div class="resource-card" data-worker-id="${escapeHtml(worker.id)}"><div><strong>${escapeHtml(worker.name)}</strong><small>${worker.active === false ? "無効" : "有効"} ／ 利用不可 ${worker.unavailablePeriods?.length || 0}件</small></div><div class="resource-period-form"><input class="worker-unavailable-start" type="datetime-local"><input class="worker-unavailable-end" type="datetime-local"><button class="secondary" data-action="add-worker-period">利用不可を追加</button><button class="icon-button" data-action="edit-worker">✎</button></div>${(worker.unavailablePeriods || []).map((period, index) => `<span class="period-chip">${escapeHtml(C.formatZoned(period.startAt, data.availability.timeZone))}〜${escapeHtml(C.formatZoned(period.endAt, data.availability.timeZone))}<button data-action="delete-worker-period" data-index="${index}">×</button></span>`).join("")}</div>`).join("");
    $("resourceEquipmentList").innerHTML = data.equipment.length ? data.equipment.map((equipment) => `<div class="resource-card" data-equipment-id="${escapeHtml(equipment.id)}"><div><strong>${escapeHtml(equipment.name)}</strong><label class="capacity-field">同時利用数 <input class="equipment-capacity" type="number" min="1" max="20" value="${equipment.capacity || 1}"></label></div><div class="resource-period-form"><input class="equipment-unavailable-start" type="datetime-local"><input class="equipment-unavailable-end" type="datetime-local"><button class="secondary" data-action="save-equipment">保存</button><button class="secondary" data-action="add-equipment-period">利用不可を追加</button></div>${(equipment.unavailablePeriods || []).map((period, index) => `<span class="period-chip">${escapeHtml(C.formatZoned(period.startAt, data.availability.timeZone))}〜${escapeHtml(C.formatZoned(period.endAt, data.availability.timeZone))}<button data-action="delete-equipment-period" data-index="${index}">×</button></span>`).join("")}</div>`).join("") : '<p class="muted">工程で装置を登録すると、ここに表示されます。</p>';
  }
  function submitWorker(event) {
    event.preventDefault(); const name = $("workerName").value.trim(); if (!name) return; const id = $("workerId").value, existing = data.workers.find((item) => item.id === id);
    if (existing) existing.name = name; else data.workers.push({ id: C.makeId("worker"), name, labAvailabilityProfileId: "profile_lab", homeAvailabilityProfileId: "profile_home", unavailablePeriods: [], active: true }); event.target.reset(); $("workerId").value = ""; saveData(existing ? "作業者を更新しました" : "作業者を追加しました");
  }
  function handleResourceAction(event) {
    const action = event.target.closest("[data-action]")?.dataset.action; if (!action) return;
    const workerCard = event.target.closest("[data-worker-id]");
    if (workerCard) {
      const worker = data.workers.find((item) => item.id === workerCard.dataset.workerId);
      if (action === "edit-worker") { $("workerId").value = worker.id; $("workerName").value = worker.name; $("workerName").focus(); return; }
      if (action === "add-worker-period") { event.preventDefault(); const startAt = C.zonedLocalToIso(workerCard.querySelector(".worker-unavailable-start").value, data.availability.timeZone), endAt = C.zonedLocalToIso(workerCard.querySelector(".worker-unavailable-end").value, data.availability.timeZone); if (!startAt || !endAt || new Date(endAt) <= new Date(startAt)) return alert("作業者の利用不可期間を正しく入力してください。"); worker.unavailablePeriods.push({ startAt, endAt }); saveData("作業者の利用不可期間を追加しました"); }
      if (action === "delete-worker-period") { worker.unavailablePeriods.splice(Number(event.target.dataset.index), 1); saveData("利用不可期間を削除しました"); }
      return;
    }
    const equipmentCard = event.target.closest("[data-equipment-id]"); if (!equipmentCard) return; const equipment = data.equipment.find((item) => item.id === equipmentCard.dataset.equipmentId);
    if (action === "save-equipment") { equipment.capacity = Math.max(1, Number(equipmentCard.querySelector(".equipment-capacity").value)); saveData("装置設定を保存しました"); }
    if (action === "add-equipment-period") { const startAt = C.zonedLocalToIso(equipmentCard.querySelector(".equipment-unavailable-start").value, data.availability.timeZone), endAt = C.zonedLocalToIso(equipmentCard.querySelector(".equipment-unavailable-end").value, data.availability.timeZone); if (!startAt || !endAt || new Date(endAt) <= new Date(startAt)) return alert("装置の利用不可期間を正しく入力してください。"); equipment.unavailablePeriods.push({ startAt, endAt }); saveData("装置の利用不可期間を追加しました"); }
    if (action === "delete-equipment-period") { equipment.unavailablePeriods.splice(Number(event.target.dataset.index), 1); saveData("装置の利用不可期間を削除しました"); }
  }

  function renderOptimizationSetup() {
    const previous = new Map([...$("optimizationPlanOptions").querySelectorAll("[data-plan-option]")].map((row) => [row.dataset.planOption, { checked: row.querySelector('input[type="checkbox"]').checked, target: row.querySelector('input[type="datetime-local"]').value }]));
    $("optimizationPlanOptions").innerHTML = data.plans.length ? data.plans.map((plan) => { const state = previous.get(plan.id), target = state?.target || C.isoToZonedInput(plan.targetCompletionDateTime, data.availability.timeZone); return `<label class="optimization-plan-row" data-plan-option="${escapeHtml(plan.id)}"><input type="checkbox" ${state ? (state.checked ? "checked" : "") : "checked"}><span><strong>${escapeHtml(plan.name)}</strong><small>優先度 ${escapeHtml(data.experimentIdeas.find((idea) => idea.id === plan.experimentIdeaId)?.priority || "中")}</small></span><input type="datetime-local" value="${escapeHtml(target)}"></label>`; }).join("") : '<p class="muted">実験計画がありません。</p>';
    const latestRun = data.optimizationRuns.at(-1); if (latestRun) renderOptimizationRun(latestRun);
  }
  function runOptimization(sourceData) {
    const rows = [...$("optimizationPlanOptions").querySelectorAll("[data-plan-option]")].filter((row) => row.querySelector('input[type="checkbox"]').checked); if (rows.length < 2) return showToast("2件以上の実験計画を選択してください");
    const targetData = sourceData || data, planIds = rows.map((row) => row.dataset.planOption);
    rows.forEach((row) => { const plan = targetData.plans.find((item) => item.id === row.dataset.planOption), value = row.querySelector('input[type="datetime-local"]').value, target = C.zonedLocalToIso(value, targetData.availability.timeZone); if (plan && target) plan.targetCompletionDateTime = target; });
    optimizationCancelled = false; $("runOptimizationButton").disabled = true; $("cancelOptimizationButton").disabled = false; $("optimizationStatus").innerHTML = '<div class="schedule-alert warning">制約を検証し、2つの近似プランを計算しています…</div>';
    const options = { granularityMinutes: Number($("optimizationGranularity").value), maxMilliseconds: Number($("optimizationTimeLimit").value), nowIso: new Date().toISOString() };
    const accept = (output) => { if (optimizationCancelled) return finishOptimizationUi("計算をキャンセルしました。"); data.optimizationRuns.push(output.run); data.optimizationResults.push(...output.results); if (!sourceData) rows.forEach((row) => { const sourcePlan = data.plans.find((item) => item.id === row.dataset.planOption); sourcePlan.targetCompletionDateTime = targetData.plans.find((item) => item.id === sourcePlan.id).targetCompletionDateTime; }); saveData("最適化結果を保存しました"); renderOptimizationRun(output.run); finishOptimizationUi(); };
    if (window.Worker && location.protocol !== "file:") {
      optimizationWorker = new Worker("optimizer-worker.js"); optimizationWorker.onmessage = (event) => { optimizationWorker.terminate(); optimizationWorker = null; if (event.data.ok) accept(event.data.output); else finishOptimizationUi(`計算エラー: ${event.data.error}`, true); }; optimizationWorker.onerror = () => { optimizationWorker?.terminate(); optimizationWorker = null; setTimeout(() => { try { accept(O.optimize(targetData, planIds, options)); } catch (error) { finishOptimizationUi(`計算エラー: ${error.message}`, true); } }, 0); }; optimizationWorker.postMessage({ data: targetData, planIds, options });
    } else setTimeout(() => { if (optimizationCancelled) return finishOptimizationUi("計算をキャンセルしました。"); try { accept(O.optimize(targetData, planIds, options)); } catch (error) { finishOptimizationUi(`計算エラー: ${error.message}`, true); } }, 30);
  }
  function finishOptimizationUi(message, error) { $("runOptimizationButton").disabled = false; $("cancelOptimizationButton").disabled = true; if (message) $("optimizationStatus").innerHTML = `<div class="schedule-alert ${error ? "error" : "warning"}">${escapeHtml(message)}</div>`; }
  function renderOptimizationRun(run) {
    const results = [run.fastestResultId, run.attendanceReducedResultId].map((id) => data.optimizationResults.find((item) => item.id === id)).filter(Boolean);
    $("optimizationStatus").innerHTML = `<div class="optimization-run-meta">計算 ${escapeHtml(C.formatZoned(run.completedAt, data.availability.timeZone))} ／ ${run.elapsedMilliseconds}ms ／ ${escapeHtml(run.algorithmVersion)} ／ 制限時間内の近似探索</div>`;
    $("optimizationComparison").innerHTML = results.map((result) => optimizationResultCard(result)).join("");
  }
  function optimizationCalendar(result, timeZone) {
    const schedules = result.stepSchedules || []; if (!schedules.length) return "";
    const firstKey = C.dateKeyInZone(schedules.map((item) => item.startAt).sort()[0], timeZone), lastKey = C.dateKeyInZone(result.metrics.makespan, timeZone), months = [];
    let cursor = `${firstKey.slice(0, 7)}-01`, guard = 0;
    while (cursor.slice(0, 7) <= lastKey.slice(0, 7) && guard++ < 6) { months.push(cursor.slice(0, 7)); const [year, month] = cursor.split("-").map(Number), next = new Date(Date.UTC(year, month, 1)); cursor = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-01`; }
    const snapshot = result.inputSnapshot || {}, attendance = snapshot.attendancePreferences || [], availability = snapshot.availability || data.availability, visitSet = new Set(result.labVisitDates || []), starts = new Map();
    schedules.forEach((item) => { const key = C.dateKeyInZone(item.scheduledWorkStartAt || item.startAt, timeZone); if (!starts.has(key)) starts.set(key, []); starts.get(key).push(item.stepName); });
    const calendars = months.map((monthKey) => {
      const [year, month] = monthKey.split("-").map(Number), offset = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(), days = new Date(Date.UTC(year, month, 0)).getUTCDate(), previousDays = new Date(Date.UTC(year, month - 1, 0)).getUTCDate(), cells = [];
      for (let index = 0; index < 42; index++) {
        let cellYear = year, cellMonth = month, day = index - offset + 1, outside = false;
        if (day < 1) { outside = true; day = previousDays + day; cellMonth--; if (cellMonth < 1) { cellMonth = 12; cellYear--; } }
        else if (day > days) { outside = true; day -= days; cellMonth++; if (cellMonth > 12) { cellMonth = 1; cellYear++; } }
        const key = `${cellYear}-${String(cellMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`, preference = attendance.find((item) => item.date === key)?.type || "normal", working = !!C.intervalForDate(key, availability, availability.activeProfileId), classes = [outside ? "outside" : "", visitSet.has(key) ? "lab-day" : "no-lab-day", preference === "preferOff" ? "prefer-off" : "", preference === "cannotVisit" ? "cannot-visit" : "", working ? "" : "nonworking"].filter(Boolean).join(" ");
        cells.push(`<div class="optimization-calendar-day ${classes}"><span>${day}</span>${visitSet.has(key) ? '<b title="来室必要">来室</b>' : ""}${(starts.get(key) || []).slice(0, 2).map((name) => `<small>${escapeHtml(name)}</small>`).join("")}</div>`);
      }
      return `<section class="optimization-month"><h4>${year}年${month}月</h4><div class="optimization-weekdays">${["日", "月", "火", "水", "木", "金", "土"].map((day) => `<span>${day}</span>`).join("")}</div><div class="optimization-calendar-grid">${cells.join("")}</div></section>`;
    }).join("");
    return `<div class="optimization-visual"><h3>来室カレンダー</h3><div class="optimization-legend"><span class="lab-key">来室必要</span><span class="no-lab-key">来室不要</span><span class="prefer-key">可能なら休みたい</span><span class="cannot-key">来室不可</span></div><div class="optimization-months">${calendars}</div>${guard >= 6 && cursor.slice(0, 7) <= lastKey.slice(0, 7) ? '<p class="field-note">表示は先頭6か月です。保存結果には全期間が含まれます。</p>' : ""}</div>`;
  }
  function optimizationGantt(result, timeZone) {
    const schedules = result.stepSchedules || []; if (!schedules.length) return ""; const start = Math.min(...schedules.map((item) => new Date(item.startAt).getTime())), end = Math.max(...schedules.map((item) => new Date(item.endAt).getTime())), span = Math.max(1, end - start), position = (value) => ((new Date(value).getTime() - start) / span) * 100;
    return `<div class="optimization-visual"><h3>工程ガント</h3><div class="gantt-axis"><span>${escapeHtml(C.formatZoned(new Date(start).toISOString(), timeZone))}</span><span>${escapeHtml(C.formatZoned(new Date(end).toISOString(), timeZone))}</span></div>${schedules.map((item) => `<div class="gantt-row"><strong title="${escapeHtml(item.stepName)}">${escapeHtml(item.stepName)}</strong><div class="gantt-track">${(item.workSegments || []).map((segment) => `<span class="gantt-bar work" style="left:${position(segment.startAt)}%;width:${Math.max(.5, position(segment.endAt) - position(segment.startAt))}%" title="作業"></span>`).join("")}${item.waitStartAt && new Date(item.endAt) > new Date(item.waitStartAt) ? `<span class="gantt-bar wait" style="left:${position(item.waitStartAt)}%;width:${Math.max(.5, position(item.endAt) - position(item.waitStartAt))}%" title="待機"></span>` : ""}${(item.equipmentReservations || []).map((reservation) => `<span class="gantt-bar equipment" style="left:${position(reservation.startAt)}%;width:${Math.max(.5, position(reservation.endAt) - position(reservation.startAt))}%" title="装置占有"></span>`).join("")}</div></div>`).join("")}</div>`;
  }
  function optimizationResultCard(result) {
    const title = result.type === "fastest" ? "最短完成プラン" : "来室日数削減プラン";
    if (!result.feasible) return `<article class="card optimization-result infeasible" data-result-id="${escapeHtml(result.id)}"><h2>${title}</h2><span class="result-state">${result.resolution === "provenInfeasible" ? "数学的・論理的に実行不可能" : "探索制限内で解を発見できません"}</span><ul>${(result.errors || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul><h3>代替案</h3><ul>${(result.alternatives || ["完成予定日時または資源設定を見直してください。"]).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></article>`;
    const timeZone = result.inputSnapshot?.timeZone || data.availability.timeZone, objective = result.type === "fastest" ? "目的関数: 全実験の最終完了日時（メイクスパン）を最小化し、同値なら完了日時合計を最小化" : "目的関数: 来室日数を最小化し、同値なら『可能なら休みたい日』への来室日数を最小化";
    return `<article class="card optimization-result" data-result-id="${escapeHtml(result.id)}"><header><div><p class="eyebrow">APPROXIMATE</p><h2>${title}</h2><p class="objective-note">${objective}</p></div><button class="primary" data-action="confirm-optimization">この計画を確定</button></header><div class="result-metrics"><span>実際の最終完了 <strong>${escapeHtml(C.formatZoned(result.metrics.makespan, timeZone))}</strong></span><span>来室 <strong>${result.metrics.labVisitDays}日</strong></span><span>休みたい日の来室 <strong>${result.metrics.preferOffVisitDays}日</strong></span></div><div class="plan-completions">${result.planResults.map((item) => `<span>${escapeHtml(item.planName)}: ${escapeHtml(C.formatZoned(item.completionAt, timeZone))}（期限 ${escapeHtml(C.formatZoned(item.targetCompletionDateTime, timeZone))}・期限内）</span>`).join("")}</div>${optimizationCalendar(result, timeZone)}${optimizationGantt(result, timeZone)}<div class="table-scroll"><table class="schedule-table"><thead><tr><th>工程</th><th>開始</th><th>作業終了</th><th>待機終了</th><th>手動開始</th></tr></thead><tbody>${result.stepSchedules.map((item) => `<tr data-opt-step-id="${escapeHtml(item.stepId)}"><td>${escapeHtml(item.stepName)}</td><td>${escapeHtml(C.formatZoned(item.startAt, timeZone))}</td><td>${escapeHtml(C.formatZoned(item.workEndAt, timeZone))}</td><td>${escapeHtml(C.formatZoned(item.endAt, timeZone))}</td><td><input class="manual-start" type="datetime-local" value="${escapeHtml(C.isoToZonedInput(data.steps.find((step) => step.id === item.stepId)?.manualStartAt, timeZone))}"></td></tr>`).join("")}</tbody></table></div><button class="secondary" data-action="recalculate-manual">手動開始を検証して再計算</button><p class="field-note">確定するまで既存の確定済み計画は変更されません。表示日時と手動入力は ${escapeHtml(timeZone)} です。</p></article>`;
  }
  function handleOptimizationAction(event) {
    const action = event.target.closest("[data-action]")?.dataset.action, card = event.target.closest("[data-result-id]"); if (!action || !card) return; const result = data.optimizationResults.find((item) => item.id === card.dataset.resultId);
    if (action === "confirm-optimization") askConfirm("最適化計画を確定しますか？", "選択した結果を現在の確定計画として設定します。過去の結果は保持されます。", () => { data.confirmedOptimizationResultId = result.id; result.stepSchedules.forEach((schedule) => { const step = data.steps.find((item) => item.id === schedule.stepId); if (step) C.assignProgressFields(step, { plannedStartDateTime: schedule.startAt, plannedEndDateTime: schedule.endAt }); }); result.planResults.forEach((item) => { const plan = data.plans.find((entry) => entry.id === item.planId); if (plan) { plan.confirmedOptimizationResultId = result.id; plan.scheduleNeedsRecalculation = false; } }); saveData("最適化計画を確定しました"); }, "確定する");
    if (action === "recalculate-manual") { const copy = JSON.parse(JSON.stringify(data)); card.querySelectorAll("[data-opt-step-id]").forEach((row) => { const step = copy.steps.find((item) => item.id === row.dataset.optStepId), value = row.querySelector(".manual-start").value; if (step) step.manualStartAt = value ? C.zonedLocalToIso(value, copy.availability.timeZone) : null; }); runOptimization(copy); }
  }

  function openApplyDialog(templateId) {
    const template = data.templates.find((item) => item.id === templateId), steps = ownerSteps("template", templateId); $("applyAlert").hidden = true;
    if (!steps.length) { showToast("計画へ適用する前に工程を追加してください"); return; }
    $("applyTemplateId").value = templateId; $("applyTemplateName").textContent = `「${template.name}」の工程を複製して、選択した実験ごとに独立した計画を作成します。`;
    $("applyIdeaOptions").innerHTML = data.experimentIdeas.length ? data.experimentIdeas.map((idea) => `<label><input type="checkbox" value="${escapeHtml(idea.id)}"><span><strong>${escapeHtml(idea.name)}</strong><small>${escapeHtml(idea.status)} ／ 希望完成日 ${escapeHtml(formatDate(idea.desiredCompletionDate))}</small></span></label>`).join("") : '<p class="muted">実験ストックを先に登録してください。</p>';
    elements.applyDialog.showModal();
  }
  function submitApply(event) {
    event.preventDefault(); const ideaIds = [...$("applyIdeaOptions").querySelectorAll("input:checked")].map((input) => input.value);
    if (!ideaIds.length) return showFormError($("applyAlert"), "実験を1件以上選択してください。");
    try {
      ideaIds.forEach((ideaId) => { const created = C.createPlanFromTemplate(data, $("applyTemplateId").value, ideaId); data.plans.push(created.plan); data.steps.push(...created.steps); const idea = data.experimentIdeas.find((item) => item.id === ideaId); if (idea.status === "未計画") { idea.status = "計画中"; idea.updatedAt = new Date().toISOString(); } });
      elements.applyDialog.close(); saveData(`${ideaIds.length}件の実験計画を作成しました`); switchView("plans");
    } catch (error) { showFormError($("applyAlert"), error.message); }
  }

  function updateAppendTemplateSummary() {
    const plan = data.plans.find((item) => item.id === $("appendPlanId").value), template = data.templates.find((item) => item.id === $("appendTemplateId").value), stepCount = template ? ownerSteps("template", template.id).length : 0;
    $("appendTemplatePlanName").textContent = plan?.name || "—"; $("appendTemplateName").textContent = template?.name || "—"; $("appendTemplateStepCount").textContent = `${stepCount}工程`;
    $("appendTemplateSubmit").disabled = !plan || !template || stepCount === 0;
  }
  function openAppendTemplateDialog(planId) {
    if (!data.templates.length) { showToast("工程テンプレートを先に作成してください"); return; }
    $("appendTemplateAlert").hidden = true;
    $("appendPlanId").innerHTML = data.plans.map((plan) => `<option value="${escapeHtml(plan.id)}">${escapeHtml(plan.name)}</option>`).join("");
    $("appendTemplateId").innerHTML = data.templates.map((template) => `<option value="${escapeHtml(template.id)}">${escapeHtml(template.name)}</option>`).join("");
    $("appendPlanId").value = planId; updateAppendTemplateSummary(); elements.appendTemplateDialog.showModal();
  }
  function appendTemplateToPlan(templateId, planId) {
    try {
      const created = C.appendTemplateToPlan(data, templateId, planId), plan = data.plans.find((item) => item.id === planId);
      data.steps.push(...created.steps); plan.templateApplications = [...(plan.templateApplications || []), created.application]; plan.scheduleNeedsRecalculation = true; plan.updatedAt = new Date().toISOString();
      if (elements.appendTemplateDialog.open) elements.appendTemplateDialog.close(); saveData(`${created.steps.length}工程を実験計画へ追加しました`); switchView("plans");
    } catch (error) { if (!elements.appendTemplateDialog.open) elements.appendTemplateDialog.showModal(); showFormError($("appendTemplateAlert"), error.message); }
  }
  function submitAppendTemplate(event) {
    event.preventDefault(); const templateId = $("appendTemplateId").value, planId = $("appendPlanId").value;
    if (!templateId || !planId) return showFormError($("appendTemplateAlert"), "テンプレートと実験計画を選択してください。");
    if (C.hasTemplateBeenApplied(data, planId, templateId)) {
      elements.appendTemplateDialog.close();
      askConfirm("テンプレートをもう一度追加しますか？", "このテンプレートは既に適用されています。もう一度追加しますか？", () => appendTemplateToPlan(templateId, planId), "もう一度追加");
      return;
    }
    appendTemplateToPlan(templateId, planId);
  }

  function deleteIdea(id) {
    const idea = data.experimentIdeas.find((item) => item.id === id); if (!idea) return; const related = data.plans.filter((plan) => plan.experimentIdeaId === id);
    askConfirm("実験を削除しますか？", `「${idea.name}」を削除します。${related.length ? `関連する計画 ${related.length}件は実験との参照が失われます。` : "関連する計画はありません。"}`, () => { data.experimentIdeas = data.experimentIdeas.filter((item) => item.id !== id); saveData("実験を削除しました"); });
  }
  function deleteOwner(type, id) {
    if (type === "template") {
      const owner = data.templates.find((item) => item.id === id), planCount = data.plans.filter((plan) => C.hasTemplateBeenApplied(data, plan.id, id)).length;
      askConfirm("テンプレートを削除しますか？", `「${owner.name}」とテンプレート工程を削除します。作成済み計画 ${planCount}件の独立した工程は保持されます。`, () => { data.templates = data.templates.filter((item) => item.id !== id); data.steps = data.steps.filter((step) => !(step.ownerType === "template" && step.ownerId === id)); saveData("テンプレートを削除しました"); });
    } else {
      const owner = data.plans.find((item) => item.id === id);
      askConfirm("実験計画を削除しますか？", `「${owner.name}」と個別計画の工程を削除します。元テンプレートは変更されません。`, () => { data.plans = data.plans.filter((item) => item.id !== id); data.steps = data.steps.filter((step) => !(step.ownerType === "plan" && step.ownerId === id)); saveData("実験計画を削除しました"); });
    }
  }
  function deleteStep(type, ownerId, stepId) {
    const step = data.steps.find((item) => item.id === stepId), dependents = ownerSteps(type, ownerId).filter((item) => item.predecessorIds.includes(stepId));
    askConfirm("工程を削除しますか？", `「${step.name}」を削除します。${dependents.length ? `後続工程 ${dependents.length}件から、この先行関係も削除されます。` : "後続工程への影響はありません。"}`, () => { data.steps = data.steps.filter((item) => item.id !== stepId); ownerSteps(type, ownerId).forEach((item, position) => { item.predecessorIds = item.predecessorIds.filter((id) => id !== stepId); item.displayOrder = position; }); markPlanScheduleStale(type, ownerId); saveData("工程を削除しました"); });
  }

  function markPlanScheduleStale(ownerType, ownerId) {
    if (ownerType !== "plan") return;
    const plan = data.plans.find((item) => item.id === ownerId);
    if (plan && (plan.activeScheduleVersionId || plan.confirmedOptimizationResultId)) plan.scheduleNeedsRecalculation = true;
  }
  function moveStep(ownerType, ownerId, stepId, offset) {
    const graph = C.validateDependencyGraph(ownerSteps(ownerType, ownerId));
    if (!graph.valid) return showToast(`表示順を変更できません: ${graph.errors[0]}`);
    const result = C.moveOwnerStepDisplayOrder(data.steps, ownerType, ownerId, stepId, offset);
    if (!result.moved) return showToast(result.error);
    saveData("表示順を保存しました。実施順序と確定済みスケジュールは変更していません");
  }

  function handleOwnerAction(event) {
    const action = event.target.closest("[data-action]")?.dataset.action, card = event.target.closest("[data-owner-id]"); if (!action || !card) return;
    const type = card.dataset.ownerType, ownerId = card.dataset.ownerId, stepRow = event.target.closest("[data-step-id]"), step = stepRow ? data.steps.find((item) => item.id === stepRow.dataset.stepId) : null;
    if (action === "edit-owner") openTemplateForm(data.templates.find((item) => item.id === ownerId));
    if (action === "delete-owner") deleteOwner(type, ownerId);
    if (action === "add-step") openStepForm(type, ownerId);
    if (action === "edit-step") openStepForm(type, ownerId, step);
    if (action === "delete-step") deleteStep(type, ownerId, step.id);
    if (action === "progress-step") openProgress(step);
    if (action === "complete-step") toggleStepCompletion(step, event.target.checked);
    if (action === "move-step-up") moveStep(type, ownerId, step.id, -1);
    if (action === "move-step-down") moveStep(type, ownerId, step.id, 1);
    if (action === "apply") openApplyDialog(ownerId);
    if (action === "add-template") openAppendTemplateDialog(ownerId);
  }
  function downstreamSteps(step) { const siblings = ownerSteps(step.ownerType, step.ownerId), found = new Set(), queue = [step.id]; while (queue.length) { const id = queue.shift(); siblings.filter((item) => (item.predecessorIds || []).includes(id) && !found.has(item.id)).forEach((item) => { found.add(item.id); queue.push(item.id); }); } return siblings.filter((item) => found.has(item.id)); }
  function openProgress(step) {
    const progress = C.progressFields(step); $("progressFormAlert").hidden = true; $("progressStepId").value = step.id; $("progressStatus").value = progress.completed ? "完了" : (step.status || "未着手"); $("progressCompleted").checked = progress.completed;
    $("plannedStartDateTime").value = C.isoToZonedInput(progress.plannedStartDateTime, data.availability.timeZone); $("plannedStartDateTime").disabled = progress.completed;
    $("remainingWorkMinutes").value = step.remainingWorkMinutes ?? step.workDurationMinutes; $("actualStartedAt").value = C.isoToZonedInput(progress.actualStartDateTime, data.availability.timeZone); $("actualEndedAt").value = C.isoToZonedInput(progress.actualEndDateTime, data.availability.timeZone); $("actualWorkMinutes").value = step.actualWorkMinutes ?? "";
    const affected = downstreamSteps(step), impact = $("progressImpact"); impact.hidden = !affected.length; impact.innerHTML = affected.length ? `<strong>再計算の影響範囲</strong>${affected.length}工程（${affected.map((item) => escapeHtml(item.name)).join("、")}）だけを再配置します。無関係な工程と過去の計算結果は保持します。` : ""; $("progressDialog").showModal();
  }
  function applyProgressUpdate(stepId, update, options) {
    const draft = JSON.parse(JSON.stringify(data)), draftStep = draft.steps.find((item) => item.id === stepId), liveStep = data.steps.find((item) => item.id === stepId); if (!draftStep || !liveStep) return { ok: false, error: "工程が見つかりません。" };
    draftStep.status = update.status; draftStep.remainingWorkMinutes = update.completed ? 0 : update.remainingWorkMinutes; draftStep.actualWorkMinutes = update.actualWorkMinutes; draftStep.progressUpdatedAt = update.recordedAt; draftStep.manualStartAt = update.completed ? draftStep.manualStartAt : update.manualStartAt;
    C.assignProgressFields(draftStep, { completed: update.completed, actualStartDateTime: update.actualStartDateTime, actualEndDateTime: update.actualEndDateTime });
    const result = O.recalculatePlanProgress(draft, draftStep.ownerId, draftStep.id, { nowIso: update.referenceAt, rejectLate: !!options?.rejectLate });
    const progressKeys = ["status", "remainingWorkMinutes", "actualWorkMinutes", "progressUpdatedAt", "manualStartAt", "completed", "actualStartDateTime", "actualEndDateTime", "actualStartedAt", "actualEndedAt"];
    if (!result.feasible && !options?.allowProgressOnly) return { ok: false, error: result.errors?.[0] || "予定を再計算できません。" };
    progressKeys.forEach((key) => { liveStep[key] = draftStep[key]; });
    const plan = data.plans.find((item) => item.id === liveStep.ownerId);
    if (!result.feasible) { if (plan) { plan.scheduleNeedsRecalculation = true; plan.progressRecalculationError = result.errors?.[0] || "予定を再計算できません。"; } return { ok: true, recalculated: false, result }; }
    const affected = new Set(result.affectedStepIds || []); result.stepSchedules.forEach((schedule) => { if (!affected.has(schedule.stepId)) return; const step = data.steps.find((item) => item.id === schedule.stepId); if (step && !C.progressFields(step).completed) C.assignProgressFields(step, { plannedStartDateTime: schedule.startAt, plannedEndDateTime: schedule.endAt }); });
    data.scheduleVersions.push(result); if (plan) { plan.activeScheduleVersionId = result.id; plan.scheduleNeedsRecalculation = false; plan.progressRecalculationError = null; plan.progressForecast = { late: result.late, forecastCompletionAt: result.forecastCompletionAt, delayMinutes: result.delayMinutes, affectedStepIds: result.affectedStepIds, affectedStepNames: result.affectedStepNames, calculatedAt: result.calculatedAt }; plan.lastProgressImpact = { changedStepId: liveStep.id, affectedStepIds: result.affectedStepIds, recordedAt: update.recordedAt }; plan.updatedAt = update.recordedAt; }
    return { ok: true, recalculated: true, result };
  }
  function toggleStepCompletion(step, completed) {
    const progress = C.progressFields(step), now = new Date().toISOString(), actualEnd = completed ? now : null, plannedStart = progress.plannedStartDateTime && new Date(progress.plannedStartDateTime) <= new Date(now) ? progress.plannedStartDateTime : null, actualStart = completed ? (progress.actualStartDateTime || plannedStart || now) : progress.actualStartDateTime;
    const outcome = applyProgressUpdate(step.id, { status: completed ? "完了" : (actualStart ? "実施中" : "未着手"), completed, actualStartDateTime: actualStart, actualEndDateTime: actualEnd, remainingWorkMinutes: completed ? 0 : step.workDurationMinutes, actualWorkMinutes: step.actualWorkMinutes ?? null, manualStartAt: step.manualStartAt || null, recordedAt: now, referenceAt: actualEnd || now }, { allowProgressOnly: completed });
    if (!outcome.ok) return alert(outcome.error); saveData(outcome.recalculated ? "工程を完了し、後続工程の予定を再計算しました" : "完了状態を保存しました。予定の再計算が必要です");
  }
  function submitProgress(event) {
    event.preventDefault(); const step = data.steps.find((item) => item.id === $("progressStepId").value); if (!step) return; $("progressFormAlert").hidden = true;
    const completed = $("progressCompleted").checked || $("progressStatus").value === "完了", now = new Date().toISOString(), plannedInput = $("plannedStartDateTime").value, manualStartAt = plannedInput ? C.zonedLocalToIso(plannedInput, data.availability.timeZone) : null;
    let actualStart = $("actualStartedAt").value ? C.zonedLocalToIso($("actualStartedAt").value, data.availability.timeZone) : null, actualEnd = $("actualEndedAt").value ? C.zonedLocalToIso($("actualEndedAt").value, data.availability.timeZone) : null;
    if (completed) { actualEnd ||= now; const planned = C.progressFields(step).plannedStartDateTime; actualStart ||= planned && new Date(planned) <= new Date(actualEnd) ? planned : actualEnd; }
    if (actualStart && actualEnd && new Date(actualEnd) < new Date(actualStart)) return showFormError($("progressFormAlert"), "実績終了日時は実績開始日時以後にしてください。");
    const status = completed ? "完了" : $("progressStatus").value, remaining = Math.max(0, Number($("remainingWorkMinutes").value)), recordedAt = now;
    const outcome = applyProgressUpdate(step.id, { status, completed, actualStartDateTime: actualStart, actualEndDateTime: completed ? actualEnd : null, remainingWorkMinutes: remaining, actualWorkMinutes: $("actualWorkMinutes").value === "" ? null : Math.max(0, Number($("actualWorkMinutes").value)), manualStartAt, recordedAt, referenceAt: completed ? actualEnd : now }, { rejectLate: !!manualStartAt && !completed, allowProgressOnly: completed });
    if (!outcome.ok) return showFormError($("progressFormAlert"), outcome.error); $("progressDialog").close(); saveData(outcome.recalculated ? "進捗を保存し、影響を受ける工程の予定を再計算しました" : "進捗を保存しました。予定の再計算が必要です");
  }
  function showFormError(alertElement, message, fieldId) { alertElement.textContent = message; alertElement.hidden = false; if (fieldId && $(fieldId)) $(fieldId).focus(); }
  function askConfirm(title, message, action, dangerLabel) { $("confirmTitle").textContent = title; $("confirmMessage").textContent = message; elements.confirmDialog.querySelector(".danger").textContent = dangerLabel || "削除する"; pendingConfirm = action; elements.confirmDialog.showModal(); }
  function showToast(message) { elements.toast.textContent = message; elements.toast.classList.add("show"); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => elements.toast.classList.remove("show"), 2800); }

  function exportBackup() { const blob = new Blob([C.serializeData(data)], { type: "application/json" }), link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `experiment-schedule-backup-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(link.href); showToast("バックアップを書き出しました"); }
  async function importBackup(file) {
    if (!file) return; const result = C.parseBackup(await file.text()); if (!result.valid) { alert(`復元できません。\n\n${result.errors.slice(0, 8).join("\n")}`); return; }
    const summary = `実験 ${result.data.experimentIdeas.length}件、テンプレート ${result.data.templates.length}件、計画 ${result.data.plans.length}件を含むデータで上書きします。${result.migrated ? "旧スキーマはv4へ移行されます。" : ""}`;
    askConfirm("バックアップを復元しますか？", summary, () => { data = result.data; saveData("バックアップを復元しました"); }, "上書きして復元");
  }
  function switchView(view) {
    document.querySelectorAll(".view").forEach((node) => node.classList.toggle("active", node.id === `${view}View`)); document.querySelectorAll(".nav-item").forEach((node) => node.classList.toggle("active", node.dataset.view === view));
    const titles = { stock: ["実験ストック", "今後やりたい実験を整理・管理します"], templates: ["工程テンプレート", "作業・待機・装置・来室条件を設計します"], plans: ["実験計画", "テンプレートから独立した個別工程を管理します"], availability: ["作業可能時間", "研究室・自宅の作業時間と来室方針を設定します"], schedule: ["逆算スケジュール", "完成予定日時から工程を逆算します"], resources: ["作業者・装置", "担当者と装置の利用条件を管理します"], optimization: ["複数実験の最適化", "期限を守りながら来室日数を減らします"], data: ["データ管理", "ローカルデータのバックアップと復元"] };
    $("pageTitle").textContent = titles[view][0]; $("pageSubtitle").textContent = titles[view][1]; document.querySelector(".sidebar").classList.remove("open");
  }

  C.STATUSES.forEach((status) => elements.filter.insertAdjacentHTML("beforeend", `<option>${status}</option>`));
  $("addButton").addEventListener("click", () => openIdeaForm()); $("emptyAddButton").addEventListener("click", () => openIdeaForm()); elements.ideaForm.addEventListener("submit", submitIdea);
  [elements.search, elements.filter, elements.sort].forEach((node) => node.addEventListener("input", renderIdeas));
  elements.ideaList.addEventListener("click", (event) => { const card = event.target.closest("[data-id]"); if (!card) return; if (event.target.closest(".edit-button")) openIdeaForm(data.experimentIdeas.find((x) => x.id === card.dataset.id)); if (event.target.closest(".delete-button")) deleteIdea(card.dataset.id); });
  $("addTemplateButton").addEventListener("click", () => openTemplateForm()); $("emptyTemplateButton").addEventListener("click", () => openTemplateForm()); elements.templateForm.addEventListener("submit", submitTemplate);
  elements.templateList.addEventListener("click", handleOwnerAction); elements.planList.addEventListener("click", handleOwnerAction); elements.stepForm.addEventListener("submit", submitStep); elements.applyForm.addEventListener("submit", submitApply); elements.appendTemplateForm.addEventListener("submit", submitAppendTemplate);
  [$("appendPlanId"), $("appendTemplateId")].forEach((node) => node.addEventListener("change", updateAppendTemplateSummary));
  $("progressForm").addEventListener("submit", submitProgress);
  $("progressCompleted").addEventListener("change", () => { $("progressStatus").value = $("progressCompleted").checked ? "完了" : ($("progressStatus").value === "完了" ? "未着手" : $("progressStatus").value); $("plannedStartDateTime").disabled = $("progressCompleted").checked; });
  $("progressStatus").addEventListener("change", () => { $("progressCompleted").checked = $("progressStatus").value === "完了"; $("plannedStartDateTime").disabled = $("progressCompleted").checked; });
  $("addEquipmentButton").addEventListener("click", () => addEquipmentRow()); $("equipmentRows").addEventListener("click", (event) => { if (event.target.closest(".remove-equipment")) event.target.closest(".equipment-row").remove(); }); $("labDuringWait").addEventListener("change", updateWaitCheck);
  document.querySelectorAll(".dialog-close, .dialog-cancel").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close())); $("closeDialog").addEventListener("click", () => elements.ideaDialog.close()); $("cancelButton").addEventListener("click", () => elements.ideaDialog.close());
  elements.confirmDialog.querySelector("form").addEventListener("submit", (event) => {
    if (event.submitter?.value === "confirm" && pendingConfirm) { const action = pendingConfirm; pendingConfirm = null; action(); }
  });
  elements.confirmDialog.addEventListener("close", () => { pendingConfirm = null; });
  $("exportButton").addEventListener("click", exportBackup); $("importButton").addEventListener("click", () => $("importInput").click()); $("importInput").addEventListener("change", (event) => { importBackup(event.target.files[0]); event.target.value = ""; });
  $("weeklyRows").addEventListener("change", (event) => { if (event.target.classList.contains("weekly-enabled")) { const row = event.target.closest(".weekly-row"); row.querySelectorAll('input[type="time"]').forEach((input) => { input.disabled = !event.target.checked; }); } });
  $("saveAvailabilityButton").addEventListener("click", saveAvailability); $("holidayForm").addEventListener("submit", submitHoliday); $("holidayList").addEventListener("click", handleAvailabilityAction); $("exceptionForm").addEventListener("submit", submitException); $("exceptionList").addEventListener("click", handleAvailabilityAction); $("exceptionType").addEventListener("change", toggleExceptionTimes);
  $("availabilityProfileSelect").addEventListener("change", (event) => { availabilityEditingProfileId = event.target.value; renderAvailability(); }); $("attendanceForm").addEventListener("submit", submitAttendance); $("attendanceList").addEventListener("click", handleAttendanceAction);
  $("workerForm").addEventListener("submit", submitWorker); $("workerList").addEventListener("click", handleResourceAction); $("resourceEquipmentList").addEventListener("click", handleResourceAction);
  $("runOptimizationButton").addEventListener("click", () => runOptimization()); $("cancelOptimizationButton").addEventListener("click", () => { optimizationCancelled = true; if (optimizationWorker) optimizationWorker.terminate(); finishOptimizationUi("計算をキャンセルしました。"); }); $("optimizationComparison").addEventListener("click", handleOptimizationAction);
  $("schedulePlanSelect").addEventListener("change", selectSchedulePlan); $("calculateScheduleButton").addEventListener("click", calculateSchedule); $("calendarPrev").addEventListener("click", () => shiftCalendar(-1)); $("calendarNext").addEventListener("click", () => shiftCalendar(1)); $("calendarToday").addEventListener("click", () => { const now = C.dateKeyInZone(new Date().toISOString(), data.availability.timeZone); calendarCursor = now.slice(0, 7); const plan = data.plans.find((item) => item.id === $("schedulePlanSelect").value), version = activeSchedule(plan); if (version) renderCalendar(version); });
  document.querySelectorAll(".nav-item").forEach((node) => node.addEventListener("click", () => switchView(node.dataset.view))); $("menuButton").addEventListener("click", () => document.querySelector(".sidebar").classList.toggle("open"));
  render(); if (migratedOnLoad) setTimeout(() => showToast("既存データをスキーマv4へ移行しました"), 100);
})();
