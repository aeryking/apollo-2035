/**
 * 保存测试结果：优先 POST 回开发服务器（docs/bench/inbox/），失败再退回浏览器下载。
 * 这样 Safari（自动下载会弹确认框）和局域网里的其它电脑都能把结果直接送回来。
 */
export async function saveResult(name, text, type = 'application/json') {
  try {
    const r = await fetch(`/__bench/save?name=${encodeURIComponent(name)}`, { method: 'POST', body: text, headers: { 'content-type': type } });
    if (r.ok) return 'server';
  } catch { /* 生产环境没有回收端，走下载 */ }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  return 'download';
}

/** 浏览器标识（报告里区分 Chrome / Safari / Edge） */
export function browserTag() {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'edge';
  if (/Chrome\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  if (/Firefox\//.test(ua)) return 'firefox';
  return 'other';
}
