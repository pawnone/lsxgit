// Serializable DOM reader. Only the observed draft-save acknowledgement or
// established draft-specific success messages count; an allocated ID does not.
export function draftSaveNoticeDom() {
  const bodies=[...document.querySelectorAll('[data-testid="beast-core-modal-body"]')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');
  const matches=bodies.filter(e=>[...e.querySelectorAll('h2,h3')].some(h=>/^保存成功[!！。]?$/.test(h.innerText.trim()))&&
    e.innerText.replace(/\s/g,'').includes('提交商品信息且发布成功后方可生效'));
  if(matches.length===1)return{kind:'draft-save-modal',text:matches[0].innerText.trim()};
  const legacy=document.body.innerText.match(/保存草稿成功|草稿保存成功|已保存至草稿箱/);
  return legacy?{kind:'draft-specific-message',text:legacy[0]}:null;
}
