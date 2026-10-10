'use strict';
// This test requests fullscreen only inside a direct, parked user's click.
(()=>{
  const root=document.documentElement, enter=document.getElementById('fullscreenEnter'),exit=document.getElementById('fullscreenExit');
  const parked=document.getElementById('parked'),status=document.getElementById('fullscreenStatus');
  let pending=null,timer=null,settleTimer=null,sequence=0;
  const attempts=[],events=[];
  let latestGeometry=null;
  function active(){return !!(document.fullscreenElement||document.webkitFullscreenElement);}
  function capabilities(){return {request:typeof root.requestFullscreen==='function'?'requestFullscreen':typeof root.webkitRequestFullscreen==='function'?'webkitRequestFullscreen':null,exit:typeof document.exitFullscreen==='function'?'exitFullscreen':typeof document.webkitExitFullscreen==='function'?'webkitExitFullscreen':null,fullscreenEnabled:typeof document.fullscreenEnabled==='boolean'?document.fullscreenEnabled:typeof document.webkitFullscreenEnabled==='boolean'?document.webkitFullscreenEnabled:null,active:active()};}
  function paint(){const c=capabilities();enter.disabled=!parked.checked||!!pending||c.active||!c.request;exit.disabled=!!pending||!c.active||!c.exit;document.getElementById('fullscreenSupport').textContent='进入 API：'+(c.request||'不可用')+'；退出 API：'+(c.exit||'不可用')+'；fullscreenEnabled：'+(c.fullscreenEnabled===null?'不可用':String(c.fullscreenEnabled))+'；实际全屏：'+(c.active?'是':'否');}
  function sample(label){return sampleGeometry('fullscreen-'+label);}
  function settle(attempt){clearTimeout(settleTimer);settleTimer=setTimeout(()=>{latestGeometry=sample('after-settled');if(attempt){if(!attempt.after)attempt.after=latestGeometry;document.getElementById('fullscreenComparison').textContent=JSON.stringify({before:attempt.before,after:attempt.after},null,2);}paint();report();},300);}
  function note(type){events.push({type,at:new Date().toISOString(),active:active()});if(events.length>40)events.shift();}
  function finish(attempt,outcome,error){if(pending!==attempt)return;clearTimeout(timer);pending=null;attempt.outcome=outcome;attempt.completedAt=new Date().toISOString();if(error)attempt.error={name:error.name||'Error',message:String(error.message||'浏览器未提供详细原因')};status.textContent=outcome==='entered'?'已确认进入全屏（实际 fullscreenElement）':outcome==='exited'?'已确认退出全屏':outcome==='unconfirmed'?'尚未确认全屏状态变化；可以手动重试。': '请求失败：'+attempt.error.name+'。'+attempt.error.message+'。请确认页面在前台并直接点击按钮；浏览器或嵌入策略可能限制全屏。';paint();settle(attempt);report();}
  function change(event){note(event.type);if(pending&&active()===(pending.action==='enter'))finish(pending,active()?'entered':'exited');else {status.textContent=active()?'浏览器状态已改变：当前处于全屏':'已退出全屏（可能按了 Esc 或由浏览器退出）';paint();settle(attempts[attempts.length-1]);} }
  function request(action){if(pending||(action==='enter'&&!parked.checked))return;const c=capabilities(),method=action==='enter'?c.request:c.exit;if(!method){status.textContent='此浏览器未提供'+(action==='enter'?'进入':'退出')+'全屏 API。';paint();return;}
    const attempt={id:++sequence,action,startedAt:new Date().toISOString(),capabilities:c,before:sample('before'),outcome:'pending',after:null};attempts.push(attempt);if(attempts.length>20)attempts.shift();pending=attempt;status.textContent='请求中；等待实际全屏状态变化…';paint();
    timer=setTimeout(()=>{if(pending===attempt)finish(attempt,active()===(action==='enter')?(action==='enter'?'entered':'exited'):'unconfirmed');},5000);
    // Do not insert await, timers, or another permission request before this call.
    try{const result=(action==='enter'?root:document)[method]();if(result&&typeof result.then==='function')result.then(()=>{attempt.promise='resolved';if(pending===attempt&&active()===(action==='enter'))finish(attempt,action==='enter'?'entered':'exited');},error=>{attempt.promise='rejected';finish(attempt,'failed',error);});}catch(error){finish(attempt,'failed',error);}report();
  }
  enter.onclick=()=>request('enter');exit.onclick=()=>request('exit');parked.addEventListener('change',paint);
  for(const type of ['fullscreenchange','webkitfullscreenchange'])document.addEventListener(type,change);
  for(const type of ['fullscreenerror','webkitfullscreenerror'])document.addEventListener(type,event=>{note(event.type);if(pending)finish(pending,'failed',{name:'FullscreenError',message:'浏览器触发 '+event.type+'，未提供详细原因'});else {paint();report();}});
  window.addEventListener('resize',()=>settle(attempts[attempts.length-1]));
  if(window.visualViewport)window.visualViewport.addEventListener('resize',()=>settle(attempts[attempts.length-1]));
  window.fullscreenReport=()=>({version:'v1.3 FULLSCREEN',capabilities:capabilities(),pending:pending?pending.id:null,attempts,events,latestGeometry,limits:'Actual browser fullscreen only. Does not bypass vehicle restrictions or establish native panel resolution. Last 20 attempts and 40 events retained.'});
  paint();report();
})();
