import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf('    function sharedUsersForMonth(');
const end=html.indexOf('    function renderSharedCalendars(',start);
if(start<0 || end<0) throw new Error('shared roster source is unavailable');
const build=runInNewContext('(function(globalUsersData){'+html.slice(start,end)+' return sharedUsersForMonth;})',{Date});
const oldUser={name:'Active',stores:['annee'],storeMemberships:[{storeName:'annee',startDate:null,endDate:null}]};
const joined={name:'New hire',stores:['annee'],storeMemberships:[{storeName:'annee',startDate:'2026-11-10',endDate:null}]};
const moved={name:'Past member',stores:['annee'],storeMemberships:[{storeName:'annee',startDate:'2026-09-01',endDate:'2026-10-31'}]};
const other={name:'Other Store',stores:['yoki.'],storeMemberships:[{storeName:'yoki.',startDate:'2026-11-01',endDate:null}]};
const legacy={name:'Older active staff',stores:['annee']};
const users=[oldUser,joined,moved,other,legacy];

test('shared roster includes an onboarding Staff only from the month containing hire date even with zero Shifts',()=>{
  const monthly=build(users);
  assert.deepEqual(Array.from(monthly(users,'annee',2026,10)).map(x=>x.name),['Active','Past member','Older active staff']);
  assert.deepEqual(Array.from(monthly(users,'annee',2026,11)).map(x=>x.name),['Active','New hire','Older active staff']);
  assert.deepEqual(Array.from(monthly(users,'annee',2026,12)).map(x=>x.name),['Active','New hire','Older active staff']);
  assert.deepEqual(Array.from(monthly(users,'yoki.',2026,11)).map(x=>x.name),['Other Store']);
});
test('shared screen uses the month-specific roster and does not depend on Shift entries',()=>{
  const render=html.slice(end,html.indexOf('    function createSharedTable(',end));
  assert.match(render,/sharedUsersForMonth\(globalUsersData, currentStore, d\.getFullYear\(\), d\.getMonth\(\) \+ 1\)/);
  assert.match(render,/createSharedTable\(d\.getFullYear\(\), d\.getMonth\(\) \+ 1, targetUsers, container\)/);
  assert.doesNotMatch(render,/globalShiftData\.filter/);
});
