(() => {
'use strict';

// The page's side of mobile remote access (desktop/mobile-companion.js keeps the server, desktop/mobile-bridge.js the
// way to a window): a message from a paired phone runs the agent turn in that device's chat, and the reply goes back
// over its sealed socket. Only the app's own window does this; the quick chat's window leaves it to the main one.
// Messages are taken one after another, so a turn on the same chat is never overtaken.
const bridge = window.openghost?.mobile;
if (!bridge || window.openghost?.quick) return;

let chain = Promise.resolve();
bridge.onAsk(request => {
 chain = chain.then(() => chat.answerMobile(request)).catch(() => {
  bridge.answer(request.id, '', I18n.t('mobile.failed'));
 });
});

// The chats are read: the page can make a phone's chat and run its agent.
library.ready.then(() => bridge.ready()).catch(() => {});
})();
