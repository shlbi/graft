import test from 'node:test';
import assert from 'node:assert/strict';

let responseFactory;
const auth={
  api:{
    signInSocial:async options=>{
      responseFactory?.options?.(options);
      return responseFactory.response();
    }
  }
};

const source=await import('node:fs/promises').then(fs=>fs.readFile(new URL('../route.js',import.meta.url),'utf8'));

test('GitHub auth bridge is coded to preserve Better Auth headers and issue a real redirect',()=>{
  assert.match(source,/upstream\.clone\(\)\.json\(\)/);
  assert.match(source,/new Headers\(upstream\.headers\)/);
  assert.match(source,/status:302/);
  assert.match(source,/headers\.set\('location'/);
});

test('GitHub auth bridge allowlists only the expected GitHub OAuth authorization endpoint',()=>{
  assert.match(source,/url\.protocol!=='https:'/);
  assert.match(source,/url\.hostname!=='github\.com'/);
  assert.match(source,/url\.pathname!=='\/login\/oauth\/authorize'/);
  assert.doesNotMatch(source,/Response\.redirect\(handoff\.url/);
});

test('GitHub auth bridge keeps post-login callback relative to Repot',()=>{
  assert.match(source,/next\.startsWith\('\/'\)&&!next\.startsWith\('\/\/'\)/);
  assert.match(source,/callbackURL/);
  assert.match(source,/errorCallbackURL:'\/sign-in\?error=github'/);
});
