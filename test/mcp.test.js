import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer, UI_URI } from '../server.js';
import { CatalogStore } from '../catalog-store.js';
import { imageUrl } from '../catalog.js';
import { FakeSource, first, second, COMMIT_A, COMMIT_B } from './helpers.js';
async function fixture() { const store = new CatalogStore({source:new FakeSource(),cacheFile:null}); await store.initialize(); return store; }
const IMAGE_URL = imageUrl(COMMIT_A, first.file);

test('MCP client discovers exactly one tool, calls it and reads its linked UI', async (t) => {
  const http = createHttpServer({catalogStore:await fixture()});
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${http.address().port}`;
  t.after(() => new Promise((resolve) => { http.close(resolve); http.closeAllConnections(); }));
  const clients = [];
  t.after(async () => { for (const client of clients) await client.close(); });
  async function connect(name) {
    const client = new Client({ name, version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    clients.push(client);
    return client;
  }
  const client = await connect('sticker-smoke-test');
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 1);
  const tool = listed.tools[0];
  assert.equal(tool.name, 'show_sticker');
  assert.equal(tool._meta.ui.resourceUri, UI_URI);
  assert.equal(tool._meta['openai/outputTemplate'], UI_URI);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.equal(tool.annotations.openWorldHint, false);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['id','query']);
  assert.equal(tool.inputSchema.required, undefined);
  assert.ok(tool.outputSchema);
  const result = await client.callTool({ name: tool.name, arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.sticker.imageUrl, IMAGE_URL);
  const resource = await client.readResource({ uri: UI_URI });
  assert.equal(resource.contents.length, 1);
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.deepEqual(resource.contents[0]._meta.ui.csp.resourceDomains, ['https://cdn.jsdelivr.net']);
  assert.deepEqual(resource.contents[0]._meta.ui.csp.connectDomains, []);
  assert.ok(!resource.contents[0].text.includes(IMAGE_URL));
  assert.ok(!resource.contents[0].text.includes(first.id));
  assert.ok(!resource.contents[0].text.includes('坏东西猫猫'));
  assert.ok(resource.contents[0].text.includes('chuyard/guxu-stickers'));
  assert.ok(!resource.contents[0].text.includes('/*__STICKER_CONFIG__*/null'));
  const second = await connect('second-client');
  const concurrent = await Promise.all([client, second].map(c => c.callTool({ name: tool.name, arguments: {} })));
  assert.ok(concurrent.every(r => r.structuredContent.sticker.imageUrl === IMAGE_URL));
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  assert.equal((await fetch(`${base}/preview`)).status, 404);
  for(const path of ['/admin','/sync','/upload','/catalog.json']) assert.equal((await fetch(base+path,{method:'POST'})).status,404);
  const invalidArgs = await client.callTool({name:tool.name,arguments:{id:123}});
  assert.equal(invalidArgs.isError,true);
  assert.equal((await fetch(`${base}/.well-known/oauth-authorization-server`)).status, 404);
  const preflight = await fetch(`${base}/mcp`, { method: 'OPTIONS', headers: { Origin: 'https://chatgpt.com' } });
  assert.equal(preflight.status, 204);
  assert.ok(preflight.headers.get('access-control-allow-headers').includes('MCP-Protocol-Version'));
  const rejected = await fetch(`${base}/mcp`, { method: 'POST', headers: { Origin: 'https://untrusted.invalid', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' });
  assert.equal(rejected.status, 403);
  const hostRejected = await new Promise((resolve, reject) => {
    const req = request(`${base}/mcp`, { method: 'POST', headers: { Host: 'untrusted.invalid', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(hostRejected, 403);
  const check = await promisify(execFile)(process.execPath, [new URL('../scripts/check-mcp.js', import.meta.url).pathname, `${base}/mcp`]);
  assert.ok(check.stdout.includes('PASS MCP initialization'));
});

test('Caddy can forward the verified public Host to the local service', async (t) => {
  const http = createHttpServer({ publicOrigin: 'https://ob.chuyard.cn', catalogStore:await fixture() });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { http.close(resolve); http.closeAllConnections(); }));
  const reply = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${http.address().port}/mcp`, {
      method: 'POST', headers: { Host: 'ob.chuyard.cn', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'caddy-host-check', version: '1' },
    } }));
  });
  assert.equal(reply.status, 200);
  assert.equal(JSON.parse(reply.body).result.serverInfo.name, 'guxu-stickers');
});


test('one running MCP server sees a second image and delisting without restart, schema or template change', async (t) => {
  const source = new FakeSource(); let clock = Date.now();
  const store = new CatalogStore({source,cacheFile:null,now:()=>clock}); await store.initialize();
  const http = createHttpServer({catalogStore:store});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{http.close(resolve);http.closeAllConnections();}));
  const client = new Client({name:'dynamic-inventory-acceptance',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`)));
  t.after(()=>client.close());
  const beforeTools=await client.listTools(), beforeUI=await client.readResource({uri:UI_URI});
  const call=args=>client.callTool({name:'show_sticker',arguments:args});
  const originalPid=process.pid, originalPort=http.address().port;
  assert.equal((await call({id:second.id})).structuredContent.error.code,'ID_NOT_FOUND');
  source.catalog.items.push(structuredClone(second));source.commit=COMMIT_B;clock+=120001;
  const added=await call({id:second.id});
  assert.equal(added.structuredContent.status,'ok');assert.equal(added.structuredContent.sticker.id,second.id);
  assert.equal(added.structuredContent.sticker.imageUrl,imageUrl(COMMIT_B,second.file));
  assert.equal((await call({query:'动态更新 技术验收'})).structuredContent.sticker.id,second.id);
  assert.deepEqual(await client.listTools(),beforeTools);
  assert.deepEqual(await client.readResource({uri:UI_URI}),beforeUI);
  assert.equal(process.pid,originalPid);assert.equal(http.address().port,originalPort);assert.equal(http.listening,true);
  source.commit='c'.repeat(40);source.catalog.items.pop();clock+=120001;
  assert.equal((await call({id:second.id})).structuredContent.error.code,'ID_NOT_FOUND');
  assert.equal((await call({})).structuredContent.sticker.id,first.id);
  const health=await (await fetch(`http://127.0.0.1:${originalPort}/healthz`)).json();
  assert.equal(health.catalog.commit,'c'.repeat(40));assert.equal(health.catalog.status,'ok');
});
