/**
 * @file Next.js production configuration, including security headers and framework-level deployment behavior.
 *
 * Production invariant: never log secrets, repository file bodies, OAuth tokens, or GitHub access tokens from this module.
 */
const nextConfig={
  poweredByHeader:false,
  reactStrictMode:true,
  experimental:{serverActions:{bodySizeLimit:'1mb'}},
  async headers(){return[{source:'/:path*',headers:[
    {key:'X-Content-Type-Options',value:'nosniff'},
    {key:'Referrer-Policy',value:'no-referrer'},
    {key:'X-Frame-Options',value:'DENY'},
    {key:'Permissions-Policy',value:'camera=(), microphone=(), geolocation=()'},
    {key:'Strict-Transport-Security',value:'max-age=63072000; includeSubDomains; preload'},
    {key:'Content-Security-Policy',value:"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"}
  ]}]}
};
export default nextConfig;
