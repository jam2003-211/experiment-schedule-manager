const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../core.js');
const clone = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const data = core.createEmptyData();
  const idea = core.saveIdea(data, {name:'樹脂含浸試験',purpose:'浸透を確認',materials:'樹脂',priority:'中',notes:'元のメモ',status:'未計画',desiredCompletionDate:'2031-06-05'});
  const now = idea.createdAt;
  data.templates.push({id:'template',name:'基本工程',description:'',createdAt:now,updatedAt:now});
  data.steps.push(...['調製','測定'].map((name,i)=>({id:`template_${i}`,name,ownerType:'template',ownerId:'template',displayOrder:i,workDurationMinutes:60,waitDurationMinutes:30,waitDurationType:'calendar',workLocation:'lab',interruptible:true,notes:'工程メモ',createdAt:now,updatedAt:now})));
  for(let i=0;i<2;i++) {
    const made=core.createPlanFromTemplate(data,'template',idea.id);
    data.plans.push(made.plan); data.steps.push(...made.steps);
    made.plan.scheduleMode='forward';
    made.plan.experimentStartDateTime=`2031-06-0${2+i}T00:00:00.000Z`;
    const version=core.calculateForwardSchedule(data,made.plan.id,made.plan.experimentStartDateTime);
    assert.equal(version.feasible,true);
    data.scheduleVersions.push(version); made.plan.activeScheduleVersionId=version.id;
    made.plan.forecastCompletionDateTime=version.forecastCompletionAt;
    version.stepSchedules.forEach(s=>core.assignProgressFields(data.steps.find(x=>x.id===s.stepId),{plannedStartDateTime:s.startAt,plannedEndDateTime:s.endAt}));
    core.assignProgressFields(made.steps[0],{completed:true,actualStartDateTime:version.stepSchedules[0].startAt,actualEndDateTime:version.stepSchedules[0].endAt});
    core.movePlanStepDisplayOrder(data.steps,made.plan.id,made.steps[1].id,-1);
  }
  return {data,idea};
}
for (const [field,value] of Object.entries({name:'樹脂含浸条件比較試験',purpose:'条件比較',priority:'高',notes:'更新メモ',materials:'新材料'})) {
  test(`ストックの${field}保存を対応する全計画へ反映`,()=>{
    const {data,idea}=fixture(); core.saveIdea(data,{...idea,[field]:value},idea.id);
    assert.ok(data.plans.every(p=>p[field]===value));
  });
}
test('ストック状態を同期しても計画と工程の完了状態は維持',()=>{
  const {data,idea}=fixture(); data.plans[0].status='完了';
  const steps=clone(data.steps);
  core.saveIdea(data,{...idea,status:'実施中'},idea.id);
  assert.ok(data.plans.every(p=>p.stockStatus==='実施中'));
  assert.equal(data.plans[0].status,'完了'); assert.deepEqual(data.steps,steps);
});
test('複数計画の工程・工程順・予定・実績・テンプレート・全スケジュール履歴を保持',()=>{
  const {data,idea}=fixture(),before=clone(data);
  core.saveIdea(data,{...idea,name:'変更後',desiredCompletionDate:'2032-01-01',status:'完了'},idea.id);
  assert.deepEqual(data.steps,before.steps);
  assert.deepEqual(data.templates,before.templates);
  assert.deepEqual(data.scheduleVersions,before.scheduleVersions);
  assert.deepEqual(data.availability,before.availability);
  const independent=p=>Object.fromEntries(Object.entries(p).filter(([k])=>!['name','purpose','priority','materials','notes','stockStatus','updatedAt'].includes(k)));
  assert.deepEqual(data.plans.map(independent),before.plans.map(independent));
  assert.notEqual(data.plans[0].experimentStartDateTime,data.plans[1].experimentStartDateTime);
});
test('ストック削除後も全計画・工程・履歴を保持し再読み込みとJSON復元に成功',()=>{
  const {data,idea}=fixture(); core.saveIdea(data,{...idea,name:'保存済み'},idea.id);
  const before=clone(data); core.deleteIdea(data,idea.id);
  assert.equal(data.experimentIdeas.length,0);
  for(const key of ['plans','steps','scheduleVersions']) assert.deepEqual(data[key],before[key]);
  assert.equal(core.validateData(data).valid,true);
  const restored=core.parseBackup(core.serializeData(data));
  assert.equal(restored.valid,true); assert.deepEqual(restored.data.plans,before.plans);
  assert.equal(core.migrateData(JSON.parse(JSON.stringify(data))).valid,true);
});
test('再読み込み後も同期値と参照IDを保持',()=>{
  const {data,idea}=fixture(); core.saveIdea(data,{...idea,name:'保存後',purpose:'保存後の目的',priority:'低',notes:'保存後のメモ'},idea.id);
  const reloaded=core.migrateData(JSON.parse(JSON.stringify(data)));
  assert.equal(reloaded.valid,true); assert.equal(core.validateData(reloaded.data).valid,true);
  assert.deepEqual(reloaded.data.plans,data.plans);
});
test('JSONバックアップ復元後も参照を保持し次のストック編集を同期',()=>{
  const {data,idea}=fixture(),restored=core.parseBackup(core.serializeData(data));
  assert.equal(restored.valid,true); assert.equal(restored.data.schemaVersion,4);
  assert.ok(restored.data.plans.every(p=>p.experimentIdeaId===idea.id));
  core.saveIdea(restored.data,{...idea,notes:'復元後の更新'},idea.id);
  assert.ok(restored.data.plans.every(p=>p.notes==='復元後の更新'));
});
test('参照のない既存v4計画や別ストックの計画は推測で紐付けず変更しない',()=>{
  const {data,idea}=fixture();
  const legacy={...clone(data.plans[0]),id:'legacy'}; delete legacy.experimentIdeaId;
  const other=core.saveIdea(data,{...idea,name:'別ストック'});
  const otherPlan={...clone(legacy),id:'other',experimentIdeaId:other.id};
  data.plans.push(legacy,otherPlan); const before=clone([legacy,otherPlan]);
  core.saveIdea(data,{...idea,name:'変更'},idea.id);
  assert.deepEqual([legacy,otherPlan],before);
  const restored=core.parseBackup(core.serializeData(data)); assert.equal(restored.valid,true);
  assert.equal(restored.data.plans.find(p=>p.id==='legacy').experimentIdeaId,undefined);
});
test('旧基本項目と未知のストック項目を保存で失わず既知の基本項目だけを同期',()=>{
  const {data,idea}=fixture(); idea.plannedEquipment='旧装置'; idea.extension={value:1};
  core.saveIdea(data,{...idea,notes:''},idea.id);
  assert.equal(data.experimentIdeas[0].plannedEquipment,'旧装置');
  assert.deepEqual(data.experimentIdeas[0].extension,{value:1});
  assert.ok(data.plans.every(p=>p.plannedEquipment==='旧装置'&&p.notes===''));
  assert.ok(data.plans.every(p=>p.extension===undefined));
});
test('不正なストック保存はストック・計画・予定を変更しない',()=>{
  const {data,idea}=fixture(),before=clone(data);
  assert.throws(()=>core.saveIdea(data,{...idea,name:''},idea.id)); assert.deepEqual(data,before);
});
