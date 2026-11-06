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
    device.addEventListener("np:resize", () => window.dispatchEvent(new Event("resize")));
    window.dispatchEvent(new Event("resize"));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, {once:true});
  else mount();
})();