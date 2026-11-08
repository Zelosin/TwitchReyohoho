document.getElementById('go').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://suseqa.moe/live' });
  window.close();
});

document.getElementById('close').addEventListener('click', () => {
  window.close();
});
