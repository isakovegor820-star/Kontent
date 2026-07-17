const sites = [
  ["SMMplanner","https://smmplanner.com/"],["Postmypost","https://postmypost.io/"],
  ["SmmBox","https://smmbox.com/"],["Amplifr","https://amplifr.com/"],
  ["Onlypult","https://onlypult.com/"],["Publer","https://publer.com/"],
  ["Novapress","https://novapress.pro/"],["PlaneMax","https://planemax.ru/"],
  ["TGStat","https://tgstat.ru/"],["Telemetr","https://telemetr.me/"],
  ["Popsters","https://popsters.ru/"],["Telega.in","https://telega.in/"],
  ["LiveDune","https://livedune.ru/"],["DataFan","https://datafan.pro/"],
  ["Brand Analytics","https://brandanalytics.ru/"],["Buffer","https://buffer.com/"],
  ["Later","https://later.com/"],["Hootsuite","https://www.hootsuite.com/"],
  ["Sprout Social","https://sproutsocial.com/"],["Metricool","https://metricool.com/"],
  ["ContentStudio","https://contentstudio.io/"],["SocialBee","https://socialbee.com/"],
  ["Vista Social","https://vistasocial.com/"],["Predis.ai","https://predis.ai/"],
];
const out = [];
await Promise.all(sites.map(async ([name, url]) => {
  try {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
    out.push(`${r.ok ? "✅" : "⚠️ " + r.status} ${name.padEnd(16)} ${url}`);
  } catch (e) { out.push(`❌ ${name.padEnd(16)} ${e.message.slice(0,45)}`); }
}));
out.sort().forEach(l => console.log(l));
