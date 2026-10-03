$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$edgePath = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profilePath = Join-Path $projectRoot '.e2e-profile'
$downloadPath = Join-Path $profilePath 'downloads'
$appPath = Join-Path $projectRoot 'index.html'
$appUrl = ([Uri]$appPath).AbsoluteUri
$debugPort = 9338
$browser = $null
$socket = $null
$script:cdpId = 0
$script:jsCallId = 0
$results = [System.Collections.Generic.List[object]]::new()

function Add-Result([string]$Name, [bool]$Passed, [string]$Detail) {
  $results.Add([PSCustomObject]@{ Test = $Name; Passed = $Passed; Detail = $Detail })
  if (-not $Passed) { throw "$Name failed: $Detail" }
}

function Invoke-Cdp([string]$Method, [hashtable]$Params = @{}) {
  $script:cdpId++
  $id = $script:cdpId
  $payload = @{ id = $id; method = $Method; params = $Params } | ConvertTo-Json -Depth 20 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $segment = [ArraySegment[byte]]::new($bytes)
  [void]$socket.SendAsync($segment, [Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()

  while ($true) {
    $builder = [Text.StringBuilder]::new()
    do {
      $buffer = New-Object byte[] 65536
      $receiveSegment = [ArraySegment[byte]]::new($buffer)
      $received = $socket.ReceiveAsync($receiveSegment, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
      [void]$builder.Append([Text.Encoding]::UTF8.GetString($buffer, 0, $received.Count))
    } while (-not $received.EndOfMessage)
    $message = $builder.ToString() | ConvertFrom-Json
    if ($message.id -eq $id) {
      if ($message.error) { throw "CDP $Method error: $($message.error.message)" }
      return $message.result
    }
  }
}

function Invoke-Js([string]$Expression) {
  $script:jsCallId++
  $response = Invoke-Cdp 'Runtime.evaluate' @{ expression = $Expression; awaitPromise = $true; returnByValue = $true }
  if ($response.exceptionDetails) { throw "JavaScript call $($script:jsCallId) error: $($response.exceptionDetails.text) $($response.exceptionDetails.exception.description) at line $($response.exceptionDetails.lineNumber); expression starts: $($Expression.Substring(0,[Math]::Min(120,$Expression.Length)))" }
  return $response.result.value
}

function Wait-For([scriptblock]$Condition, [int]$TimeoutSeconds = 10) {
  $limit = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    try { if (& $Condition) { return $true } } catch {}
    Start-Sleep -Milliseconds 150
  } while ((Get-Date) -lt $limit)
  return $false
}

try {
  if (-not (Test-Path -LiteralPath $edgePath)) { throw 'Microsoft Edge was not found.' }
  New-Item -ItemType Directory -Path $downloadPath -Force | Out-Null
  $arguments = @(
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-default-apps',
    "--remote-debugging-port=$debugPort", "--user-data-dir=$profilePath", $appUrl
  )
  $browser = Start-Process -FilePath $edgePath -ArgumentList $arguments -PassThru -WindowStyle Hidden

  $targets = $null
  $ready = Wait-For {
    $script:targets = Invoke-RestMethod "http://127.0.0.1:$debugPort/json/list"
    return [bool]($script:targets | Where-Object { $_.type -eq 'page' -and $_.url -like '*index.html*' })
  }
  if (-not $ready) { throw 'Edge DevTools endpoint did not become ready.' }
  $target = $script:targets | Where-Object { $_.type -eq 'page' -and $_.url -like '*index.html*' } | Select-Object -First 1
  $socket = [Net.WebSockets.ClientWebSocket]::new()
  $socket.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  [void](Invoke-Cdp 'Runtime.enable')
  [void](Invoke-Cdp 'Page.enable')
  [void](Invoke-Cdp 'Page.setDownloadBehavior' @{ behavior = 'allow'; downloadPath = $downloadPath })

  [void](Invoke-Js @'
(() => {
  const legacy = ExperimentCore.createEmptyData();
  legacy.schemaVersion = 2;
  legacy.availability = {weekly:ExperimentCore.defaultWeekly(),exceptions:[]};
  legacy.experimentIdeas.push({id:'legacy_idea',name:'Legacy',purpose:'',materials:'',plannedEquipment:'',priority:'\u4e2d',desiredCompletionDate:'',notes:'',status:'\u672a\u8a08\u753b',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  localStorage.setItem(ExperimentCore.STORAGE_KEY, JSON.stringify(legacy));
  return true;
})()
'@)
  [void](Invoke-Cdp 'Page.reload' @{ ignoreCache = $true })
  if (-not (Wait-For { (Invoke-Js 'document.readyState') -eq 'complete' })) { throw 'Migration reload timed out.' }
  $migration = Invoke-Js "(() => {const d=JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY));const b=JSON.parse(localStorage.getItem(ExperimentCore.migrationBackupKey(2)));return {version:d.schemaVersion,count:d.experimentIdeas.length,name:d.experimentIdeas[0].name,backupVersion:b.schemaVersion,backupCount:b.experimentIdeas.length,profiles:d.availability.profiles.length};})()"
  Add-Result 'Schema migration' ($migration.version -eq 4 -and $migration.count -eq 1 -and $migration.name -eq 'Legacy' -and $migration.backupVersion -eq 2 -and $migration.backupCount -eq 1 -and $migration.profiles -eq 2) 'Backed up v2 and migrated to v4 without losing existing record'

  [void](Invoke-Js "localStorage.clear(); location.reload(); true")
  if (-not (Wait-For { (Invoke-Js 'document.readyState') -eq 'complete' })) { throw 'Initial reload timed out.' }

  $registration = Invoke-Js @'
(() => {
  const set = (id, value) => { const el = document.getElementById(id); el.value = value; };
  const submit = (values) => {
    document.getElementById('addButton').click();
    Object.entries(values).forEach(([id, value]) => set(id, value));
    document.getElementById('ideaForm').requestSubmit();
  };
  submit({name:'Alpha', purpose:'initial-purpose', materials:'sample-A', plannedEquipment:'device-A', priority:'\u9ad8', status:'\u672a\u8a08\u753b', desiredCompletionDate:'2026-12-20'});
  const firstId = JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY)).experimentIdeas[0].id;
  document.querySelector(`[data-id="${firstId}"] .edit-button`).click();
  set('name', 'Alpha-edited'); set('purpose', 'edited-purpose');
  document.getElementById('ideaForm').requestSubmit();
  submit({name:'Beta', purpose:'search-keyword', materials:'sample-B', plannedEquipment:'device-B', priority:'\u4f4e', status:'\u5b8c\u4e86', desiredCompletionDate:'2027-01-10'});
  submit({name:'Gamma', purpose:'active-test', materials:'sample-C', plannedEquipment:'device-C', priority:'\u4e2d', status:'\u5b9f\u65bd\u4e2d', desiredCompletionDate:'2026-12-25'});
  const saved = JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY));
  return {count:saved.experimentIdeas.length, first:saved.experimentIdeas.find(x => x.id === firstId), cards:document.querySelectorAll('.idea-card').length};
})()
'@
  Add-Result 'Create and edit' ($registration.count -eq 3 -and $registration.first.name -eq 'Alpha-edited' -and $registration.first.purpose -eq 'edited-purpose' -and $registration.cards -eq 3) 'Created 3 records and persisted edited fields'

  $filtering = Invoke-Js @'
(() => {
  const fire = (el) => el.dispatchEvent(new Event('input', {bubbles:true}));
  const search = document.getElementById('searchInput'); const filter = document.getElementById('statusFilter'); const sort = document.getElementById('sortSelect');
  search.value = 'search-keyword'; fire(search);
  const searchNames = [...document.querySelectorAll('.idea-card h2')].map(x => x.textContent);
  search.value = ''; fire(search); filter.value = '\u5b8c\u4e86'; fire(filter);
  const filterNames = [...document.querySelectorAll('.idea-card h2')].map(x => x.textContent);
  filter.value = ''; fire(filter); sort.value = 'priority'; fire(sort);
  const sortedNames = [...document.querySelectorAll('.idea-card h2')].map(x => x.textContent);
  return {searchNames, filterNames, sortedNames};
})()
'@
  $sortOk = ($filtering.sortedNames -join ',') -eq 'Alpha-edited,Gamma,Beta'
  Add-Result 'Search filter sort' ($filtering.searchNames.Count -eq 1 -and $filtering.searchNames[0] -eq 'Beta' -and $filtering.filterNames.Count -eq 1 -and $filtering.filterNames[0] -eq 'Beta' -and $sortOk) 'Search 1, completed filter 1, priority high-medium-low'

  [void](Invoke-Cdp 'Page.reload' @{ ignoreCache = $true })
  if (-not (Wait-For { (Invoke-Js 'document.readyState') -eq 'complete' })) { throw 'Persistence reload timed out.' }
  $persistence = Invoke-Js "(() => { const d=JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY)); return {stored:d.experimentIdeas.length,cards:document.querySelectorAll('.idea-card').length,names:d.experimentIdeas.map(x=>x.name)}; })()"
  Add-Result 'Reload persistence' ($persistence.stored -eq 3 -and $persistence.cards -eq 3 -and $persistence.names -contains 'Alpha-edited') 'Three records remained in localStorage and UI'

  [void](Invoke-Js "document.getElementById('exportButton').click(); true")
  $backupFile = $null
  $downloaded = Wait-For {
    $script:backupFile = Get-ChildItem -LiteralPath $downloadPath -Filter 'experiment-schedule-backup-*.json' -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike '*.crdownload' } | Select-Object -First 1
    return $null -ne $script:backupFile
  }
  if (-not $downloaded) { throw 'Backup download timed out.' }
  $backupObject = Get-Content -Raw -Encoding UTF8 -LiteralPath $script:backupFile.FullName | ConvertFrom-Json
  $backupValid = $backupObject.schemaVersion -eq 4 -and $backupObject.experimentIdeas.Count -eq 3

  $deletion = Invoke-Js @'
(async () => {
  const card = [...document.querySelectorAll('.idea-card')].find(x => x.querySelector('h2').textContent === 'Gamma');
  card.querySelector('.delete-button').click();
  document.querySelector('#confirmDialog button[value="confirm"]').click();
  await new Promise(resolve => setTimeout(resolve, 100));
  return {stored:JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY)).experimentIdeas.length,cards:document.querySelectorAll('.idea-card').length};
})()
'@
  Add-Result 'Delete' ($deletion.stored -eq 2 -and $deletion.cards -eq 2) 'Deleted one record after confirmation'

  $documentNode = Invoke-Cdp 'DOM.getDocument' @{ depth = 1 }
  $inputNode = Invoke-Cdp 'DOM.querySelector' @{ nodeId = $documentNode.root.nodeId; selector = '#importInput' }
  [void](Invoke-Cdp 'DOM.setFileInputFiles' @{ nodeId = $inputNode.nodeId; files = @($script:backupFile.FullName) })
  Start-Sleep -Milliseconds 500
  $confirmOpen = Invoke-Js "document.getElementById('confirmDialog').open"
  if (-not $confirmOpen) { [void](Invoke-Js "document.getElementById('importInput').dispatchEvent(new Event('change',{bubbles:true})); true"); Start-Sleep -Milliseconds 500 }
  $restorePrompt = Invoke-Js "document.getElementById('confirmDialog').open"
  [void](Invoke-Js "document.querySelector('#confirmDialog button[value=confirm]').click(); true")
  $restored = Invoke-Js "(() => {const d=JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY)); return {count:d.experimentIdeas.length, gamma:d.experimentIdeas.some(x=>x.name==='Gamma')};})()"
  Add-Result 'JSON backup and restore' ($backupValid -and $restorePrompt -and $restored.count -eq 3 -and $restored.gamma) "backupValid=$backupValid restorePrompt=$restorePrompt restoredCount=$($restored.count) gamma=$($restored.gamma)"

  $beforeInvalid = Invoke-Js "localStorage.getItem(ExperimentCore.STORAGE_KEY)"
  $invalidResult = Invoke-Js @'
(async () => {
  window.__testAlert = '';
  window.alert = (message) => { window.__testAlert = message; };
  const file = new File(['{"schemaVersion":999,"experimentIdeas":"broken"}'], 'invalid.json', {type:'application/json'});
  const transfer = new DataTransfer(); transfer.items.add(file);
  const input = document.getElementById('importInput'); input.files = transfer.files;
  input.dispatchEvent(new Event('change', {bubbles:true}));
  await new Promise(resolve => setTimeout(resolve, 300));
  return {alert:window.__testAlert, dialogOpen:document.getElementById('confirmDialog').open};
})()
'@
  $afterInvalid = Invoke-Js "localStorage.getItem(ExperimentCore.STORAGE_KEY)"
  Add-Result 'Invalid import protection' ($beforeInvalid -eq $afterInvalid -and $invalidResult.alert.Length -gt 0 -and -not $invalidResult.dialogOpen) 'Rejected invalid schema and preserved exact saved JSON'

  $beforeBrokenV4 = Invoke-Js "localStorage.getItem(ExperimentCore.STORAGE_KEY)"
  $brokenV4 = Invoke-Js @'
(async () => {
  window.__testAlert = '';
  const broken = JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY)); broken.steps = 'broken';
  const file = new File([JSON.stringify(broken)], 'broken-v4.json', {type:'application/json'});
  const transfer = new DataTransfer(); transfer.items.add(file);
  const input = document.getElementById('importInput'); input.files = transfer.files;
  input.dispatchEvent(new Event('change', {bubbles:true}));
  await new Promise(resolve => setTimeout(resolve, 300));
  return {alert:window.__testAlert,hasCollectionName:window.__testAlert.includes('steps'),hasJapanese:/[\u3040-\u30ff\u4e00-\u9fff]/.test(window.__testAlert),dialogOpen:document.getElementById('confirmDialog').open};
})()
'@
  $afterBrokenV4 = Invoke-Js "localStorage.getItem(ExperimentCore.STORAGE_KEY)"
  Add-Result 'Strict v4 collection rejection' ($beforeBrokenV4 -eq $afterBrokenV4 -and $brokenV4.hasCollectionName -and $brokenV4.hasJapanese -and -not $brokenV4.dialogOpen) 'Rejected a non-array steps collection with a Japanese reason and preserved exact saved data'

  $strictMatrix = Invoke-Js @'
(() => {
  const original=JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY));
  const duplicate=JSON.parse(JSON.stringify(original));duplicate.experimentIdeas.push({...duplicate.experimentIdeas[0]});
  const badDate=JSON.parse(JSON.stringify(original));badDate.updatedAt='not-a-date';
  const missingRef=JSON.parse(JSON.stringify(original));missingRef.plans.push({id:'missing_plan',name:'Missing',experimentIdeaId:'does_not_exist',sourceTemplateId:null,targetCompletionDateTime:'2030-01-01T00:00:00.000Z',activeScheduleVersionId:null});
  const a=ExperimentCore.parseBackup(JSON.stringify(duplicate)),b=ExperimentCore.parseBackup(JSON.stringify(badDate)),c=ExperimentCore.parseBackup(JSON.stringify(missingRef));
  return {duplicateRejected:!a.valid,duplicateReason:a.errors.join('\n'),dateRejected:!b.valid,dateReason:b.errors.join('\n'),referenceRejected:!c.valid,referenceReason:c.errors.join('\n')};
})()
'@
  Add-Result 'Strict v4 IDs dates references' ($strictMatrix.duplicateRejected -and $strictMatrix.dateRejected -and $strictMatrix.referenceRejected -and $strictMatrix.duplicateReason.Length -gt 0 -and $strictMatrix.dateReason.Length -gt 0 -and $strictMatrix.referenceReason.Length -gt 0) 'Rejected duplicate IDs, invalid dates, and missing references'

  $legacyRestore = Invoke-Js @'
(() => {
  const results=[1,2,3].map(version=>{const old=ExperimentCore.createEmptyData();old.schemaVersion=version;if(version<3)old.availability={weekly:ExperimentCore.defaultWeekly(),exceptions:[]};const parsed=ExperimentCore.parseBackup(JSON.stringify(old));return {version,valid:parsed.valid,migrated:parsed.migrated,resultVersion:parsed.data?.schemaVersion};});
  return {all:results.every(x=>x.valid&&x.migrated&&x.resultVersion===4),results};
})()
'@
  Add-Result 'Legacy v1-v3 restore' ($legacyRestore.all) 'Accepted normal v1, v2, and v3 backups and migrated each to v4'

  $templateCreated = Invoke-Js @'
(() => {
  document.querySelector('[data-view="templates"]').click();
  document.getElementById('addTemplateButton').click();
  document.getElementById('templateName').value = 'Culture template';
  document.getElementById('templateDescription').value = 'Reusable process';
  document.getElementById('templateForm').requestSubmit();
  const d = JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY));
  return {count:d.templates.length,id:d.templates[0].id,name:d.templates[0].name};
})()
'@
  Add-Result 'Template create' ($templateCreated.count -eq 1 -and $templateCreated.name -eq 'Culture template') 'Created and persisted one process template'

  $stepsCreated = Invoke-Js @'
(() => {
  const templateId = JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY)).templates[0].id;
  const addStep = (values, equipmentName, occupancy, predecessor) => {
    const card = document.querySelector(`[data-owner-id="${templateId}"]`);
    card.querySelector('[data-action="add-step"]').click();
    document.getElementById('stepName').value = values.name;
    document.getElementById('workDurationMinutes').value = values.work;
    document.getElementById('waitDurationMinutes').value = values.wait;
    document.getElementById('waitDurationType').value = values.waitType;
    document.getElementById('labAtStart').checked = values.start;
    document.getElementById('labAtEnd').checked = values.end;
    document.getElementById('labDuringWait').checked = values.waitCheck;
    document.getElementById('labDuringWait').dispatchEvent(new Event('change',{bubbles:true}));
    document.getElementById('waitCheckIntervalMinutes').value = values.interval;
    if (predecessor) document.querySelector('#predecessorOptions input').checked = true;
    document.getElementById('addEquipmentButton').click();
    const row = document.querySelector('#equipmentRows .equipment-row:last-child');
    row.querySelector('.equipment-name').value = equipmentName;
    row.querySelector('.equipment-start').value = 0; row.querySelector('.equipment-end').value = occupancy;
    document.getElementById('stepForm').requestSubmit();
  };
  addStep({name:'Incubate',work:45,wait:120,waitType:'calendar',start:true,end:false,waitCheck:true,interval:60},'Incubator',120,false);
  addStep({name:'Observe',work:30,wait:0,waitType:'working',start:false,end:true,waitCheck:false,interval:0},'Microscope',30,true);
  const d = JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY));
  const steps = d.steps.filter(x => x.ownerType === 'template' && x.ownerId === templateId);
  return {count:steps.length,first:steps[0],second:steps[1],equipment:d.equipment.length};
})()
'@
  $stepShapeOk = $stepsCreated.count -eq 2 -and $stepsCreated.first.workDurationMinutes -eq 45 -and $stepsCreated.first.waitDurationMinutes -eq 120 -and $stepsCreated.first.labRequirement.start -and $stepsCreated.first.labRequirement.waitCheck -and $stepsCreated.first.equipmentRequirements[0].occupancyMinutes -eq 120 -and $stepsCreated.second.predecessorIds[0] -eq $stepsCreated.first.id
  Add-Result 'Step fields and dependency' ($stepShapeOk -and $stepsCreated.equipment -eq 2) 'Saved work/wait, lab visits, equipment occupancy, and predecessor IDs'

  $cycle = Invoke-Js @'
(() => {
  const d = JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY));
  const templateId = d.templates[0].id;
  const steps = d.steps.filter(x => x.ownerType === 'template' && x.ownerId === templateId);
  const firstRow = document.querySelector(`[data-step-id="${steps[0].id}"]`);
  firstRow.querySelector('[data-action="edit-step"]').click();
  document.querySelector('#predecessorOptions input').checked = true;
  document.getElementById('stepForm').requestSubmit();
  const after = JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY));
  const unchanged = after.steps.find(x => x.id === steps[0].id).predecessorIds.length === 0;
  const error = document.getElementById('stepAlert').textContent;
  document.getElementById('stepDialog').close();
  return {unchanged,error,dialogWasOpen:error.length > 0};
})()
'@
  Add-Result 'Cycle rejection' ($cycle.unchanged -and $cycle.dialogWasOpen) 'Rejected circular dependency without changing saved step'

  $plans = Invoke-Js @'
(() => {
  const d = JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY)); const templateId = d.templates[0].id;
  document.querySelector(`[data-owner-id="${templateId}"] [data-action="apply"]`).click();
  const choices = [...document.querySelectorAll('#applyIdeaOptions input')]; choices[0].checked = true; choices[1].checked = true;
  document.getElementById('applyForm').requestSubmit();
  const after = JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY));
  const planSteps = after.steps.filter(x => x.ownerType === 'plan'); const templateSteps = after.steps.filter(x => x.ownerType === 'template');
  return {plans:after.plans.length,planSteps:planSteps.length,templateSteps:templateSteps.length,idsIndependent:planSteps.every(x => !templateSteps.some(t => t.id === x.id)),sourceLinked:planSteps.every(x => !!x.sourceTemplateStepId)};
})()
'@
  Add-Result 'Apply to multiple experiments' ($plans.plans -eq 2 -and $plans.planSteps -eq 4 -and $plans.templateSteps -eq 2 -and $plans.idsIndependent -and $plans.sourceLinked) 'Created two plans with independent cloned step IDs'

  $independence = Invoke-Js @'
(() => {
  const d = JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY));
  const templateStep = d.steps.find(x => x.ownerType === 'template' && x.name === 'Incubate');
  document.querySelector('[data-view="templates"]').click();
  document.querySelector(`[data-step-id="${templateStep.id}"] [data-action="edit-step"]`).click();
  document.getElementById('workDurationMinutes').value = '60'; document.getElementById('stepForm').requestSubmit();
  const afterTemplate = JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY));
  const firstPlan = afterTemplate.plans[0]; const planStep = afterTemplate.steps.find(x => x.ownerId === firstPlan.id && x.name === 'Incubate');
  document.querySelector('[data-view="plans"]').click();
  document.querySelector(`[data-step-id="${planStep.id}"] [data-action="edit-step"]`).click();
  document.getElementById('workDurationMinutes').value = '50'; document.getElementById('stepForm').requestSubmit();
  const finalData = JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY));
  return {templateWork:finalData.steps.find(x => x.id === templateStep.id).workDurationMinutes,editedPlanWork:finalData.steps.find(x => x.id === planStep.id).workDurationMinutes,otherPlanWork:finalData.steps.find(x => x.ownerType === 'plan' && x.ownerId !== firstPlan.id && x.name === 'Incubate').workDurationMinutes};
})()
'@
  Add-Result 'Template plan independence' ($independence.templateWork -eq 60 -and $independence.editedPlanWork -eq 50 -and $independence.otherPlanWork -eq 45) 'Template and each generated plan can be edited independently'

  [void](Invoke-Cdp 'Page.reload' @{ ignoreCache = $true })
  if (-not (Wait-For { (Invoke-Js 'document.readyState') -eq 'complete' })) { throw 'Stage 2 reload timed out.' }
  $stage2Persistence = Invoke-Js @'
(() => {
  const data = JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY));
  const roundTrip = ExperimentCore.parseBackup(ExperimentCore.serializeData(data));
  return {templates:data.templates.length,plans:data.plans.length,steps:data.steps.length,valid:roundTrip.valid,roundTripSteps:roundTrip.valid ? roundTrip.data.steps.length : -1};
})()
'@
  Add-Result 'Stage 2 persistence and backup' ($stage2Persistence.templates -eq 1 -and $stage2Persistence.plans -eq 2 -and $stage2Persistence.steps -eq 6 -and $stage2Persistence.valid -and $stage2Persistence.roundTripSteps -eq 6) 'Reloaded and validated backup round-trip with template and plan steps'

  $scheduleAlgorithms = Invoke-Js @'
(() => {
  const makeStep = (id,name,work,wait,type,preds=[],lab={}) => ({id,ownerType:'plan',ownerId:'p',sourceTemplateStepId:null,name,workDurationMinutes:work,waitDurationMinutes:wait,waitDurationType:type,predecessorIds:preds,labRequirement:{start:!!lab.start,end:!!lab.end,waitCheck:!!lab.waitCheck},waitCheckIntervalMinutes:lab.interval||0,equipmentRequirements:[],notes:'',status:'\u672a\u7740\u624b'});
  const makeData = (steps) => { const d=ExperimentCore.createEmptyData(); d.plans=[{id:'p',name:'Plan',experimentIdeaId:'i',sourceTemplateId:'t'}]; d.steps=steps; return d; };
  const local = (iso) => ExperimentCore.isoToZonedInput(iso,'Asia/Tokyo');
  const opts={nowIso:'2029-01-01T00:00:00.000Z'};

  const single=ExperimentCore.calculatePlanSchedule(makeData([makeStep('a','A',60,0,'calendar')]),'p','2030-01-07T18:00',opts);
  const sequential=ExperimentCore.calculatePlanSchedule(makeData([makeStep('a','A',60,0,'calendar'),makeStep('b','B',60,0,'calendar',['a'])]),'p','2030-01-07T18:00',opts);
  const parallel=ExperimentCore.calculatePlanSchedule(makeData([makeStep('a','A',60,0,'calendar'),makeStep('b','B',120,0,'calendar'),makeStep('c','C',30,0,'calendar',['a','b'])]),'p','2030-01-07T18:00',opts);

  const holidayData=makeData([makeStep('a','A',120,0,'calendar')]); holidayData.availability.holidays=[{id:'h',date:'2030-01-07',name:'Holiday'}];
  const holiday=ExperimentCore.calculatePlanSchedule(holidayData,'p','2030-01-08T10:00',opts);

  const calendarWait=ExperimentCore.calculatePlanSchedule(makeData([makeStep('a','A',60,1440,'calendar')]),'p','2030-01-08T18:00',opts);
  const workingWait=ExperimentCore.calculatePlanSchedule(makeData([makeStep('a','A',60,120,'working')]),'p','2030-01-07T18:00',opts);
  const changed=ExperimentCore.calculatePlanSchedule(makeData([makeStep('a','A',60,0,'calendar')]),'p','2030-01-07T17:00',opts);

  const warningData=makeData([makeStep('a','A',0,60,'calendar',[],{end:true,waitCheck:true,interval:30})]);
  const warning=ExperimentCore.calculatePlanSchedule(warningData,'p','2030-01-13T12:00',opts);
  const noTime=makeData([makeStep('a','A',60,0,'calendar')]); noTime.availability.profiles[0].weekly.forEach(x=>x.enabled=false);
  const impossible=ExperimentCore.calculatePlanSchedule(noTime,'p','2030-01-07T18:00',opts);
  const late=ExperimentCore.calculatePlanSchedule(makeData([makeStep('a','A',60,0,'calendar')]),'p','2030-01-07T18:00',{nowIso:'2030-01-08T00:00:00.000Z'});
  const snapshotData=makeData([makeStep('a','A',60,0,'calendar')]); const snapshot=ExperimentCore.calculatePlanSchedule(snapshotData,'p','2030-01-07T18:00',opts); snapshotData.availability.profiles[0].weekly[1].enabled=false;

  const byId = (result,id) => result.stepSchedules.find(x=>x.stepId===id);
  return {
    single:{ok:single.feasible,start:local(byId(single,'a').startAt),end:local(byId(single,'a').endAt),target:single.targetCompletionDateTime},
    sequential:{aEnd:local(byId(sequential,'a').endAt),bStart:local(byId(sequential,'b').startAt)},
    parallel:{aEnd:local(byId(parallel,'a').endAt),bEnd:local(byId(parallel,'b').endAt),cStart:local(byId(parallel,'c').startAt)},
    holiday:{start:local(byId(holiday,'a').startAt),segments:byId(holiday,'a').workSegments.map(x=>local(x.startAt)+'/'+local(x.endAt))},
    waits:{calendarBoundary:byId(calendarWait,'a').workEndAt===byId(calendarWait,'a').waitStartAt,calendarStart:local(byId(calendarWait,'a').startAt),calendarEnd:local(byId(calendarWait,'a').endAt),workingBoundary:byId(workingWait,'a').workEndAt===byId(workingWait,'a').waitStartAt,workingStart:local(byId(workingWait,'a').startAt)},
    changed:{first:local(byId(single,'a').startAt),second:local(byId(changed,'a').startAt)},
    warning:{count:warning.warnings.length,end:local(byId(warning,'a').endAt),visitUnavailable:byId(warning,'a').labVisits.every(x=>!x.available)},
    impossible:{feasible:impossible.feasible,error:impossible.errors[0]}, late:{feasible:late.feasible,error:late.errors[0]},
    snapshot:{kept:snapshot.availabilitySnapshot.profiles[0].weekly[1].enabled,current:snapshotData.availability.profiles[0].weekly[1].enabled},
    timezone:single.targetCompletionDateTime
  };
})()
'@
  Add-Result 'Single-step backward schedule' ($scheduleAlgorithms.single.ok -and $scheduleAlgorithms.single.start -eq '2030-01-07T17:00' -and $scheduleAlgorithms.single.end -eq '2030-01-07T18:00') 'Calculated one-hour step backward from target'
  Add-Result 'Sequential dependencies' ($scheduleAlgorithms.sequential.aEnd -eq $scheduleAlgorithms.sequential.bStart) 'Predecessor ends when successor starts'
  Add-Result 'Parallel and merged dependencies' ($scheduleAlgorithms.parallel.aEnd -eq $scheduleAlgorithms.parallel.cStart -and $scheduleAlgorithms.parallel.bEnd -eq $scheduleAlgorithms.parallel.cStart) 'Parallel branches both finish before merged successor'
  Add-Result 'Work across holiday' ($scheduleAlgorithms.holiday.start -eq '2030-01-04T17:00' -and $scheduleAlgorithms.holiday.segments.Count -eq 2) 'Skipped weekend and configured Monday holiday'
  Add-Result 'Calendar and working waits' ($scheduleAlgorithms.waits.calendarBoundary -and $scheduleAlgorithms.waits.workingBoundary -and $scheduleAlgorithms.waits.calendarEnd -eq '2030-01-08T18:00') 'Separated work/wait and preserved exact boundary for both wait types'
  Add-Result 'Target change recalculation' ($scheduleAlgorithms.changed.first -eq '2030-01-07T17:00' -and $scheduleAlgorithms.changed.second -eq '2030-01-07T16:00') 'Moved required start when target changed'
  Add-Result 'Unavailable visit warning' ($scheduleAlgorithms.warning.count -ge 2 -and $scheduleAlgorithms.warning.end -eq '2030-01-13T12:00' -and $scheduleAlgorithms.warning.visitUnavailable) 'Kept Sunday times unchanged and warned for end/check visits'
  Add-Result 'Impossible and late detection' (-not $scheduleAlgorithms.impossible.feasible -and -not $scheduleAlgorithms.late.feasible -and $scheduleAlgorithms.impossible.error.Length -gt 0 -and $scheduleAlgorithms.late.error.Length -gt 0) 'Detected missing work slots and required start in the past'
  Add-Result 'Timezone and settings snapshot' ($scheduleAlgorithms.timezone -eq '2030-01-07T09:00:00.000Z' -and $scheduleAlgorithms.snapshot.kept -and -not $scheduleAlgorithms.snapshot.current) 'Stored UTC instant, Asia/Tokyo zone, and immutable availability snapshot'

  $availabilityUi = Invoke-Js @'
(() => {
  document.querySelector('[data-view="availability"]').click();
  document.getElementById('holidayDate').value='2027-01-01'; document.getElementById('holidayName').value='New Year'; document.getElementById('holidayForm').requestSubmit();
  document.getElementById('exceptionDate').value='2027-01-02'; document.getElementById('exceptionType').value='available'; document.getElementById('exceptionStart').value='10:00'; document.getElementById('exceptionEnd').value='12:00'; document.getElementById('exceptionForm').requestSubmit();
  const d=JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY)); return {holiday:d.availability.holidays.some(x=>x.date==='2027-01-01'),exception:d.availability.exceptions.some(x=>x.date==='2027-01-02'&&x.startTime==='10:00'),profiles:d.availability.profiles.length,zone:d.availability.timeZone};
})()
'@
  Add-Result 'Availability settings UI' ($availabilityUi.holiday -and $availabilityUi.exception -and $availabilityUi.profiles -eq 2 -and $availabilityUi.zone -eq 'Asia/Tokyo') 'Saved holiday and date exception in extensible profile structure'

  $scheduleUi = Invoke-Js @'
(() => {
  document.querySelector('[data-view="schedule"]').click();
  document.getElementById('schedulePlanSelect').selectedIndex=0; document.getElementById('schedulePlanSelect').dispatchEvent(new Event('change',{bubbles:true}));
  document.getElementById('targetCompletionDateTime').value='2027-03-01T18:00'; document.getElementById('calculateScheduleButton').click();
  const d=JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY)); const plan=d.plans[0]; const version=d.scheduleVersions.find(x=>x.id===plan.activeScheduleVersionId);
  return {versions:d.scheduleVersions.length,active:!!version,rows:document.querySelectorAll('#scheduleTableBody tr').length,days:document.querySelectorAll('#scheduleCalendar .calendar-day').length,gantt:document.querySelectorAll('#ganttChart .gantt-row').length,snapshotHoliday:version.availabilitySnapshot.holidays.some(x=>x.date==='2027-01-01')};
})()
'@
  Add-Result 'Schedule UI calendar and Gantt' ($scheduleUi.versions -ge 1 -and $scheduleUi.active -and $scheduleUi.rows -eq 2 -and $scheduleUi.days -eq 42 -and $scheduleUi.gantt -eq 2 -and $scheduleUi.snapshotHoliday) 'Saved calculation and rendered table, monthly calendar, Gantt, and snapshot'

  [void](Invoke-Cdp 'Page.reload' @{ ignoreCache = $true })
  if (-not (Wait-For { (Invoke-Js 'document.readyState') -eq 'complete' })) { throw 'Stage 3 reload timed out.' }
  $scheduleReload = Invoke-Js @'
(() => {document.querySelector('[data-view="schedule"]').click();const d=JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY));return {version:d.schemaVersion,versions:d.scheduleVersions.length,active:!!d.plans[0].activeScheduleVersionId,rows:document.querySelectorAll('#scheduleTableBody tr').length,days:document.querySelectorAll('#scheduleCalendar .calendar-day').length};})()
'@
  Add-Result 'Stage 3 save and reload' ($scheduleReload.version -eq 4 -and $scheduleReload.versions -ge 1 -and $scheduleReload.active -and $scheduleReload.rows -eq 2 -and $scheduleReload.days -eq 42) 'Preserved schedule and visual results after page reload'

  $optimizerCases = Invoke-Js @'
(() => {
  const C=ExperimentCore,O=ExperimentOptimizer;
  const worker=(id)=>({id,name:id,labAvailabilityProfileId:'profile_lab',homeAvailabilityProfileId:'profile_home',unavailablePeriods:[],active:true});
  const plan=(id,deadline,idea)=>({id,name:id,experimentIdeaId:idea,targetCompletionDateTime:C.zonedLocalToIso(deadline,'Asia/Tokyo')});
  const step=(id,owner,work,wait=0,preds=[],extra={})=>({id,ownerType:'plan',ownerId:owner,name:id,workDurationMinutes:work,waitDurationMinutes:wait,waitDurationType:extra.waitType||'calendar',predecessorIds:preds,labRequirement:{start:!!extra.start,end:!!extra.end,waitCheck:!!extra.waitCheck},waitCheckIntervalMinutes:extra.interval||0,waitCheckDurationMinutes:extra.checkDuration||5,waitCheckWorkerId:extra.checkWorker||'w1',waitCheckRequiresLab:extra.checkLab!==false,assignedWorkerId:extra.worker||'w1',workLocation:extra.location||'lab',interruptible:extra.interruptible!==false,manualStartAt:extra.manual||null,equipmentRequirements:extra.equipment||[],notes:'',status:extra.status||'\u672a\u7740\u624b',remainingWorkMinutes:extra.remaining??work,actualStartedAt:extra.actualStart||null,actualEndedAt:extra.actualEnd||null,actualSegments:[]});
  const base=()=>{const d=C.createEmptyData();d.workers=[worker('w1'),worker('w2')];d.experimentIdeas=[{id:'i1',name:'I1',priority:'\u9ad8',status:'\u8a08\u753b\u4e2d'},{id:'i2',name:'I2',priority:'\u4f4e',status:'\u8a08\u753b\u4e2d'}];return d;};
  const options={nowIso:C.zonedLocalToIso('2030-01-07T09:00','Asia/Tokyo'),granularityMinutes:15,maxMilliseconds:5000};

  const attendance=base();attendance.plans=[plan('p1','2030-01-09T18:00','i1'),plan('p2','2030-01-08T18:00','i2')];attendance.steps=[step('a','p1',60),step('wait','p2',0,1440),step('c','p2',60,0,['wait'])];
  const att=O.optimize(attendance,['p1','p2'],options),fast=att.results.find(x=>x.type==='fastest'),reduced=att.results.find(x=>x.type==='attendanceReduced');

  const equipment=base();equipment.equipment=[{id:'eq',name:'Device',capacity:1,unavailablePeriods:[]}];equipment.plans=[plan('p1','2030-01-08T18:00','i1'),plan('p2','2030-01-08T18:00','i2')];const req=(monitor=false)=>[{equipmentId:'eq',equipmentName:'Device',occupancyMinutes:120,occupancyStartOffsetMinutes:0,occupancyEndOffsetMinutes:120,requiresContinuousMonitoring:monitor}];equipment.steps=[step('e1','p1',60,0,[],{worker:'w1',equipment:req()}),step('e2','p2',60,0,[],{worker:'w2',equipment:req()})];const eq=O.optimize(equipment,['p1','p2'],options).results[0];
  const eqOverlap=eq.feasible&&eq.equipmentReservations.some((a,i,all)=>all.some((b,j)=>j>i&&a.resourceId===b.resourceId&&new Date(a.startAt)<new Date(b.endAt)&&new Date(b.startAt)<new Date(a.endAt)));

  const monitoring=base();monitoring.equipment=[{id:'eq',name:'Device',capacity:1,unavailablePeriods:[]}];monitoring.plans=[plan('p1','2030-01-08T18:00','i1'),plan('p2','2030-01-08T18:00','i2')];monitoring.steps=[step('m1','p1',15,0,[],{worker:'w1',equipment:req(true)}),step('m2','p2',60,0,[],{worker:'w1'})];const mon=O.optimize(monitoring,['p1','p2'],options).results[0];const monitorReservation=mon.feasible&&mon.workerReservations.some(x=>x.kind==='monitoring');

  const noninterruptible=base();noninterruptible.plans=[plan('p1','2030-01-10T18:00','i1'),plan('p2','2030-01-10T18:00','i2')];noninterruptible.steps=[step('long','p1',600,0,[],{interruptible:false}),step('other','p2',15)];const non=O.optimize(noninterruptible,['p1','p2'],options).results[0];

  const home=base();home.availability.profiles.find(x=>x.locationType==='home').weekly.forEach(x=>x.enabled=x.dayOfWeek>=1&&x.dayOfWeek<=5);home.attendancePreferences=[{id:'no',date:'2030-01-07',type:'cannotVisit'}];home.plans=[plan('p1','2030-01-07T18:00','i1'),plan('p2','2030-01-08T18:00','i2')];home.steps=[step('home','p1',60,0,[],{location:'home'}),step('lab','p2',60)];const hom=O.optimize(home,['p1','p2'],options).results[0];

  const manual=base();manual.attendancePreferences=[{id:'no',date:'2030-01-07',type:'cannotVisit'}];manual.plans=[plan('p1','2030-01-08T18:00','i1'),plan('p2','2030-01-08T18:00','i2')];manual.steps=[step('fixed','p1',60,0,[],{manual:C.zonedLocalToIso('2030-01-07T10:00','Asia/Tokyo')}),step('other','p2',60)];const man=O.optimize(manual,['p1','p2'],options).results[0];

  const checks=base();checks.plans=[plan('p1','2030-01-08T18:00','i1'),plan('p2','2030-01-08T18:00','i2')];checks.steps=[step('check','p1',30,120,[],{waitCheck:true,interval:60,checkDuration:15}),step('other','p2',60)];const chk=O.optimize(checks,['p1','p2'],options).results[0];

  const completed=base();completed.plans=[plan('p1','2030-01-08T18:00','i1'),plan('p2','2030-01-08T18:00','i2')];completed.steps=[step('done','p1',60,0,[],{status:'\u5b8c\u4e86',actualStart:C.zonedLocalToIso('2030-01-07T09:00','Asia/Tokyo'),actualEnd:C.zonedLocalToIso('2030-01-07T10:00','Asia/Tokyo')}),step('after','p1',60,0,['done']),step('other','p2',30)];const done=O.optimize(completed,['p1','p2'],options).results[0],doneSchedule=done.stepSchedules.find(x=>x.stepId==='done'),afterSchedule=done.stepSchedules.find(x=>x.stepId==='after');

  const workers=base();workers.plans=[plan('p1','2030-01-08T18:00','i1'),plan('p2','2030-01-08T18:00','i2')];workers.steps=[step('w1a','p1',120),step('w1b','p2',120)];const wr=O.optimize(workers,['p1','p2'],options).results[0];const workerOverlap=wr.workerReservations.some((a,i,all)=>all.some((b,j)=>j>i&&a.resourceId===b.resourceId&&a.stepId!==b.stepId&&new Date(a.startAt)<new Date(b.endAt)&&new Date(b.startAt)<new Date(a.endAt)));

  const occupancy=base();occupancy.equipment=[{id:'eq1',name:'D1',capacity:1,unavailablePeriods:[]},{id:'eq2',name:'D2',capacity:1,unavailablePeriods:[]}];occupancy.plans=[plan('p1','2030-01-08T18:00','i1'),plan('p2','2030-01-08T18:00','i2')];occupancy.steps=[step('multi','p1',30,0,[],{equipment:[{equipmentId:'eq1',equipmentName:'D1',occupancyMinutes:180,occupancyStartOffsetMinutes:0,occupancyEndOffsetMinutes:180,requiresContinuousMonitoring:false},{equipmentId:'eq2',equipmentName:'D2',occupancyMinutes:180,occupancyStartOffsetMinutes:60,occupancyEndOffsetMinutes:240,requiresContinuousMonitoring:false}]}),step('other','p2',30)];const occ=O.optimize(occupancy,['p1','p2'],options).results[0],multi=occ.stepSchedules.find(x=>x.stepId==='multi');

  const limited=O.optimize(workers,['p1','p2'],{...options,maxMilliseconds:-1}).results[0];

  const old={...C.createEmptyData(),schemaVersion:3};old.workers=undefined;old.optimizationRuns=undefined;old.optimizationResults=undefined;old.attendancePreferences=undefined;const migration=C.migrateData(old);
  return {attendance:{feasible:fast.feasible&&reduced.feasible,fastDays:fast.metrics?.labVisitDays,reducedDays:reduced.metrics?.labVisitDays,deadlines:reduced.planResults?.every(x=>x.meetsDeadline)},equipment:{feasible:eq.feasible,overlap:eqOverlap},monitoring:{feasible:mon.feasible,reservation:monitorReservation},noninterruptible:{feasible:non.feasible,resolution:non.resolution,error:(non.errors||[])[0]},home:{feasible:hom.feasible,homeDay:hom.stepSchedules?.find(x=>x.stepId==='home')?.startAt},manual:{feasible:man.feasible,resolution:man.resolution},checks:{feasible:chk.feasible,required:chk.workerReservations?.some(x=>x.kind==='waitCheck'&&((new Date(x.endAt)-new Date(x.startAt))/60000)===15)},completed:{feasible:done.feasible,fixed:doneSchedule?.fixed,start:doneSchedule?.startAt,after:afterSchedule?.startAt,end:doneSchedule?.endAt},workers:{feasible:wr.feasible,overlap:workerOverlap},occupancy:{feasible:occ.feasible,count:multi?.equipmentReservations?.length,afterWork:multi&&new Date(multi.equipmentReservations[1].endAt)>new Date(multi.workEndAt)},limited:{feasible:limited.feasible,resolution:limited.resolution},migration:{valid:migration.valid,version:migration.data?.schemaVersion,worker:migration.data?.workers?.length,backupKey:C.migrationBackupKey(3)},snapshot:fast.inputSnapshot?.workers?.length};
})()
'@
  Add-Result 'Attendance-day optimization' ($optimizerCases.attendance.feasible -and $optimizerCases.attendance.reducedDays -lt $optimizerCases.attendance.fastDays -and $optimizerCases.attendance.deadlines) 'Reduced laboratory visit days without missing either deadline'
  Add-Result 'Equipment conflict avoidance' ($optimizerCases.equipment.feasible -and -not $optimizerCases.equipment.overlap) 'Prevented overlapping occupancy of the same equipment'
  Add-Result 'Continuous monitoring' ($optimizerCases.monitoring.feasible -and $optimizerCases.monitoring.reservation) 'Reserved the worker for monitored equipment occupancy'
  Add-Result 'Non-interruptible infeasibility' (-not $optimizerCases.noninterruptible.feasible -and $optimizerCases.noninterruptible.resolution -eq 'provenInfeasible' -and $optimizerCases.noninterruptible.error.Length -gt 0) 'Proved no continuous work window for a 600-minute step'
  Add-Result 'Home work on no-visit day' ($optimizerCases.home.feasible -and $optimizerCases.home.homeDay) 'Allowed home work while prohibiting laboratory attendance'
  Add-Result 'Manual start validation' (-not $optimizerCases.manual.feasible -and $optimizerCases.manual.resolution -eq 'provenInfeasible') 'Rejected a manual laboratory start on a cannot-visit day'
  Add-Result 'Mandatory periodic checks' ($optimizerCases.checks.feasible -and $optimizerCases.checks.required) 'Scheduled required 15-minute wait check as worker reservation'
  Add-Result 'Completed-step fixation' ($optimizerCases.completed.feasible -and $optimizerCases.completed.fixed -and $optimizerCases.completed.after -ge $optimizerCases.completed.end) 'Kept completed actuals fixed and scheduled successor afterward'
  Add-Result 'Worker conflict avoidance' ($optimizerCases.workers.feasible -and -not $optimizerCases.workers.overlap) 'Prevented overlapping work assigned to the same worker'
  Add-Result 'Independent multi-equipment occupancy' ($optimizerCases.occupancy.feasible -and $optimizerCases.occupancy.count -eq 2 -and $optimizerCases.occupancy.afterWork) 'Reserved multiple devices independently beyond worker task completion'
  Add-Result 'Search-limit classification' (-not $optimizerCases.limited.feasible -and $optimizerCases.limited.resolution -eq 'searchLimit') 'Distinguished exhausted search time from proven infeasibility'
  Add-Result 'V3 to V4 migration model' ($optimizerCases.migration.valid -and $optimizerCases.migration.version -eq 4 -and $optimizerCases.migration.worker -ge 1 -and $optimizerCases.migration.backupKey -like '*.v3') 'Preserved v3 data and supplied v4 defaults and backup key'
  Add-Result 'Optimization input snapshot' ($optimizerCases.snapshot -ge 1) 'Stored workers and settings with generated result'

  $optimizationUi = Invoke-Js @'
(async()=>{
  document.querySelector('[data-view="optimization"]').click();
  document.querySelectorAll('#optimizationPlanOptions input[type="checkbox"]').forEach(x=>x.checked=true);
  document.querySelectorAll('#optimizationPlanOptions input[type="datetime-local"]').forEach((x,i)=>x.value=i===0?'2027-04-01T18:00':'2027-04-02T18:00');
  const before=JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY)).confirmedOptimizationResultId;
  document.getElementById('runOptimizationButton').click();
  for(let i=0;i<100&&!document.querySelector('.optimization-result');i++)await new Promise(r=>setTimeout(r,50));
  const mid=JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY));
  const cards=document.querySelectorAll('.optimization-result').length,runCount=mid.optimizationRuns.length,resultCount=mid.optimizationResults.length,stillUnconfirmed=mid.confirmedOptimizationResultId===before;
  const confirm=document.querySelector('.optimization-result:not(.infeasible) [data-action="confirm-optimization"]');if(confirm){confirm.click();document.querySelector('#confirmDialog button[value="confirm"]').click();await new Promise(r=>setTimeout(r,100));}
  const after=JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY));
  return {cards,runCount,resultCount,stillUnconfirmed,confirmed:!!after.confirmedOptimizationResultId,calendarDays:document.querySelectorAll('.optimization-calendar-day').length,ganttRows:document.querySelectorAll('.optimization-visual .gantt-row').length};
})()
'@
  Add-Result 'Optimization UI and confirmation' ($optimizationUi.cards -eq 2 -and $optimizationUi.runCount -ge 1 -and $optimizationUi.resultCount -ge 2 -and $optimizationUi.stillUnconfirmed -and $optimizationUi.confirmed -and $optimizationUi.calendarDays -ge 42 -and $optimizationUi.ganttRows -ge 4) 'Rendered comparison visuals and changed confirmed plan only after explicit confirmation'

  $progressImpact = Invoke-Js @'
(() => {
  document.querySelector('[data-view="plans"]').click();
  const firstPlan=document.querySelector('#planList [data-owner-type="plan"]');
  firstPlan.querySelector('[data-action="progress-step"]').click();
  const impact=document.getElementById('progressImpact'),result={visible:!impact.hidden,text:impact.textContent};
  document.getElementById('progressDialog').close();return result;
})()
'@
  Add-Result 'Progress impact preview' ($progressImpact.visible -and $progressImpact.text.Length -gt 0) 'Displayed affected successor steps before saving progress changes'

  $results | Format-Table -AutoSize | Out-String -Width 240 | Write-Output
  Write-Output "ALL_TESTS_PASSED=$($results.Count)"
}
finally {
  if ($socket -and $socket.State -eq [Net.WebSockets.WebSocketState]::Open) {
    try { [void](Invoke-Cdp 'Browser.close') } catch {}
    try { $socket.Dispose() } catch {}
  }
  if ($browser -and -not $browser.HasExited) { try { Stop-Process -Id $browser.Id -Force } catch {} }
  Start-Sleep -Milliseconds 500
  if (Test-Path -LiteralPath $profilePath) {
    $resolvedProfile = (Resolve-Path -LiteralPath $profilePath).Path
    if ($resolvedProfile.StartsWith($projectRoot + '\') -and (Split-Path -Leaf $resolvedProfile) -eq '.e2e-profile') {
      for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try { Remove-Item -LiteralPath $resolvedProfile -Recurse -Force -ErrorAction Stop; break } catch { Start-Sleep -Milliseconds 300 }
      }
    }
  }
}
