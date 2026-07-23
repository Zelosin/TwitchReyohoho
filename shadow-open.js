(() => {
  const nativeAttachShadow = Element.prototype.attachShadow;
  if (!window.__RYH_SHADOW_PATCHED__) {
    window.__RYH_SHADOW_PATCHED__ = true;
    Element.prototype.attachShadow = function attachShadow(init) {
      return nativeAttachShadow.call(this, { ...init, mode: 'open' });
    };
  }

  if (window.__RYH_CHAT_INSERT_READY__) {
    return;
  }
  window.__RYH_CHAT_INSERT_READY__ = true;

  const CHAT_INPUT_SELECTOR =
    'textarea[data-a-target="chat-input"], div[data-a-target="chat-input"]';

  function getReactInstance(element) {
    if (!element) {
      return null;
    }

    for (const key in element) {
      if (
        key.startsWith('__reactFiber$') ||
        key.startsWith('__reactInternalInstance$')
      ) {
        return element[key];
      }
    }

    return null;
  }

  function searchReactParents(node, predicate, maxDepth = 30, depth = 0) {
    try {
      if (node && predicate(node)) {
        return node;
      }
    } catch {
      /* ignore */
    }

    if (!node || depth > maxDepth) {
      return null;
    }

    return searchReactParents(node.return, predicate, maxDepth, depth + 1);
  }

  function getChatInputNode(element) {
    return searchReactParents(
      getReactInstance(element),
      (node) =>
        node.memoizedProps &&
        node.memoizedProps.componentType != null &&
        node.memoizedProps.value != null
    );
  }

  function getChatInputNodeBySetter(element) {
    return searchReactParents(
      getReactInstance(element),
      (node) => typeof node?.memoizedProps?.setInputValue === 'function'
    );
  }

  function getChatInputEditor(element) {
    const editorNode = searchReactParents(
      getReactInstance(element),
      (node) =>
        node?.memoizedProps?.value?.editor != null ||
        node?.stateNode?.state?.slateEditor != null
    );

    return (
      editorNode?.memoizedProps?.value?.editor ??
      editorNode?.stateNode?.state?.slateEditor ??
      null
    );
  }

  function readChatValue(element, chatInput) {
    if (element?.tagName === 'TEXTAREA' && typeof element.value === 'string') {
      return element.value;
    }

    if (typeof chatInput?.memoizedProps?.value === 'string') {
      return chatInput.memoizedProps.value;
    }

    return String(element?.textContent || '').replace(/\uFEFF/g, '');
  }

  function readCaretOffset(element, fullText) {
    if (element?.tagName === 'TEXTAREA' && typeof element.selectionStart === 'number') {
      return element.selectionStart;
    }

    const selection = element.ownerDocument.getSelection();
    if (selection && selection.rangeCount > 0 && element.contains(selection.focusNode)) {
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      range.setEnd(selection.focusNode, selection.focusOffset);
      return range.toString().replace(/\uFEFF/g, '').length;
    }

    return fullText.length;
  }

  function buildInsertedValue(current, caret, text) {
    const needsSpaceBefore = caret > 0 && !/\s/.test(current[caret - 1] || '');
    const needsSpaceAfter = caret < current.length && !/\s/.test(current[caret] || '');
    const piece = `${needsSpaceBefore ? ' ' : ''}${text}${needsSpaceAfter ? ' ' : ''}`;
    return `${current.slice(0, caret)}${piece}${current.slice(caret)}`;
  }

  function setViaTwitchProps(element, text) {
    const chatInput = getChatInputNodeBySetter(element) || getChatInputNode(element);
    const setInputValue = chatInput?.memoizedProps?.setInputValue;
    if (typeof setInputValue !== 'function') {
      return false;
    }

    const current = readChatValue(element, chatInput);
    const caret = readCaretOffset(element, current);
    const next = buildInsertedValue(current, caret, text);

    chatInput.memoizedProps.value = next;
    setInputValue(next);
    if (typeof chatInput.memoizedProps.onValueUpdate === 'function') {
      chatInput.memoizedProps.onValueUpdate(next);
    }
    return true;
  }

  function setViaSlateEditor(element, text) {
    const editor = getChatInputEditor(element);
    if (!editor) {
      return false;
    }

    element.focus();

    try {
      if (typeof editor.focus === 'function') {
        editor.focus();
      }
    } catch {
      /* ignore */
    }

    if (typeof editor.insertText === 'function') {
      editor.insertText(text);
      return true;
    }

    if (editor.selection == null && typeof editor.children !== 'undefined') {
      try {
        const end = editor.children?.length
          ? [editor.children.length - 1, (editor.children.at(-1)?.text || '').length]
          : [0, 0];
        editor.selection = {
          anchor: { path: [end[0], 0], offset: end[1] },
          focus: { path: [end[0], 0], offset: end[1] }
        };
      } catch {
        /* ignore */
      }
    }

    if (typeof editor.insertText === 'function') {
      editor.insertText(text);
      return true;
    }

    return false;
  }

  function setViaExecCommand(element, text) {
    element.focus();

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !element.contains(selection.anchorNode)) {
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }

    try {
      return document.execCommand('insertText', false, text);
    } catch {
      return false;
    }
  }

  function setViaTextarea(element, text) {
    if (element.tagName !== 'TEXTAREA') {
      return false;
    }

    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? element.value.length;
    const next = `${element.value.slice(0, start)}${text}${element.value.slice(end)}`;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    descriptor?.set?.call(element, next);
    element.dispatchEvent(new Event('input', { bubbles: true }));

    const instance = getReactInstance(element);
    const onChange = instance?.memoizedProps?.onChange;
    if (typeof onChange === 'function') {
      onChange({ target: element });
    }

    try {
      element.setSelectionRange(start + text.length, start + text.length);
    } catch {
      /* ignore */
    }

    return true;
  }

  function insertChatText(text) {
    const value = String(text || '');
    if (!value) {
      return false;
    }

    const element = document.querySelector(CHAT_INPUT_SELECTOR);
    if (!element) {
      return false;
    }

    element.focus();

    if (setViaTextarea(element, value)) {
      return true;
    }
    if (setViaTwitchProps(element, value)) {
      return true;
    }
    if (setViaSlateEditor(element, value)) {
      return true;
    }
    if (setViaExecCommand(element, value)) {
      return true;
    }

    return false;
  }

  document.documentElement.addEventListener('ryh-insert-chat-text', () => {
    const text = document.documentElement.getAttribute('data-ryh-insert-chat') || '';
    document.documentElement.removeAttribute('data-ryh-insert-chat');
    insertChatText(text);
  });

  window.__RYH_INSERT_CHAT_TEXT__ = insertChatText;
})();
