/* Review frame for earlier mock prototypes. Does not own product behavior. */
(() => {
  "use strict";
  function mount() {
    const config = document.getElementById("np-review-config");
    const page = document.querySelector("[data-np-root]");
    if (!config || !page) return;
    const c = JSON.parse(config.textContent);
    const device = page.querySelector("[data-np-device]");
    const fixtures = page.querySelector("[data-np-fixtures]");
    const older = page.querySelector("[data-np-legacy]");
    const product = document.querySelector(c.surface);
    if (!product || !device || !fixtures || !older || page.contains(product)) {
      console.error("Prototype review frame: missing product", c.surface); return;
    }
    for (const selector of c.external || []) {
      for (const element of document.querySelectorAll(selector)) {
        if (!page.contains(element) && element !== product && !element.contains(product)) fixtures.appendChild(element);
      }
    }
    for (const selector of c.extra || []) {
      for (const element of document.querySelectorAll(selector)) {
        if (!page.contains(element) && element !== product) device.appendChild(element);
      }
    }
    device.prepend(product);
    for (const item of c.proxy || []) {
      const button = document.createElement("button");
      button.type = "button"; button.className = "np-bridge-action";
      button.textContent = item[0];
      button.addEventListener("click", () => {
        const target = product.querySelector(item[1]);
        if (target) target.click();
      });
      fixtures.appendChild(button);
    }
    for (const selector of c.hide || []) {
      const style = document.createElement("style");
      style.textContent = 'body[data-nession-prototype-frame="v1"] .np-device ' + selector + '{display:none!important}';
      document.head.appendChild(style);
    }
    for (const element of [...document.body.children]) {
      if (element !== page && element.tagName !== "SCRIPT" && element.tagName !== "STYLE") older.appendChild(element);
    }
    // Legacy CSS is viewport-media based. The review canvas is a fixed-width
    // element inside a potentially wide browser, so mirror width-only media
    // rules as container queries. Preserve the original CSS for standalone use.
    device.style.containerType = "inline-size";
    const responsive = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.type !== 4) continue; // CSSMediaRule
          const condition = rule.conditionText;
          if (!/\((?:max|min)-width\s*:/i.test(condition) ||
              /(?:prefers-|orientation|print|screen|hover|pointer)/i.test(condition)) continue;
          responsive.push("@container " + condition + " { " +
            [...rule.cssRules].map(item => item.cssText).join("\n") + " }");
        }
      } catch (_) { /* cross-origin sheets: no read access */ }
    }
    if (responsive.length) {
      const adaptive = document.createElement("style");
      adaptive.textContent = responsive.join("\n");
      document.head.appendChild(adaptive);
    }
    device.addEventListener("np:resize", () => window.dispatchEvent(new Event("resize")));
    window.dispatchEvent(new Event("resize"));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, {once:true});
  else mount();
})();