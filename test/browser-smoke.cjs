const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const root = path.resolve(__dirname, '..');
  const { createMcpServer, UI_URI } = await import(root + '/server.js');
  const { CatalogStore } = await import(root + '/catalog-store.js');
  const { imageUrl } = await import(root + '/catalog.js');
  const { FakeSource, first, second, photo, secondBytes, COMMIT_B } = await import('./helpers.js');
  const { Client } = await import(root + '/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const { InMemoryTransport } = await import(root + '/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js');
  const source = new FakeSource(), store = new CatalogStore({ source, cacheFile: null }); await store.initialize();
  const server = createMcpServer({ catalogStore: store }), client = new Client({ name: 'inventory-ui-qa', version: '1' });
  const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  const result = await client.callTool({ name: 'show_sticker', arguments: {} });
  const resource = (await client.readResource({ uri: UI_URI })).contents[0];
  assert.equal(resource._meta.ui.prefersBorder, false);
  assert.ok(!resource.text.includes(first.id)); assert.ok(!resource.text.includes(first.file));
  const secondResult = { ...result, structuredContent: { ...result.structuredContent, sticker: { id: second.id, title: second.title, alt: second.alt, imageUrl: imageUrl(COMMIT_B, second.file) } } };
  const browser = await chromium.launch({ executablePath: process.env.QA_CHROMIUM_EXECUTABLE, args: ['--no-sandbox','--disable-gpu','--disable-dev-shm-usage'] });
  const exceptions = [];
  async function routeImages(page, fail=false) {
    await page.unroute('https://cdn.jsdelivr.net/**');
    await page.route('https://cdn.jsdelivr.net/**', route => fail ? route.abort() : route.fulfill(route.request().url().endsWith('.png') ? {contentType:'image/png',body:secondBytes} : {contentType:'image/jpeg',body:photo}));
  }
  async function mount(width, fail=false) {
    const page = await browser.newPage({viewport:{width,height:700},isMobile:width<500,hasTouch:width<500});
    page.on('pageerror',e=>exceptions.push(e.message));await routeImages(page,fail);
    await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><iframe sandbox="allow-scripts" style="width:100%;height:600px;border:0"></iframe>');
    await page.evaluate(({html,result})=>{
      window.sizes=[];window.addEventListener('message',event=>{
        const frame=document.querySelector('iframe');if(event.source!==frame.contentWindow)return;
        const msg=event.data;
        if(msg?.method==='ui/initialize')frame.contentWindow.postMessage({jsonrpc:'2.0',id:msg.id,result:{protocolVersion:'2026-01-26'}},'*');
        if(msg?.method==='ui/notifications/initialized')frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:result},'*');
        if(msg?.method==='ui/notifications/size-changed'){window.sizes.push(msg.params.height);frame.style.height=msg.params.height+'px';}
      });
      const csp='<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; img-src https://cdn.jsdelivr.net; style-src &#39;unsafe-inline&#39;; script-src &#39;unsafe-inline&#39;">';
      document.querySelector('iframe').srcdoc=html.replace('<head>','<head>'+csp);
    },{html:resource.text,result});
    const frame=page.frameLocator('iframe');
    const send=async data=>page.evaluate(data=>document.querySelector('iframe').contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:data},'*'),data);
    const loaded=async()=>{await frame.locator('#sticker').waitFor({state:'visible'});await frame.locator('#sticker').evaluate(img=>img.complete&&img.naturalWidth?null:new Promise(resolve=>img.addEventListener('load',resolve,{once:true})));};
    return {page,frame,send,loaded};
  }
  try {
    for(const width of [320,390,800]) {
      const {page,frame,send,loaded}=await mount(width);await loaded();
      const state=await frame.locator('body').evaluate(body=>({text:body.innerText.trim(),width:body.querySelector('img').getBoundingClientRect().width,height:body.querySelector('main').getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>innerWidth}));
      assert.deepEqual(state,{text:'',width:160,height:160,overflow:false});await page.waitForFunction(()=>window.sizes.includes(160));
      await send(secondResult);await frame.locator('#sticker').evaluate((img,id)=>img.src.includes(id)?null:new Promise(resolve=>{const timer=setInterval(()=>{if(img.src.includes(id)){clearInterval(timer);resolve();}},10)}),second.id);await loaded();
      assert.equal(await frame.locator('#sticker').getAttribute('alt'),second.alt);
      assert.equal(await frame.locator('#sticker').evaluate(img=>img.naturalWidth),32);
      assert.equal((await frame.locator('body').innerText()).trim(),'');
      await send(result);await page.waitForFunction(()=>window.sizes.includes(160));await loaded();
      await send({...result,_meta:{presentation:{imageSize:120,padding:4,radius:6}}});
      await page.waitForFunction(()=>window.sizes.includes(128));assert.equal(await frame.locator('#sticker').evaluate(img=>img.getBoundingClientRect().width),120);
      console.log('PASS compact UI, image-only state, 160px height, repeated image switching and metadata:',width);
      if(width===390){fs.mkdirSync(path.join(root,'test-results'),{recursive:true});await page.screenshot({path:path.join(root,'test-results/inventory-ui.png')});}
      const badUrls=[result.structuredContent.sticker.imageUrl.replace('chuyard/guxu-stickers','other/repo'),result.structuredContent.sticker.imageUrl.replace('https://cdn.jsdelivr.net','https://example.com'),result.structuredContent.sticker.imageUrl.replace(/@[a-f0-9]{40}/,'@main'),result.structuredContent.sticker.imageUrl.replace('/stickers/','/incoming/'),result.structuredContent.sticker.imageUrl+'?x=1'];
      for(const imageUrl of badUrls){await send({...result,structuredContent:{...result.structuredContent,sticker:{...result.structuredContent.sticker,imageUrl}}});await frame.locator('#image-error').waitFor({state:'visible'});assert.equal(await frame.locator('#sticker').isVisible(),false);assert.equal(await frame.locator('#retry').isVisible(),false);}
      await send(result);await loaded();
      await send({structuredContent:{status:'no_match',sticker:null,error:null}});await frame.locator('#image-error').waitFor({state:'visible'});assert.match(await frame.locator('#image-error').innerText(),/没有合适/);assert.equal(await frame.locator('#sticker').isVisible(),false);
      await send(result);await loaded();
      await send({isError:true,structuredContent:{status:'error',sticker:null,error:{code:'ID_NOT_FOUND'}}});await frame.locator('#image-error').waitFor({state:'visible'});assert.match(await frame.locator('#image-error').innerText(),/未找到指定/);assert.equal(await frame.locator('#sticker').isVisible(),false);
      console.log('PASS illegal repository URLs, no match and missing ID clear previous image:',width);await page.close();
    }
    const {page,frame,loaded}=await mount(390,true);await frame.locator('#retry').waitFor({state:'visible'});await routeImages(page);await frame.locator('#retry').click();await loaded();assert.equal((await frame.locator('body').innerText()).trim(),'');await page.close();
    console.log('PASS image network failure and retry recovery');
    const legacy=await browser.newPage();legacy.on('pageerror',e=>exceptions.push(e.message));await routeImages(legacy);
    await legacy.setContent(resource.text.replace('<script>','<script>window.openai={toolOutput:'+JSON.stringify(result.structuredContent)+'};'));
    await legacy.locator('#sticker').waitFor({state:'visible'});
    await legacy.evaluate(data=>{window.openai.toolOutput=data;window.dispatchEvent(new Event('openai:set_globals'));},secondResult.structuredContent);
    await legacy.waitForFunction(id=>document.querySelector('#sticker').src.includes(id)&&document.querySelector('#sticker').naturalWidth===32,second.id);
    assert.equal((await legacy.locator('body').innerText()).trim(),'');
    await legacy.evaluate(()=>{window.openai.toolOutput={status:'no_match',sticker:null};window.dispatchEvent(new Event('openai:set_globals'));});
    await legacy.locator('#image-error').waitFor({state:'visible'});assert.equal(await legacy.locator('#sticker').isVisible(),false);
    console.log('PASS legacy initial result, later image change and no-match clearing');
    assert.deepEqual(exceptions,[]);console.log('PASS no uncaught browser exceptions');
  } finally {await browser.close();await client.close();await server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
