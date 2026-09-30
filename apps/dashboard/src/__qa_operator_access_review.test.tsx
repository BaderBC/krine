import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { Settings } from './Settings';
import { Api, api, ApiError } from './api';
import { authenticateFixture, methodsFixture, sessionFixture } from './operator-test-fixtures';
import { validPage, validOperator, ownedStorage } from './operator';
import { useOperatorChange, type OperatorChange } from './operator-form';
const target = {...sessionFixture('editor', 'op_qa_target').operator!, name:'QA Target', sign_in_name:'qa_target'};
function mount(path='/settings?view=operators&operator=op_qa_target') {
 return render(<RouterProvider router={createMemoryRouter([{path:'/settings',element:<Settings/>}],{initialEntries:[path]})}/>);
}
beforeEach(()=>{
 sessionStorage.clear();
 vi.spyOn(api,'get').mockImplementation(async(path)=>{
  if(path.startsWith('/operators?')) return {items:[target],next_cursor:null} as never;
  if(path===`/operators/${target.id}`) return target as never;
  if(path.includes('/sessions?')) return {items:[{id:'os_qa',created_at:1,expires_at:Date.now()+60000,revoked_at:null,current:false}],next_cursor:null} as never;
  throw Error(`Unexpected ${path}`);
 });
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();sessionStorage.clear();});
it('QA: entering another operator mode never silently discards the current typed change',async()=>{
 const user=userEvent.setup();mount();
 await user.click(await screen.findByRole('button',{name:'Edit access'}));
 await user.clear(screen.getByLabelText('Name'));
 await user.type(screen.getByLabelText('Name'),'Unsaved reviewed name');
 await user.type(screen.getByLabelText('Reason'),'Preserve this operator correction');
 await user.click(screen.getByRole('button',{name:'Add operator'}));
 expect(screen.getByLabelText('Name')).toHaveProperty('value','Unsaved reviewed name');
 expect(screen.getByLabelText('Reason')).toHaveProperty('value','Preserve this operator correction');
});
it('QA: a rejected whitespace revocation reason explains why no request was sent',async()=>{
 const user=userEvent.setup();const send=vi.spyOn(api,'run');mount();
 await user.type(await screen.findByLabelText('Revocation reason'),'   ');
 await user.click(screen.getByRole('button',{name:'Revoke sessions'}));
 expect(send).not.toHaveBeenCalled();
 expect(screen.queryByRole('alert')).not.toBeNull();
});
it('QA: lifecycle validation failure remains handled when browser storage stops permitting removal',async()=>{
 let changeApi: ReturnType<typeof useOperatorChange> | undefined;
 function Harness(){changeApi=useOperatorChange(()=>{});return <span>{changeApi.error}</span>;}
 render(<RouterProvider router={createMemoryRouter([{path:'/',element:<Harness/>}])}/>);
 const change:OperatorChange={kind:'update',target:target.id,revision:1,session_id:null,started_at:Date.now(),operation:{path:`/operators/${target.id}`,method:'PUT',key:'qa-key',owner:api.requireOwner(),body:{revision:1,name:target.name,role:'editor',state:'active',reason:'Reviewed change'}}};
 vi.spyOn(api,'run').mockRejectedValue(new ApiError(409,'revision_conflict','Updated elsewhere'));
 vi.spyOn(Storage.prototype,'removeItem').mockImplementation(()=>{throw new DOMException('Storage disabled','SecurityError');});
 let thrown:unknown;
 await act(async()=>{try{await changeApi!.send(change);}catch(error){thrown=error;}});
 expect(thrown).toBeUndefined();
 expect(changeApi!.busy).toBe(false);
 expect(changeApi!.error).toMatch(/changed|recovery|storage|browser/i);
});
it('QA: a response delayed during body parsing cannot cross to a different actor',async()=>{
 const client=new Api();authenticateFixture(client);
 let finish!:(v:unknown)=>void;
 const body=new Promise(r=>{finish=r;});
 vi.stubGlobal('fetch',vi.fn(async()=>({status:200,ok:true,json:()=>body})));
 const response=client.get('/operators');
 await Promise.resolve();
 client.acceptSession(sessionFixture('viewer','op_other'));
 finish({items:[target],next_cursor:null});
 await expect(response).rejects.toMatchObject({code:'stale_authority'});
});
it('QA: actual serialized backend audit/operator cursor formats satisfy the page boundary',()=>{
 for(const scope of ['operators','operator-sessions:op_019aaead17bd70008b423a062304886f','a'.repeat(64)]){
  const cursor=btoa(JSON.stringify([1790769999000,`${scope}\u0000op_019aaead17bd70008b423a062304886f`])).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
  expect(validPage({items:[target],next_cursor:cursor},validOperator)).toBe(true);
 }
});
it('QA: opaque storage ownership does not collide with a delimiter in installation or actor IDs',()=>{
 const one=ownedStorage(sessionStorage,{installation_id:'i:a',actor_id:'b'});
 const two=ownedStorage(sessionStorage,{installation_id:'i',actor_id:'a:b'});
 one.setItem('draft','one');two.setItem('draft','two');
 expect(one.getItem('draft')).toBe('one');expect(two.getItem('draft')).toBe('two');
});
it('QA: a malformed role-changing session cannot assign authority or discard a valid existing reveal',()=>{
 const client=new Api();authenticateFixture(client);
 client.revealCredential({operator:target,credential:`ok_${'a'.repeat(43)}`,secret_status:'revealed'});
 expect(()=>client.acceptSession({...sessionFixture('viewer'),capabilities:['session','investigate','administer']})).toThrow();
 expect(client.current?.operator?.role).toBe('admin');
 expect(client.revealedCredential?.credential).toBeTruthy();
});
it('QA: changing installations makes an already captured mutation unusable',async()=>{
 const client=new Api();authenticateFixture(client);
 const operation={path:'/operators',method:'POST' as const,body:{},key:'immutable',owner:client.requireOwner()};
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({...methodsFixture,installation_id:'second-install'}),{status:200})));
 await client.authMethods();
 expect(client.current).toBeNull();
 client.acceptSession(sessionFixture());
 await expect(client.run(operation)).rejects.toMatchObject({code:'actor_changed'});
});
it('QA: malformed structured error details cannot strand a draft in saving or drop its immutable retry',async()=>{
 const {DraftController}=await import('./draft');
 const client=new Api();authenticateFixture(client);
 const initial={name:'qa_check',description:'',active_version:1,draft_revision:1,has_draft_changes:false,draft:{schema_version:1 as const,inputs:{},rules:[],otherwise:'DENY' as const},updated_at:1};
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:{code:'validation_failed',message:'Malformed diagnostic',details:{path:'draft',message:'Wrong details shape'}}}),{status:422})));
 const model=new DraftController(client,initial,sessionStorage);
 model.edit({...initial.draft,otherwise:'ALLOW'});
 let thrown:unknown;
 try{await model.save();}catch(error){thrown=error;}
 expect(thrown).toBeUndefined();
 expect(model.state.status).toBe('failed');
 const record=ownedStorage(sessionStorage,api.requireOwner()).getItem('krine:draft:qa_check');
 expect(JSON.parse(record!).pending).not.toBeNull();
 model.dispose();
});
