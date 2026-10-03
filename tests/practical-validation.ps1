$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$edgePath = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profilePath = Join-Path $projectRoot '.practical-profile'
$serverScript = Join-Path $PSScriptRoot 'local-server.ps1'
$port = 8765
$debugPort = 9341
$server = $null; $browser = $null; $socket = $null
$script:cdpId = 0

function Invoke-Cdp([string]$Method, [hashtable]$Params = @{}) {
  $script:cdpId++
  $payload = @{ id = $script:cdpId; method = $Method; params = $Params } | ConvertTo-Json -Depth 30 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  [void]$socket.SendAsync([ArraySegment[byte]]::new($bytes), [Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  while ($true) {
    $builder = [Text.StringBuilder]::new()
    do {
      $buffer = New-Object byte[] 131072
      $received = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), [Threading.CancellationToken]::None).GetAwaiter().GetResult()
      [void]$builder.Append([Text.Encoding]::UTF8.GetString($buffer, 0, $received.Count))
    } while (-not $received.EndOfMessage)
    $message = $builder.ToString() | ConvertFrom-Json
    if ($message.id -eq $script:cdpId) {
      if ($message.error) { throw "CDP $Method error: $($message.error.message)" }
      return $message.result
    }
  }
}
function Invoke-Js([string]$Expression) {
  $response = Invoke-Cdp 'Runtime.evaluate' @{ expression = $Expression; awaitPromise = $true; returnByValue = $true }
  if ($response.exceptionDetails) { throw "JavaScript error: $($response.exceptionDetails.exception.description)" }
  return $response.result.value
}
function Wait-For([scriptblock]$Condition, [int]$Seconds = 15) {
  $until = (Get-Date).AddSeconds($Seconds)
  do { try { if (& $Condition) { return $true } } catch {}; Start-Sleep -Milliseconds 100 } while ((Get-Date) -lt $until)
  return $false
}

try {
  if (-not (Test-Path -LiteralPath $edgePath)) { throw 'Microsoft Edge was not found.' }
  if (Test-Path -LiteralPath $profilePath) {
    $resolved = (Resolve-Path -LiteralPath $profilePath).Path
    if (-not ($resolved.StartsWith($projectRoot + '\') -and (Split-Path -Leaf $resolved) -eq '.practical-profile')) { throw 'Unsafe practical profile path.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
  New-Item -ItemType Directory -Path $profilePath | Out-Null
  $serverOut = Join-Path $profilePath 'server.out.log'; $serverErr = Join-Path $profilePath 'server.err.log'
  $server = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$serverScript,'-Root',$projectRoot,'-Port',$port) -PassThru -WindowStyle Hidden -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr
  if (-not (Wait-For { try { (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/index.html" -TimeoutSec 1).StatusCode -eq 200 } catch { $false } })) { $detail = if (Test-Path -LiteralPath $serverErr) { Get-Content -LiteralPath $serverErr -Raw } else { '' }; throw "Local HTTP server did not start. $detail" }
  $browser = Start-Process -FilePath $edgePath -ArgumentList @('--headless=new','--disable-gpu','--no-first-run','--disable-default-apps',"--remote-debugging-port=$debugPort", "--user-data-dir=$profilePath", "http://127.0.0.1:$port/index.html") -PassThru -WindowStyle Hidden
  $targets = $null
  if (-not (Wait-For { $script:targets = Invoke-RestMethod "http://127.0.0.1:$debugPort/json/list"; [bool]($script:targets | Where-Object { $_.type -eq 'page' -and $_.url -like "http://127.0.0.1:$port/*" }) })) { throw 'Edge DevTools endpoint did not start.' }
  $target = $script:targets | Where-Object { $_.type -eq 'page' -and $_.url -like "http://127.0.0.1:$port/*" } | Select-Object -First 1
  $socket = [Net.WebSockets.ClientWebSocket]::new(); $socket.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult(); [void](Invoke-Cdp 'Runtime.enable')

  $report = Invoke-Js @'
(async () => {
  const sampleText = await fetch('/tests/fixtures/practical-research-sample-v4.json', {cache:'no-store'}).then(r => r.text());
  const validatorSource = await fetch('/tests/practical-validator.js', {cache:'no-store'}).then(r => r.text());
  (0, eval)(validatorSource);
  const sample = JSON.parse(sampleText), planIds = sample.plans.map(x => x.id), options = {nowIso:'2031-06-02T00:00:00.000Z',granularityMinutes:15,maxMilliseconds:20000};
  const schema = ExperimentCore.parseBackup(sampleText);
  if (!schema.valid) throw new Error('Sample schema invalid: '+schema.errors.join('; '));

  const started = performance.now(), output = ExperimentOptimizer.optimize(sample, planIds, options), elapsed = performance.now() - started;
  const fastest = output.results.find(x => x.type === 'fastest'), attendance = output.results.find(x => x.type === 'attendanceReduced');
  const independentFastest = PracticalValidator.validate(sample, fastest), independentAttendance = PracticalValidator.validate(sample, attendance);

  const saved = JSON.parse(JSON.stringify(sample)); saved.optimizationRuns.push(output.run); saved.optimizationResults.push(...output.results);
  const backupText = ExperimentCore.serializeData(saved), restored = ExperimentCore.parseBackup(backupText), corrupt = JSON.parse(backupText); corrupt.steps = 'broken';
  const invalidRestore = ExperimentCore.parseBackup(JSON.stringify(corrupt));

  const exactScenario = {
    slots:[{date:'2031-06-02'},{date:'2031-06-02'},{date:'2031-06-02'},{date:'2031-06-03'}],
    deadlineSlots:{small_a:4,small_b:4},
    tasks:[
      {id:'small_a1',planId:'small_a',durationSlots:1,predecessorIds:[],workerId:'small_worker',equipmentId:'small_eq1',requiresLab:true},
      {id:'small_a2',planId:'small_a',durationSlots:1,predecessorIds:['small_a1'],workerId:'small_worker',equipmentId:'small_eq2',requiresLab:true},
      {id:'small_b1',planId:'small_b',durationSlots:1,predecessorIds:[],workerId:'small_worker',equipmentId:'small_eq2',requiresLab:true}
    ]
  };
  const exact = PracticalValidator.exactSolve(exactScenario);
  const small = ExperimentCore.createEmptyData();
  small.availability.profiles.find(x=>x.locationType==='lab').weekly.forEach(day=>{day.enabled=false;day.startTime='09:00';day.endTime='12:00';});
  const lab=small.availability.profiles.find(x=>x.locationType==='lab');lab.weekly.find(x=>x.dayOfWeek===1).enabled=true;lab.weekly.find(x=>x.dayOfWeek===2).enabled=true;lab.weekly.find(x=>x.dayOfWeek===2).endTime='10:00';
  small.workers=[{id:'small_worker',name:'Small',labAvailabilityProfileId:'profile_lab',homeAvailabilityProfileId:'profile_home',unavailablePeriods:[],active:true}];
  small.equipment=[{id:'small_eq1',name:'E1',capacity:1,unavailablePeriods:[]},{id:'small_eq2',name:'E2',capacity:1,unavailablePeriods:[]}];
  small.experimentIdeas=[{id:'small_i1',name:'A',priority:'\u9ad8',status:'\u8a08\u753b\u4e2d'},{id:'small_i2',name:'B',priority:'\u4e2d',status:'\u8a08\u753b\u4e2d'}];
  small.plans=[{id:'small_a',name:'A',experimentIdeaId:'small_i1',targetCompletionDateTime:'2031-06-03T01:00:00.000Z'},{id:'small_b',name:'B',experimentIdeaId:'small_i2',targetCompletionDateTime:'2031-06-03T01:00:00.000Z'}];
  const makeSmall=(id,owner,preds,equipment)=>({id,ownerType:'plan',ownerId:owner,name:id,workDurationMinutes:60,waitDurationMinutes:0,waitDurationType:'calendar',predecessorIds:preds,labRequirement:{start:true,end:true,waitCheck:false},waitCheckIntervalMinutes:0,waitCheckDurationMinutes:0,waitCheckWorkerId:'small_worker',waitCheckRequiresLab:false,assignedWorkerId:'small_worker',workLocation:'lab',interruptible:false,manualStartAt:null,equipmentRequirements:[{equipmentId:equipment,equipmentName:equipment,occupancyMinutes:60,occupancyStartOffsetMinutes:0,occupancyEndOffsetMinutes:60,requiresContinuousMonitoring:false}],notes:'',status:'\u672a\u7740\u624b',remainingWorkMinutes:60,actualStartedAt:null,actualEndedAt:null,actualSegments:[]});
  small.steps=[makeSmall('small_a1','small_a',[],'small_eq1'),makeSmall('small_a2','small_a',['small_a1'],'small_eq2'),makeSmall('small_b1','small_b',[],'small_eq2')];
  const heuristic = ExperimentOptimizer.optimize(small,['small_a','small_b'],{nowIso:'2031-06-02T00:00:00.000Z',granularityMinutes:60,maxMilliseconds:5000});
  const hf=heuristic.results.find(x=>x.type==='fastest'),ha=heuristic.results.find(x=>x.type==='attendanceReduced');
  const boundaries=['2031-06-02T01:00:00.000Z','2031-06-02T02:00:00.000Z','2031-06-02T03:00:00.000Z','2031-06-03T01:00:00.000Z'];
  const heuristicMakespan=boundaries.indexOf(hf.metrics.makespan)+1;

  const workerStarted=performance.now();
  const workerResult=await new Promise((resolve,reject)=>{const worker=new Worker('/optimizer-worker.js');const timer=setTimeout(()=>{worker.terminate();reject(new Error('Worker timeout'));},30000);worker.onmessage=e=>{clearTimeout(timer);worker.terminate();e.data.ok?resolve(e.data.output):reject(new Error(e.data.error));};worker.onerror=e=>{clearTimeout(timer);worker.terminate();reject(new Error(e.message));};worker.postMessage({data:sample,planIds,options});});
  const workerElapsed=performance.now()-workerStarted;

  return {
    isolation:{protocol:location.protocol,temporaryProfile:true,sampleIdeas:sample.experimentIdeas.length,samplePlans:sample.plans.length},
    sample:{plans:sample.plans.map(p=>({name:p.name,deadline:p.targetCompletionDateTime})),steps:sample.steps.length,holiday:sample.availability.holidays[0].date,preferOff:sample.attendancePreferences.find(x=>x.type==='preferOff').date},
    optimization:{elapsedMilliseconds:Math.round(elapsed),fastest:{feasible:fastest.feasible,makespan:fastest.metrics?.makespan,visitDays:fastest.metrics?.labVisitDays,visitDates:fastest.labVisitDates,preferOffDays:fastest.metrics?.preferOffVisitDays,plans:fastest.planResults},attendance:{feasible:attendance.feasible,makespan:attendance.metrics?.makespan,visitDays:attendance.metrics?.labVisitDays,visitDates:attendance.labVisitDates,preferOffDays:attendance.metrics?.preferOffVisitDays,plans:attendance.planResults},savedSnapshots:output.results.every(x=>x.inputSnapshot?.availability&&x.inputSnapshot?.workers)},
    independent:{fastest:independentFastest,attendance:independentAttendance},
    exact:{evaluated:exact.evaluated,feasibleCount:exact.feasibleCount,exactMakespan:exact.fastest?.makespan,heuristicMakespan,exactVisitDays:exact.attendance?.visitDays,heuristicVisitDays:ha.metrics?.labVisitDays,fastestGap:heuristicMakespan-exact.fastest.makespan,visitDayGap:ha.metrics.labVisitDays-exact.attendance.visitDays},
    worker:{available:typeof Worker==='function',calculationOk:workerResult.results.every(x=>x.feasible),elapsedMilliseconds:Math.round(workerElapsed)},
    backup:{sampleAccepted:schema.valid,serializedAccepted:restored.valid,runsRestored:restored.data?.optimizationRuns?.length,resultsRestored:restored.data?.optimizationResults?.length,invalidRejected:!invalidRestore.valid,originalUnchanged:sample.steps.length===9}
  };
})()
'@

  [void](Invoke-Js "fetch('/tests/fixtures/practical-research-sample-v4.json',{cache:'no-store'}).then(r=>r.text()).then(t=>{localStorage.setItem(ExperimentCore.STORAGE_KEY,t);return true})")
  [void](Invoke-Cdp 'Page.reload' @{ ignoreCache = $true })
  if (-not (Wait-For { (Invoke-Js 'document.readyState') -eq 'complete' })) { throw 'Reload with isolated sample timed out.' }
  $cancel = Invoke-Js @'
(async()=>{
  document.querySelector('[data-view="optimization"]').click();
  document.querySelectorAll('#optimizationPlanOptions input[type="checkbox"]').forEach(x=>x.checked=true);
  const beforeRuns=JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY)).optimizationRuns.length;
  document.getElementById('runOptimizationButton').click();
  const enabled=!document.getElementById('cancelOptimizationButton').disabled;
  document.getElementById('cancelOptimizationButton').click();
  await new Promise(resolve=>setTimeout(resolve,500));
  const after=JSON.parse(localStorage.getItem(ExperimentCore.STORAGE_KEY));
  return {enabled,message:document.getElementById('optimizationStatus').textContent.includes('\u30ad\u30e3\u30f3\u30bb\u30eb'),noSavedRun:after.optimizationRuns.length===beforeRuns,buttonReset:document.getElementById('cancelOptimizationButton').disabled};
})()
'@
  $report.worker | Add-Member -NotePropertyName cancel -NotePropertyValue $cancel

  $attendanceNotWorse = $report.optimization.attendance.visitDays -lt $report.optimization.fastest.visitDays -or ($report.optimization.attendance.visitDays -eq $report.optimization.fastest.visitDays -and ($report.optimization.attendance.preferOffDays -lt $report.optimization.fastest.preferOffDays -or ($report.optimization.attendance.preferOffDays -eq $report.optimization.fastest.preferOffDays -and [DateTime]$report.optimization.attendance.makespan -le [DateTime]$report.optimization.fastest.makespan)))
  $allValid = $report.optimization.fastest.feasible -and $report.optimization.attendance.feasible -and $attendanceNotWorse -and $report.independent.fastest.valid -and $report.independent.attendance.valid -and $report.exact.fastestGap -eq 0 -and $report.exact.visitDayGap -eq 0 -and $report.worker.calculationOk -and $report.worker.cancel.enabled -and $report.worker.cancel.message -and $report.worker.cancel.noSavedRun -and $report.backup.sampleAccepted -and $report.backup.serializedAccepted -and $report.backup.invalidRejected
  if (-not $allValid) { throw "Practical validation failed: $($report | ConvertTo-Json -Depth 20 -Compress)" }
  $report | ConvertTo-Json -Depth 20
  $issueCount = 0
  if (-not $report.backup.invalidRejected) { $issueCount++ }
  if ($report.optimization.attendance.visitDays -ge $report.optimization.fastest.visitDays -and $report.optimization.attendance.preferOffDays -gt $report.optimization.fastest.preferOffDays) { $issueCount++ }
  Write-Output "PRACTICAL_VALIDATION_COMPLETED=True"
  Write-Output "ISSUES_FOUND=$issueCount"
}
finally {
  if ($socket -and $socket.State -eq [Net.WebSockets.WebSocketState]::Open) { try { [void](Invoke-Cdp 'Browser.close') } catch {}; $socket.Dispose() }
  if ($browser -and -not $browser.HasExited) { try { Stop-Process -Id $browser.Id -Force } catch {} }
  if ($server -and -not $server.HasExited) { try { Stop-Process -Id $server.Id -Force } catch {} }
  Start-Sleep -Milliseconds 400
  if (Test-Path -LiteralPath $profilePath) {
    $resolved = (Resolve-Path -LiteralPath $profilePath).Path
    if ($resolved.StartsWith($projectRoot + '\') -and (Split-Path -Leaf $resolved) -eq '.practical-profile') { Remove-Item -LiteralPath $resolved -Recurse -Force }
  }
}
