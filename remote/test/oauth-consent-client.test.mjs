/**
 * @file Executes the actual consent browser module with a minimal DOM substitute.
 * These checks observe serialization, click gating, navigation and error states,
 * not browser CSP enforcement or a real ChatGPT connection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source=await readFile(new URL('../../web/connected/public/oauth-consent.mjs',import.meta.url),'utf8');

/** Construct only the DOM interfaces used by the module; requests remain synthetic. */
async function harness(send, action='https://getrepot.com/consent/decision') {
  const buttons=[{disabled:false},{disabled:false}], status={textContent:''}, navigations=[];
  const forms=['true','false'].map((value,i)=>({action,fields:[['accept',value],['oauth_query','test-signed+query']],querySelectorAll:()=>[buttons[i]],addEventListener(_event,handler){this.submit=handler;}}));
  const doc={querySelectorAll:()=>forms,getElementById:()=>status};
  class TestFormData { constructor(form){this.fields=form.fields;} [Symbol.iterator](){return this.fields[Symbol.iterator]();} }
  const context=vm.createContext({URL,URLSearchParams,FormData:TestFormData});
  const module=new vm.SourceTextModule(source,{context});await module.link(()=>assert.fail('No external imports'));await module.evaluate();
  module.namespace.installConsentForms(doc,send,{origin:'https://getrepot.com',href:'https://getrepot.com/consent',assign:url=>navigations.push(url)});
  return {forms,buttons,status,navigations,click:i=>forms[i].submit({preventDefault(){}})};
}

for(const [i,decision] of ['true','false'].entries()) test('serializes '+decision+' and navigates only after the server returns a successful handoff',async()=>{
  let request;
  const h=await harness(async(url,options)=>{request={url,options};return Response.json({redirect:true,url:'https://chatgpt.com/test-callback?'+(i?'error=access_denied':'code=synthetic')});});
  await h.click(i);
  assert.equal(request.url,'https://getrepot.com/consent/decision');assert.equal(request.options.body.get('accept'),decision);assert.equal(request.options.body.get('oauth_query'),'test-signed+query');
  assert.equal(request.options.credentials,'same-origin');assert.equal(request.options.redirect,'error');assert.equal(request.options.headers.accept,'application/json');
  assert.equal(h.navigations.length,1);assert.equal(h.status.textContent,'Returning to your app…');assert.ok(h.buttons.every(b=>b.disabled));
});

test('duplicate clicks cannot submit a second decision while the first is pending',async()=>{
  let resolve,calls=0;const promise=new Promise(r=>{resolve=r;});const h=await harness(async()=>{calls++;return promise;});
  const pending=h.click(0);await h.click(1);assert.equal(calls,1);assert.ok(h.buttons.every(b=>b.disabled));
  resolve(Response.json({redirect:true,url:'https://client.example/callback?code=test'}));await pending;assert.equal(h.navigations.length,1);
});

for(const mode of ['httpError','badJson','notRedirect','badURL','network','insecure','credentials']) test('failure stays visible and re-enables the form without leaking data: '+mode,async()=>{
  const send=async()=>{
    if(mode==='network')throw new Error('PRIVATE_NETWORK_DETAILS');
    if(mode==='httpError')return Response.json({error:'PRIVATE_ERROR'},{status:400});
    if(mode==='badJson')return new Response('PRIVATE_BAD_JSON');
    return Response.json({redirect:mode!=='notRedirect',url:mode==='badURL'?'javascript:PRIVATE()':mode==='insecure'?'http://remote.example/callback':mode==='credentials'?'https://user:PRIVATE@client.example/callback':'https://client.example/callback?code=test'});
  };
  const h=await harness(send);await h.click(0);assert.equal(h.navigations.length,0);assert.ok(h.buttons.every(b=>!b.disabled));
  assert.match(h.status.textContent,/could not finish/);assert.doesNotMatch(h.status.textContent,/PRIVATE/);
});

test('the controller cannot POST a form to an external or unrelated endpoint',async()=>{
  for(const action of ['https://attacker.example/consent/decision','https://getrepot.com/other']){
    let calls=0;const h=await harness(async()=>{calls++;},action);await h.click(0);assert.equal(calls,0);assert.equal(h.navigations.length,0);
  }
});
