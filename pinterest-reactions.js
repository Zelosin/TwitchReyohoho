(() => {
  const HEART_EYES_SRC = /\/webapp\/heart_eyes-[^/?#]+\.png(?:[?#]|$)/i;

  function isTargetReaction(img) {
    if (!(img instanceof HTMLImageElement)) {
      return false;
    }
    const src = img.currentSrc || img.src || '';
    const alt = (img.getAttribute('alt') || '').trim().toLowerCase();
    return HEART_EYES_SRC.test(src) || alt === 'heart eyes';
  }

  function clearDecoration(img) {
    if (img.dataset.ryhGreenHeart !== '1') {
      return;
    }
    img.style.removeProperty('opacity');
    delete img.dataset.ryhGreenHeart;
    img.parentElement?.querySelector(':scope > .ryh-green-heart')?.remove();
  }

  function decorate(img) {
    if (!isTargetReaction(img)) {
      clearDecoration(img);
      return;
    }

    const host = img.parentElement;
    if (!host) {
      return;
    }

    img.style.setProperty('opacity', '0', 'important');
    img.dataset.ryhGreenHeart = '1';

    let badge = host.querySelector(':scope > .ryh-green-heart');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'ryh-green-heart';
      badge.textContent = '💚';
      badge.setAttribute('aria-hidden', 'true');
      img.insertAdjacentElement('afterend', badge);
    }

    const computed = window.getComputedStyle(host);
    if (computed.position === 'static') {
      host.style.position = 'relative';
    }
  }

  function scan(root) {
    if (!root) {
      return;
    }

    if (root instanceof HTMLImageElement) {
      decorate(root);
    }

    if (root.querySelectorAll) {
      root.querySelectorAll('img').forEach(decorate);
    }
  }

  scan(document);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes' && mutation.target instanceof HTMLImageElement) {
        decorate(mutation.target);
        continue;
      }

      mutation.addedNodes.forEach((node) => {
        if (node instanceof Element) {
          scan(node);
        }
      });
    }
  });

  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['src', 'alt']
  });
})();
