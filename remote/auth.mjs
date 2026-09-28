import {betterAuth} from 'better-auth';
import {jwt} from 'better-auth/plugins';
import {mcp} from '@better-auth/mcp';
import {cimd} from '@better-auth/cimd';
import {fetchClientMetadataResource} from '@better-auth/cimd/node';
import {db} from './db.mjs';
import {env,resource} from './env.mjs';
let instance;
export function getAuth(){
  if(instance)return instance;
  instance=betterAuth({
    appName:'Repot',
    baseURL:env('BETTER_AUTH_URL'),
    basePath:'/api/auth',
    secret:env('BETTER_AUTH_SECRET'),
    database:db(),
    trustedOrigins:['https://getrepot.com','https://mcp.getrepot.com'],
    advanced:{database:{joins:true}},
    socialProviders:{
      github:{
        clientId:env('GITHUB_CLIENT_ID'),
        clientSecret:env('GITHUB_CLIENT_SECRET'),
        redirectURI:'https://getrepot.com/auth/callback'
      }
    },
    plugins:[
      jwt(),
      mcp({
        loginPage:'/sign-in',
        consentPage:'/consent',
        resource:resource(),
        scopes:['openid','profile','offline_access','repot:read','repot:write'],
        allowDynamicClientRegistration:true,
        allowUnauthenticatedClientRegistration:true,
        accessTokenExpiresIn:3600,
        refreshTokenExpiresIn:2592000,
        codeExpiresIn:300
      }),
      cimd({fetchClientMetadataResource,metadataProfile:'mcp-2026-07-28'})
    ]
  });
  return instance;
}
