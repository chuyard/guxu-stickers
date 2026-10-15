import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { CatalogStore } from './catalog-store.js';
import { REPOSITORY, selectSticker, imageUrl } from './catalog.js';

export const UI_URI = 'ui://guxu-stickers/inventory-image-v5.html';
export const VERSION = '0.3.0';
export const TOOL_DESCRIPTION = '只读显示正式库存中的单张表情包。id 精确选图，不存在则报错且不替换；query 综合匹配标题、原文、标签、同义表达、适用语境和语气，并排除与 avoid 明显冲突的结果，匹配不足返回没有合适的表情包。同时提供 id 和 query 时以 id 为准；均省略则显示默认图片。查询应包含当前聊天的实际语境，尤其是真难过、认真表达不满或严肃冲突等限制；不要只保留正面关键词。只检索仓库已发布目录，不生成图片、不写入仓库。调用后自然回应，不播报工具过程；数据返回不代表客户端图片已加载。';
const template = readFileSync(new URL('./public/sticker.html', import.meta.url), 'utf8');
const jsonForHtml = value => JSON.stringify(value).replaceAll('<', '\\u003c');
const html = template.replace('/*__STICKER_CONFIG__*/null', jsonForHtml({ repository: REPOSITORY }));
const defaultStore = new CatalogStore();
const outputSchema = {
  status: z.enum(['ok', 'no_match', 'error']),
  sticker: z.object({ id: z.string(), title: z.string(), alt: z.string(), imageUrl: z.string().url() }).nullable(),
  catalog: z.object({ commit: z.string(), stale: z.boolean() }).nullable(),
  selection: z.object({ mode: z.enum(['id', 'query', 'default']), score: z.number().optional(), matchedFields: z.array(z.string()).optional() }).nullable(),
  error: z.object({ code: z.enum(['ID_NOT_FOUND', 'CATALOG_UNAVAILABLE']), message: z.string() }).nullable(),
};

export async function showSticker(store, args) {
  let snapshot;
  try { snapshot = await store.getSnapshot(); }
  catch {
    const error = { code: 'CATALOG_UNAVAILABLE', message: '表情包库存暂时不可用，请稍后重试。' };
    return { isError: true, structuredContent: { status: 'error', sticker: null, catalog: null, selection: null, error }, content: [{ type: 'text', text: error.message }] };
  }
  const selected = selectSticker(snapshot.catalog, args);
  const catalog = { commit: snapshot.commit, stale: store.health().stale };
  if (selected.status === 'error') {
    const error = { code: selected.code, message: selected.message };
    return { isError: true, structuredContent: { status: 'error', sticker: null, catalog, selection: null, error }, content: [{ type: 'text', text: error.message }] };
  }
  if (selected.status === 'no_match') return {
    structuredContent: { status: 'no_match', sticker: null, catalog, selection: { mode: 'query' }, error: null },
    content: [{ type: 'text', text: '没有合适的表情包。' }],
  };
  const { id, title, alt, file } = selected.item;
  return {
    structuredContent: { status: 'ok', sticker: { id, title, alt, imageUrl: imageUrl(snapshot.commit, file) }, catalog, selection: selected.selection, error: null },
    content: [{ type: 'text', text: title }],
    _meta: { presentation: { imageSize: 160, padding: 0, radius: 8 } },
  };
}

export function createMcpServer({ catalogStore = defaultStore } = {}) {
  const server = new McpServer({ name: 'guxu-stickers', version: VERSION });
  registerAppResource(server, 'inventory-sticker', UI_URI, {}, async () => ({
    contents: [{
      uri: UI_URI, mimeType: RESOURCE_MIME_TYPE, text: html,
      _meta: {
        ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: ['https://cdn.jsdelivr.net'] } },
        'openai/widgetDescription': '显示本次选中的单张表情包。正常状态只显示图片，失败时显示重试。无需重复描述卡片或解释工具。',
        'openai/widgetPrefersBorder': false,
        'openai/widgetCSP': { connect_domains: [], resource_domains: ['https://cdn.jsdelivr.net'] },
      },
    }],
  }));
  registerAppTool(server, 'show_sticker', {
    title: '表情包', description: TOOL_DESCRIPTION,
    inputSchema: {
      id: z.string().trim().min(1).max(80).optional().describe('稳定图片 ID；优先于 query，未知 ID 明确报错。'),
      query: z.string().max(1000).optional().describe('完整查询语境、内容、情绪或标签；保留严肃冲突、真难过等不适用情形。'),
    },
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    securitySchemes: [{ type: 'noauth' }],
    _meta: {
      securitySchemes: [{ type: 'noauth' }], ui: { resourceUri: UI_URI, visibility: ['model'] },
      'openai/outputTemplate': UI_URI,
      'openai/toolInvocation/invoking': '打开表情包', 'openai/toolInvocation/invoked': '表情包',
    },
  }, async args => showSticker(catalogStore, args));
  return server;
}

export function createHttpServer({ publicOrigin = process.env.PUBLIC_ORIGIN, catalogStore = defaultStore } = {}) {
  const publicUrl = publicOrigin ? new URL(publicOrigin) : null;
  if (publicUrl && (publicUrl.protocol !== 'https:' || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password)) {
    throw new Error('PUBLIC_ORIGIN 必须是 HTTPS origin，例如 https://stickers.example.com');
  }
  const localHosts = ['localhost', '127.0.0.1', '[::1]'];
  const allowedHosts = [...localHosts];
  if (publicUrl) allowedHosts.push(publicUrl.host);
  const allowedOrigins = ['https://chatgpt.com', 'https://chat.openai.com'];
  if (publicUrl) allowedOrigins.push(publicUrl.origin);
  return createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'GET' && (pathname === '/' || pathname === '/healthz')) {
      res.writeHead(catalogStore.health().available ? 200 : 503, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: catalogStore.health().available, service: 'guxu-stickers', version: VERSION, catalog: catalogStore.health() }));
      return;
    }
    // A local browser preview is a separate test; it does not prove ChatGPT renders the resource.
    if (req.method === 'GET' && pathname === '/preview' && process.env.ENABLE_PREVIEW === '1') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      const result = await showSticker(catalogStore, {});
      res.end(html.replace('const LOCAL_PREVIEW = false;', 'const LOCAL_PREVIEW = true;').replace('/*__PREVIEW_RESULT__*/null', jsonForHtml(result)));
      return;
    }
    if (pathname !== '/mcp') {
      res.writeHead(404).end('Not found');
      return;
    }
    const origin = req.headers.origin;
    const isLocalOrigin = origin && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
    if (origin && (allowedOrigins.includes(origin) || isLocalOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
      }).end();
      return;
    }
    if (!['POST', 'GET', 'DELETE'].includes(req.method)) {
      res.writeHead(405, { Allow: 'POST, GET, DELETE, OPTIONS' }).end();
      return;
    }
    const server = createMcpServer({ catalogStore });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: [...allowedHosts, ...localHosts.map(h => `${h}:${req.socket.localPort}`)],
      allowedOrigins: isLocalOrigin ? [...allowedOrigins, origin] : allowedOrigins,
    });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('MCP request failed:', error.message);
      if (!res.headersSent) res.writeHead(500).end('MCP request failed');
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8788), host = process.env.HOST ?? '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  await defaultStore.initialize();
  const httpServer = createHttpServer();
  httpServer.listen(port, host, () => console.log(`Gu Xu sticker MCP ${VERSION} listening at http://${host}:${port}/mcp`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => httpServer.close(() => process.exit(0)));
}
