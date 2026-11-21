// Chrome起動後、最初のクリック／キー入力でサイドバーを自動で開く。
// sidePanel.open() はユーザー操作が必要なため、ページ上の操作をきっかけにする。
(() => {
  let done = true; // 状態を読み込むまでは何もしない

  chrome.storage.session
    .get("autoOpened")
    .then(({ autoOpened }) => {
      done = !!autoOpened;
    })
    .catch(() => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.autoOpened) done = !!changes.autoOpened.newValue;
  });

  const trigger = (e) => {
    if (done || !e.isTrusted) return;
    done = true;
    chrome.runtime.sendMessage({ type: "auto-open-sidepanel" }).catch(() => {});
  };

  window.addEventListener("pointerdown", trigger, true);
  window.addEventListener("keydown", trigger, true);
})();
