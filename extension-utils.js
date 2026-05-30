(() => {
  if (window.__RYH_EXT_UTILS__) {
    return;
  }
  window.__RYH_EXT_UTILS__ = true;

  const INVALID_RE = /extension context invalidated/i;
  const BANNER_ID = 'ryh-ext-reload-banner';

  function isExtensionContextValid() {
    try {
      chrome.runtime.getURL('');
      return true;
    } catch {
      return false;
    }
  }

  function isInvalidatedError(error) {
    return INVALID_RE.test(String(error?.message || error));
  }

  function showExtensionReloadBanner() {
    if (document.getElementById(BANNER_ID)) {
      return;
    }

    const banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.textContent = 'Twitch ReYohoho: расширение обновлено — обновите страницу (F5)';
    banner.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'right:0',
      'z-index:2147483647',
      'padding:10px 16px',
      'background:#9147ff',
      'color:#fff',
      'font:14px/1.4 system-ui,sans-serif',
      'text-align:center',
      'box-shadow:0 2px 8px rgba(0,0,0,.35)'
    ].join(';');
    (document.body || document.documentElement).appendChild(banner);
  }

  async function safeRuntimeSendMessage(payload) {
    if (!isExtensionContextValid()) {
      showExtensionReloadBanner();
      throw new Error('Расширение было обновлено. Обновите страницу (F5).');
    }

    try {
      return await chrome.runtime.sendMessage(payload);
    } catch (error) {
      if (isInvalidatedError(error)) {
        showExtensionReloadBanner();
        throw new Error('Расширение было обновлено. Обновите страницу (F5).');
      }
      throw error;
    }
  }

  async function safeStorageGet(keys) {
    if (!isExtensionContextValid()) {
      showExtensionReloadBanner();
      return {};
    }

    try {
      return await chrome.storage.local.get(keys);
    } catch (error) {
      if (isInvalidatedError(error)) {
        showExtensionReloadBanner();
        return {};
      }
      throw error;
    }
  }

  async function safeStorageSet(items) {
    if (!isExtensionContextValid()) {
      showExtensionReloadBanner();
      return;
    }

    try {
      await chrome.storage.local.set(items);
    } catch (error) {
      if (isInvalidatedError(error)) {
        showExtensionReloadBanner();
        return;
      }
      throw error;
    }
  }

  async function safeStorageRemove(keys) {
    if (!isExtensionContextValid()) {
      showExtensionReloadBanner();
      return;
    }

    try {
      await chrome.storage.local.remove(keys);
    } catch (error) {
      if (isInvalidatedError(error)) {
        showExtensionReloadBanner();
      }
    }
  }

  window.__RYH_EXT__ = {
    isExtensionContextValid,
    isInvalidatedError,
    showExtensionReloadBanner,
    safeRuntimeSendMessage,
    safeStorageGet,
    safeStorageSet,
    safeStorageRemove
  };
})();
