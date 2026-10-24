// Shared deterministic DOM adapter. It runs with Playwright or Ego's documented
// Page API; neither path needs a model to decide individual form actions.
export class PddDriver {
  constructor({ page, kind = "playwright", expectedShop, onEvent = () => {} }) {
    if (!["playwright", "ego"].includes(kind) || !page || !expectedShop?.trim())
      throw Error("缺少拼多多页面、连接类型或目标店铺完整名称");
    Object.assign(this, { page, kind, expectedShop, onEvent });
    this.saveEnabled = false;
    this.blockedError = null;
    this.guardChecks = new Set();
  }
  addGuardCheck(check){this.guardChecks.add(check);return()=>this.guardChecks.delete(check);}
  read(fn, arg) { return arg === undefined ? this.page.evaluate(fn) : this.page.evaluate(fn, arg); }
  async guard() {
    if (this.blockedError) throw Error(this.blockedError);
    const state = await this.read(() => {
      const visible = e => {
        if (!e?.getClientRects().length) return false;
        for (let p = e; p; p = p.parentElement) {
          const s = getComputedStyle(p);
          if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse") return false;
        }
        return true;
      };
      const names = [...document.querySelectorAll(".user-name-name .user-name-text")]
        .filter(visible).map(e => e.innerText.trim());
      const text = document.body.innerText;
      const blocked = /为保障您账号的安全，请验证手机|请完成安全验证|访问受限|操作过于频繁|拖动滑块完成验证/.test(text) ||
        [...document.querySelectorAll("iframe")].some(e => visible(e) && /验证码|安全验证/.test(e.title));
      return { url: location.href, names: [...new Set(names)], blocked };
    });
    if (state.blocked) {
      this.saveEnabled = false;
      this.blockedError = "SAFETY_BLOCKED：页面要求安全验证，已停止，保留原浏览器";
      await this.onEvent({ type: "safety-blocked", code: "SAFETY_BLOCKED" });
      throw Error(this.blockedError);
    }
    if (new URL(state.url).origin !== "https://mms.pinduoduo.com" || /\/login(?:\/|\?|$)/.test(new URL(state.url).pathname))
      throw Error("AUTH_REQUIRED：请在原窗口完成人工登录");
    if (state.names.length !== 1 || state.names[0] !== this.expectedShop)
      throw Error("店铺身份不符或无法唯一核对；目标为“" + this.expectedShop + "”，已停止");
    for(const check of this.guardChecks)await check();
    return state;
  }
  async click(selector, options = {}) {
    await this.guard();
    const targets = await this.read(selector => {
      const snapshot=selector.startsWith('xpath=')?document.evaluate(selector.slice(6),document,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null):null;
      const nodes=snapshot?Array.from({length:snapshot.snapshotLength},(_,i)=>snapshot.snapshotItem(i)):[...document.querySelectorAll(selector)];
      return nodes.map(e => {
      const button = e.closest("button,a") || e;
      return { text: button.innerText.trim(), id: button.id, tracking: button.getAttribute("data-tracking-viewid") };
      });
    }, selector);
    if (targets.some(t => t.id === "submit_button" || /提交并上架|提交并发布|立即上架|立即发布|确认发布|确定发布/.test(t.text)))
      throw Error("禁止正式发布商品");
    if (targets.some(t => t.tracking === "save_draft" || /保存草稿/.test(t.text)) && !this.saveEnabled)
      throw Error("保存门禁尚未通过，不能点击保存草稿");
    if(options.expectedText!==undefined&&(targets.length!==1||targets[0].text!==options.expectedText))
      throw Error('下拉选项内容已变化，停止以免选错：'+options.expectedText);
    return this.kind === "ego"
      ? this.page.click(selector.startsWith('xpath=')?selector:"loc=css:" + selector, { label: options.label || "填写拼多多商品资料", timeout: options.timeout || 15000 })
      : this.page.locator(selector).click({ timeout: options.timeout || 15000 });
  }
  async fill(selector, value, { blur = true } = {}) {
    await this.guard();
    const values = await this.read(css => [...document.querySelectorAll(css)].map(e => ({ type: e.type, disabled: e.disabled })), selector);
    if (values.length !== 1 || values[0].type === "hidden" || values[0].disabled)
      throw Error("输入控件不唯一、隐藏或不可填写：" + selector);
    if (this.kind === "ego") await this.page.fill("loc=css:" + selector, String(value), {timeout:15000});
    else await this.page.locator(selector).fill(String(value), { timeout: 15000 });
    if (blur) await this.press(selector, "Tab");
    const got = await this.read(css => {
      const nodes = document.querySelectorAll(css);
      return { count: nodes.length, value: nodes.length === 1 ? nodes[0].value : null,
        field: nodes.length === 1 ? nodes[0].placeholder : null };
    }, selector);
    if (got.count !== 1 || got.value !== String(value)) throw Error("输入回读不一致：" + (got.field || selector) +
      "；预期" + JSON.stringify(String(value)) + "，实际" + JSON.stringify(got.value));
  }
  async press(selector, key) {
    await this.guard();
    return this.kind === "ego" ? this.page.press("loc=css:" + selector, key, {timeout:15000})
      : this.page.locator(selector).press(key, { timeout: 15000 });
  }
  async setFiles(selector, files) {
    await this.guard();
    const count = await this.read(css => document.querySelectorAll(css).length, selector);
    if (count !== 1) throw Error("上传控件不是唯一匹配：" + selector);
    if (this.kind !== "ego") return this.page.locator(selector).setInputFiles(files, { timeout: 30000 });
    // Cold entry accepted a FileList without starting an upload. After entry
    // initialization, use the normal local-upload interaction once instead of
    // retrying a silent assignment after a timeout.
    const reveal = await this.read(css => {
      const input = document.querySelector(css);
      const card = input.closest('section[class*="goodsCarousel_uploadImgEnter"]') ||
        (input.getAttribute('data-tracking-click-viewid')==='detail_img_localfile_upload' ? input.closest('button') : null);
      if(input.getAttribute('data-tracking-click-viewid')==='detail_img_localfile_upload'&&!card)
        throw Error('详情图缺少可核对的本地上传按钮，尚未选择文件');
      if (!card) return null;
      const parts = [];
      for (let e = card; e && e !== document.documentElement; e = e.parentElement) {
        const siblings = [...e.parentElement.children].filter(p => p.tagName === e.tagName);
        parts.unshift(e.tagName.toLowerCase() + ":nth-of-type(" + (siblings.indexOf(e) + 1) + ")");
      }
      return "html > " + parts.join(" > ");
    }, selector);
    if (reveal) {
      await this.page.hover("loc=css:" + reveal, { label: "展开本地图片上传入口", timeout:15000 });
      const button = await this.read(css => {
        const e = document.querySelector(css)?.closest("button");
        if (!e?.getClientRects().length || e.disabled) throw Error("本地上传按钮尚未可用");
        const parts = [];
        for (let p = e; p && p !== document.documentElement; p = p.parentElement) {
          const siblings = [...p.parentElement.children].filter(n => n.tagName === p.tagName);
          parts.unshift(p.tagName.toLowerCase() + ":nth-of-type(" + (siblings.indexOf(p) + 1) + ")");
        }
        return "html > " + parts.join(" > ");
      }, selector);
      const pending = this.page.waitForFileChooser({timeout:15000});
      // Observe rejection even if the click fails; never re-dispatch files.
      pending.catch(() => {});
      await this.click(button, { label: "选择本地商品图片" });
      const chooser = await pending;
      await this.guard();
      return chooser.setFiles(files);
    }
    return this.page.setInputFiles("loc=css:" + selector, files);
  }
  async wait(fn, arg, timeout = 30000) {
    try { await this.page.waitForFunction(fn, arg, { timeout }); }
    catch (e) { await this.guard(); throw e; }
    await this.guard();
  }
  async wheel(selector, delta, deltaX = 0) {
    await this.guard();
    // Hovering a whole document/form makes auto-scroll chase an element taller
    // than the viewport. Place the wheel inside its currently visible portion.
    const point = await this.read(css => {
      const nodes = document.querySelectorAll(css);
      if (nodes.length !== 1) throw Error('滚动区域不唯一');
      const r = nodes[0] === document.scrollingElement
        ? {left:0,right:innerWidth,top:0,bottom:innerHeight} : nodes[0].getBoundingClientRect();
      const left=Math.max(1,r.left),right=Math.min(innerWidth-1,r.right);
      const top=Math.max(1,r.top),bottom=Math.min(innerHeight-80,r.bottom);
      if(right<=left||bottom<=top)throw Error('滚动区域不在当前可见页面内');
      return{x:(left+right)/2,y:(top+bottom)/2};
    },selector);
    if (this.kind === 'ego') await this.page.mouse.move(point.x,point.y,{label:'滚动显示当前表单控件'});
    else await this.page.mouse.move(point.x,point.y);
    return this.page.mouse.wheel(deltaX, delta);
  }
  async exposeFormControl(selector,{reserveBelow=0}={}) {
    // Native scrolling accounts for the merchant's fixed footer. DOM is read
    // only; a covered control is never force-clicked.
    let settled=false;
    for (let i = 0; i < 24; i++) {
      await this.guard();
      const pos = await this.read(({css,reserveBelow}) => {
        const cssPath = node => {
          if (node === document.documentElement) return "html";
          const parts = [];
          for (let p = node; p && p !== document.documentElement; p = p.parentElement) {
            const siblings = [...p.parentElement.children].filter(s => s.tagName === p.tagName);
            parts.unshift(p.tagName.toLowerCase() + ":nth-of-type(" + (siblings.indexOf(p) + 1) + ")");
          }
          return "html > " + parts.join(" > ");
        };
        const nodes = document.querySelectorAll(css);
        if (nodes.length !== 1) throw Error("控件不是唯一匹配");
        const e = nodes[0], r = e.getBoundingClientRect();
        const footer = document.querySelector(".goods-footer-main")?.getBoundingClientRect();
        let bottom = Math.min(innerHeight, footer?.top ?? innerHeight) - 24;
        let top = 1;
        bottom-=Math.min(reserveBelow,Math.max(0,(bottom-top)/2));
        const y = r.top + r.height / 2, x = r.left + r.width / 2;
        let left = 20, right = innerWidth - 20, horizontalTarget = document.scrollingElement;
        for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
          const box = p.getBoundingClientRect();
          if (/(?:auto|scroll)/.test(getComputedStyle(p).overflowX) && p.scrollWidth > p.clientWidth + 2 &&
              box.right > left && box.left < right && (x < box.left + 10 || x > box.right - 10)) {
            left = Math.max(left, box.left + 15); right = Math.min(right, box.right - 15); horizontalTarget = p; break;
          }
        }
        let form = e.closest("form");
        if (!form) throw Error("目标控件不在商品表单内");
        while (form.parentElement?.closest("form")) form = form.parentElement.closest("form");
        let scrollTarget = form;
        for (let p = e.parentElement; p && p !== form; p = p.parentElement) {
          const box = p.getBoundingClientRect();
          if (/(?:auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight + 2 &&
              box.bottom > top + 40 && box.top < bottom - 40 && (y < box.top || y > box.bottom)) {
            top = Math.max(top, box.top + 20); bottom = Math.min(bottom, box.bottom - 20); scrollTarget = p; break;
          }
        }
        const hit = document.elementFromPoint(x, y);
        return { x, left, right, horizontalSelector: cssPath(horizontalTarget), y, top, bottom, scrollSelector: cssPath(scrollTarget),
          reachable: x > left && x < right && y > top && y < bottom && (e === hit || e.contains(hit)) };
      }, {css:selector,reserveBelow});
      if (pos.reachable) {
        if(reserveBelow&&!settled){await this.settleControlGeometry(selector);settled=true;continue;}
        return;
      }
      settled=false;
      if (pos.x <= pos.left || pos.x >= pos.right) {
        await this.wheel(pos.horizontalSelector, 0, Math.max(-500,Math.min(500,pos.x-(pos.left+pos.right)/2)));
        await this.settleControlGeometry(selector);
        continue;
      }
      const delta = pos.y - (pos.top + pos.bottom) / 2;
      if (Math.abs(delta) < 35) throw Error("目标控件被其他弹层遮挡，请检查当前页面");
      await this.wheel(pos.scrollSelector, Math.max(-500, Math.min(500, delta)));
      // Native wheel dispatch returns before Chromium applies the scroll.
      // Re-reading immediately can queue another wheel and overshoot the field.
      await this.settleControlGeometry(selector);
    }
    throw Error("无法通过原生滚动显示目标控件");
  }
  async settleControlGeometry(selector){
    await this.read(async css=>{
      const start=performance.now();let signature='',since=start;
      for(;;){
        const nodes=document.querySelectorAll(css);if(nodes.length!==1)throw Error('等待布局时控件已变化');
        const e=nodes[0],r=e.getBoundingClientRect();let scroll='';
        for(let p=e.parentElement;p;p=p.parentElement)scroll+=p.scrollTop+','+p.scrollLeft+';';
        const next=[r.x,r.y,r.width,r.height,scroll].join('|'),now=performance.now();
        if(next!==signature){signature=next;since=now;}
        if(now-since>=120)return;
        if(now-start>=2000)throw Error('下拉控件位置仍在变化，尚未点击');
        await new Promise(resolve=>setTimeout(resolve,25));
      }
    },selector);
  }
  async exposeDropdownOption(selector){
    // Portal options may exist outside <form>, and getClientRects() stays
    // nonempty for options clipped by the list's own scrolling viewport.
    let settled=false;
    for(let i=0;i<20;i++){
      await this.guard();
      const pos=await this.read(css=>{
        const nodes=document.querySelectorAll(css);if(nodes.length!==1)throw Error('下拉选项不是唯一匹配');
        const e=nodes[0],portal=e.closest('[data-testid="beast-core-portal"][class*="ST_dropdown_"]');
        if(!portal||e.getAttribute('role')!=='option')throw Error('下拉选项归属已变化');
        const path=node=>{const parts=[];for(let p=node;p&&p!==document.documentElement;p=p.parentElement){const same=[...p.parentElement.children].filter(s=>s.tagName===p.tagName);parts.unshift(p.tagName.toLowerCase()+':nth-of-type('+(same.indexOf(p)+1)+')');}return'html > '+parts.join(' > ');};
        const r=e.getBoundingClientRect(),p=portal.getBoundingClientRect(),footer=document.querySelector('.goods-footer-main')?.getBoundingClientRect();
        let top=Math.max(1,p.top+2),bottom=Math.min(innerHeight-8,footer?.top-12||innerHeight-8,p.bottom-2),left=Math.max(1,p.left),right=Math.min(innerWidth-1,p.right),scroll;
        for(let a=e.parentElement;a&&a!==portal.parentElement;a=a.parentElement){
          const s=getComputedStyle(a),b=a.getBoundingClientRect();
          if(/auto|scroll|hidden|clip/.test(s.overflowY)){top=Math.max(top,b.top+2);bottom=Math.min(bottom,b.bottom-2);}
          if(/auto|scroll|hidden|clip/.test(s.overflowX)){left=Math.max(left,b.left+1);right=Math.min(right,b.right-1);}
          if(!scroll&&/auto|scroll/.test(s.overflowY)&&a.scrollHeight>a.clientHeight+2)scroll=a;
        }
        if(bottom-top<8||right-left<8)throw Error('下拉列表被底栏或页面边界遮挡，尚未点击选项');
        const x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);
        const inside=x>left&&x<right&&y>top&&y<bottom;
        return{x,y,top,bottom,inside,reachable:inside&&(e===hit||e.contains(hit)),scroll:scroll?path(scroll):null};
      },selector);
      if(pos.reachable){if(!settled){await this.settleControlGeometry(selector);settled=true;continue;}return;}
      settled=false;
      if(pos.inside)throw Error('下拉选项被其他元素遮挡，尚未点击选项');
      if(!pos.scroll)throw Error('下拉选项被遮挡，尚未点击选项');
      const delta=pos.y-(pos.top+pos.bottom)/2;
      if(Math.abs(delta)<8)throw Error('下拉选项被其他元素遮挡，尚未点击选项');
      await this.wheel(pos.scroll,Math.max(-400,Math.min(400,delta)));
      await this.settleControlGeometry(selector);
    }
    throw Error('下拉选项尚未滚动到可点击区域，未重复点击');
  }
  async step(name, work) {
    await this.guard();
    const started = Date.now();
    await this.onEvent({ type: "step-start", name });
    const result = await work();
    await this.guard();
    await this.onEvent({ type: "step-complete", name, durationMs: Date.now() - started });
    return result;
  }
}
