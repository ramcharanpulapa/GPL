const path=require('path');
const express=require('express');
const{DatabaseSync}=require('node:sqlite');

const PORT=process.env.PORT||3000;
const DB_FILE=process.env.DB_FILE||path.join(__dirname,'gpl.db');

// all money is in lakhs
const TEAM_BUDGET=100;
const TEAMS=['Bhaukaal','Fluxo','Bham Bole','Winners'];
const PLAYERS=[
  ['Jitthu','batting',20],
  ['Ram Charan','batting',18],
  ['Akhil','batting',20],
  ['Harsha','batting',12],
  ['Abhilash','both',15],
  ['Nissy','bowling',16],
  ['Manideep','both',14],
  ['Dhanvith','batting',12],
  ['Kranthi Kumar','bowling',10],
  ['Yashwanth','both',10],
  ['Hansik','batting',9],
  ['Satish','both',8],
  ['Pavan Sai','bowling',6],
  ['Varun Sai','bowling',5],
];

function openDb(file=DB_FILE){
  const db=new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys=ON;

    CREATE TABLE IF NOT EXISTS teams(
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      total_budget INTEGER NOT NULL CHECK(total_budget>0),
      remaining_budget INTEGER NOT NULL CHECK(remaining_budget>=0)
    );

    CREATE TABLE IF NOT EXISTS players(
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      skill TEXT NOT NULL CHECK(skill IN('batting','bowling','both')),
      base_price INTEGER NOT NULL CHECK(base_price>0),
      status TEXT NOT NULL DEFAULT 'available' CHECK(status IN('available','in_auction','sold')),
      sold_price INTEGER,
      team_id INTEGER REFERENCES teams(id)
    );

    CREATE TABLE IF NOT EXISTS bids(
      id INTEGER PRIMARY KEY,
      player_id INTEGER NOT NULL REFERENCES players(id),
      team_id INTEGER NOT NULL REFERENCES teams(id),
      amount INTEGER NOT NULL CHECK(amount>0),
      time TEXT NOT NULL
    );
  `);

  const{count}=db.prepare('SELECT COUNT(*) AS count FROM teams').get();
  if(count===0){
    const addTeam=db.prepare('INSERT INTO teams(name,total_budget,remaining_budget) VALUES(?,?,?)');
    TEAMS.forEach(name=>addTeam.run(name,TEAM_BUDGET,TEAM_BUDGET));

    const addPlayer=db.prepare('INSERT INTO players(name,skill,base_price) VALUES(?,?,?)');
    PLAYERS.forEach(([name,skill,price])=>addPlayer.run(name,skill,price));
  }
  return db;
}

class ApiError extends Error{
  constructor(status,message){
    super(message);
    this.status=status;
  }
}

function auction(db){
  const one=(sql,...args)=>db.prepare(sql).get(...args);
  const all=(sql,...args)=>db.prepare(sql).all(...args);
  const run=(sql,...args)=>db.prepare(sql).run(...args);

  function transaction(fn){
    db.exec('BEGIN');
    try{
      fn();
      db.exec('COMMIT');
    }catch(err){
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function players(status){
    if(status)return all('SELECT * FROM players WHERE status=? ORDER BY id',status);
    return all('SELECT * FROM players ORDER BY id');
  }

  function teams(){
    return all('SELECT * FROM teams ORDER BY id').map((team)=>({
      ...team,
      players:all('SELECT id,name,skill,sold_price FROM players WHERE team_id=? ORDER BY id',team.id),
    }));
  }

  function current(){
    const player=one("SELECT * FROM players WHERE status='in_auction'");
    if(!player)return null;

    const bids=all(
      `SELECT bids.*,teams.name AS team_name FROM bids
       JOIN teams ON teams.id=bids.team_id
       WHERE player_id=? ORDER BY amount DESC`,
      player.id,
    );
    return{player,bids,highest:bids[0]||null};
  }

  function start(playerId){
    const player=one('SELECT * FROM players WHERE id=?',playerId);
    if(!player)throw new ApiError(404,'Player not found');
    if(current())throw new ApiError(409,'Another player is already up for auction');
    if(player.status==='sold')throw new ApiError(409,`${player.name} is already sold`);

    run("UPDATE players SET status='in_auction' WHERE id=?",player.id);
    return current();
  }

  function bid(teamId,amount){
    const team=one('SELECT * FROM teams WHERE id=?',teamId);
    if(!team)throw new ApiError(404,'Team not found');

    const live=current();
    if(!live)throw new ApiError(409,'No player is up for auction');
    if(!Number.isInteger(amount)||amount<=0)throw new ApiError(400,'Bid amount must be a whole number');

    const{player,highest}=live;
    if(highest&&highest.team_id===team.id){
      throw new ApiError(409,'You already have the highest bid');
    }
    if(amount<=player.base_price){
      throw new ApiError(422,`Bid must be more than the base price of ${player.base_price}`);
    }
    if(highest&&amount<=highest.amount){
      throw new ApiError(422,`Bid must be more than the highest bid of ${highest.amount}`);
    }
    if(amount>team.remaining_budget){
      throw new ApiError(422,`Not enough budget: ${team.name} only has ${team.remaining_budget} left`);
    }

    run(
      'INSERT INTO bids(player_id,team_id,amount,time) VALUES(?,?,?,?)',
      player.id,team.id,amount,new Date().toISOString(),
    );
    return current();
  }

  function accept(){
    const live=current();
    if(!live)throw new ApiError(409,'No player is up for auction');
    if(!live.highest)throw new ApiError(409,'There are no bids to accept');

    const{player,highest}=live;
    transaction(()=>{
      run("UPDATE players SET status='sold',sold_price=?,team_id=? WHERE id=?",
        highest.amount,highest.team_id,player.id);
      run('UPDATE teams SET remaining_budget=remaining_budget-? WHERE id=?',
        highest.amount,highest.team_id);
    });
    return one('SELECT * FROM players WHERE id=?',player.id);
  }

  // the player goes back to the pool and their bids are cleared,
  // so the next round for them starts fresh
  function reject(){
    const live=current();
    if(!live)throw new ApiError(409,'No player is up for auction');

    transaction(()=>{
      run('DELETE FROM bids WHERE player_id=?',live.player.id);
      run("UPDATE players SET status='available' WHERE id=?",live.player.id);
    });
    return one('SELECT * FROM players WHERE id=?',live.player.id);
  }

  return{players,teams,current,start,bid,accept,reject};
}

function createApp(db){
  const a=auction(db);
  const app=express();

  app.use(express.json());
  app.use(express.static(path.join(__dirname,'public')));

  // no real login - the page sends the picked role in headers
  const onlyAuctioneer=(req,res,next)=>{
    if(req.get('X-Role')!=='auctioneer')throw new ApiError(403,'Only the auctioneer can do this');
    next();
  };
  const onlyManager=(req,res,next)=>{
    if(req.get('X-Role')!=='manager')throw new ApiError(403,'Only a team manager can bid');
    next();
  };

  app.get('/api/state',(req,res)=>{
    res.json({players:a.players(),teams:a.teams(),auction:a.current()});
  });
  app.get('/api/players',(req,res)=>res.json(a.players(req.query.status)));
  app.get('/api/teams',(req,res)=>res.json(a.teams()));

  app.post('/api/auction/start',onlyAuctioneer,(req,res)=>{
    res.status(201).json(a.start(Number(req.body?.playerId)||0));
  });
  app.post('/api/auction/bid',onlyManager,(req,res)=>{
    res.status(201).json(a.bid(Number(req.get('X-Team'))||0,req.body?.amount));
  });
  app.post('/api/auction/accept',onlyAuctioneer,(req,res)=>res.json(a.accept()));
  app.post('/api/auction/reject',onlyAuctioneer,(req,res)=>res.json(a.reject()));

  app.use((err,req,res,next)=>{
    if(err instanceof ApiError)return res.status(err.status).json({error:err.message});
    if(err.type==='entity.parse.failed')return res.status(400).json({error:'Invalid JSON'});
    console.error(err);
    res.status(500).json({error:'Something went wrong'});
  });

  return app;
}

if(require.main===module){
  createApp(openDb()).listen(PORT,()=>console.log(`GPL auction running on http://localhost:${PORT}`));
}

module.exports={openDb,auction,createApp};