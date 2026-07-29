/**
 * ui/i18n.ts —— 界面文字全部经此取得（NFR-11）。
 *
 * 唯一语言包 _locales/zh_CN/messages.json，default_locale = zh_CN。
 * 新增语言只需添加同结构 JSON，代码不改。
 */

export function t(key: string, ...args: string[]): string {
  if (typeof chrome !== 'undefined' && chrome.i18n?.getMessage) {
    const msg = chrome.i18n.getMessage(key, args);
    if (msg) return msg;
  }
  // 语言包缺键时暴露 key，便于开发期发现遗漏，而不是静默显示空白。
  return `⟦${key}⟧`;
}

/**
 * 扫描 DOM，把 data-i18n / data-i18n-attr 的元素填上文案。
 * HTML 里只写 key，避免文字硬编码在两处。
 */
export function localizeDom(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = el.dataset['i18n'];
    if (key) el.textContent = t(key);
  }
  // data-i18n-attr="placeholder:keyA,title:keyB"
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-attr]')) {
    const spec = el.dataset['i18nAttr'];
    if (!spec) continue;
    for (const pair of spec.split(',')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  }
  if (root === document) {
    const title = document.querySelector('title');
    const key = title?.dataset?.['i18n'];
    if (title && key) title.textContent = t(key);
    document.documentElement.lang = chrome?.i18n?.getUILanguage?.() ?? 'zh-CN';
  }
}
