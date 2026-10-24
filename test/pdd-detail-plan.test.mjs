import test from "node:test";
import assert from "node:assert/strict";
import { detailImagePlan } from "../engine/pdd/media.mjs";

test("keep details then cycle main slots without mutating inputs", () => {
  const p = { sizeImage: "/size.png", detailImages: ["/detail1.png", "/detail2.png"], mainImages: ["/main1.png", "/main2.png", "/main3.png"] };
  const before = JSON.stringify(p), result = detailImagePlan(p);
  assert.deepEqual(result, ["/size.png", "/detail1.png", "/detail2.png", ...Array.from({length:14}, (_,i)=>p.mainImages[i%3])]);
  assert.equal(JSON.stringify(p), before);
});
test("size path repeated in source lists only appears first once", () => {
  const result = detailImagePlan({sizeImage:"/size.png",detailImages:["/size.png"],mainImages:["/size.png","/main.png"]});
  assert.deepEqual(result, ["/size.png", ...Array(16).fill("/main.png")]);
});
test("exactly sixteen existing details need no main images", () => {
  const detailImages = Array.from({length:16},(_,i)=>`/detail${i}.png`);
  assert.deepEqual(detailImagePlan({sizeImage:"/size.png",detailImages}), ["/size.png",...detailImages]);
});
test("size chart is optional; unusable refill and excess details still fail explicitly", () => {
  assert.deepEqual(detailImagePlan({mainImages:["/main.png"]}),Array(17).fill("/main.png"));
  assert.throws(()=>detailImagePlan({sizeImage:"/size.png"}), /主图目录/);
  assert.throws(()=>detailImagePlan({sizeImage:"/size.png",detailImages:Array(17).fill("/detail.png")}), /超过16/);
});
