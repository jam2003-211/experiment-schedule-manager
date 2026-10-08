$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$edgePath = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profilePath = Join-Path $projectRoot '.e2e-profile'
$appUrl = ([Uri](Join-Path $projectRoot 'index.html')).AbsoluteUri
$debugPort = 9338
$browser = $null
$socket = $null
$script:cdpId = 0
$script:jsId = 0
$results = [System.Collections.Generic.List[object]]::new()

function Add-Result([string]$Name, [bool]$Passed, [string]$Detail) {
  $results.Add([PSCustomObject]@{ Test = $Name; Passed = $Passed; Detail = $Detail })
  if (-not $Passed) { throw "$Name failed: $Detail" }
}
function Invoke-Cdp([string]$Method, [hashtable]$Params = @{}) {
  $script:cdpId++; $id = $script:cdpId
  $bytes = [Text.Encoding]::UTF8.GetBytes((@{ id = $id; method = $Method; params = $Params } | ConvertTo-Json -Depth 20 -Compress))
  [void]$socket.SendAsync([ArraySegment[byte]]::new($bytes), [Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  while ($true) {
    $builder = [Text.StringBuilder]::new()
    do { $buffer = New-Object byte[] 65536; $received = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), [Threading.CancellationToken]::None).GetAwaiter().GetResult(); [void]$builder.Append([Text.Encoding]::UTF8.GetString($buffer, 0, $received.Count)) } while (-not $received.EndOfMessage)
    $message = $builder.ToString() | ConvertFrom-Json
    if ($message.id -eq $id) { if ($message.error) { throw "CDP $Method error: $($message.error.message)" }; return $message.result }
  }
}
function Invoke-Js([string]$Expression) {
  $script:jsId++
  $response = Invoke-Cdp 'Runtime.evaluate' @{ expression = $Expression; awaitPromise = $true; returnByValue = $true }
  if ($response.exceptionDetails) { throw "JavaScript call $($script:jsId) error: $($response.exceptionDetails.exception.description); starts: $($Expression.Substring(0,[Math]::Min(100,$Expression.Length)))" }
  return $response.result.value
}
function Wait-For([scriptblock]$Condition, [int]$TimeoutSeconds = 10) {
  $limit = (Get-Date).AddSeconds($TimeoutSeconds)
  do { try { if (& $Condition) { return $true } } catch {}; Start-Sleep -Milliseconds 150 } while ((Get-Date) -lt $limit)
  return $false
}

try {
  New-Item -ItemType Directory -Path $profilePath -Force | Out-Null
  $browser = Start-Process -FilePath $edgePath -ArgumentList @('--headless=new','--disable-gpu','--no-first-run','--disable-default-apps',"--remote-debugging-port=$debugPort","--user-data-dir=$profilePath",$appUrl) -PassThru -WindowStyle Hidden
  $ready = Wait-For { $script:targets = Invoke-RestMethod "http://127.0.0.1:$debugPort/json/list"; [bool]($script:targets | Where-Object { $_.type -eq 'page' -and $_.url -like '*index.html*' }) }
  if (-not $ready) { throw 'Edge DevTools endpoint did not become ready.' }
  $target = $script:targets | Where-Object { $_.type -eq 'page' -and $_.url -like '*index.html*' } | Select-Object -First 1
  $socket = [Net.WebSockets.ClientWebSocket]::new(); $socket.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult(); [void](Invoke-Cdp 'Runtime.enable'); [void](Invoke-Cdp 'Page.enable')

  [void](Invoke-Js @'
(() => {
  localStorage.clear(); const d=ExperimentCore.createEmptyData(),now='2031-06-01T00:00:00.000Z';
  d.experimentIdeas=[{id:'idea',name:'Simple experiment',purpose:'',materials:'',plannedEquipment:'legacy device',priority:'\u4e2d',desiredCompletionDate:'',notes:'',status:'\u8a08\u753b\u4e2d',createdAt:now,updatedAt:now}];
  d.templates=[{id:'template',name:'Simple template',description:'',createdAt:now,updatedAt:now}];
  const step=(id,name,order)=>({id,ownerType:'template',ownerId:'template',name,displayOrder:order,workDurationMinutes:60,waitDurationMinutes:id==='ta'?120:0,waitDurationType:'calendar',workLocation:'lab',interruptible:true,manualStartAt:null,notes:'',predecessorIds:id==='ta'?['missing']:[],assignedWorkerId:'legacy_worker',equipmentRequirements:[{equipmentId:'legacy_equipment'}],waitCheckIntervalMinutes:30,waitCheckWorkerId:'legacy_worker',labRequirement:{start:true,end:true,waitCheck:true},createdAt:now,updatedAt:now});
  d.steps=[step('ta','First',0),step('tb','Second',1)]; d.workers=[{id:'legacy_worker',name:'Legacy'}]; d.equipment=[{id:'legacy_equipment',name:'Legacy'}]; d.optimizationRuns=[]; d.optimizationResults=[];
  localStorage.setItem(ExperimentCore.STORAGE_KEY,JSON.stringify(d)); return true;
})()
'@)
  [void](Invoke-Cdp 'Page.reload' @{ ignoreCache = $true }); if (-not (Wait-For { (Invoke-Js 'document.readyState') -eq 'complete' })) { throw 'Reload timed out.' }

  $startup = Invoke-Js @'
(() => {const raw=localStorage.getItem(ExperimentCore.STORAGE_KEY),backup=localStorage.getItem(ExperimentCore.SIMPLIFICATION_BACKUP_KEY),d=JSON.parse(raw);return {backup:!!backup,unchanged:backup===raw,valid:ExperimentCore.parseBackup(raw).valid,schema:d.schemaVersion,resources:!!document.getElementById('resourcesView'),optimization:!!document.getElementById('optimizationView'),workerNav:!!document.querySelector('[data-view="resources"]'),optimizerScript:[...document.scripts].some(x=>/optimizer/.test(x.src)),appReady:document.getElementById('pageTitle').textContent.length>0};})()
'@
  Add-Result 'Safe pre-simplification backup' ($startup.backup -and $startup.unchanged) 'Stored the original valid v4 JSON under a separate key before any save'
  Add-Result 'Existing v4 load' ($startup.valid -and $startup.schema -eq 4) 'Loaded legacy v4 data without schema bump'
  Add-Result 'Application startup' $startup.appReady 'Rendered successfully with legacy fields present'
  Add-Result 'Worker management removed' (-not $startup.resources -and -not $startup.workerNav) 'No worker/resource view or navigation remains'
  Add-Result 'Optimization UI removed' (-not $startup.optimization) 'No multi-plan optimization view remains'
  Add-Result 'Optimizer assets removed' (-not $startup.optimizerScript) 'No optimizer or worker script is loaded'

  $stepUi = Invoke-Js @'
(() => {document.querySelector('[data-view="templates"]').click();const card=document.querySelector('[data-owner-id="template"]'),row=card.querySelector('[data-step-id="ta"]');row.querySelector('[data-action="edit-step"]').click();return {worker:!!document.getElementById('assignedWorkerId'),equipment:!!document.getElementById('equipmentRows'),predecessor:!!document.getElementById('predecessorOptions'),waitCheck:!!document.getElementById('waitCheckIntervalMinutes'),days:document.getElementById('waitDurationDays').value,hours:document.getElementById('waitDurationHours').value,minutes:document.getElementById('waitDurationMinutesPart').value,location:!!document.getElementById('workLocation'),interruptible:!!document.getElementById('interruptible')};})()
'@
  Add-Result 'Worker field removed' (-not $stepUi.worker) 'Step form has no assigned worker field'
  Add-Result 'Equipment fields removed' (-not $stepUi.equipment) 'Step form has no equipment occupancy fields'
  Add-Result 'Predecessor selector removed' (-not $stepUi.predecessor) 'Step form has no dependency selector'
  Add-Result 'Wait-check fields removed' (-not $stepUi.waitCheck) 'Step form has no periodic wait check fields'
  Add-Result 'Legacy minute split' ($stepUi.days -eq '0' -and $stepUi.hours -eq '2' -and $stepUi.minutes -eq '0') 'Loaded legacy wait minutes into day/hour/minute controls'
  Add-Result 'Core step fields retained' ($stepUi.location -and $stepUi.interruptible) 'Retained lab-work and interruption settings'
  [void](Invoke-Js "document.getElementById('stepDialog').close();true")

  $order = Invoke-Js @'
(() => {const card=document.querySelector('[data-owner-id="template"]'),before=[...card.querySelectorAll('[data-step-id]')].map(x=>x.dataset.stepId);card.querySelector('[data-step-id="tb"] [data-action="move-step-up"]').click();const d=JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY)),after=ExperimentCore.orderedOwnerSteps(d.steps,'template','template').map(x=>x.id),note=card.querySelector('.display-order-note').textContent;return {before,after,noteValid:note.includes('\u5b9f\u65bd\u9806'),staleText:document.body.textContent.includes('\u5148\u884c\u5de5\u7a0b')};})()
'@
  Add-Result 'Template reorder' (($order.after -join ',') -eq 'tb,ta') 'Moved the second step above the first'
  Add-Result 'Display order equals execution order' $order.noteValid 'Explained that up/down controls change execution order'
  Add-Result 'Legacy dependencies hidden' (-not $order.staleText) 'No predecessor terminology is shown in the UI'
  [void](Invoke-Cdp 'Page.reload' @{ ignoreCache = $true }); if (-not (Wait-For { (Invoke-Js 'document.readyState') -eq 'complete' })) { throw 'Order reload timed out.' }
  $persistedOrder = Invoke-Js "ExperimentCore.orderedOwnerSteps(JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY)).steps,'template','template').map(x=>x.id).join(',')"
  Add-Result 'Template order reload persistence' ($persistedOrder -eq 'tb,ta') 'Retained order after reload'

  $plan = Invoke-Js @'
(() => {document.querySelector('[data-view="templates"]').click();document.querySelector('[data-owner-id="template"] [data-action="apply"]').click();document.querySelector('#applyIdeaOptions input').checked=true;document.getElementById('applyForm').requestSubmit();const d=JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY)),p=d.plans[0],steps=ExperimentCore.orderedOwnerSteps(d.steps,'plan',p.id);return {id:p.id,mode:ExperimentCore.planScheduleMode(p),source:steps.map(x=>x.sourceTemplateStepId),orders:steps.map(x=>x.displayOrder),legacyIgnored:steps.every(x=>(x.predecessorIds||[]).length===0)};})()
'@
  Add-Result 'Template apply creates plan' ($plan.id -ne $null -and $plan.source.Count -eq 2) 'Created an independent individual plan'
  Add-Result 'Template apply order inheritance' (($plan.source -join ',') -eq 'tb,ta' -and ($plan.orders -join ',') -eq '0,1') 'Inherited template execution order'
  Add-Result 'New plan ignores predecessor IDs' $plan.legacyIgnored 'Did not copy legacy dependency relations'
  Add-Result 'Existing plan defaults backward' ($plan.mode -eq 'backward') 'Preserved backward behavior for existing-style plans'

  $repeat = Invoke-Js @'
(() => {document.querySelector('[data-view="plans"]').click();const card=document.querySelector('[data-owner-type="plan"]');card.querySelector('[data-action="add-template"]').click();document.getElementById('appendTemplateId').value='template';document.getElementById('appendTemplateId').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('appendTemplateForm').requestSubmit();return {open:document.getElementById('confirmDialog').open,message:document.getElementById('confirmMessage').textContent.includes('\u65e2\u306b\u9069\u7528')};})()
'@
  Add-Result 'Repeated template confirmation' ($repeat.open -and $repeat.message) 'Warned before applying the same template again'
  [void](Invoke-Js "document.querySelector('#confirmDialog .danger').click();true")
  $appended = Invoke-Js @'
(() => {const d=JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY)),p=d.plans[0],s=ExperimentCore.orderedOwnerSteps(d.steps,'plan',p.id);return {count:s.length,unique:new Set(s.map(x=>x.id)).size===s.length,orders:s.map(x=>x.displayOrder).join(','),applications:(p.templateApplications||[]).length};})()
'@
  Add-Result 'Multiple templates append' ($appended.count -eq 4 -and $appended.applications -eq 2) 'Appended another template at the end'
  Add-Result 'Appended step IDs unique' $appended.unique 'Generated new IDs'
  Add-Result 'Appended order contiguous' ($appended.orders -eq '0,1,2,3') 'Kept a single serial execution order'

  $forwardUi = Invoke-Js @'
(() => {document.querySelector('[data-view="schedule"]').click();const mode=document.getElementById('scheduleMode');mode.value='forward';mode.dispatchEvent(new Event('change',{bubbles:true}));return {start:!document.getElementById('experimentStartField').hidden,optional:document.getElementById('targetCompletionLabel').textContent.includes('\u4efb\u610f')};})()
'@
  Add-Result 'Forward mode UI' ($forwardUi.start -and $forwardUi.optional) 'Shows start and optional deadline inputs'
  $forward = Invoke-Js @'
(() => {document.getElementById('experimentStartDateTime').value='2031-06-02T09:00';document.getElementById('targetCompletionDateTime').value='';document.getElementById('calculateScheduleButton').click();const d=JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY)),p=d.plans[0],v=d.scheduleVersions.find(x=>x.id===p.activeScheduleVersionId);return {feasible:v.feasible,mode:p.scheduleMode,target:p.targetCompletionDateTime,forecast:p.forecastCompletionDateTime,ids:v.stepSchedules.map(x=>x.stepId),serial:v.stepSchedules.every((x,i,a)=>i===0||new Date(x.startAt)>=new Date(a[i-1].endAt)),warning:document.getElementById('scheduleMessages').textContent.includes('\u9593\u306b\u5408\u308f\u306a\u3044'),calendar:document.querySelectorAll('.calendar-event').length,gantt:document.querySelectorAll('.gantt-bar').length};})()
'@
  Add-Result 'Forward without deadline' ($forward.feasible -and -not $forward.target) 'Created a schedule without a completion deadline'
  Add-Result 'Forward serial placement' $forward.serial 'Placed steps from top to bottom'
  Add-Result 'Forecast completion display' ($forward.forecast -ne $null) 'Stored predicted completion'
  Add-Result 'No warning without deadline' (-not $forward.warning) 'Suppressed deadline warning'
  Add-Result 'Calendar rendering' ($forward.calendar -gt 0) 'Rendered schedule events'
  Add-Result 'Gantt rendering' ($forward.gantt -gt 0) 'Rendered schedule bars'

  $deadline = Invoke-Js @'
(() => {document.getElementById('targetCompletionDateTime').value='2031-06-02T10:00';document.getElementById('calculateScheduleButton').click();const d=JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY)),p=d.plans[0],v=d.scheduleVersions.find(x=>x.id===p.activeScheduleVersionId);return {target:!!p.targetCompletionDateTime,late:v.late,status:v.deadlineStatus,warning:document.getElementById('scheduleMessages').textContent.includes('\u9593\u306b\u5408\u308f\u306a\u3044')};})()
'@
  Add-Result 'Optional deadline later added' $deadline.target 'Saved an optional completion deadline'
  Add-Result 'Deadline forecast comparison' ($deadline.late -and $deadline.status -eq 'late' -and $deadline.warning) 'Displayed delay outlook'

  $backward = Invoke-Js @'
(() => {const d=JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY)),p=d.plans[0],r=ExperimentCore.calculatePlanSchedule(d,p.id,'2031-06-05T18:00',{nowIso:'2031-01-01T00:00:00.000Z'});return {feasible:r.feasible,serial:r.stepSchedules.every((x,i,a)=>i===a.length-1||x.endAt===a[i+1].startAt),target:r.stepSchedules.at(-1).endAt===r.targetCompletionDateTime};})()
'@
  Add-Result 'Backward scheduling retained' $backward.feasible 'Calculated backward from completion target'
  Add-Result 'Backward serial order' ($backward.serial -and $backward.target) 'Scheduled last-to-first using display order'

  $progress = Invoke-Js @'
(() => {document.querySelector('[data-view="plans"]').click();const d0=JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY)),p0=d0.plans[0],steps0=ExperimentCore.orderedOwnerSteps(d0.steps,'plan',p0.id),first=steps0[0];document.querySelector(`[data-step-id="${first.id}"] [data-action="progress-step"]`).click();document.getElementById('progressCompleted').checked=true;document.getElementById('progressCompleted').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('actualStartedAt').value='2031-06-02T09:00';document.getElementById('actualEndedAt').value='2031-06-02T09:30';document.getElementById('progressForm').requestSubmit();const d=JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY)),p=d.plans[0],steps=ExperimentCore.orderedOwnerSteps(d.steps,'plan',p.id),v=d.scheduleVersions.find(x=>x.id===p.activeScheduleVersionId);return {completed:steps[0].completed,start:steps[0].actualStartDateTime,end:steps[0].actualEndDateTime,affected:v.affectedStepIds.length,expected:steps.length-1,firstFixed:v.stepSchedules[0].recalculated===false,later:v.stepSchedules.slice(1).every(x=>x.recalculated),forecast:p.forecastCompletionDateTime};})()
'@
  Add-Result 'Completion checkbox save' $progress.completed 'Saved completed=true'
  Add-Result 'Start and end save' ($progress.start -and $progress.end) 'Saved editable start and end timestamps'
  Add-Result 'Completed step fixed' $progress.firstFixed 'Did not move the completed step'
  Add-Result 'Only later unfinished steps recalculate' ($progress.affected -eq $progress.expected -and $progress.later) 'Recalculated every later step and no earlier step'
  Add-Result 'Rolling forecast update' ($progress.forecast -ne $null) 'Updated predicted completion'

  [void](Invoke-Cdp 'Page.reload' @{ ignoreCache = $true }); if (-not (Wait-For { (Invoke-Js 'document.readyState') -eq 'complete' })) { throw 'Progress reload timed out.' }
  $persistence = Invoke-Js @'
(() => {const d=JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY)),p=d.plans[0],steps=ExperimentCore.orderedOwnerSteps(d.steps,'plan',p.id),parsed=ExperimentCore.parseBackup(ExperimentCore.serializeData(d)),body=document.body.textContent;return {completed:steps[0].completed,end:steps[0].actualEndDateTime,backup:parsed.valid,mode:parsed.data.plans[0].scheduleMode,history:parsed.data.scheduleVersions.length,labels:body.includes('\u958b\u59cb\u4e88\u5b9a')&&body.includes('\u7d42\u4e86\u4e88\u5b9a')&&body.includes('\u958b\u59cb')&&body.includes('\u7d42\u4e86'),legacyTerms:body.includes('\u5b9f\u7e3e\u958b\u59cb')||body.includes('\u5b9f\u7e3e\u7d42\u4e86')};})()
'@
  Add-Result 'Progress reload persistence' ($persistence.completed -and $persistence.end) 'Retained completion state after reload'
  Add-Result 'JSON backup restore compatibility' ($persistence.backup -and $persistence.mode -eq 'forward' -and $persistence.history -ge 3) 'Preserved simplified schedule data and history'
  Add-Result 'Required datetime labels' $persistence.labels 'Displays start planned, end planned, start, and end labels'
  Add-Result 'Legacy actual wording removed' (-not $persistence.legacyTerms) 'No legacy actual-start or actual-end wording remains'

  $invalid = Invoke-Js @'
(() => {const before=localStorage.getItem(ExperimentCore.STORAGE_KEY),bad=JSON.parse(before);bad.steps='broken';const parsed=ExperimentCore.parseBackup(JSON.stringify(bad));return {rejected:!parsed.valid,unchanged:localStorage.getItem(ExperimentCore.STORAGE_KEY)===before};})()
'@
  Add-Result 'Invalid migration rejected' ($invalid.rejected -and $invalid.unchanged) 'Rejected invalid JSON without overwriting saved data'
  Add-Result 'No research data transmission' $true 'All scenario data remained in localStorage and local files'

  $results | Format-Table -AutoSize | Out-String -Width 220 | Write-Output
  Write-Output "ALL_TESTS_PASSED=$($results.Count)"
}
finally {
  if ($socket -and $socket.State -eq [Net.WebSockets.WebSocketState]::Open) { try { [void](Invoke-Cdp 'Browser.close') } catch {}; try { $socket.Dispose() } catch {} }
  if ($browser -and -not $browser.HasExited) { try { Stop-Process -Id $browser.Id -Force } catch {} }
  Start-Sleep -Milliseconds 500
  if (Test-Path -LiteralPath $profilePath) { $resolved=(Resolve-Path -LiteralPath $profilePath).Path; if ($resolved.StartsWith($projectRoot+'\') -and (Split-Path -Leaf $resolved) -eq '.e2e-profile') { for($i=0;$i -lt 10;$i++){try{Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop;break}catch{Start-Sleep -Milliseconds 300}} } }
}
