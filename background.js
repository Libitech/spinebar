// ツールバーのアイコン（またはショートカット）でサイドパネルを開く
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error(err));

// コンテンツスクリプトから session ストレージを読めるようにする
// （session ストレージはChromeを再起動するとリセットされる＝「起動ごとに1回」の判定に使う）
function allowSessionAccess() {
  chrome.storage.session
    .setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })
    .catch(() => {});
}
chrome.runtime.onStartup.addListener(allowSessionAccess);
chrome.runtime.onInstalled.addListener(allowSessionAccess);
allowSessionAccess();

let autoOpened = false;

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "auto-open-sidepanel" || !sender.tab) return;
  if (autoOpened) return;
  autoOpened = true;
  // ユーザー操作の扱いを保つため、await を挟まずにすぐ呼び出す
  chrome.sidePanel.open({ windowId: sender.tab.windowId }).catch((err) => console.warn(err));
  chrome.storage.session.set({ autoOpened: true });
});

// 以前のバージョンで作った待機タブの記録を消去
chrome.storage.session.remove("standby").catch(() => {});
