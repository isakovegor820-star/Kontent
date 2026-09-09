// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, expect, it } from 'vitest';
import { persistPendingDraft, findPendingDraft, removePendingDraft, removePendingDraftCopy, type PendingDraftRevision } from '@/lib/draft-outbox';
const source=readFileSync(process.env.N35_COMPOSER_SOURCE || resolve('src/app/app/composer/page.tsx'),'utf8');
const tree=ts.createSourceFile('composer.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let callback: ts.Expression | undefined;
function visit(node: ts.Node) {
 if(ts.isJsxAttribute(node) && node.name.getText(tree)==='onConfirm' && node.initializer && ts.isJsxExpression(node.initializer)
   && node.initializer.expression?.getText(tree).match(/removePendingDraft(?:Copy)?\(deleting/u)) callback=node.initializer.expression;
 ts.forEachChild(node,visit);
}
visit(tree);if(!callback)throw new Error('actual selected-copy deletion callback unavailable');
function confirmSelected(selected: PendingDraftRevision) {
 const errors:string[]=[];
 const bindings={deleting:selected,userId:selected.userId,workspace:selected.workspaceId,removePendingDraft,removePendingDraftCopy,
   setDeleting:()=>{},setError:(message:string)=>errors.push(message),refresh:()=>{}};
 const code=ts.transpileModule('return ('+callback!.getText(tree)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 new Function(...Object.keys(bindings),code)(...Object.values(bindings))();return errors;
}
function revision(number:number,text:string):PendingDraftRevision {return {
 schema:1,userId:7,workspaceId:'project:11',clientKey:'draft_1234567890abcdef',copyId:'copy_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
 draftId:41,baseVersion:1,revision:number,writtenAt:new Date(1000+number).toISOString(),
 payload:{text,formatting:[],media:null,scheduledAt:null,origin:'manual',sourceRef:null,channelIds:[],aiValidation:null},
 form:{networks:[],channelIds:[],date:'',time:'',noDate:false}
};}
afterEach(()=>localStorage.clear());
it('retains a newer writer revision if the copy changed after opening deletion confirmation',()=>{
 const selected=revision(1,'Text reviewed by the deleting tab');persistPendingDraft(selected);
 const newer=revision(2,'New unsaved text written by the owning tab after dialog opened');persistPendingDraft(newer);
 const errors = confirmSelected(selected);
 expect(errors.join(" ")).toContain("Копия обновилась");
 expect(findPendingDraft(7,{draftId:41,copyId:selected.copyId},undefined,'project:11'),
   'Confirmation of old copy snapshot must not delete the newer unsaved revision').toEqual(newer);
});
it('allows explicit removal of the unchanged selected revision',()=>{
 const selected=revision(1,'Reviewed copy');persistPendingDraft(selected);confirmSelected(selected);
 expect(findPendingDraft(7,{copyId:selected.copyId},undefined,'project:11')).toBeNull();
});
