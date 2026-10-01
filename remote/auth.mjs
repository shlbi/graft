/**
 * @file Central Better Auth configuration for GitHub identity, OAuth 2.1, MCP authorization, CIMD, scopes, and token lifetimes.
 *
 * Production invariant: never log secrets, repository file bodies, OAuth tokens, or GitHub access tokens from this module.
 */
import {betterAuth} from 'better-auth';
import {jwt} from 'better-auth/plugins';
import {mcp} from '@better-auth/mcp';
import {cimd} from '@better-auth/cimd';
import {fetchClientMetadataResource} from '@better-auth/cimd/node';
import {db} from './db.mjs';
import {authBaseUrl,env,resource} from './env.mjs';
import {githubIdentity} from './github-identity.mjs';
let instance;
/**
 * @function getAuth
 * Constructs Repot's GitHub-only auth service; the provider's numeric subject
 * identifies an account, not its current handle or email address. The internal
 * .invalid alias exists only for Better Auth's required schema field.
 * OAuth state, PKCE, token exchange, account binding and sessions remain owned
 * by Better Auth. Never mark the alias verified or enable email-based linking.
 */
export function getAuth(){
  if(instance)return instance;
  instance=betterAuth({
    appName:'Repot',
    baseURL:authBaseUrl(),
    basePath:'/api/auth',
    secret:env('BETTER_AUTH_SECRET'),
    database:db(),
    trustedOrigins:['https://getrepot.com','https://mcp.getrepot.com'],
    advanced:{database:{joins:true}},
    // GitHub OAuth is the only identity proof. Email-shaped aliases are not
    // contact addresses, recovery channels, or proof that accounts should merge.
    emailAndPassword:{enabled:false},
    emailVerification:{sendOnSignUp:false,sendOnSignIn:false},
    user:{changeEmail:{enabled:false}},
    account:{accountLinking:{enabled:false}},
    socialProviders:{
      github:{
        clientId:env('GITHUB_CLIENT_ID'),
        clientSecret:env('GITHUB_CLIENT_SECRET'),
        redirectURI:'https://getrepot.com/auth/callback',
        disableDefaultScope:true,
        scope:[],
        getUserInfo:githubIdentity,
        // Refresh the handle/alias on a returning login using the SAME GitHub
        // subject. A renamed GitHub account must not create a second identity.
        overrideUserInfoOnSignIn:true
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
