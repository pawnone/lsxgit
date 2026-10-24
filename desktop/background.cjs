// Main-process lifecycle policy, independent of renderer timers.
function createBackgroundController({ powerSaveBlocker, Notification, showWindow, fallback }) {
  let blocker = null;
  const states = new Map(), live = new Set();
  function update(run, running) {
    const active = running && ['running', 'pausing'].includes(run?.status);
    if (active && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!active && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
    if (!run) return;
    const previous = states.get(run.id);
    states.set(run.id, run.status);
    // Never notify about historical state restored at startup.
    if (previous === undefined || previous === run.status) return;
    const titles = { complete: '本批任务已完成', stopped: '本批任务已停止', paused: '任务已暂停', 'safety-blocked': '需要人工处理安全验证', 'needs-review': '保存结果需要核实', failed: '任务执行失败' };
    titles['complete-with-errors']='本批结束，有失败商品';
    if (!titles[run.status]) return;
    const body = `已确认 ${run.tasks.filter(t => t.status === 'confirmed' || t.status === 'already-saved').length}/${run.tasks.length} 项，失败 ${run.tasks.filter(t=>t.status==='failed').length} 项。${run.error || '点击返回文青尚品查看详情'}`;
    if (!Notification.isSupported()) { fallback(titles[run.status], body); return; }
    try {
      const n = new Notification({ title: titles[run.status], body });
      live.add(n);
      n.on('click', showWindow);
      n.on('close', () => live.delete(n));
      n.on('failed', () => { live.delete(n); fallback(titles[run.status], body); });
      n.show();
    } catch { fallback(titles[run.status], body); }
  }
  return { update, dispose() { if (blocker !== null) powerSaveBlocker.stop(blocker); blocker = null; for (const n of live) n.close(); live.clear(); } };
}
module.exports = { createBackgroundController };
