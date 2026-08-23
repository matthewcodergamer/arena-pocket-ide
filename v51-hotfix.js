/* X Coder 5.1 final runtime polish */
(()=>{
  const apply=()=>{
    document.documentElement.dataset.xcoderVersion='5.1.0';
    const icon='./icons/app-icon.svg';
    const ios='./icons/apple-touch-icon-v51.svg';
    document.querySelectorAll('link[rel="icon"]').forEach(l=>l.href=icon);
    document.querySelectorAll('link[rel="apple-touch-icon"]').forEach(l=>l.href=ios);
    document.querySelectorAll('img.drawer-app-icon').forEach(i=>{if(!i.src.endsWith('/app-icon.svg'))i.src=icon;});
    const send=document.querySelector('#aiSendBtn');
    if(send){send.title='Tap to send · hold and slide to choose a model';send.setAttribute('aria-label','Send message. Hold and slide to choose AI model.');}
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',apply,{once:true});else apply();
  window.addEventListener('pageshow',apply,{passive:true});
})();
