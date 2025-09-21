/**
 * Shared test helpers to reduce duplication in HTTP request creation and polling.
 * Non-goals: abstract every test concern; keep surface minimal & stable.
 */
import http from 'node:http';

export function httpRequest(port: number, path: string, method='GET', body?: any, headers?: Record<string,string>): Promise<{code:number, body:string}> {
  return new Promise((resolve,reject)=>{
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({ port, path, method, headers: { ...(data?{ 'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(data)) }:{}), ...(headers||{}) } }, res=>{
      let chunks=''; res.on('data',c=>chunks+=c); res.on('end',()=>resolve({code:res.statusCode||0, body:chunks}));
    });
    req.on('error',reject); if(data) req.write(data); req.end();
  });
}

export async function createGuardRequest(port: number, partial?: any): Promise<{ token: string }> {
  const base = {
    action: 'rerequest_demo',
    params: { foo: 'bar' },
    meta: {
      origin: { repo: 'a/b' },
      requester: { id: 'U1', source: 'slack' },
      justification: 'trace test'
    }
  };
  const res = await httpRequest(port, '/api/guard/request','POST', { ...base, ...(partial||{}) });
  if(res.code!==200) throw new Error('createGuardRequest failed: '+res.body);
  return JSON.parse(res.body);
}
