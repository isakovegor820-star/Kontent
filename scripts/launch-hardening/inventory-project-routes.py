from pathlib import Path
import re, json

# Non-project endpoints have an explicit, documented identity. Everything else is project scoped.
public = {'health','readiness','lead','tracking/client.js','tracking/ping','tracking/conversions'}
account = {'settings','settings/profile','settings/account-profile','settings/notifications','ai/engines','media/capabilities','rss/catalog','channels/oauth/providers','legal-sources','legal-sources/connections','legal-sources/connections/[id]/actions','bot/connect','bot/link'}
context = {'projects','project-invitations/accept','bot/miniapp/overview'}
callback = {'channels/oauth/callback'}
rows=[]
for p in sorted(Path('src/app/api').rglob('route.ts')):
 path=str(p.relative_to('src/app/api')).removesuffix('/route.ts')
 s=p.read_text()
 methods=re.findall(r'(?:export )?async function (?:handle)?(GET|POST|PATCH|PUT|DELETE|HEAD|OPTIONS)\(',s)
 for method in methods:
  policy = 'project'
  if path in public:policy='public'
  elif path.startswith('auth/') or path.startswith('admin/') or path in account or path.startswith('settings/profile/') or path.startswith('settings/account-profile/'):policy='account'
  elif path in context or path=='projects/current' and method in ('GET','PUT'):policy='context'
  elif path in callback:policy='callback'
  elif path=='posts/create':policy='retired'
  rows.append({'path':'/api/'+path, 'method':method, 'policy':policy})
Path('src/lib/project-route-policies.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
if '--apply' in __import__('sys').argv:
 for p in sorted(Path('src/app/api').rglob('route.ts')):
  url='/api/'+str(p.relative_to('src/app/api')).removesuffix('/route.ts')
  selected=[x for x in rows if x['path']==url and x['policy']=='project']
  if not selected:continue
  s=p.read_text()
  if 'withProjectRoute' in s:continue
  exports=[]
  for r in selected:
   method=r['method'];s=s.replace('export async function '+method+'(', 'async function handle'+method+'(')
   option=', { projectInPath: true }' if url.startswith('/api/projects/[projectId]/') else ''
   if url=='/api/media/assets/[id]':option=', { objectRead: true }'
   exports.append('export const '+method+' = withProjectRoute(handle'+method+option+');')
  s='import { withProjectRoute } from "@/lib/project-route";\n'+s+'\n'+'\n'.join(exports)+'\n'
  p.write_text(s)
print('Inventoried',len(rows),'HTTP methods;',sum(x['policy']=='project' for x in rows),'project scoped')
