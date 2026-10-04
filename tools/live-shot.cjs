/** 线上真实环境渲染截图（登录页），用于确认部署后无致命错误 */
const exe='C:/Users/Administrator/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core';
const {chromium:cr}=require(exe);
const url=process.argv[2], out=process.argv[3];
(async()=>{
  const b=await cr.launch({channel:'msedge'}).catch(()=>cr.launch());
  const p=await b.newPage({viewport:{width:1440,height:900}});
  const errs=[];
  p.on('pageerror',e=>{const m=e.message.split('\n')[0];if(!/favicon|404/i.test(m))errs.push(m);});
  p.on('console',m=>{if(m.type()==='error'&&!/favicon|404|Failed to load resource/i.test(m.text()))errs.push('console: '+m.text().slice(0,140));});
  await p.goto(url,{waitUntil:'domcontentloaded'});
  await p.waitForTimeout(5000);
  const r=await p.evaluate(()=>{const a=document.getElementById('app');
    return {kids:a?a.children.length:-1,len:a?a.innerHTML.length:0,h:a?Math.round(a.getBoundingClientRect().height):0};});
  console.log(url+'  #app.children='+r.kids+' innerHTML='+r.len+' 高='+r.h);
  console.log('JS 错误: '+(errs.length?errs.join(' | '):'无'));
  await p.screenshot({path:out});
  await b.close();
})().catch(e=>{console.error('FATAL',e.message);process.exit(1)});
