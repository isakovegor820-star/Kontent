import { randomUUID } from "node:crypto";

// Controlled QA data. These counters must never be presented as live measurements.
export async function seedTrendQa(pool) {
  const suffix = randomUUID().slice(0, 8);
  const user = Number((await pool.query("insert into users (email, name, onboarding_completed_at) values ($1, 'Проверка трендов', now()) returning id", [`trends-${suffix}@example.test`])).rows[0].id);
  const otherUser = Number((await pool.query("insert into users (email, name) values ($1, 'Другой пользователь') returning id", [`other-${suffix}@example.test`])).rows[0].id);
  const projects = (await pool.query("insert into projects (name, timezone, created_by_user_id) values ('Тренды QA', 'Europe/Moscow', $1), ('Другой проект QA', 'Europe/Moscow', $1) returning id", [user])).rows.map(row => Number(row.id));
  const [project, otherProject] = projects;
  await pool.query("insert into project_members (project_id, user_id, role, status) values ($1,$3,'owner','active'), ($2,$3,'owner','active'), ($2,$4,'author','active')", [project, otherProject, user, otherUser]);
  await pool.query("insert into user_project_preferences (user_id, selected_project_id) values ($1,$2)", [user, project]);
  const channel = Number((await pool.query("insert into channels (user_id, project_id, network, title, handle, tg_chat_id, status, is_active) values ($1,$2,'tg','Тема проекта','trends_qa', $3,'active',true) returning id", [user, project, String(-1009900000000 - user)])).rows[0].id);
  const otherChannel = Number((await pool.query("insert into channels (user_id, project_id, network, title, handle, tg_chat_id, status, is_active) values ($1,$2,'tg','Другой канал','trends_other', $3,'active',true) returning id", [user, project, String(-1009910000000 - user)])).rows[0].id);
  const competitor = Number((await pool.query("insert into competitors (user_id, channel_id, network, title, handle, status, collected_at) values ($1,$2,'tg','Глубина','qa_depth_' || $3,'ready',now()) returning id", [user, channel, suffix])).rows[0].id);
  await pool.query("insert into competitor_posts (competitor_id, tg_msg_id, text, views, posted_at, collected_at) select $1,n,'Лодка и снасти',100,now() - (n+3)*interval '1 day',now() from generate_series(1,5)n", [competitor]);
  await pool.query(`insert into competitor_posts (competitor_id, tg_msg_id, text, views, reactions, posted_at, collected_at) values
    ($1,10,'Щука: техника ловли',400,12,now()-interval '3 days',now()),
    ($1,11,'Щука: старый снимок счётчика',900,null,now()-interval '72 hours',now()-interval '71 hours'),
    ($1,12,'Щука: счётчик недоступен',null,null,now()-interval '1 day',now()),
    ($1,13,'Щука: ноль просмотров',0,0,now()-interval '1 hour',now()),
    ($1,14,'Щука без даты',500,null,null,now()),
    ($1,15,'Щука из будущего',777,null,now()+interval '1 day',now()),
    ($1,16,'Садоводство: полив',300,4,now()-interval '1 day',now())`, [competitor]);
  const collection = Number((await pool.query("insert into trend_sources (handle, title, category, enabled, status, collected_at) values ($1,'Открытые темы','ниша',true,'ready',now()) returning id", [`qa_collection_${suffix}`])).rows[0].id);
  await pool.query("insert into trend_posts (source_id,tg_msg_id,text,views,posted_at,collected_at) values ($1,1,'Щука в подборке',20,now()-interval '1 day',now())", [collection]);
  async function run(query, owner = user, destination = channel, workspace = project) {
    return Number((await pool.query("insert into radar_search_runs (user_id,project_id,channel_id,request_key,query,normalized_query,status,stage,progress,search_scope,search_period,completed_at) values ($1,$2,$3,$4,$5,$5,'ready','ready',100,'telegram','week',now()) returning id", [owner, workspace, destination, randomUUID(), query])).rows[0].id);
  }
  const oldRun = await run('рыбалка');
  const currentRun = await run('рыбалка');
  const otherTopic = await run('садоводство');
  const otherChannelRun = await run('рыбалка',user,otherChannel);
  const otherProjectRun = await run('рыбалка',user,null,otherProject);
  const otherUserRun = await run('рыбалка',otherUser,null,otherProject);
  async function result({ runId = currentRun, owner = user, handle = 'qa_fishing', msg = 10, type = 'post', views = 300, text = 'Ловля щуки на спиннинг', posted = new Date(Date.now()-3*86400000).toISOString(), raw = {}, url }) {
    return Number((await pool.query(`insert into radar_search_results
      (run_id,user_id,result_type,provider,canonical_key,url,handle,external_id,title,text,views,reactions,posted_at,quality_score,reason,raw_data,verified_at)
      values ($1,$2,$3,'qa-fixture',$4,$5,$6,$7,'Рыболовный дневник',$8,$9,null,$10,75,'Контрольные данные QA',$11::jsonb,'2026-09-09T12:00:00Z') returning id`,
      [runId,owner,type,`${type}:${handle}:${msg}`,url || `https://t.me/${handle}/${msg}`,handle,msg,text,views,posted,JSON.stringify(raw)])).rows[0].id);
  }
  await result({ runId: oldRun, views: 9999 });
  await result({});
  await result({ type: 'trend', url:'https://t.me/s/qa_fishing/10', raw: { medianViews: 100, baselinePosts: 5, viewRatio: 3 } });
  await result({ msg: 11, views: null });
  await result({ msg: 12, posted: null, views: 999 });
  await result({ msg: 13, posted: new Date(Date.now()+86400000).toISOString(), views: 888 });
  await result({ runId: otherTopic, text:'Садоводство и рыбалка', views:7777 });
  await result({ runId: otherChannelRun, views:6666 });
  await result({ runId: otherProjectRun, views:5555 });
  await result({ runId: otherUserRun, owner:otherUser, views:4444 });
  const paginatedRun = await run('ремонт квартиры');
  for(let n=1;n<=30;n++) {
    await result({runId:paginatedRun,handle:`qa_renovation_${n%5}`,msg:100+n,views:n*100,text:`Ремонт квартиры: планирование пространства, материал ${n}. Как выбрать отделку и рассчитать бюджет.`,posted:new Date(Date.now()-(n%7)*86400000-3600000).toISOString(),raw:{media:'text'}});
  }
  // Use actual current verification times; the fixture is independent of wall-clock date.
  await pool.query("update radar_search_results set verified_at=now() where user_id in ($1,$2)",[user,otherUser]);
  return { user, otherUser, project, otherProject, channel, otherChannel, competitor, collection, currentRun, oldRun, otherTopic, otherChannelRun, otherProjectRun, otherUserRun, paginatedRun };
}
