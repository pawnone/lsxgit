/* Shared prototype task planning. No browser automation or platform connections. */
(function(root){
  function buildPlan({platform,products,shops}){
    if(!['dou','pdd'].includes(platform))throw new Error('请选择支持的平台');
    if(!products.length)throw new Error('请至少选择一个商品');
    if(!shops.length)throw new Error('请至少选择一家店铺');
    if(new Set(shops.map(s=>s.id)).size!==shops.length)throw new Error('店铺选择重复');
    if(new Set(products.map(p=>p.id)).size!==products.length)throw new Error('商品选择重复');
    for(const s of shops){
      if(s.platform!==platform)throw new Error('所选店铺不属于当前平台');
      if(!s.loggedIn)throw new Error(s.name+'：尚未登录');
      if(!s.verified||s.actualName!==s.name)throw new Error(s.name+'：尚未核对或店铺不符');
    }
    const shopCopies=shops.map(({id,name,platform})=>({id,name,platform}));
    const productCopies=products.map(({id,code,title,sku})=>({id,code,title,sku}));
    const tasks=shopCopies.flatMap((shop,shopIndex)=>productCopies.map((product,productIndex)=>({
      id:shop.id+'--'+product.id,number:shopIndex*productCopies.length+productIndex+1,
      shopId:shop.id,shopName:shop.name,productId:product.id,productCode:product.code,
      productTitle:product.title,skuCount:product.sku,operation:'save-draft'
    })));
    return {platform,draftOnly:true,shops:shopCopies,products:productCopies,tasks,
      taskCount:tasks.length,totalSkuWrites:tasks.reduce((s,t)=>s+t.skuCount,0)};
  }
  function selectionKey(plan){return JSON.stringify({platform:plan.platform,shops:plan.shops,products:plan.products,draftOnly:plan.draftOnly});}
  const api={buildPlan,selectionKey};root.ListingTaskPlan=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);
