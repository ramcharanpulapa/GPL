const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const{openDb,auction,createApp}=require('./server');

// player 1 has base price 20, player 13 has base price 6. every team starts with 100.
const fresh=()=>auction(openDb(':memory:'));

function fails(fn,status,message){
  assert.throws(fn,(err)=>err.status===status&&message.test(err.message));
}

test('preloads 4 teams and 14 players',()=>{
  const a=fresh();
  assert.equal(a.teams().length,4);
  assert.equal(a.players('available').length,14);
});

test('four managers can bid, each higher than the last',()=>{
  const a=fresh();
  a.start(1);
  a.bid(1,21);
  a.bid(2,25);
  a.bid(3,30);
  const live=a.bid(4,35);
  assert.deepEqual(live.bids.map((b)=>b.amount),[35,30,25,21]);
  assert.equal(live.highest.team_id,4);
});

test('bid must be more than the base price',()=>{
  const a=fresh();
  a.start(1);
  fails(()=>a.bid(1,20),422,/base price/);
  fails(()=>a.bid(1,10),422,/base price/);
});

test('only a higher bid is stored',()=>{
  const a=fresh();
  a.start(1);
  a.bid(1,30);
  fails(()=>a.bid(2,30),422,/highest bid/);
  fails(()=>a.bid(2,25),422,/highest bid/);
  assert.equal(a.current().bids.length,1);
});

test('a team cannot bid twice in a row',()=>{
  const a=fresh();
  a.start(1);
  a.bid(1,25);
  fails(()=>a.bid(1,40),409,/already have the highest bid/);
  a.bid(2,30);
  a.bid(1,35);
});

test('bid above remaining budget is refused',()=>{
  const a=fresh();
  a.start(1);
  fails(()=>a.bid(1,101),422,/Not enough budget/);
  a.bid(1,100);
});

test('budget check uses what is left, not the total',()=>{
  const a=fresh();
  a.start(1);
  a.bid(1,60);
  a.accept();
  a.start(13);
  fails(()=>a.bid(1,41),422,/only has 40 left/);
});

test('cannot bid when nobody is up for auction',()=>{
  fails(()=>fresh().bid(1,30),409,/No player/);
});

test('only one auction at a time',()=>{
  const a=fresh();
  a.start(1);
  fails(()=>a.start(2),409,/already up/);
});

test('accept moves the player to the team roster at the bid price',()=>{
  const a=fresh();
  a.start(1);
  a.bid(1,25);
  a.bid(3,42);
  const player=a.accept();

  assert.equal(player.status,'sold');
  assert.equal(player.team_id,3);
  assert.equal(player.sold_price,42);
  assert.equal(a.current(),null);
  assert.ok(!a.players('available').some((p)=>p.id===1));

  const[team1,,team3]=a.teams();
  assert.deepEqual(team3.players.map((p)=>[p.id,p.sold_price]),[[1,42]]);
  assert.equal(team3.remaining_budget,58);
  assert.equal(team1.remaining_budget,100);
});

test('accept needs at least one bid',()=>{
  const a=fresh();
  a.start(1);
  fails(()=>a.accept(),409,/no bids/);
});

test('sold player cannot be auctioned again',()=>{
  const a=fresh();
  a.start(13);
  a.bid(2,10);
  a.accept();
  fails(()=>a.start(13),409,/already sold/);
});

test('reject does not assign the player',()=>{
  const a=fresh();
  a.start(1);
  a.bid(1,50);
  const player=a.reject();

  assert.equal(player.status,'available');
  assert.equal(player.team_id,null);
  assert.ok(a.teams().every((t)=>t.remaining_budget===100&&t.players.length===0));

  a.start(1);
  assert.equal(a.current().bids.length,0);
  a.bid(1,21);
});

test('rosters and budgets survive a restart',()=>{
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'gpl-')),'test.db');
  const db=openDb(file);
  const a=auction(db);
  a.start(1);
  a.bid(2,33);
  a.accept();
  db.close();

  const db2=openDb(file);
  const team=auction(db2).teams()[1];
  assert.equal(team.remaining_budget,67);
  assert.equal(team.players[0].name,'MS Dhoni');
  db2.close();
});

test('API checks roles and returns errors as JSON',async()=>{
  const server=createApp(openDb(':memory:')).listen(0);
  const url=`http://localhost:${server.address().port}/api`;
  const post=(route,headers,body)=>fetch(url+route,{
    method:'POST',
    headers:{'Content-Type':'application/json',...headers},
    body:JSON.stringify(body),
  });

  try{
    let res=await post('/auction/start',{'X-Role':'manager'},{playerId:1});
    assert.equal(res.status,403);

    res=await post('/auction/start',{'X-Role':'auctioneer'},{playerId:1});
    assert.equal(res.status,201);

    res=await post('/auction/bid',{'X-Role':'manager','X-Team':'1'},{amount:500});
    assert.equal(res.status,422);
    assert.match((await res.json()).error,/Not enough budget/);

    res=await post('/auction/bid',{'X-Role':'manager','X-Team':'1'},{amount:30});
    assert.equal(res.status,201);

    res=await post('/auction/accept',{'X-Role':'auctioneer'});
    assert.equal(res.status,200);
    assert.equal((await res.json()).team_id,1);
  }finally{
    server.close();
  }
});