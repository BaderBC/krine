import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { api, ApiError } from './api';
import { useOperatorChange, type OperatorChange } from './operator-form';
import { sessionFixture } from './operator-test-fixtures';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const target = sessionFixture('editor', 'op_qa_storage').operator!;
function change(): OperatorChange {
 return {kind:'update',target:target.id,revision:1,session_id:null,started_at:Date.now(),operation:{path:`/operators/${target.id}`,method:'PUT',key:'qa-storage-key',owner:api.requireOwner(),body:{revision:1,name:target.name,role:'editor',state:'active',reason:'Reviewed QA change'}}};
}
function mount() {
 let state!:ReturnType<typeof useOperatorChange>;
 function Harness(){state=useOperatorChange(()=>{});return <span>{state.error}</span>;}
 render(<RouterProvider router={createMemoryRouter([{path:'/',element:<Harness/>}])}/>);
 return {get state(){return state;}};
}
it('QA: unavailable storage access cannot silently dispatch an unpersisted operator intent',async()=>{
 const operation=change();
 vi.spyOn(window,'sessionStorage','get').mockImplementation(()=>{throw new DOMException('Storage disabled','SecurityError');});
 let fail!:(reason:unknown)=>void;
 const run=vi.spyOn(api,'run').mockImplementation(()=>new Promise((_,reject)=>{fail=reject;}));
 const hook=mount();let sent!:Promise<void>;
 await act(async()=>{sent=hook.state.send(operation);await Promise.resolve();});
 expect(run).toHaveBeenCalledTimes(1);
 const during=hook.state.error;
 await act(async()=>{fail(new ApiError(0,'network_error','The request could not be completed.'));await sent;});
 expect(during).toEqual(expect.stringMatching(/browser recovery|storage|keep this page open/i));
});
it('QA: failed persistence remains explicit after an ambiguous lifecycle request',async()=>{
 vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new DOMException('Storage full','QuotaExceededError');});
 vi.spyOn(api,'run').mockRejectedValue(new ApiError(0,'network_error','The request could not be completed.'));
 const hook=mount();await act(async()=>{await hook.state.send(change());});
 expect(hook.state.pending).not.toBeNull();
 expect(hook.state.error).toMatch(/browser recovery|storage|keep this page open/i);
});
