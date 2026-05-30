(() => {
  if (window.__RYH_SHADOW_PATCHED__) {
    return;
  }
  window.__RYH_SHADOW_PATCHED__ = true;

  const nativeAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function attachShadow(init) {
    return nativeAttachShadow.call(this, { ...init, mode: 'open' });
  };
})();
