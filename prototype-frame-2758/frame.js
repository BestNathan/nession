/* Shared review-page controls (#2758); strictly outside the product runtime. */
(() => {
  'use strict';
  const init = () => {
    for (const page of document.querySelectorAll('[data-np-root]')) {
      const device = page.querySelector('[data-np-device]');
      const widthLabel = page.querySelector('[data-np-current-size]');
      if (!device) continue;
      const controls = [...page.querySelectorAll('[data-np-size]')];
      const selectSize = (button) => {
        const width = Number(button.getAttribute('data-np-size'));
        if (!Number.isInteger(width) || width < 320 || width > 1920) return;
        // No scaling: the viewport's rendered width is literally width CSS px.
        device.style.setProperty('--np-device-width', width + 'px');
        for (const control of controls) control.setAttribute('aria-pressed', String(control === button));
        if (widthLabel) widthLabel.textContent = width + ' CSS px · 1:1';
        device.dispatchEvent(new CustomEvent('np:resize', {detail:{width},bubbles:false}));
      };
      controls.forEach(button => button.addEventListener('click', () => selectSize(button)));
      const selected = controls.find(b => b.getAttribute('aria-pressed') === 'true') || controls[0];
      if (selected) selectSize(selected);
      page.querySelectorAll('[data-np-reset]').forEach(button =>
        button.addEventListener('click', () => { window.location.reload(); })
      );
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true});
  else init();
})();
